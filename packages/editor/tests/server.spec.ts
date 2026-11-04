import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { apply, createEditorApi, resolveConfig } from '../src/index.ts'
import { workspaceIdentity } from '../src/security.ts'

it('resolves the permitted workspace and rejects cross-origin bridge requests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editor-api-'))
  let origin = ''
  const api = createEditorApi({
    editorOrigin: 'http://127.0.0.1:9000',
    bridgeDirectory: root, bridgeMode: 'required', timeoutMs: 1000, maxHotWorkspaces: 3,
    allowedOrigin: () => origin,
    resolveWorkspace: async () => ({ directory: root, allowedRoot: root }),
  })
  const server = http.createServer((req, res) => { api.handle(req, res) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing port')
  try {
    const base = `http://127.0.0.1:${address.port}`
    origin = base
    const workspace: unknown = await (await fetch(`${base}/amadeus/editor/workspace`)).json()
    if (typeof workspace !== 'object' || workspace === null || !('bridgeToken' in workspace)
      || typeof workspace.bridgeToken !== 'string') throw new Error('Missing bridge token')
    const token = workspace.bridgeToken
    expect(workspace).toHaveProperty('editorOrigin', 'http://127.0.0.1:9000')
    expect((await fetch(`${base}/amadeus/editor/action`, {
      method: 'POST', headers: { 'x-amadeus-bridge-token': token },
      body: '{"action":"invalid"}',
    })).status).toBe(400)
    for (const headers of [
      { origin: 'http://evil.test' },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      expect((await fetch(`${base}/amadeus/editor/action`, {
        method: 'POST', headers: { ...headers, 'x-amadeus-bridge-token': token },
        body: '{"action":"invalid"}',
      })).status).toBe(403)
    }
    const spoofed = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.get(`${base}/amadeus/editor/workspace`, { headers: { host: `attacker.test:${address.port}` } }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      request.once('error', reject)
    })
    expect(spoofed).toBe(403)
    expect((await fetch(`${base}/amadeus/editor/action`, {
      method: 'POST', headers: { origin: base }, body: '{"action":"dirtyState"}',
    })).status).toBe(403)
    expect((await fetch(`${base}/amadeus/editor/action`, {
      method: 'POST', headers: { origin: base, 'x-amadeus-bridge-token': 'wrong' }, body: '{"action":"dirtyState"}',
    })).status).toBe(403)
    expect((await fetch(`${base}/amadeus/editor/bridge`, {
      method: 'POST', headers: { origin: 'http://evil.test' }, body: '{"action":"dirtyState"}',
    })).status).toBe(403)
    expect((await fetch(`${base}/amadeus/editor/workspace?directory=${encodeURIComponent(os.tmpdir())}`)).status).toBe(400)
    expect((await fetch(`${base}/amadeus/editor/bridge`, {
      method: 'POST', headers: { origin: base, 'x-amadeus-bridge-token': token },
      body: JSON.stringify({ action: 'openFile', path: os.tmpdir() }),
    })).status).toBe(400)
    for (const endpoint of ['open', 'action', 'settings']) {
      expect((await fetch(`${base}/amadeus/editor/${endpoint}`, {
        method: 'POST', headers: { origin: 'http://evil.test' }, body: '{"action":"dirtyState"}',
      })).status).toBe(403)
    }
  } finally {
    await api.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    await rm(root, { recursive: true, force: true })
  }
})

it('aborts an incomplete request body and completes API disposal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editor-request-'))
  let origin = ''
  const api = createEditorApi({
    editorOrigin: 'http://127.0.0.1:9000',
    bridgeDirectory: root, bridgeMode: 'required', timeoutMs: 1000, maxHotWorkspaces: 3,
    allowedOrigin: () => origin,
    resolveWorkspace: () => Promise.resolve({ directory: root, allowedRoot: root }),
  })
  const server = http.createServer((req, res) => { api.handle(req, res) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  origin = `http://127.0.0.1:${address.port}`
  try {
    const workspace: unknown = await (await fetch(`${origin}/amadeus/editor/workspace`)).json()
    if (typeof workspace !== 'object' || workspace === null || !('bridgeToken' in workspace)
      || typeof workspace.bridgeToken !== 'string') throw new Error('Missing bridge token')
    const entered = new Promise<void>((resolve) => {
      server.once('request', () => { resolve() })
    })
    const socket = net.connect(address.port, '127.0.0.1')
    await once(socket, 'connect')
    socket.write(`POST /amadeus/editor/action HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nOrigin: ${origin}\r\nX-Amadeus-Bridge-Token: ${workspace.bridgeToken}\r\nContent-Length: 100\r\n\r\n{`)
    await entered
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    const closed = once(socket, 'close')
    await api.dispose()
    await closed
  } finally {
    await api.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    await rm(root, { recursive: true, force: true })
  }
})

it('registers routes and discovered upgrade paths and removes them on Cordis disposal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editor-host-'))
  const current = path.join(root, 'current')
  const cold = path.join(root, 'cold')
  await mkdir(current)
  await mkdir(cold)
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<script src="stable-abcdef123456/static/out/vs/code/browser/workbench/workbench.js"></script>')
  })
  upstream.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    socket.on('end', () => { socket.destroy() })
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const upstreamAddress = upstream.address()
  if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('Missing upstream port')
  const routes = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>()
  const upgrades = new Map<string, (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void>()
  let hostOrigin = ''
  const ctx = new Context()
  ctx.provide('webServer', {
    getOrigin() { return hostOrigin },
    register(route: { path: string; handler: (req: http.IncomingMessage, res: http.ServerResponse) => void }) {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
    registerUpgrade(route: { path: string; handler: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void }) {
      upgrades.set(route.path, route.handler)
      return () => { upgrades.delete(route.path) }
    },
  })
  ctx.provide('sessions', { get: (id: string) => id === 'session' ? { header: { cwd: root } } : undefined })
  ctx.provide('sessionPersistence', { stat: (id: string) => Promise.resolve(id === 'cold' ? { header: { cwd: cold } } : undefined) })
  ctx.provide('sandboxPolicy', { resolve: () => ({ workspaceRoot: root }) })
  ctx.provide('workingDirectory', { defaultDirectory: root, get: () => current })
  const web = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://test').pathname
    const handler = routes.get(pathname) ?? (pathname.startsWith('/amadeus/code/') ? routes.get('/amadeus/code') : undefined)
    if (handler) handler(req, res)
    else res.writeHead(404).end()
  })
  web.on('upgrade', (req, socket, head) => {
    const handler = upgrades.get(new URL(req.url ?? '/', 'http://test').pathname)
    if (handler) handler(req, socket, head)
    else socket.destroy()
  })
  web.listen(0, '127.0.0.1')
  await once(web, 'listening')
  const address = web.address()
  if (!address || typeof address === 'string') throw new Error('Missing server port')
  hostOrigin = `http://127.0.0.1:${address.port}`
  try {
    apply(ctx, { upstream: `http://127.0.0.1:${upstreamAddress.port}`, stateDir: root })
    await vi.waitFor(() => { expect(routes.size).toBe(6) })
    const base = `http://127.0.0.1:${address.port}`
    expect((await fetch(`${base}/amadeus/editor/workspace`)).status).toBe(200)
    const workspace: unknown = await (await fetch(`${base}/amadeus/editor/workspace?sessionId=session`)).json()
    expect(workspace).toMatchObject({
      workspaceRoot: (await workspaceIdentity(current)).root, maxHotWorkspaces: 3,
      editorOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
    })
    const coldWorkspace: unknown = await (await fetch(`${base}/amadeus/editor/workspace?sessionId=cold`)).json()
    expect(coldWorkspace).toMatchObject({ workspaceRoot: (await workspaceIdentity(cold)).root, maxHotWorkspaces: 3 })
    expect((await fetch(`${base}/amadeus/editor/workspace?sessionId=missing`)).status).toBe(400)
    expect((await fetch(`${base}/amadeus/code/?folder=test`)).status).toBe(200)
    expect(upgrades.has('/amadeus/code/stable-abcdef123456')).toBe(true)
    const socket = net.connect(address.port, '127.0.0.1')
    await once(socket, 'connect')
    socket.write(`GET /amadeus/code/stable-abcdef123456?token=test HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nOrigin: ${base}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)
    await once(socket, 'data')
    const closed = once(socket, 'close')
    await ctx.fiber.dispose()
    await closed
    expect(routes.size).toBe(0)
    expect(upgrades.size).toBe(0)
  } finally {
    await ctx.fiber.dispose()
    web.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => web.close(() => { resolve() })),
      new Promise<void>(resolve => upstream.close(() => { resolve() }))])
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps the host running and reports unavailable when the managed executable is missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editor-missing-'))
  const ctx = new Context()
  const register = vi.fn()
  ctx.provide('webServer', { register, registerUpgrade: vi.fn(), getOrigin: () => 'http://127.0.0.1:8080' })
  ctx.provide('sessions', { get: () => undefined })
  ctx.provide('sandboxPolicy', { resolve: () => ({ workspaceRoot: root }) })
  ctx.provide('workingDirectory', { defaultDirectory: root, get: () => root })
  const messages: string[] = []
  ctx.logger.exporter({ export(message) { messages.push(message.type) } })
  try {
    apply(ctx, { executablePath: path.join(root, 'missing'), stateDir: root, startupTimeoutMs: 1000 })
    await vi.waitFor(() => { expect(messages).toContain('error') })
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ path: '/amadeus/editor/workspace' }))
    const route = register.mock.calls[0]?.[0] as { handler: (req: http.IncomingMessage, res: http.ServerResponse) => void }
    const server = http.createServer(route.handler)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/amadeus/editor/workspace`)
      expect(response.status).toBe(503)
      expect(await response.json()).toHaveProperty('error', expect.stringContaining('executable path'))
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    }
    await ctx.fiber.dispose()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects invalid editor configuration', () => {
  expect(resolveConfig().bridgeTimeoutMs).toBe(3000)
  expect(resolveConfig().stateDir).toBe(path.resolve(path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'editor')))
  expect(() => resolveConfig({ upstream: 'file:///secret' })).toThrow()
  expect(() => resolveConfig({ maxHotWorkspaces: 0 })).toThrow()
})

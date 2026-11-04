import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BridgeClient } from './bridge-client.ts'
import { WorkspaceBridges } from './bridge-workspace.ts'
import { startManagedEditor, type ManagedEditor } from './process.ts'
import { createProxy } from './proxy.ts'
import { isSameOrigin, validBearer, workspaceIdentity, workspaceTarget } from './security.ts'

/** Editor deployment options. */
export interface Config {
  upstream?: string
  executablePath?: string
  stateDir?: string
  startupTimeoutMs?: number
  bridgeTimeoutMs?: number
  bridgeMode?: 'required' | 'disabled'
  maxHotWorkspaces?: number
  publicOrigin?: string
}

/** Validated editor deployment options. */
export interface ResolvedConfig {
  upstream: string | undefined
  executablePath: string
  stateDir: string
  startupTimeoutMs: number
  bridgeTimeoutMs: number
  bridgeMode: 'required' | 'disabled'
  maxHotWorkspaces: number
  publicOrigin: string | undefined
}

/** Editor configuration schema. */
export const Config = z.object({
  upstream: z.string().volatile(),
  executablePath: z.string().volatile(),
  stateDir: z.string().volatile(),
  startupTimeoutMs: z.number().volatile(),
  bridgeTimeoutMs: z.number().volatile(),
  bridgeMode: z.union(['required', 'disabled'] as const).volatile(),
  maxHotWorkspaces: z.number().volatile(),
  publicOrigin: z.string().volatile(),
})

function isVolatile<T>(value: T | { get(): T }): value is { get(): T } {
  return typeof value === 'object' && value !== null && 'get' in value && typeof value.get === 'function'
}

function unwrapVolatile<T>(value: T | { get(): T }): T {
  return isVolatile(value) ? value.get() : value
}

/**
 * Resolve and validate editor deployment options.
 * @param config - Optional deployment configuration.
 * @returns Complete editor configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const plain = unwrapVolatile(config)
  const defaultStateRoot = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const resolved: ResolvedConfig = {
    upstream: unwrapVolatile(plain.upstream),
    executablePath: unwrapVolatile(plain.executablePath) ?? 'code-server',
    stateDir: path.resolve(unwrapVolatile(plain.stateDir) ?? path.join(defaultStateRoot, 'editor')),
    startupTimeoutMs: unwrapVolatile(plain.startupTimeoutMs) ?? 15000,
    bridgeTimeoutMs: unwrapVolatile(plain.bridgeTimeoutMs) ?? 3000,
    bridgeMode: unwrapVolatile(plain.bridgeMode) ?? 'required',
    maxHotWorkspaces: unwrapVolatile(plain.maxHotWorkspaces) ?? 3,
    publicOrigin: unwrapVolatile(plain.publicOrigin),
  }
  for (const value of [resolved.startupTimeoutMs, resolved.bridgeTimeoutMs, resolved.maxHotWorkspaces]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Editor timeouts and workspace limit must be positive integers')
  }
  if (!resolved.executablePath) throw new Error('Editor executable path must not be empty')
  for (const origin of [resolved.upstream, resolved.publicOrigin]) {
    if (origin === undefined) continue
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Editor upstream must be an HTTP(S) origin')
    }
  }
  return resolved
}

interface EditorHostContext {
  webServer?: {
    getOrigin(): string
    register(route: { kind: 'exact' | 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): () => void
    registerUpgrade(route: { path: string; handler(req: IncomingMessage, socket: Duplex, head: Buffer): void }): () => void
  }
  sandboxPolicy?: { resolve(request?: { session?: EditorSession }): { workspaceRoot: string } }
  sessions?: { get(id: string): EditorSession | undefined }
  sessionPersistence?: { stat(id: string): Promise<EditorSession | undefined> }
  workingDirectory?: { defaultDirectory: string; get(session: EditorSession): string }
}

interface EditorSession {
  header: { cwd?: string | null }
}

/** Cordis plugin name. */
export const name = 'amadeus-editor'

/** Required host services. */
export const inject = ['webServer', 'sandboxPolicy', 'sessions', 'workingDirectory']

/**
 * Register the editor routes for the plugin lifetime.
 * @param ctx - Cordis context containing the host services.
 * @param config - Optional editor configuration.
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved = resolveConfig(config)
  const host = ctx as Context & EditorHostContext
  const { webServer, sandboxPolicy, sessions, workingDirectory } = host
  if (!webServer || !sandboxPolicy || !sessions || !workingDirectory) {
    throw new Error('Editor requires webServer, sandboxPolicy, sessions and workingDirectory')
  }
  ctx.effect(async () => {
    let managed: ManagedEditor | undefined
    let upstream = resolved.upstream
    if (upstream === undefined) {
      try {
        managed = await startManagedEditor({
          binary: resolved.executablePath, stateDir: resolved.stateDir,
          extensionDir: fileURLToPath(new URL('../extension', import.meta.url)), startupTimeoutMs: resolved.startupTimeoutMs,
        })
        upstream = managed.upstream
      } catch (error) {
        ctx.logger('amadeus-editor').error(`Editor unavailable: ${String(error)}`)
        return webServer.register({
          kind: 'exact', path: '/amadeus/editor/workspace',
          handler(_req, res) { json(res, 503, { error: 'Editor unavailable; check the executable path or upstream in plugin settings' }) },
        })
      }
    }
    const disposers: (() => void)[] = []
    const paths = new Set<string>()
    const api = createEditorApi({
      bridgeDirectory: path.join(resolved.stateDir, 'bridges'), bridgeMode: resolved.bridgeMode, timeoutMs: resolved.bridgeTimeoutMs,
      maxHotWorkspaces: resolved.maxHotWorkspaces,
      editorOrigin: upstream,
      allowedOrigin: () => resolved.publicOrigin ?? webServer.getOrigin(),
      async resolveWorkspace(sessionId) {
        if (sessionId === undefined) {
          return {
            directory: workingDirectory.defaultDirectory,
            allowedRoot: sandboxPolicy.resolve().workspaceRoot,
          }
        }
        const live = sessions.get(sessionId)
        if (live) {
          return {
            directory: workingDirectory.get(live),
            allowedRoot: sandboxPolicy.resolve({ session: live }).workspaceRoot,
          }
        }
        const stored = await host.sessionPersistence?.stat(sessionId)
        if (!stored) throw new Error(`Session not found: ${sessionId}`)
        const fallbackRoot = sandboxPolicy.resolve().workspaceRoot
        const allowedRoot = stored.header.cwd ?? fallbackRoot
        return {
          directory: stored.header.cwd ?? workingDirectory.defaultDirectory,
          allowedRoot,
        }
      },
    })
    const proxy = createProxy(upstream, '/amadeus/code', (upgradePath) => {
      if (paths.has(upgradePath)) return
      disposers.push(webServer.registerUpgrade({
        path: upgradePath,
        handler(req, socket, head) {
          if (req.headers.host !== new URL(resolved.publicOrigin ?? webServer.getOrigin()).host) { socket.destroy(); return }
          proxy.upgrade(req, socket, head)
        },
      }))
      paths.add(upgradePath)
    })
    async function dispose(): Promise<void> {
      const errors: unknown[] = []
      try {
        for (const unregister of disposers.reverse()) {
          try { unregister() } catch (error) { errors.push(error) }
        }
      } finally {
        try { proxy.close() } finally {
          try { await api.dispose() } finally { await managed?.dispose() }
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Editor route cleanup failed')
    }
    try {
      disposers.push(webServer.register({ kind: 'exact', path: '/amadeus/editor/workspace', handler: (req, res) => { api.handle(req, res) } }))
      disposers.push(webServer.register({ kind: 'exact', path: '/amadeus/editor/bridge', handler: (req, res) => { api.handle(req, res) } }))
      for (const route of ['/amadeus/editor/open', '/amadeus/editor/action', '/amadeus/editor/settings']) {
        disposers.push(webServer.register({ kind: 'exact', path: route, handler: (req, res) => { api.handle(req, res) } }))
      }
      disposers.push(webServer.register({
        kind: 'prefix', path: '/amadeus/code',
        handler(req, res) {
          if (req.headers.host !== new URL(resolved.publicOrigin ?? webServer.getOrigin()).host) {
            res.writeHead(403).end()
            return
          }
          proxy.handle(req, res)
        },
      }))
      disposers.push(webServer.registerUpgrade({
        path: '/amadeus/code',
        handler(req, socket, head) {
          if (req.headers.host !== new URL(resolved.publicOrigin ?? webServer.getOrigin()).host) { socket.destroy(); return }
          proxy.upgrade(req, socket, head)
        },
      }))
    } catch (error) {
      await dispose()
      throw error
    }
    return dispose
  }, 'amadeus-editor lifecycle')
}

/** Workspace resolution supplied by the host for a session. */
export interface WorkspaceAccess {
  directory: string
  allowedRoot: string
}

/** Dependencies for the editor API handlers. */
export interface EditorApiOptions {
  editorOrigin: string
  bridgeDirectory: string
  bridgeMode: 'required' | 'disabled'
  timeoutMs: number
  maxHotWorkspaces: number
  allowedOrigin(): string
  resolveWorkspace(sessionId: string | undefined): Promise<WorkspaceAccess>
}

async function readBody(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  const abort = (): void => { req.destroy(new Error('Editor request aborted')) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    for await (const chunk of req) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Invalid request body')
      size += chunk.length
      if (size > 65536) throw new Error('Request body too large')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

function json(res: ServerResponse, status: number, value: object): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/**
 * Create workspace and bridge HTTP handlers with a single request owner.
 * @param options - Host workspace resolver and bridge settings.
 * @returns HTTP handler and async disposer.
 */
export function createEditorApi(options: EditorApiOptions) {
  const client = new BridgeClient()
  const bridges = new WorkspaceBridges(options.bridgeDirectory, client, options.timeoutMs)
  const pending = new Set<Promise<void>>()
  const controller = new AbortController()
  const capability = randomBytes(32).toString('hex')
  let disposed = false
  const isDisposed = (): boolean => disposed

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (isDisposed()) { json(res, 503, { error: 'Editor is shutting down' }); return }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const expected = new URL(options.allowedOrigin())
    if (req.headers.host !== expected.host) {
      json(res, 403, { error: 'Host rejected' })
      return
    }
    if (req.headers.origin && req.headers.origin !== expected.origin) {
      json(res, 403, { error: 'Origin rejected' })
      return
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') { json(res, 403, { error: 'Origin rejected' }); return }
    const sessionId = url.searchParams.get('sessionId') || undefined
    const access = await options.resolveWorkspace(sessionId)
    if (isDisposed()) { json(res, 503, { error: 'Editor is shutting down' }); return }
    const directory = url.searchParams.get('directory') || access.directory
    const root = await workspaceTarget(access.allowedRoot, directory)
    if (isDisposed()) { json(res, 503, { error: 'Editor is shutting down' }); return }
    if (url.pathname === '/amadeus/editor/workspace' && req.method === 'GET') {
      const identity = await workspaceIdentity(root)
      json(res, 200, {
        ...identity, workspaceRoot: identity.root, folderPath: identity.root, sessionId: sessionId ?? null,
        bridgeMode: options.bridgeMode, maxHotWorkspaces: options.maxHotWorkspaces,
        bridgeToken: capability,
        editorOrigin: options.editorOrigin,
      })
      return
    }
    const endpoints = ['/amadeus/editor/bridge', '/amadeus/editor/open', '/amadeus/editor/action', '/amadeus/editor/settings']
    if (!endpoints.includes(url.pathname) || req.method !== 'POST') {
      json(res, 404, { error: 'Not found' })
      return
    }
    // Desktop removes browser origin metadata when forwarding; the capability still authenticates the command.
    const originless = req.headers.origin === undefined && req.headers['sec-fetch-site'] === undefined
    if (!req.headers.host || (!originless && !isSameOrigin(req.headers, expected.origin))
      || !validBearer(`Bearer ${String(req.headers['x-amadeus-bridge-token'] ?? '')}`, capability)) {
      json(res, 403, { error: 'Origin rejected' })
      return
    }
    if (options.bridgeMode === 'disabled') { json(res, 409, { error: 'Bridge is disabled' }); return }
    const command = await readBody(req, controller.signal)
    if (typeof command !== 'object' || command === null || !('action' in command)) throw new Error('Invalid command')
    if (url.pathname === '/amadeus/editor/open' && command.action !== 'openFile') throw new Error('Invalid open action')
    if (url.pathname === '/amadeus/editor/settings' && command.action !== 'appearance') throw new Error('Invalid settings action')
    if (url.pathname === '/amadeus/editor/action' && !['dirtyState', 'saveAll', 'revertAndClose'].includes(String(command.action))) {
      throw new Error('Invalid editor action')
    }
    switch (command.action) {
      case 'dirtyState': {
        const state = await bridges.dirtyState(root)
        json(res, 200, { ...state, known: true, dirtyCount: state.dirty ? 1 : 0, instanceCount: state.count })
        return
      }
      case 'saveAll': json(res, 200, { clean: await bridges.saveAll(root) }); return
      case 'revertAndClose': json(res, 200, { clean: await bridges.revertAndClose(root) }); return
      case 'openFile': {
        if (!('path' in command) || typeof command.path !== 'string') throw new Error('Invalid file path')
        const line = 'line' in command ? command.line : undefined
        const column = 'column' in command ? command.column : undefined
        if (line !== undefined && (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1)) {
          throw new Error('Invalid line')
        }
        if (column !== undefined && (typeof column !== 'number' || !Number.isSafeInteger(column) || column < 1)) {
          throw new Error('Invalid column')
        }
        const target = await workspaceTarget(root, command.path)
        const result = await bridges.send(root, {
          action: 'openFile', path: target,
          ...line === undefined ? {} : { line },
          ...column === undefined ? {} : { column },
        })
        json(res, 200, { result })
        return
      }
      case 'appearance': {
        if (!('theme' in command) || typeof command.theme !== 'string') throw new Error('Invalid appearance')
        const result = await bridges.send(root, { action: 'appearance', theme: command.theme })
        json(res, 200, { result })
        return
      }
      default: throw new Error('Invalid command')
    }
  }

  return {
    handle(req: IncomingMessage, res: ServerResponse): void {
      const task = handleRequest(req, res).catch((error: unknown) => {
        if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : 'Editor request failed' })
        else res.destroy()
      })
      pending.add(task)
      void task.finally(() => { pending.delete(task) })
    },
    async dispose(): Promise<void> {
      disposed = true
      controller.abort()
      await client.dispose()
      await Promise.allSettled(pending)
    },
  }
}

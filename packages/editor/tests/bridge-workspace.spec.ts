import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { BridgeClient } from '../src/bridge-client.ts'
import { WorkspaceBridges } from '../src/bridge-workspace.ts'
import { workspaceIdentity } from '../src/security.ts'

it('verifies every save and refuses discarding changes across instances', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'amadeus-workspace-'))
  const directory = path.join(base, 'bridges')
  const workspace = path.join(base, 'workspace')
  await mkdir(directory)
  await mkdir(workspace)
  const client = new BridgeClient()
  let changed = true
  let failSave = false
  const actions: string[] = []
  const server = createServer((req, res) => { void handle(req, res) })
  async function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk)
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
    if (typeof body !== 'object' || body === null || !('action' in body) || typeof body.action !== 'string') throw new Error('Invalid command')
    actions.push(body.action)
    if (body.action === 'saveAll' && !failSave) changed = false
    if (body.action === 'revertAndClose') changed = false
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ dirty: changed, saved: !failSave }))
  }
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server port')
  const { key } = await workspaceIdentity(workspace)
  const ids = ['a0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-000000000000']
  const register = async (id: string): Promise<void> => {
    await writeFile(path.join(directory, `${key}-${id}.json`), JSON.stringify({
      instanceId: id, workspaceRoot: workspace, port: address.port, token: 'a'.repeat(64), pid: process.pid,
    }))
  }
  try {
    await register(ids[0]!)
    const bridges = new WorkspaceBridges(directory, client, 1000)
    expect(await bridges.dirtyState(workspace)).toEqual({ count: 1, dirty: true })
    expect(await bridges.saveAll(workspace)).toBe(true)
    expect(actions.slice(-1)).toEqual(['dirtyState'])
    changed = true
    failSave = true
    expect(await bridges.saveAll(workspace)).toBe(false)
    await register(ids[1]!)
    await expect(bridges.revertAndClose(workspace)).rejects.toThrow('multiple')
    expect(actions).not.toContain('revertAndClose')
    await writeFile(path.join(directory, `${key}-${ids[0]}.json`), JSON.stringify({
      instanceId: ids[0], workspaceRoot: workspace, port: 1, token: 'a'.repeat(64), pid: process.pid,
    }))
    expect(await bridges.send(workspace, { action: 'appearance', theme: 'Default Dark Modern' })).toMatchObject({ saved: false })
    await rm(path.join(directory, `${key}-${ids[1]}.json`))
    await writeFile(path.join(directory, `${key}-${ids[1]}.json`), JSON.stringify({
      instanceId: ids[1], workspaceRoot: workspace, port: address.port, pid: process.pid,
    }))
    await expect(bridges.dirtyState(workspace)).rejects.toThrow('Invalid bridge registration')
    await expect(bridges.revertAndClose(workspace)).rejects.toThrow('Invalid bridge registration')
    expect(actions).not.toContain('revertAndClose')
  } finally {
    await client.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    await rm(base, { recursive: true, force: true })
  }
})

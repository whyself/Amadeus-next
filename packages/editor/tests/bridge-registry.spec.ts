import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { readBridgeRegistrations } from '../src/bridge-registry.ts'
import { workspaceIdentity } from '../src/security.ts'

it('accepts only registrations whose identity and workspace match their filename', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'amadeus-bridge-'))
  try {
    const workspace = path.join(base, 'workspace')
    const directory = path.join(base, 'bridges')
    await mkdir(workspace)
    await mkdir(directory)
    const { key } = await workspaceIdentity(workspace)
    const instanceId = 'a0000000-0000-4000-8000-000000000000'
    const registration = { instanceId, workspaceRoot: workspace, port: 1234, token: 'a'.repeat(64), pid: 1 }
    await writeFile(path.join(directory, `${key}-${instanceId}.json`), JSON.stringify(registration))
    expect(await readBridgeRegistrations(directory, workspace)).toEqual([registration])
    await writeFile(path.join(directory, `${key}-bad.json`), '{')
    await expect(readBridgeRegistrations(directory, workspace)).rejects.toThrow('Invalid bridge registration')
    await rm(path.join(directory, `${key}-bad.json`))
    await writeFile(path.join(directory, `${key}-wrong.json`), JSON.stringify(registration))
    await expect(readBridgeRegistrations(directory, workspace)).rejects.toThrow('Invalid bridge registration')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

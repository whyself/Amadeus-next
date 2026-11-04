import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSameOrigin, validBearer, workspaceIdentity, workspaceTarget } from '../src/security.ts'

describe('editor security boundaries', () => {
  it('resolves workspace paths and rejects traversal and symlink escapes', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'amadeus-editor-'))
    try {
      const root = path.join(base, 'workspace')
      await mkdir(root)
      await writeFile(path.join(root, 'file.txt'), 'test')
      await writeFile(path.join(base, 'outside.txt'), 'test')
      expect(await workspaceTarget(root, 'file.txt')).toBe(await realpath(path.join(root, 'file.txt')))
      await expect(workspaceTarget(root, '../outside.txt')).rejects.toThrow('outside')
      if (process.platform !== 'win32') {
        await symlink(path.join(base, 'outside.txt'), path.join(root, 'link'))
        await expect(workspaceTarget(root, 'link')).rejects.toThrow('outside')
      }
      expect((await workspaceIdentity(root)).key).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('rejects cross-origin requests and invalid bridge tokens', () => {
    expect(isSameOrigin({ origin: 'https://example.test', 'sec-fetch-site': 'same-origin' }, 'https://example.test')).toBe(true)
    expect(isSameOrigin({ origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' }, 'https://example.test')).toBe(false)
    expect(isSameOrigin({}, 'https://example.test')).toBe(false)
    expect(validBearer('Bearer secret', 'secret')).toBe(true)
    expect(validBearer('Bearer wrong', 'secret')).toBe(false)
  })
})

import { createHash } from 'node:crypto'
import { access, chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { c } from 'tar'
import { afterEach, expect, it, vi } from 'vitest'
import { createEditorSetup, installedExecutable } from '../src/setup.ts'
import { resolveConfig } from '../src/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('does not download or create directories until explicitly requested', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editor-setup-idle-'))
  const network = vi.fn(() => { throw new Error('Unexpected network') })
  vi.stubGlobal('fetch', network)
  const setup = createEditorSetup(resolveConfig({ installDir: path.join(root, 'runtime') }))
  try {
    expect(setup.snapshot().phase).toBe('idle')
    await setup.dispose()
    expect(network).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
    setup.start()
    expect(setup.snapshot().phase).toBe('idle')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('validates download settings at the configuration boundary', () => {
  for (const downloadVersion of ['latest', '../4.100.3', '4.89.0', '5.0.0', '4.100.3-beta.1']) {
    expect(() => resolveConfig({ downloadVersion })).toThrow('Download version')
  }
  for (const downloadBaseUrl of ['http://example.test', 'https://user:pass@example.test', 'https://example.test?q=1']) {
    expect(() => resolveConfig({ downloadBaseUrl })).toThrow('Download source')
  }
})

it.skipIf(!['linux', 'darwin'].includes(process.platform))('verifies, extracts and reuses an explicitly downloaded executable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editor-setup-install-'))
  const options = resolveConfig({ installDir: path.join(root, 'runtime') })
  const setup = createEditorSetup(options)
  try {
    const bin = path.join(root, 'fixture', 'code-server', 'bin')
    await mkdir(bin, { recursive: true })
    const binary = path.join(bin, 'code-server')
    await writeFile(binary, '#!/usr/bin/env node\nconsole.log("4.145.0")\n')
    await chmod(binary, 0o755)
    const archive = path.join(root, 'fixture.tar.gz')
    await c({ file: archive, cwd: path.join(root, 'fixture'), gzip: true }, ['code-server'])
    const bytes = await readFile(archive)
    const osName = process.platform === 'darwin' ? 'macos' : 'linux'
    const arch = process.arch === 'x64' ? 'amd64' : 'arm64'
    const network = vi.fn(async (url: string) => url.startsWith('https://api.github.com/')
      ? Response.json({ assets: [{ name: `code-server-4.145.0-${osName}-${arch}.tar.gz`,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }] })
      : new Response(bytes, { headers: { 'content-length': String(bytes.length) } }))
    vi.stubGlobal('fetch', network)
    setup.start(); setup.start()
    await vi.waitFor(() => { expect(setup.snapshot().phase).toBe('ready') })
    await access(installedExecutable(options))
    expect(network).toHaveBeenCalledTimes(2)
    expect(await readdir(options.installDir)).toEqual(['4.145.0'])
    setup.start()
    expect(network).toHaveBeenCalledTimes(2)
  } finally { await setup.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.skipIf(!['linux', 'darwin'].includes(process.platform))('rejects a corrupt archive and removes its temporary files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editor-setup-digest-'))
  const options = resolveConfig({ installDir: path.join(root, 'runtime') })
  const setup = createEditorSetup(options)
  const osName = process.platform === 'darwin' ? 'macos' : 'linux'
  const arch = process.arch === 'x64' ? 'amd64' : 'arm64'
  vi.stubGlobal('fetch', async (url: string) => url.startsWith('https://api.github.com/')
    ? Response.json({ assets: [{ name: `code-server-4.145.0-${osName}-${arch}.tar.gz`, digest: `sha256:${'0'.repeat(64)}` }] })
    : new Response('corrupt archive'))
  try {
    setup.start()
    await vi.waitFor(() => { expect(setup.snapshot().phase).toBe('failed') })
    expect(setup.snapshot().error).toContain('SHA-256 mismatch')
    expect(await readdir(options.installDir)).toEqual([])
    await expect(access(installedExecutable(options))).rejects.toHaveProperty('code', 'ENOENT')
  } finally { await setup.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.skipIf(!['linux', 'darwin'].includes(process.platform))('cancels outstanding network work when disposed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editor-setup-cancel-'))
  const setup = createEditorSetup(resolveConfig({ installDir: path.join(root, 'runtime') }))
  let requested = false
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    requested = true
    const signal = init.signal
    if (!signal) throw new Error('Missing request cancellation')
    signal.addEventListener('abort', () => { reject(new Error('Request aborted', { cause: signal.reason })) }, { once: true })
  }))
  try {
    setup.start()
    await vi.waitFor(() => { expect(requested).toBe(true) })
    await setup.dispose()
    expect(setup.snapshot().phase).toBe('cancelled')
    expect(await readdir(root)).toEqual([])
  } finally { await setup.dispose(); await rm(root, { recursive: true, force: true }) }
})

import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { x } from 'tar'
import { checkEditorVersion } from './process.ts'

async function* downloadChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally { await reader.cancel(); reader.releaseLock() }
}

/** Explicit download settings; no download is started by construction. */
export interface SetupOptions {
  installDir: string
  downloadVersion: string
  downloadBaseUrl: string
  startupTimeoutMs: number
}

/** Host-owned preparation state returned to settings. */
export interface SetupState {
  phase: 'idle' | 'checking' | 'downloading' | 'verifying' | 'extracting' | 'ready' | 'failed' | 'cancelled'
  supported: boolean
  version: string
  directory: string
  source: string
  completedBytes: number
  totalBytes?: number | undefined
  error?: string | undefined
}

/**
 * Locate the versioned, plugin-owned executable without consulting PATH.
 * @param options - Resolved download configuration.
 * @returns Absolute code-server executable path.
 */
export function installedExecutable(options: SetupOptions): string {
  return path.join(options.installDir, options.downloadVersion, 'bin', 'code-server')
}

/**
 * Own a cancellable installation triggered exclusively by settings actions.
 * @param options - Resolved install directory, source and version.
 * @returns Preparation controls; dispose cancels and drains all filesystem work.
 */
export function createEditorSetup(options: SetupOptions) {
  const supported = ['linux', 'darwin'].includes(process.platform) && ['x64', 'arm64'].includes(process.arch)
  let state: SetupState = {
    phase: 'idle', supported, version: options.downloadVersion, directory: options.installDir,
    source: options.downloadBaseUrl, completedBytes: 0,
  }
  let task: Promise<void> | undefined
  let controller: AbortController | undefined
  let disposed = false

  async function install(signal: AbortSignal): Promise<void> {
    if (!supported) throw new Error('Managed download supports Linux and macOS x64/arm64; use WSL or an external service on Windows')
    if (await access(installedExecutable(options)).then(() => true, () => false)) {
      await checkEditorVersion(installedExecutable(options), options.startupTimeoutMs)
      state = { ...state, phase: 'ready' }
      return
    }
    const os = process.platform === 'darwin' ? 'macos' : 'linux'
    const arch = process.arch === 'x64' ? 'amd64' : 'arm64'
    const assetName = `code-server-${options.downloadVersion}-${os}-${arch}.tar.gz`
    // The digest always comes from the publisher, including when an archive mirror is configured.
    const release = await fetch(`https://api.github.com/repos/coder/code-server/releases/tags/v${options.downloadVersion}`, { signal })
    if (!release.ok) throw new Error(`Release metadata: HTTP ${release.status}`)
    const metadata: unknown = await release.json()
    if (typeof metadata !== 'object' || metadata === null || !('assets' in metadata) || !Array.isArray(metadata.assets)) {
      throw new Error('Invalid code-server release metadata')
    }
    const asset: unknown = metadata.assets.find((item: unknown) => typeof item === 'object' && item !== null && 'name' in item && item.name === assetName)
    if (typeof asset !== 'object' || asset === null || !('digest' in asset) || typeof asset.digest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error(`Missing publisher SHA-256 digest for ${assetName}`)
    await mkdir(options.installDir, { recursive: true })
    const scratch = await mkdtemp(path.join(options.installDir, `.download-${randomUUID()}-`))
    try {
      state = { ...state, phase: 'downloading' }
      const response = await fetch(`${options.downloadBaseUrl}/v${options.downloadVersion}/${assetName}`, { signal })
      if (!response.ok || !response.body) throw new Error(`Download ${assetName}: HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length'))
      if (total > 0) state = { ...state, totalBytes: total }
      const digest = createHash('sha256')
      const archive = path.join(scratch, 'archive.tar.gz')
      await pipeline(Readable.from(downloadChunks(response.body)), new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          digest.update(chunk)
          state = { ...state, completedBytes: state.completedBytes + chunk.length }
          callback(null, chunk)
        },
      }), createWriteStream(archive, { flags: 'wx' }), { signal })
      state = { ...state, phase: 'verifying' }
      if (`sha256:${digest.digest('hex')}` !== asset.digest) throw new Error(`SHA-256 mismatch for ${assetName}`)
      signal.throwIfAborted()
      state = { ...state, phase: 'extracting' }
      const unpacked = path.join(scratch, 'unpacked')
      await mkdir(unpacked)
      await x({ file: archive, cwd: unpacked, strip: 1, strict: true, preservePaths: false })
      signal.throwIfAborted()
      await checkEditorVersion(path.join(unpacked, 'bin', 'code-server'), options.startupTimeoutMs)
      signal.throwIfAborted()
      await rename(unpacked, path.join(options.installDir, options.downloadVersion))
      state = { ...state, phase: 'ready' }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  return {
    snapshot(): SetupState { return state },
    start(): void {
      if (disposed || task || state.phase === 'ready') return
      controller = new AbortController()
      const signal = controller.signal
      state = { ...state, phase: 'checking', completedBytes: 0, totalBytes: undefined, error: undefined }
      task = install(signal).catch((error: unknown) => {
        state = { ...state, phase: signal.aborted ? 'cancelled' : 'failed', error: String(error) }
      }).finally(() => { task = undefined })
    },
    cancel(): void { controller?.abort() },
    async dispose(): Promise<void> { disposed = true; controller?.abort(); await task },
  }
}

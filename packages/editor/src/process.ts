import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Configuration required to start one managed editor process. */
export interface ManagedOptions {
  binary: string
  stateDir: string
  extensionDir: string
  startupTimeoutMs: number
}

/** A managed editor and its private state lock. */
export interface ManagedEditor {
  upstream: string
  dispose(): Promise<void>
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

async function lock(stateDir: string): Promise<() => Promise<void>> {
  await mkdir(stateDir, { recursive: true })
  const file = path.join(stateDir, 'owner.lock')
  const guard = path.join(stateDir, 'owner.lock.reclaim')
  const owner = { pid: process.pid, startTime: Date.now(), id: randomUUID() }
  let acquired = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(guard)
      acquired = true
      break
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      await delay(20)
    }
  }
  if (!acquired) throw new Error(`Editor lock recovery is busy: ${guard}`)
  try {
    let handle
    try {
      handle = await open(file, 'wx', 0o600)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      const current: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (typeof current !== 'object' || current === null || !('pid' in current)
        || typeof current.pid !== 'number' || !Number.isSafeInteger(current.pid) || current.pid <= 0) {
        throw new Error(`Invalid editor lock: ${file}`)
      }
      if (running(current.pid)) throw new Error(`Editor state is owned by process ${current.pid}`)
      await cleanStaleBridges(path.join(stateDir, 'bridges'))
      await rm(file)
      handle = await open(file, 'wx', 0o600)
    }
    try {
      await handle.writeFile(JSON.stringify(owner))
    } finally {
      await handle.close()
    }
    const actual: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof actual !== 'object' || actual === null || !('id' in actual) || actual.id !== owner.id) {
      throw new Error(`Editor lock ownership changed: ${file}`)
    }
    return async () => {
      let contents: string
      try {
        contents = await readFile(file, 'utf8')
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
        throw error
      }
      const current: unknown = JSON.parse(contents)
      if (typeof current === 'object' && current !== null && 'id' in current && current.id === owner.id) await rm(file)
    }
  } finally {
    await rm(guard, { recursive: true, force: true })
  }
}

async function cleanStaleBridges(directory: string): Promise<void> {
  let files: string[]
  try {
    files = await readdir(directory)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  for (const name of files) {
    if (!name.endsWith('.json')) continue
    const file = path.join(directory, name)
    let record: unknown
    try {
      record = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) continue
      throw error
    }
    if (typeof record !== 'object' || record === null || !('pid' in record)
      || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) continue
    if (!running(record.pid)) await rm(file, { force: true })
  }
}

async function version(binary: string, timeout: number): Promise<void> {
  const child = spawn(binary, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', (data: Buffer) => { output += data.toString() })
  const result = await new Promise<number | null>((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeout)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error('code-server version check timed out'))
      else resolve(code)
    })
  })
  if (result !== 0) throw new Error(`code-server version check failed: ${result}`)
  const match = output.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/)
  if (!match || Number(match[1]) !== 4 || Number(match[2]) < 90) throw new Error(`Unsupported code-server version: ${output.trim()}`)
}

async function prepare(options: ManagedOptions): Promise<void> {
  const user = path.join(options.stateDir, 'user-data', 'User')
  const extensions = path.join(options.stateDir, 'extensions')
  const bridges = path.join(options.stateDir, 'bridges')
  await Promise.all([
    mkdir(user, { recursive: true }),
    mkdir(extensions, { recursive: true }),
    mkdir(bridges, { recursive: true, mode: 0o700 }),
  ])
  const settings = path.join(user, 'settings.json')
  try {
    await writeFile(settings, JSON.stringify({
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'files.watcherExclude': { '**/.git/objects/**': true, '**/node_modules/**': true },
    }, null, 2), { flag: 'wx' })
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
  }
  const destination = path.join(extensions, 'amadeus-bridge')
  const temporary = path.join(extensions, `.amadeus-bridge-${randomUUID()}`)
  const backup = path.join(extensions, `.amadeus-bridge-backup-${randomUUID()}`)
  await cp(options.extensionDir, temporary, { recursive: true, errorOnExist: true })
  let hadPrevious = false
  try {
    try {
      await rename(destination, backup)
      hadPrevious = true
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    try {
      await rename(temporary, destination)
    } catch (error) {
      if (hadPrevious) await rename(backup, destination)
      throw error
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  if (hadPrevious) await rm(backup, { recursive: true, force: true })
}

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return
    const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => {
      taskkill.once('error', reject)
      taskkill.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`taskkill failed: ${code}`))
      })
    })
    if (isChildRunning(child)) {
      await Promise.race([
        new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) }),
        delay(2000).then(() => { throw new Error('code-server did not exit after taskkill') }),
      ])
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
    return
  }
  await delay(2000)
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
  }
  if (isChildRunning(child)) {
    await Promise.race([
      new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) }),
      delay(2000).then(() => { throw new Error('code-server did not exit after SIGKILL') }),
    ])
  }
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

/**
 * Start a managed code-server with an exclusive persistent state directory.
 * @param options - Process paths and startup timeout.
 * @returns Ready upstream and an async disposer.
 */
export async function startManagedEditor(options: ManagedOptions): Promise<ManagedEditor> {
  const release = await lock(options.stateDir)
  let child: ChildProcess | undefined
  try {
    await cleanStaleBridges(path.join(options.stateDir, 'bridges'))
    await version(options.binary, options.startupTimeoutMs)
    await prepare(options)
    child = spawn(options.binary, [
      '--bind-addr', '127.0.0.1:0', '--auth', 'none', '--disable-telemetry', '--disable-update-check',
      '--disable-workspace-trust', '--user-data-dir', path.join(options.stateDir, 'user-data'),
      '--extensions-dir', path.join(options.stateDir, 'extensions'),
    ], {
      env: { ...process.env, AMADEUS_BRIDGE_DIR: path.join(options.stateDir, 'bridges'), VSCODE_RECONNECTION_GRACE_TIME: '5000' },
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    })
    const current = child
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('code-server startup timed out')) }, options.startupTimeoutMs)
      let output = ''
      const inspect = (chunk: Buffer): void => {
        output += chunk.toString()
        const match = output.match(/https?:\/\/127\.0\.0\.1:(\d+)/)
        if (!match) return
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
      current.stdout?.on('data', inspect)
      current.stderr?.on('data', inspect)
      current.once('error', (error) => { clearTimeout(timer); reject(error) })
      current.once('exit', (code) => { clearTimeout(timer); reject(new Error(`code-server exited during startup: ${code}`)) })
    })
    const upstream = `http://127.0.0.1:${port}`
    const deadline = Date.now() + options.startupTimeoutMs
    while (true) {
      try {
        await fetch(upstream, { signal: AbortSignal.timeout(1000) })
        break
      } catch (error) {
        if (Date.now() >= deadline || current.exitCode !== null) throw error
        await delay(50)
      }
    }
    let disposed = false
    return {
      upstream,
      async dispose() {
        if (disposed) return
        await terminate(current)
        await cleanStaleBridges(path.join(options.stateDir, 'bridges'))
        await release()
        disposed = true
      },
    }
  } catch (error) {
    if (child) {
      await terminate(child)
      await cleanStaleBridges(path.join(options.stateDir, 'bridges'))
    }
    await release()
    throw error
  }
}

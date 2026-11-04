import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { startManagedEditor } from '../src/process.ts'

const run = promisify(execFile)
const compilerAvailable = spawnSync('gcc', ['--version'], { stdio: 'ignore' }).status === 0

it.skipIf(!compilerAvailable)('waits for the timed-out version process to terminate before releasing its lock', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'editor-version-'))
  const source = path.join(base, 'fixture.c')
  const executable = path.join(base, process.platform === 'win32' ? 'fixture.exe' : 'fixture')
  const pidFile = path.join(base, 'pid.txt')
  const normalizedPidFile = pidFile.replace(/\\/g, '/')
  try {
    await writeFile(source, `
#include <stdio.h>
#ifdef _WIN32
#include <windows.h>
#include <process.h>
#define GETPID _getpid
#else
#include <unistd.h>
#define GETPID getpid
#endif
int main(void) {
  FILE *file = fopen("${normalizedPidFile}", "w");
  if (!file) return 1;
  fprintf(file, "%d", GETPID());
  fclose(file);
#ifdef _WIN32
  Sleep(30000);
#else
  sleep(30);
#endif
  return 0;
}
`)
    await run('gcc', [source, '-o', executable])
    await expect(startManagedEditor({
      binary: executable, stateDir: path.join(base, 'state'), extensionDir: base, startupTimeoutMs: 1000,
    })).rejects.toThrow('version check timed out')
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
    await expect(readFile(path.join(base, 'state', 'owner.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}, 30000)

it.skipIf(!compilerAvailable)('removes dead bridge registrations after the managed process exits', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'editor-managed-'))
  const source = path.join(base, 'fixture.c')
  const script = path.join(base, 'fixture.cjs')
  const extension = path.join(base, 'extension')
  const executable = path.join(base, process.platform === 'win32' ? 'fixture.exe' : 'fixture')
  const cPath = (value: string): string => value.replace(/\\/g, '/').replace(/"/g, '\\"')
  try {
    await mkdir(extension)
    await writeFile(path.join(extension, 'package.json'), '{}')
    await writeFile(script, `
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
fs.writeFileSync(path.join(process.env.AMADEUS_BRIDGE_DIR, 'owned.json'), JSON.stringify({ pid: process.pid }))
http.createServer((req, res) => res.end('ok')).listen(0, '127.0.0.1', function () {
  process.stdout.write('http://127.0.0.1:' + this.address().port + '\\n')
})
`)
    await writeFile(source, `
#include <stdio.h>
#include <string.h>
#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
#endif
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--version") == 0) { puts("4.100.0"); return 0; }
#ifdef _WIN32
  return _spawnl(_P_WAIT, "${cPath(process.execPath)}", "\\"${cPath(process.execPath)}\\"", "\\"${cPath(script)}\\"", NULL);
#else
  execl("${cPath(process.execPath)}", "${cPath(process.execPath)}", "${cPath(script)}", (char *)0);
  return 1;
#endif
}
`)
    await run('gcc', [source, '-o', executable])
    const stateDir = path.join(base, 'state')
    const editor = await startManagedEditor({ binary: executable, stateDir, extensionDir: extension, startupTimeoutMs: 5000 })
    const settings: unknown = JSON.parse(await readFile(path.join(stateDir, 'user-data', 'User', 'settings.json'), 'utf8'))
    expect(settings).toMatchObject({ 'workbench.secondarySideBar.defaultVisibility': 'hidden' })
    const registration = path.join(stateDir, 'bridges', 'owned.json')
    const record: unknown = JSON.parse(await readFile(registration, 'utf8'))
    if (typeof record !== 'object' || record === null || !('pid' in record) || typeof record.pid !== 'number') {
      throw new Error('Missing extension process PID')
    }
    const pid = record.pid
    await editor.dispose()
    expect(() => process.kill(pid, 0)).toThrow()
    await expect(readFile(registration)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(stateDir, 'owner.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}, 30000)

it('releases its state lock when the executable is missing', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'editor-process-'))
  try {
    await expect(startManagedEditor({
      binary: path.join(base, 'missing'),
      stateDir: path.join(base, 'state'),
      extensionDir: path.join(base, 'extension'),
      startupTimeoutMs: 1000,
    })).rejects.toThrow()
    await expect(readFile(path.join(base, 'state', 'owner.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

it('cleans stale registrations at startup even without a stale owner lock', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'editor-stale-'))
  const bridges = path.join(base, 'bridges')
  try {
    await mkdir(bridges)
    await writeFile(path.join(bridges, 'dead.json'), JSON.stringify({ pid: 2147483647 }))
    await expect(startManagedEditor({
      binary: path.join(base, 'missing'), stateDir: base, extensionDir: base, startupTimeoutMs: 1000,
    })).rejects.toThrow()
    await expect(readFile(path.join(bridges, 'dead.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

it('refuses a state directory locked by a running process', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'editor-process-'))
  try {
    const file = path.join(base, 'owner.lock')
    await writeFile(file, JSON.stringify({ pid: process.pid, startTime: Date.now() }))
    await expect(startManagedEditor({
      binary: path.join(base, 'missing'), stateDir: base, extensionDir: base, startupTimeoutMs: 1000,
    })).rejects.toThrow('owned')
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ pid: process.pid })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

it('reclaims a dead owner and removes only dead bridge registrations', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'editor-process-'))
  try {
    const file = path.join(base, 'owner.lock')
    const bridges = path.join(base, 'bridges')
    await mkdir(bridges)
    await writeFile(file, JSON.stringify({ pid: 2147483647, startTime: 1 }))
    await writeFile(path.join(bridges, 'dead.json'), JSON.stringify({ pid: 2147483647 }))
    await writeFile(path.join(bridges, 'live.json'), JSON.stringify({ pid: process.pid }))
    await expect(startManagedEditor({
      binary: path.join(base, 'missing'), stateDir: base, extensionDir: base, startupTimeoutMs: 1000,
    })).rejects.toThrow()
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(bridges, 'dead.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(path.join(bridges, 'live.json'), 'utf8'))).toMatchObject({ pid: process.pid })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

/** Repository file discovery and gate reporting shared by the documentation gates. */

import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Absolute path of the repository root. */
export const repoRoot = resolve(import.meta.dirname, '..', '..')

/** One located rule violation, reported as `file:line: message`. */
export interface Violation {
  /** Repository-relative path with forward slashes. */
  file: string
  /** 1-based line number. */
  line: number
  message: string
}

/**
 * List tracked and untracked-but-not-ignored regular files; symlinks are skipped so a linked directory is scanned once at its target.
 * @param root - repository root to list.
 * @param include - predicate over repository-relative paths.
 * @returns matching repository-relative paths in `git ls-files` order.
 */
export function listRepoFiles(root: string, include: (file: string) => boolean): string[] {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  const files = [...new Set(output.split('\0').filter(file => file !== ''))]
  return files.filter((file) => {
    if (!include(file)) return false
    try {
      return lstatSync(resolve(root, file)).isFile()
    } catch (_error) {
      // A file staged for deletion is still listed by `--cached` but no longer exists on disk.
      return false
    }
  })
}

/**
 * Whether the current process was started with this module as its entry script.
 * @param moduleUrl - the caller's `import.meta.url`.
 * @returns true when the module runs as a CLI rather than being imported by a spec.
 */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1]
  return entry !== undefined && moduleUrl === pathToFileURL(resolve(entry)).href
}

/**
 * Print a gate's result and set a failing exit code when it found violations.
 * @param gate - gate name used in the summary line.
 * @param checked - number of files the gate inspected.
 * @param violations - every violation found.
 */
export function reportGate(gate: string, checked: number, violations: readonly Violation[]): void {
  if (checked === 0) {
    console.error(`${gate}: no files matched; the gate's file patterns are stale.`)
    process.exitCode = 1
    return
  }
  for (const violation of violations) console.error(`${violation.file}:${violation.line}: ${violation.message}`)
  if (violations.length > 0) {
    console.error(`${gate}: ${violations.length} violation(s) in ${checked} file(s).`)
    process.exitCode = 1
    return
  }
  console.log(`${gate}: ${checked} file(s) OK.`)
}

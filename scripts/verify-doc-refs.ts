/**
 * Verify that repository-root documentation paths cited in package source (`docs/….md`, `.agents/notes/….md`) exist.
 * Built output under `lib/` and declaration files are not scanned.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isMain, listRepoFiles, reportGate, repoRoot, type Violation } from './lib/repo.ts'

const DOC_REF = /(?:\bdocs|\.agents\/notes)\/[A-Za-z0-9._/一-鿿-]+\.md/g

/**
 * Find cited documentation paths that do not exist.
 * @param file - repository-relative path of the source file.
 * @param source - complete source text.
 * @param exists - whether a repository-relative path exists.
 * @returns one violation per missing cited path.
 */
export function findDocRefViolations(file: string, source: string, exists: (path: string) => boolean): Violation[] {
  const violations: Violation[] = []
  source.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(DOC_REF)) {
      if (!exists(match[0])) violations.push({ file, line: index + 1, message: `cited documentation path "${match[0]}" does not exist` })
    }
  })
  return violations
}

function main(): void {
  const files = listRepoFiles(repoRoot, file => /^packages\/[^/]+\/src\/.+\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
  const violations = files.flatMap(file => findDocRefViolations(file, readFileSync(resolve(repoRoot, file), 'utf8'), path => existsSync(resolve(repoRoot, path))))
  reportGate('verify-doc-refs', files.length, violations)
}

if (isMain(import.meta.url)) main()

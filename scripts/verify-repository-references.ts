/**
 * Reject maintained files that cite a commit of this repository by its hash. History is cited by tag or by the commit's
 * description; a hash ties prose to one clone's object store and survives no history rewrite.
 * A hex token counts only when it is 7 to 40 characters long and is a prefix of exactly one known commit, so digests and other hex
 * values pass.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isMain, listRepoFiles, reportGate, repoRoot, type Violation } from './lib/repo.ts'

const HEX_TOKEN = /(?<![0-9a-z])[0-9a-f]{7,40}(?![0-9a-z])/gi

/** Generated or binary files whose hex content is not authored prose. */
const EXCLUDED = new Set(['pnpm-lock.yaml'])

/**
 * Find lines citing a known commit.
 * @param file - repository-relative path.
 * @param source - complete file text.
 * @param commits - full lowercase commit ids of this repository.
 * @returns one violation per line that cites a commit.
 */
export function findCommitReferences(file: string, source: string, commits: readonly string[]): Violation[] {
  const violations: Violation[] = []
  source.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(HEX_TOKEN)) {
      const token = match[0].toLowerCase()
      const matching = commits.filter(commit => commit.startsWith(token))
      if (matching.length === 1) {
        violations.push({ file, line: index + 1, message: `"${match[0]}" names a repository commit; cite a tag or the commit's description instead` })
        return
      }
    }
  })
  return violations
}

function main(): void {
  const commits = execFileSync('git', ['rev-list', '--all'], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(id => id !== '')
  const files = listRepoFiles(repoRoot, file => !EXCLUDED.has(file) && /\.(md|ts|tsx|json|ya?ml)$/.test(file))
  const violations = files.flatMap(file => findCommitReferences(file, readFileSync(resolve(repoRoot, file), 'utf8'), commits))
  reportGate('verify-repository-references', files.length, violations)
}

if (isMain(import.meta.url)) main()

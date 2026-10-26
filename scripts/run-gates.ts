/**
 * Run one named group of gates, each as its own process, and fail when any gate fails. Every gate in the group runs even after a
 * failure, so one run reports all violations. Usage: `node scripts/run-gates.ts <doc-sync | hygiene>`.
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { repoRoot } from './lib/repo.ts'

const GROUPS: Readonly<Record<string, readonly string[]>> = {
  'doc-sync': [
    'verify-md-wrap',
    'verify-md-links',
    'verify-doc-refs',
    'verify-repository-references',
    'verify-agent-notes',
    'verify-skill-metadata',
    'verify-export-jsdoc',
    'verify-doc-budgets',
    'verify-client-ui-i18n',
    'verify-package-readme-limitations',
    'verify-package-readme-model-experience',
  ],
  'hygiene': [
    'verify-no-unknown-casts',
    'verify-package-meta',
  ],
}

const group = process.argv[2] ?? ''
const gates = GROUPS[group]
if (gates === undefined) {
  console.error(`run-gates: expected one of ${Object.keys(GROUPS).join(', ')}, got "${group}"`)
  process.exit(2)
}

const failed = gates.filter((gate) => {
  const result = spawnSync(process.execPath, [resolve(repoRoot, 'scripts', `${gate}.ts`)], { cwd: repoRoot, stdio: 'inherit' })
  return result.status !== 0
})

if (failed.length > 0) {
  console.error(`${group}: ${failed.length} of ${gates.length} gate(s) failed: ${failed.join(', ')}`)
  process.exitCode = 1
} else {
  console.log(`${group}: all ${gates.length} gates passed.`)
}

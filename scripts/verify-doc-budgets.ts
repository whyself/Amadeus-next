/**
 * Enforce the length ceilings in `scripts/doc-budgets.manifest.json` for standing documents. A listed file that is missing fails, so
 * a rename cannot silently drop its budget. The owning rule is "字数预算" in `docs/AGENTS.md`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isMain, reportGate, repoRoot, type Violation } from './lib/repo.ts'

const CJK = /[㐀-鿿豈-﫿]/g
const CJK_AND_FULLWIDTH_PUNCTUATION = /[㐀-鿿豈-﫿　-〿＀-￯]/g

/**
 * Length of a mixed Chinese and English text: each CJK character counts as one unit, and each remaining whitespace-delimited token
 * counts as one unit, so English passages count like `wc -w`.
 * @param text - complete document text.
 * @returns the number of counting units.
 */
export function countUnits(text: string): number {
  const characters = text.match(CJK)?.length ?? 0
  const words = text.replace(CJK_AND_FULLWIDTH_PUNCTUATION, ' ').split(/\s+/).filter(token => token !== '').length
  return characters + words
}

/**
 * Compare budgeted files against their ceilings.
 * @param budgets - repository-relative path to ceiling.
 * @param read - text of a repository-relative path, or null when it does not exist.
 * @returns one violation per missing file or file over its ceiling.
 */
export function findBudgetViolations(budgets: Readonly<Record<string, number>>, read: (file: string) => string | null): Violation[] {
  const violations: Violation[] = []
  for (const [file, ceiling] of Object.entries(budgets)) {
    const text = read(file)
    if (text === null) {
      violations.push({ file, line: 1, message: 'budgeted file is missing; update scripts/doc-budgets.manifest.json' })
      continue
    }
    const units = countUnits(text)
    if (units > ceiling) {
      violations.push({ file, line: 1, message: `${units} units exceeds the ${ceiling}-unit ceiling; relocate or condense per docs/AGENTS.md` })
    }
  }
  return violations
}

function main(): void {
  const manifest: unknown = JSON.parse(readFileSync(resolve(repoRoot, 'scripts/doc-budgets.manifest.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) throw new Error('doc-budgets.manifest.json must be an object')
  const budgets: Record<string, number> = {}
  for (const [file, ceiling] of Object.entries(manifest)) {
    if (typeof ceiling !== 'number') throw new Error(`doc-budgets.manifest.json: ceiling for ${file} must be a number`)
    budgets[file] = ceiling
  }
  const read = (file: string): string | null => {
    const path = resolve(repoRoot, file)
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }
  const violations = findBudgetViolations(budgets, read)
  for (const [file, ceiling] of Object.entries(budgets)) {
    const text = read(file)
    if (text !== null) console.log(`${String(countUnits(text)).padStart(6)} / ${String(ceiling).padEnd(6)} ${file}`)
  }
  reportGate('verify-doc-budgets', Object.keys(budgets).length, violations)
}

if (isMain(import.meta.url)) main()

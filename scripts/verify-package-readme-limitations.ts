/**
 * Require every package (`packages/<name>/package.json`) to have a sibling `README.md` with exactly one `## 已知限制与延期工作`
 * section containing at least one top-level `- ` bullet. Packages audited as having no limitations are listed in
 * `NO_LIMITATIONS` with a reason and must omit the section. The owning rule is the package README row in `docs/AGENTS.md`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isMain, listRepoFiles, reportGate, repoRoot, type Violation } from './lib/repo.ts'

/** The one canonical section heading, required verbatim as an h2. */
export const CANONICAL = '## 已知限制与延期工作'

/** Packages audited as having no limitations section, keyed by repository-relative directory, with the reason. */
const NO_LIMITATIONS: Readonly<Record<string, string>> = {}

function isLimitationsLike(heading: string): boolean {
  return /限制|延期|推迟|非目标|limitations?|deferred|non-goals?/i.test(heading)
}

/**
 * Check one package README's limitations section.
 * @param readme - repository-relative README path used in violations.
 * @param source - README text, or null when the package has no README.
 * @param exempt - whether the package is audited as having no limitations.
 * @returns every missing, duplicated, non-canonical, or empty limitations section.
 */
export function findLimitationViolations(readme: string, source: string | null, exempt: boolean): Violation[] {
  if (source === null) return [{ file: readme, line: 1, message: `package has no README.md with the "${CANONICAL}" section` }]
  const lines = source.split('\n')
  const headings: { index: number; depth: number; raw: string; text: string }[] = []
  let inFence = false
  lines.forEach((raw, index) => {
    if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence
    const match = !inFence && /^(#{1,6})\s+(.*?)\s*$/.exec(raw)
    if (match && match[1] !== undefined && match[2] !== undefined) {
      headings.push({ index, depth: match[1].length, raw: raw.trimEnd(), text: match[2] })
    }
  })
  const limitations = headings.filter(heading => isLimitationsLike(heading.text))
  if (exempt) {
    return limitations.map(heading => ({ file: readme, line: heading.index + 1, message: 'listed in NO_LIMITATIONS but carries a limitations section; drop the section or the allowlist entry' }))
  }
  const [heading, ...extra] = limitations
  if (heading === undefined) {
    return [{ file: readme, line: 1, message: `missing the "${CANONICAL}" section; a package with genuinely nothing to declare joins NO_LIMITATIONS instead` }]
  }
  if (extra.length > 0) return [{ file: readme, line: heading.index + 1, message: `keep exactly one "${CANONICAL}" section` }]
  if (heading.depth !== 2 || heading.raw !== CANONICAL) {
    return [{ file: readme, line: heading.index + 1, message: `non-canonical heading "${heading.raw}"; use "${CANONICAL}"` }]
  }
  const next = headings.find(entry => entry.index > heading.index)
  const body = lines.slice(heading.index + 1, next === undefined ? lines.length : next.index)
  if (!body.some(line => line.startsWith('- '))) {
    return [{ file: readme, line: heading.index + 1, message: 'the section has no top-level "- " bullet; state the limitations, or add the package to NO_LIMITATIONS' }]
  }
  return []
}

function main(): void {
  const packages = listRepoFiles(repoRoot, file => /^packages\/[^/]+\/package\.json$/.test(file)).map(file => file.slice(0, -'/package.json'.length))
  const violations: Violation[] = []
  for (const [entry, reason] of Object.entries(NO_LIMITATIONS)) {
    if (!packages.includes(entry)) violations.push({ file: 'scripts/verify-package-readme-limitations.ts', line: 1, message: `NO_LIMITATIONS entry ${entry} names no package` })
    if (reason.trim() === '') violations.push({ file: 'scripts/verify-package-readme-limitations.ts', line: 1, message: `NO_LIMITATIONS entry ${entry} has no reason` })
  }
  for (const pkg of packages) {
    const readme = `${pkg}/README.md`
    const path = resolve(repoRoot, readme)
    violations.push(...findLimitationViolations(readme, existsSync(path) ? readFileSync(path, 'utf8') : null, Object.hasOwn(NO_LIMITATIONS, pkg)))
  }
  reportGate('verify-package-readme-limitations', packages.length, violations)
}

if (isMain(import.meta.url)) main()

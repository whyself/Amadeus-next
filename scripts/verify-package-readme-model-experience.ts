/**
 * Require every package README (`packages/<name>/README.md`) to declare what the package puts in front of the model, in one
 * `## 模型体验` section placed immediately before `## 已知限制与延期工作` (or last, when the package has no limitations section).
 * The section takes one of two forms:
 * - entries: one or more `### <请求上下文与条件>` entries, each with the fields `#### 模型看到什么`, `#### Token 影响` and
 *   `#### KV Cache 影响` in that order; every field has prose, and a field without an effect says `无，因为……。`;
 * - short: one paragraph `无，因为……。` (no model-visible effect) or `间接，通过……。` (the effect reaches the model only through
 *   another package).
 * A bare "无" is rejected everywhere. The owning rule is "包 README" in `docs/AGENTS.md`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isMain, listRepoFiles, reportGate, repoRoot, type Violation } from './lib/repo.ts'

/** The section heading, required verbatim as an h2. */
export const MODEL_EXPERIENCE = '## 模型体验'
const LIMITATIONS = '## 已知限制与延期工作'
const FIELDS = ['#### 模型看到什么', '#### Token 影响', '#### KV Cache 影响']
const SHORT_FORM = /^(?:无，因为|间接，通过).+。$/
const BARE_NONE = /^(?:无|没有|none)[。.]?$/i

interface Line {
  index: number
  raw: string
}

function proseLines(source: string): Line[] {
  const lines: Line[] = []
  let inFence = false
  source.split('\n').forEach((raw, index) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence
      return
    }
    if (!inFence) lines.push({ index, raw: raw.trimEnd() })
  })
  return lines
}

/**
 * Check one package README's model experience section.
 * @param readme - repository-relative README path used in violations.
 * @param source - README text, or null when the package has no README.
 * @returns every missing, misplaced, or malformed part of the section.
 */
export function findModelExperienceViolations(readme: string, source: string | null): Violation[] {
  if (source === null) return [{ file: readme, line: 1, message: `package has no README.md with the "${MODEL_EXPERIENCE}" section` }]
  const report = (index: number, message: string): Violation => ({ file: readme, line: index + 1, message })
  const lines = proseLines(source)
  const h2 = lines.filter(line => /^## /.test(line.raw))
  const sections = h2.filter(line => line.raw === MODEL_EXPERIENCE)
  const [section, ...extra] = sections
  if (section === undefined) return [report(0, `missing the "${MODEL_EXPERIENCE}" section; write "无，因为……。" when the package adds nothing to model requests`)]
  if (extra.length > 0) return [report(section.index, `keep exactly one "${MODEL_EXPERIENCE}" section`)]
  const next = h2.find(line => line.index > section.index)
  if (next !== undefined && next.raw !== LIMITATIONS) {
    return [report(section.index, `"${MODEL_EXPERIENCE}" must be followed only by "${LIMITATIONS}"`)]
  }
  if (next !== undefined && h2.some(line => line.index > next.index)) {
    return [report(next.index, `"${LIMITATIONS}" must be the last section`)]
  }
  const body = lines.filter(line => line.index > section.index && (next === undefined || line.index < next.index) && line.raw !== '')
  const entries = body.filter(line => /^### /.test(line.raw))
  if (entries.length === 0) {
    const [first, ...rest] = body
    if (first === undefined || rest.length > 0 || !SHORT_FORM.test(first.raw)) {
      return [report(section.index, 'without "### " entries the section must be one paragraph "无，因为……。" or "间接，通过……。"')]
    }
    return []
  }
  const violations: Violation[] = []
  if (body[0] !== entries[0]) violations.push(report(section.index, 'put every model-visible effect under a "### <请求上下文与条件>" entry'))
  entries.forEach((entry, position) => {
    const end = entries[position + 1]?.index ?? Number.POSITIVE_INFINITY
    const entryBody = body.filter(line => line.index > entry.index && line.index < end)
    const fields = entryBody.filter(line => /^#### /.test(line.raw))
    if (fields.map(field => field.raw).join('|') !== FIELDS.join('|')) {
      violations.push(report(entry.index, `"${entry.raw}" must have exactly the fields ${FIELDS.join(', ')} in this order`))
      return
    }
    fields.forEach((field, fieldPosition) => {
      const fieldEnd = fields[fieldPosition + 1]?.index ?? end
      const prose = entryBody.filter(line => line.index > field.index && line.index < fieldEnd && !/^#/.test(line.raw))
      if (prose.length === 0) violations.push(report(field.index, `"${field.raw}" has no content; write "无，因为……。" when there is no effect`))
      else if (prose.length === 1 && prose[0] !== undefined && BARE_NONE.test(prose[0].raw)) {
        violations.push(report(prose[0].index, `state why "${field.raw}" has no effect: "无，因为……。"`))
      }
    })
  })
  return violations
}

function main(): void {
  const packages = listRepoFiles(repoRoot, file => /^packages\/[^/]+\/package\.json$/.test(file)).map(file => file.slice(0, -'/package.json'.length))
  const violations = packages.flatMap((pkg) => {
    const readme = `${pkg}/README.md`
    const path = resolve(repoRoot, readme)
    return findModelExperienceViolations(readme, existsSync(path) ? readFileSync(path, 'utf8') : null)
  })
  reportGate('verify-package-readme-model-experience', packages.length, violations)
}

if (isMain(import.meta.url)) main()

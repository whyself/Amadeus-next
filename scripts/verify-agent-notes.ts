/**
 * Enforce the Agent Note path and in-file format defined in `.agents/notes/README.md`: `{lifecycle}/{class}/yyyy-mm-dd-topic.md`,
 * the header block, a `Status:` matching the lifecycle folder, and the required sections of each lifecycle.
 * `README.md` and `AGENTS.md` files inside the tree are rule files, not notes.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isMain, listRepoFiles, reportGate, repoRoot, type Violation } from './lib/repo.ts'

const NOTES_ROOT = '.agents/notes/'
const LIFECYCLES = ['proposed', 'implemented', 'rejected'] as const
const CLASSES = new Set(['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'])
const FILE_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

/** Sections every note of a lifecycle must contain, in order. */
const REQUIRED_SECTIONS: Record<Lifecycle, readonly string[]> = {
  proposed: ['问题', '提案', '考虑过的替代方案', '验收标准', '风险'],
  implemented: ['问题', '决策', '考虑过的替代方案', '后果'],
  rejected: ['问题', '提案', '考虑过的替代方案'],
}

/** Proposal-era sections that an implemented note must not carry. */
const IMPLEMENTED_FORBIDDEN = ['提案', '计划', '迁移计划', '验收标准']

type Lifecycle = typeof LIFECYCLES[number]

function isLifecycle(value: string): value is Lifecycle {
  return (LIFECYCLES as readonly string[]).includes(value)
}

/**
 * Whether a repository-relative path is an Agent Note rather than a rule file in the notes tree.
 * @param file - repository-relative path.
 * @returns true for Markdown files under `.agents/notes/` other than `README.md` and `AGENTS.md`.
 */
export function isAgentNote(file: string): boolean {
  if (!file.startsWith(NOTES_ROOT) || !file.endsWith('.md')) return false
  const base = file.slice(file.lastIndexOf('/') + 1)
  return base !== 'README.md' && base !== 'AGENTS.md'
}

/**
 * Check one Agent Note's path and format.
 * @param file - repository-relative path under `.agents/notes/`.
 * @param source - complete note text.
 * @returns every path, header, status, and section violation.
 */
export function findAgentNoteViolations(file: string, source: string): Violation[] {
  const violations: Violation[] = []
  const report = (line: number, message: string): void => {
    violations.push({ file, line, message })
  }
  const segments = file.slice(NOTES_ROOT.length).split('/')
  const [lifecycle, noteClass, name] = segments
  if (segments.length !== 3 || lifecycle === undefined || noteClass === undefined || name === undefined) {
    report(1, 'Agent Note path must be .agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md')
    return violations
  }
  if (!isLifecycle(lifecycle)) report(1, `unknown lifecycle folder "${lifecycle}"; expected ${LIFECYCLES.join(', ')}`)
  if (!CLASSES.has(noteClass)) report(1, `unknown class folder "${noteClass}"; expected ${[...CLASSES].join(', ')}`)
  if (!FILE_NAME.test(name)) report(1, 'file name must be yyyy-mm-dd-topic.md with the topic in lowercase English kebab-case')

  const lines = source.split('\n')
  if (!(lines[0] ?? '').startsWith('# Agent Note: ')) report(1, 'first line must be "# Agent Note: <title>"')
  if (lines[1] !== '') report(2, 'second line must be blank')
  const status = lines[2] ?? ''
  if (!status.startsWith('Status: ')) report(3, 'third line must be the "Status:" line')
  if (lines[3] !== '') report(4, 'the "Status:" line must be followed by a blank line')
  if (!isLifecycle(lifecycle)) return violations

  const expectedStatus = lifecycle === 'rejected' ? /^Status: rejected — \S/ : new RegExp(`^Status: ${lifecycle}$`)
  if (status.startsWith('Status: ') && !expectedStatus.test(status)) {
    report(3, lifecycle === 'rejected' ? 'status must be "Status: rejected — <reason>"' : `status must be "Status: ${lifecycle}" to match its folder`)
  }

  const sections: { title: string; line: number }[] = []
  let inFence = false
  lines.forEach((text, index) => {
    if (/^(```|~~~)/.test(text)) inFence = !inFence
    const match = !inFence && /^## (.+?)\s*$/.exec(text)
    if (match && match[1] !== undefined) sections.push({ title: match[1], line: index + 1 })
  })
  if (sections[0]?.title !== '问题') report(sections[0]?.line ?? 1, 'the first section must be "## 问题"')
  let cursor = 0
  for (const required of REQUIRED_SECTIONS[lifecycle]) {
    const found = sections.findIndex((section, index) => index >= cursor && section.title === required)
    if (found === -1) {
      report(1, `missing "## ${required}" (required in ${lifecycle}/ notes, in this order: ${REQUIRED_SECTIONS[lifecycle].join(', ')})`)
      continue
    }
    cursor = found + 1
  }
  if (lifecycle === 'implemented') {
    for (const section of sections) {
      if (IMPLEMENTED_FORBIDDEN.includes(section.title)) report(section.line, `"## ${section.title}" is proposal-era wording and is not allowed in an implemented note`)
    }
  }
  return violations
}

function main(): void {
  const ruleFiles = listRepoFiles(repoRoot, file => file.startsWith(NOTES_ROOT) && file.endsWith('.md'))
  const notes = ruleFiles.filter(file => isAgentNote(file))
  const violations = notes.flatMap(file => findAgentNoteViolations(file, readFileSync(resolve(repoRoot, file), 'utf8')))
  // The tree's rule files keep the gate's corpus non-empty before the first note exists.
  reportGate('verify-agent-notes', ruleFiles.length, violations)
}

if (isMain(import.meta.url)) main()

/**
 * Verify every repository skill's `SKILL.md` frontmatter: a YAML object whose `name` equals the skill's directory name and whose
 * `description` is non-empty. The description is what triggers the skill, so a missing one makes the skill unreachable.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { isMain, listRepoFiles, reportGate, repoRoot, type Violation } from './lib/repo.ts'

const SKILL_FILE = /^\.agents\/skills\/([^/]+)\/SKILL\.md$/

/**
 * Check one skill's frontmatter.
 * @param file - repository-relative path `.agents/skills/<name>/SKILL.md`.
 * @param source - complete file text.
 * @returns every frontmatter violation.
 */
export function findSkillViolations(file: string, source: string): Violation[] {
  const directory = SKILL_FILE.exec(file)?.[1]
  const lines = source.split('\n')
  if (lines[0]?.trimEnd() !== '---') return [{ file, line: 1, message: 'SKILL.md must start with YAML frontmatter' }]
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---')
  if (end === -1) return [{ file, line: 1, message: 'SKILL.md frontmatter is not closed' }]
  let metadata: unknown
  try {
    metadata = load(lines.slice(1, end).join('\n'))
  } catch (error) {
    return [{ file, line: 2, message: `frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}` }]
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return [{ file, line: 2, message: 'frontmatter must be a YAML object' }]
  }
  const violations: Violation[] = []
  const name = 'name' in metadata ? metadata.name : undefined
  const description = 'description' in metadata ? metadata.description : undefined
  if (name !== directory) violations.push({ file, line: 2, message: `frontmatter name must equal the directory name "${directory ?? ''}"` })
  if (typeof description !== 'string' || description.trim() === '') violations.push({ file, line: 2, message: 'frontmatter description must be a non-empty string' })
  return violations
}

function main(): void {
  const files = listRepoFiles(repoRoot, file => SKILL_FILE.test(file))
  const violations = files.flatMap(file => findSkillViolations(file, readFileSync(resolve(repoRoot, file), 'utf8')))
  reportGate('verify-skill-metadata', files.length, violations)
}

if (isMain(import.meta.url)) main()

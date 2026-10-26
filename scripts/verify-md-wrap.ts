/**
 * Reject Markdown prose paragraphs that span more than one physical line, including paragraphs inside lists and blockquotes.
 * Code blocks, tables, and other multiline structures are not paragraphs and are not checked. The owning rule is "一段一行" in
 * `docs/AGENTS.md`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { maskFrontmatter, parseMarkdown, visitMarkdown } from './lib/markdown.ts'
import { isMain, listRepoFiles, reportGate, repoRoot, type Violation } from './lib/repo.ts'

/**
 * Find hard-wrapped paragraphs in one Markdown document.
 * @param file - repository-relative path used in violations.
 * @param source - complete Markdown text.
 * @returns one violation per paragraph whose start and end lines differ.
 */
export function findWrapViolations(file: string, source: string): Violation[] {
  const violations: Violation[] = []
  visitMarkdown(parseMarkdown(maskFrontmatter(source)), (node) => {
    if (node.type !== 'paragraph' || node.position === undefined) return undefined
    const { start, end } = node.position
    if (end.line > start.line) {
      violations.push({ file, line: start.line, message: `paragraph spans lines ${start.line}-${end.line}; keep one paragraph on one physical line` })
    }
    return false
  })
  return violations
}

function main(): void {
  const files = listRepoFiles(repoRoot, file => file.endsWith('.md'))
  const violations = files.flatMap(file => findWrapViolations(file, readFileSync(resolve(repoRoot, file), 'utf8')))
  reportGate('verify-md-wrap', files.length, violations)
}

if (isMain(import.meta.url)) main()

/**
 * Reject type assertions to `unknown` (`value as unknown`, `<unknown>value`) in package sources and scripts. Asserting to `unknown`
 * drops the compatibility check between the original and the target type, so a wrong interface or an incomplete fixture can pass
 * as the real thing. Declaring a value as `unknown` (`const value: unknown = JSON.parse(text)`) stays allowed. The owning rule is
 * in the root `AGENTS.md`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { isMain, listRepoFiles, reportGate, repoRoot, type Violation } from './lib/repo.ts'

/**
 * Find assertions to `unknown` in one TypeScript source.
 * @param file - repository-relative path used in violations; `.tsx` files are parsed as TSX.
 * @param sourceText - complete source text.
 * @returns one violation per assertion.
 */
export function findUnknownCasts(file: string, sourceText: string): Violation[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const violations: Violation[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && node.type.kind === ts.SyntaxKind.UnknownKeyword) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      violations.push({ file, line, message: 'assertion to `unknown` hides the type mismatch; use a typed value or validate the input' })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

function main(): void {
  const files = listRepoFiles(repoRoot, file => /^(packages\/[^/]+\/src|scripts)\/.+\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
  const violations = files.flatMap(file => findUnknownCasts(file, readFileSync(resolve(repoRoot, file), 'utf8')))
  reportGate('verify-no-unknown-casts', files.length, violations)
}

if (isMain(import.meta.url)) main()

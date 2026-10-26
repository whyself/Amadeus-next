/**
 * Reject product UI copy written directly in client source (`packages/<name>/src/**\/*.tsx`). Locale dictionaries (`locale.ts`,
 * `locales.ts`, or files under a `locales/` directory) are the only files allowed to own text; presentation code receives copy
 * through `t` or an already-localized prop. Checked forms: JSX text, copy-bearing JSX attributes, and string literals rendered as
 * JSX children, including both branches of conditionals. The owning rule is in the root `AGENTS.md`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { isMain, listRepoFiles, reportGate, repoRoot, type Violation } from './lib/repo.ts'

const COPY_ATTRIBUTES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-valuetext',
  'description',
  'label',
  'placeholder',
  'title',
])
const COPY_ATTRIBUTE_SUFFIX = /(?:Aria|Copy|Description|Heading|Label|Message|Placeholder|Summary|Text|Title|Tooltip)$/
const FALLBACK_OPERATORS = [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken]
const LOCALE_KEY = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)+$/

function isLocaleOwner(file: string): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1)
  return base === 'locale.ts' || base === 'locales.ts' || file.includes('/locales/')
}

function isCopyAttribute(name: string): boolean {
  return !name.endsWith('Key') && (COPY_ATTRIBUTES.has(name) || COPY_ATTRIBUTE_SUFFIX.test(name))
}

function isProductText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized !== '' && !LOCALE_KEY.test(normalized) && /\p{L}/u.test(normalized)
}

/**
 * Find hard-coded product copy in one client source file.
 * @param file - repository-relative path used in violations; locale dictionaries return no violations.
 * @param sourceText - complete TSX source.
 * @returns violations in source order.
 */
export function findUiI18nViolations(file: string, sourceText: string): Violation[] {
  if (isLocaleOwner(file)) return []
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const violations: Violation[] = []
  const report = (node: ts.Node, text: string, where: string): void => {
    if (!isProductText(text)) return
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    violations.push({ file, line, message: `hard-coded UI copy in ${where}: "${text.replace(/\s+/g, ' ').trim()}"; move it to the locale dictionary` })
  }
  const collect = (expression: ts.Expression, where: string): void => {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) report(expression, expression.text, where)
    else if (ts.isTemplateExpression(expression)) {
      report(expression.head, expression.head.text, where)
      for (const span of expression.templateSpans) report(span.literal, span.literal.text, where)
    } else if (ts.isConditionalExpression(expression)) {
      collect(expression.whenTrue, where)
      collect(expression.whenFalse, where)
    } else if (ts.isBinaryExpression(expression) && FALLBACK_OPERATORS.includes(expression.operatorToken.kind)) {
      collect(expression.right, where)
    } else if (ts.isParenthesizedExpression(expression)) collect(expression.expression, where)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) report(node, node.text, 'JSX text')
    if (ts.isJsxAttribute(node) && node.initializer !== undefined) {
      const name = node.name.getText(source)
      if (isCopyAttribute(name)) {
        if (ts.isStringLiteral(node.initializer)) report(node.initializer, node.initializer.text, `${name} attribute`)
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined) {
          collect(node.initializer.expression, `${name} attribute`)
        }
      }
    }
    if (ts.isJsxExpression(node) && node.expression !== undefined && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      collect(node.expression, 'JSX child')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

function main(): void {
  const files = listRepoFiles(repoRoot, file => /^packages\/[^/]+\/src\/.+\.tsx$/.test(file))
  if (files.length === 0) {
    // No package ships client UI yet; the gate starts checking as soon as the first .tsx source exists.
    console.log('verify-client-ui-i18n: no client .tsx sources yet.')
    return
  }
  const violations = files.flatMap(file => findUiI18nViolations(file, readFileSync(resolve(repoRoot, file), 'utf8')))
  reportGate('verify-client-ui-i18n', files.length, violations)
}

if (isMain(import.meta.url)) main()

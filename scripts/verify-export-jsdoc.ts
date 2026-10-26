/**
 * Enforce JSDoc on every top-level export in `packages/<name>/src`: each exported declaration needs description prose, and each
 * exported function, function-valued const, and public class method needs `@param` for every parameter and `@returns` unless it
 * returns void.
 * Cordis plugin-protocol slots (`name`, `inject`, `Config`, `reusable`, `apply`, and the same statics on an exported class),
 * constructors, and re-exports keep their docs at the declaring contract. The owning rule is in the root `AGENTS.md`.
 */

import { resolve } from 'node:path'
import ts from 'typescript'
import { isMain, listRepoFiles, reportGate, repoRoot, type Violation } from './lib/repo.ts'

const PROTOCOL_EXPORTS = new Set(['Config', 'inject', 'name', 'reusable', 'apply'])
const PROTOCOL_STATICS = new Set(['Config', 'inject', 'name', 'reusable'])

type FunctionLike = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression

interface DocInfo {
  description: string
  params: Set<string>
  hasReturns: boolean
}

function docInfo(node: ts.Node): DocInfo | null {
  const docs = ts.getJSDocCommentsAndTags(node).filter((doc): doc is ts.JSDoc => ts.isJSDoc(doc))
  const doc = docs.at(-1)
  if (doc === undefined) return null
  const description = typeof doc.comment === 'string' ? doc.comment : (doc.comment ?? []).map(part => part.text).join('')
  const params = new Set<string>()
  let hasReturns = false
  for (const tag of doc.tags ?? []) {
    if (ts.isJSDocParameterTag(tag)) params.add(tag.name.getText())
    if (ts.isJSDocReturnTag(tag)) hasReturns = true
  }
  return { description: description.trim(), params, hasReturns }
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
}

function isVoidLike(type: ts.Type, checker: ts.TypeChecker): boolean {
  const voidLike = ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never
  if ((type.flags & voidLike) !== 0) return true
  const symbol = type.getSymbol()
  if (symbol?.getName() === 'Promise') {
    const [inner] = checker.getTypeArguments(type as ts.TypeReference)
    return inner !== undefined && (inner.flags & voidLike) !== 0
  }
  return false
}

function checkFunction(
  label: string,
  docNode: ts.Node,
  fn: FunctionLike,
  checker: ts.TypeChecker,
  report: (node: ts.Node, message: string) => void,
): void {
  const info = docInfo(docNode)
  if (info === null || info.description === '') {
    report(docNode, `${label} needs a JSDoc description`)
    return
  }
  for (const parameter of fn.parameters) {
    const name = parameter.name.getText()
    if (!info.params.has(name)) report(parameter, `${label} needs "@param ${name}"`)
  }
  const signature = checker.getSignatureFromDeclaration(fn)
  if (signature !== undefined && !info.hasReturns && !isVoidLike(checker.getReturnTypeOfSignature(signature), checker)) {
    report(docNode, `${label} returns a value and needs "@returns"`)
  }
}

function checkClass(cls: ts.ClassDeclaration, checker: ts.TypeChecker, report: (node: ts.Node, message: string) => void): void {
  const className = cls.name?.text ?? 'default class'
  for (const member of cls.members) {
    if (!ts.isMethodDeclaration(member) || member.body === undefined) continue
    const modifiers = ts.getModifiers(member) ?? []
    const hidden = [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword]
    if (modifiers.some(modifier => hidden.includes(modifier.kind))) continue
    if (ts.isPrivateIdentifier(member.name) || ts.isComputedPropertyName(member.name)) continue
    const isStatic = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)
    if (isStatic && PROTOCOL_STATICS.has(member.name.getText())) continue
    checkFunction(`method ${className}.${member.name.getText()}`, member, member, checker, report)
  }
}

/**
 * Check every top-level export of one source file.
 * @param sourceFile - parsed source file from a program that contains it.
 * @param checker - the program's type checker, used to decide whether a function returns a value.
 * @param file - repository-relative path used in violations.
 * @returns every missing description, `@param`, or `@returns`.
 */
export function findExportJsDocViolations(sourceFile: ts.SourceFile, checker: ts.TypeChecker, file: string): Violation[] {
  const violations: Violation[] = []
  const report = (node: ts.Node, message: string): void => {
    violations.push({ file, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, message })
  }
  for (const statement of sourceFile.statements) {
    if (!hasExportModifier(statement)) continue
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? 'default'
      if (PROTOCOL_EXPORTS.has(name) || statement.body === undefined) continue
      checkFunction(`function ${name}`, statement, statement, checker, report)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(sourceFile)
        if (PROTOCOL_EXPORTS.has(name)) continue
        const init = declaration.initializer
        if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          checkFunction(`const ${name}`, statement, init, checker, report)
        } else if ((docInfo(statement)?.description ?? '') === '') {
          report(declaration, `const ${name} needs a JSDoc description`)
        }
      }
    } else if (ts.isClassDeclaration(statement)) {
      if ((docInfo(statement)?.description ?? '') === '') report(statement, `class ${statement.name?.text ?? 'default'} needs a JSDoc description`)
      checkClass(statement, checker, report)
    } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      if ((docInfo(statement)?.description ?? '') === '') report(statement, `${statement.name.text} needs a JSDoc description`)
    }
  }
  return violations
}

function main(): void {
  const files = listRepoFiles(repoRoot, file => /^packages\/[^/]+\/src\/.+\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
  const program = ts.createProgram(files.map(file => resolve(repoRoot, file)), {
    strict: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  })
  const checker = program.getTypeChecker()
  const violations = files.flatMap((file) => {
    const sourceFile = program.getSourceFile(resolve(repoRoot, file))
    if (sourceFile === undefined) throw new Error(`${file} is not part of the program`)
    return findExportJsDocViolations(sourceFile, checker, file)
  })
  reportGate('verify-export-jsdoc', files.length, violations)
}

if (isMain(import.meta.url)) main()

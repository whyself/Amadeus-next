/**
 * Verify that relative Markdown links, images, and definitions resolve: the target file must exist, and a `#fragment` onto a
 * Markdown target (including a same-file `#anchor`) must name a heading slug or an explicit `<a id>`.
 * External URLs and root-absolute paths are not checked. The owning rule is "仓库内引用" in `docs/AGENTS.md`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { documentAnchors, maskFrontmatter, parseMarkdown, visitMarkdown } from './lib/markdown.ts'
import { isMain, listRepoFiles, reportGate, repoRoot, type Violation } from './lib/repo.ts'

/** Read access to repository files, injected so specs can supply an in-memory tree. */
export interface LinkTargets {
  /** Whether a repository-relative path exists as a file or directory. */
  exists(file: string): boolean
  /** Text of a repository-relative Markdown file. */
  read(file: string): string
}

function isExternalOrAbsolute(url: string): boolean {
  return url.startsWith('//') || url.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)
}

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch (_error) {
    // A malformed percent escape names no file or anchor; report it as unresolved.
    return null
  }
}

/**
 * Find unresolved relative links in one Markdown document.
 * @param file - repository-relative path of the document.
 * @param source - complete Markdown text.
 * @param targets - repository file access used to resolve targets and anchors.
 * @returns one violation per link whose target file or fragment does not exist.
 */
export function findLinkViolations(file: string, source: string, targets: LinkTargets): Violation[] {
  const violations: Violation[] = []
  const anchorCache = new Map<string, Set<string>>()
  const anchorsOf = (target: string): Set<string> => {
    let anchors = anchorCache.get(target)
    if (anchors === undefined) {
      anchors = documentAnchors(target === file ? source : targets.read(target))
      anchorCache.set(target, anchors)
    }
    return anchors
  }
  visitMarkdown(parseMarkdown(maskFrontmatter(source)), (node) => {
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return undefined
    const line = node.position?.start.line ?? 1
    const url = node.url
    if (url === '' || isExternalOrAbsolute(url)) return undefined
    const hashIndex = url.indexOf('#')
    const pathPart = (hashIndex === -1 ? url : url.slice(0, hashIndex)).split('?')[0] ?? ''
    const fragmentPart = hashIndex === -1 ? null : url.slice(hashIndex + 1)
    const decodedPath = decode(pathPart)
    if (decodedPath === null) {
      violations.push({ file, line, message: `link target "${url}" has a malformed escape` })
      return undefined
    }
    const target = decodedPath === '' ? file : posix.normalize(posix.join(posix.dirname(file), decodedPath)).replace(/\/$/, '')
    if (target !== file && (target.startsWith('../') || !targets.exists(target))) {
      violations.push({ file, line, message: `link target "${url}" does not exist` })
      return undefined
    }
    if (fragmentPart === null || fragmentPart === '' || !target.endsWith('.md')) return undefined
    const fragment = decode(fragmentPart)
    if (fragment === null || !anchorsOf(target).has(fragment)) {
      violations.push({ file, line, message: `link "${url}" names no heading or anchor in ${target}` })
    }
    return undefined
  })
  return violations
}

function main(): void {
  const files = listRepoFiles(repoRoot, file => file.endsWith('.md'))
  const targets: LinkTargets = {
    exists: target => existsSync(resolve(repoRoot, target)),
    read: target => readFileSync(resolve(repoRoot, target), 'utf8'),
  }
  const violations = files.flatMap(file => findLinkViolations(file, readFileSync(resolve(repoRoot, file), 'utf8'), targets))
  reportGate('verify-md-links', files.length, violations)
}

if (isMain(import.meta.url)) main()

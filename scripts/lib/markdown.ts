/** GitHub-flavored Markdown parsing, traversal, and heading anchors for the documentation gates. */

import type { Nodes } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

/**
 * Parse GitHub-flavored Markdown.
 * @param source - complete Markdown text.
 * @returns the mdast root.
 */
export function parseMarkdown(source: string): Nodes {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

/**
 * Visit a Markdown tree depth-first; returning false prunes a node's children.
 * @param node - current tree node.
 * @param visitor - callback invoked before each node's children.
 */
export function visitMarkdown(node: Nodes, visitor: (node: Nodes) => boolean | void): void {
  if (visitor(node) === false) return
  if ('children' in node) {
    for (const child of node.children) visitMarkdown(child, visitor)
  }
}

/**
 * Blank a leading YAML frontmatter block, keeping line numbers, so it is not parsed as Markdown.
 * @param source - complete Markdown text.
 * @returns the text with frontmatter lines emptied.
 */
export function maskFrontmatter(source: string): string {
  const lines = source.split('\n')
  if (lines[0]?.trimEnd() !== '---') return source
  const closing = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---')
  if (closing === -1) return source
  return lines.map((line, index) => index <= closing ? '' : line).join('\n')
}

/** Rendered text of a node: text and inline code values, without Markdown syntax or raw HTML. */
function renderedText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value
  if (node.type === 'html') return ''
  if ('children' in node) return node.children.map(child => renderedText(child)).join('')
  return ''
}

/**
 * GitHub's heading slug: lowercase, drop everything except letters, numbers, underscores, spaces, and hyphens, then turn
 * spaces into hyphens.
 * @param heading - rendered heading text.
 * @returns the anchor GitHub assigns to the first occurrence of the heading.
 */
export function githubSlug(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replaceAll(' ', '-')
}

/**
 * Every fragment one Markdown document exposes: heading slugs with GitHub's `-1`, `-2` suffixes for repeats, plus explicit
 * `<a id="…">` anchors in HTML flow.
 * @param source - complete Markdown text.
 * @returns the set of valid fragments for links into this document.
 */
export function documentAnchors(source: string): Set<string> {
  const anchors = new Set<string>()
  const occurrences = new Map<string, number>()
  visitMarkdown(parseMarkdown(maskFrontmatter(source)), (node) => {
    if (node.type === 'heading') {
      const base = githubSlug(renderedText(node))
      let candidate = base
      let bump = occurrences.get(base) ?? 0
      while (anchors.has(candidate)) {
        bump += 1
        candidate = `${base}-${bump}`
      }
      occurrences.set(base, bump)
      anchors.add(candidate)
      return false
    }
    if (node.type === 'html') {
      for (const match of node.value.matchAll(/<a\s+[^>]*\bid="([^"]+)"/g)) {
        if (match[1] !== undefined) anchors.add(match[1])
      }
    }
    return undefined
  })
  return anchors
}

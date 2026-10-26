// Each gate is exercised with an accepted input and a near-miss input it must reject, so a gate that silently accepts everything
// fails here.

import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { findAgentNoteViolations, isAgentNote } from './verify-agent-notes.ts'
import { findUiI18nViolations } from './verify-client-ui-i18n.ts'
import { countUnits, findBudgetViolations } from './verify-doc-budgets.ts'
import { findDocRefViolations } from './verify-doc-refs.ts'
import { findExportJsDocViolations } from './verify-export-jsdoc.ts'
import { findLinkViolations, type LinkTargets } from './verify-md-links.ts'
import { findWrapViolations } from './verify-md-wrap.ts'
import { CANONICAL, findLimitationViolations } from './verify-package-readme-limitations.ts'
import { MODEL_EXPERIENCE, findModelExperienceViolations } from './verify-package-readme-model-experience.ts'
import { findCommitReferences } from './verify-repository-references.ts'
import { findSkillViolations } from './verify-skill-metadata.ts'

describe('verify-md-wrap', () => {
  it('accepts one-line paragraphs, lists, tables, and code blocks', () => {
    const source = '# T\n\nOne paragraph.\n\n- item one\n- item two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```sh\nline one\nline two\n```\n'
    expect(findWrapViolations('a.md', source)).toEqual([])
  })

  it('rejects a paragraph wrapped across lines, including inside a list item', () => {
    expect(findWrapViolations('a.md', 'first half\nsecond half\n')).toHaveLength(1)
    expect(findWrapViolations('a.md', '- item first half\n  second half\n')).toHaveLength(1)
  })

  it('ignores YAML frontmatter', () => {
    expect(findWrapViolations('a.md', '---\nname: x\ndescription: y\n---\n\nText.\n')).toEqual([])
  })
})

describe('verify-md-links', () => {
  const tree: Record<string, string> = {
    'docs/a.md': '# A\n\n## 分层：一事实一归属\n\n<a id="custom"></a>\n',
    'docs/sub/b.md': '# B\n',
  }
  const targets: LinkTargets = {
    exists: file => file in tree || file === 'docs' || file === 'docs/sub',
    read: (file) => {
      const text = tree[file]
      if (text === undefined) throw new Error(`no fixture ${file}`)
      return text
    },
  }

  it('accepts existing targets, GitHub heading slugs, explicit anchors, and external URLs', () => {
    const source = '## Slop 清单\n\n[b](sub/b.md) [h](a.md#分层一事实一归属) [s](#slop-清单) [c](a.md#custom) [x](https://example.com/missing) [d](sub/)\n'
    expect(findLinkViolations('docs/index.md', source, targets)).toEqual([])
  })

  it('rejects a missing file, a missing anchor, and a path that leaves the repository', () => {
    const source = '[m](missing.md) [h](a.md#no-such-heading) [o](../../outside.md)\n'
    expect(findLinkViolations('docs/index.md', source, targets).map(v => v.message)).toEqual([
      'link target "missing.md" does not exist',
      'link "a.md#no-such-heading" names no heading or anchor in docs/a.md',
      'link target "../../outside.md" does not exist',
    ])
  })
})

describe('verify-doc-refs', () => {
  it('accepts an existing cited path and rejects a missing one', () => {
    const exists = (path: string): boolean => path === 'docs/AGENTS.md'
    expect(findDocRefViolations('src/a.ts', '// see docs/AGENTS.md\n', exists)).toEqual([])
    expect(findDocRefViolations('src/a.ts', '// see docs/missing.md\n', exists)).toHaveLength(1)
  })
})

describe('verify-repository-references', () => {
  const commits = ['1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']

  it('rejects an abbreviated or full commit id', () => {
    expect(findCommitReferences('a.md', 'fixed in 1111111\n', commits)).toHaveLength(1)
    expect(findCommitReferences('a.md', `see ${commits[1] ?? ''}\n`, commits)).toHaveLength(1)
  })

  it('accepts hex that is not a commit, short tokens, and tags', () => {
    expect(findCommitReferences('a.md', 'digest deadbeefcafe, id 111111, tag test@0.1.0\n', commits)).toEqual([])
  })
})

describe('verify-agent-notes', () => {
  const implemented = '# Agent Note: Npm distribution\n\nStatus: implemented\n\n## 问题\n\nx\n\n## 决策\n\nx\n\n## 考虑过的替代方案\n\nx\n\n## 后果\n\nx\n'

  it('treats README.md and AGENTS.md as rule files, not notes', () => {
    expect(isAgentNote('.agents/notes/README.md')).toBe(false)
    expect(isAgentNote('.agents/notes/implemented/AGENTS.md')).toBe(false)
    expect(isAgentNote('.agents/notes/implemented/process/2026-10-24-npm.md')).toBe(true)
  })

  it('accepts a well-formed implemented note', () => {
    expect(findAgentNoteViolations('.agents/notes/implemented/process/2026-10-24-npm.md', implemented)).toEqual([])
  })

  it('rejects an unknown class, a status that disagrees with the folder, and a missing section', () => {
    expect(findAgentNoteViolations('.agents/notes/implemented/refactor/2026-10-24-npm.md', implemented)).toHaveLength(1)
    expect(findAgentNoteViolations('.agents/notes/proposed/process/2026-10-24-npm.md', implemented).length).toBeGreaterThan(0)
    expect(findAgentNoteViolations('.agents/notes/implemented/process/2026-10-24-npm.md', implemented.replace('## 后果', '## Notes'))).toHaveLength(1)
  })

  it('rejects a topic that is not lowercase English kebab-case', () => {
    expect(findAgentNoteViolations('.agents/notes/implemented/process/2026-10-24-npm分发.md', implemented)).toHaveLength(1)
    expect(findAgentNoteViolations('.agents/notes/implemented/process/2026-10-24-Npm_Distribution.md', implemented)).toHaveLength(1)
  })

  it('rejects proposal-era sections in an implemented note and a rejected status without a reason', () => {
    expect(findAgentNoteViolations('.agents/notes/implemented/process/2026-10-24-npm.md', `${implemented}\n## 验收标准\n\nx\n`)).toHaveLength(1)
    const rejected = '# Agent Note: X\n\nStatus: rejected\n\n## 问题\n\nx\n\n## 提案\n\nx\n\n## 考虑过的替代方案\n\nx\n'
    expect(findAgentNoteViolations('.agents/notes/rejected/feature/2026-10-24-x.md', rejected)).toHaveLength(1)
  })
})

describe('verify-skill-metadata', () => {
  it('accepts matching name and a description', () => {
    expect(findSkillViolations('.agents/skills/demo/SKILL.md', '---\nname: demo\ndescription: Use when testing.\n---\n\n# Demo\n')).toEqual([])
  })

  it('rejects a name that differs from the directory, a missing description, and missing frontmatter', () => {
    expect(findSkillViolations('.agents/skills/demo/SKILL.md', '---\nname: other\ndescription: x\n---\n')).toHaveLength(1)
    expect(findSkillViolations('.agents/skills/demo/SKILL.md', '---\nname: demo\n---\n')).toHaveLength(1)
    expect(findSkillViolations('.agents/skills/demo/SKILL.md', '# Demo\n')).toHaveLength(1)
  })
})

describe('verify-export-jsdoc', () => {
  function check(source: string): string[] {
    const fileName = 'fixture.ts'
    const host = ts.createCompilerHost({ strict: true, noEmit: true })
    const original = host.getSourceFile.bind(host)
    host.getSourceFile = (name, languageVersion) => name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true)
      : original(name, languageVersion)
    const program = ts.createProgram([fileName], { strict: true, noEmit: true, skipLibCheck: true }, host)
    const sourceFile = program.getSourceFile(fileName)
    if (sourceFile === undefined) throw new Error('fixture missing from program')
    return findExportJsDocViolations(sourceFile, program.getTypeChecker(), fileName).map(v => v.message)
  }

  it('accepts documented exports and exempts plugin-protocol slots', () => {
    const source = [
      'export const name = "x"',
      'export function apply(ctx: object) {}',
      '/**',
      ' * Adds two numbers.',
      ' * @param a - first operand.',
      ' * @param b - second operand.',
      ' * @returns the sum.',
      ' */',
      'export function add(a: number, b: number): number { return a + b }',
      '/** Logs a line. @param text - the line. */',
      'export function log(text: string): void { void text }',
    ].join('\n')
    expect(check(source)).toEqual([])
  })

  it('rejects a missing description, a missing @param, and a missing @returns', () => {
    expect(check('export function f(): number { return 1 }')).toEqual(['function f needs a JSDoc description'])
    expect(check('/** Doubles. @returns twice x. */\nexport function f(x: number): number { return x * 2 }')).toEqual(['function f needs "@param x"'])
    expect(check('/** Doubles. @param x - input. */\nexport function f(x: number): number { return x * 2 }')).toEqual(['function f returns a value and needs "@returns"'])
    expect(check('export interface Shape { size: number }')).toEqual(['Shape needs a JSDoc description'])
  })
})

describe('verify-doc-budgets', () => {
  it('counts each CJK character and each English word as one unit, ignoring full-width punctuation', () => {
    expect(countUnits('写当前状态。Use pnpm run lint')).toBe(9)
  })

  it('accepts a file at its ceiling and rejects a file over it or missing', () => {
    const files: Record<string, string> = { 'a.md': '一二三', 'b.md': '一二三四' }
    const read = (file: string): string | null => files[file] ?? null
    expect(findBudgetViolations({ 'a.md': 3 }, read)).toEqual([])
    expect(findBudgetViolations({ 'b.md': 3 }, read)).toHaveLength(1)
    expect(findBudgetViolations({ 'gone.md': 3 }, read)).toHaveLength(1)
  })
})

describe('verify-client-ui-i18n', () => {
  it('accepts copy routed through t, locale keys, and copy inside locale dictionaries', () => {
    const view = 'export const View = () => <button title={t("files.upload")}>{t("files.upload")}</button>'
    expect(findUiI18nViolations('packages/files/src/view.tsx', view)).toEqual([])
    expect(findUiI18nViolations('packages/files/src/locales/zh.tsx', 'export const zh = <span>上传</span>')).toEqual([])
  })

  it('rejects JSX text, a copy attribute, and a literal in a conditional child', () => {
    const view = [
      'export const View = (p: { busy: boolean }) => <div>',
      '  <span>上传文件</span>',
      '  <input placeholder="Search files" />',
      '  {p.busy ? "Saving" : t("x.y")}',
      '</div>',
    ].join('\n')
    expect(findUiI18nViolations('packages/files/src/view.tsx', view).map(v => v.line)).toEqual([2, 3, 4])
  })
})

describe('verify-package-readme-limitations', () => {
  const section = (body: string): string => `# P\n\n${CANONICAL}\n\n${body}\n`

  it('accepts one canonical section with a bullet', () => {
    expect(findLimitationViolations('r.md', section('- 只支持本地文件。'), false)).toEqual([])
  })

  it('rejects a missing README, a missing section, a variant heading, and an empty section', () => {
    expect(findLimitationViolations('r.md', null, false)).toHaveLength(1)
    expect(findLimitationViolations('r.md', '# P\n\n说明。\n', false)).toHaveLength(1)
    expect(findLimitationViolations('r.md', '# P\n\n## 限制\n\n- x\n', false)).toHaveLength(1)
    expect(findLimitationViolations('r.md', section('暂无。'), false)).toHaveLength(1)
  })

  it('rejects a section on an allowlisted package', () => {
    expect(findLimitationViolations('r.md', section('- x'), true)).toHaveLength(1)
    expect(findLimitationViolations('r.md', '# P\n', true)).toEqual([])
  })
})

describe('verify-package-readme-model-experience', () => {
  const readme = (section: string): string => `# P\n\n${MODEL_EXPERIENCE}\n\n${section}\n\n${CANONICAL}\n\n- x\n`
  const full = '### 工具调用\n\n#### 模型看到什么\n\na\n\n#### Token 影响\n\nb\n\n#### KV Cache 影响\n\n无，因为结果只追加在对话末尾。'

  it('accepts entries whose fields may say "无，因为", and both short forms', () => {
    expect(findModelExperienceViolations('r.md', readme(full))).toEqual([])
    expect(findModelExperienceViolations('r.md', readme('无，因为插件不向模型请求添加内容。'))).toEqual([])
    expect(findModelExperienceViolations('r.md', readme('间接，通过 files 包的工具结果。'))).toEqual([])
  })

  it('rejects a missing section, a bare "无", a missing field, an empty field, and a bare "无" field', () => {
    expect(findModelExperienceViolations('r.md', `# P\n\n${CANONICAL}\n\n- x\n`)).toHaveLength(1)
    expect(findModelExperienceViolations('r.md', readme('无。'))).toHaveLength(1)
    expect(findModelExperienceViolations('r.md', readme(full.replace('#### Token 影响\n\nb\n\n', '')))).toHaveLength(1)
    expect(findModelExperienceViolations('r.md', readme(full.replace('\n\nb\n\n', '\n\n')))).toHaveLength(1)
    expect(findModelExperienceViolations('r.md', readme(full.replace('无，因为结果只追加在对话末尾。', '无。')))).toHaveLength(1)
  })

  it('rejects a section that is not immediately before the limitations section', () => {
    const misplaced = `# P\n\n${MODEL_EXPERIENCE}\n\n无，因为没有。\n\n## 配置\n\nx\n\n${CANONICAL}\n\n- x\n`
    expect(findModelExperienceViolations('r.md', misplaced)).toHaveLength(1)
  })
})

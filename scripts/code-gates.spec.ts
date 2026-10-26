// Each gate is exercised with an accepted input and a near-miss input it must reject,
// so a gate that silently accepts everything fails here.

import { describe, expect, it } from 'vitest'
import { findUnknownCasts } from './verify-no-unknown-casts.ts'
import { ENGINES_DSH, findPackageMetaViolations } from './verify-package-meta.ts'

describe('verify-no-unknown-casts', () => {
  it('accepts a value declared as unknown and assertions to other types', () => {
    expect(findUnknownCasts('a.ts', 'const value: unknown = JSON.parse("1")\nconst n = value as number\n')).toEqual([])
  })

  it('rejects `as unknown`, a double cast through unknown, and `<unknown>`', () => {
    expect(findUnknownCasts('a.ts', 'const a = 1 as unknown\n')).toHaveLength(1)
    expect(findUnknownCasts('a.ts', 'const b = "x" as unknown as number\n')).toHaveLength(1)
    expect(findUnknownCasts('a.ts', 'const c = <unknown>1\n')).toHaveLength(1)
  })
})

describe('verify-package-meta', () => {
  const valid = {
    name: '@amadeus-dsh/files',
    engines: { dsh: ENGINES_DSH },
    files: ['lib', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    dependencies: { yazl: '3.3.1' },
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.5' },
    devDependencies: { '@deepseek-ai/cordis': '4.0.5' },
  }
  const patch = '- insert:\n    - id: amadeus-files\n      name: "@amadeus-dsh/files"\n'
  const read = (text: string | null) => (): string | null => text

  it('accepts a conforming manifest and patch', () => {
    expect(findPackageMetaViolations('packages/files', valid, read(patch))).toEqual([])
  })

  it('rejects a wrong name, a wrong engines.dsh, and a peer without its dev twin', () => {
    expect(findPackageMetaViolations('packages/files', { ...valid, name: '@amadeus/files' }, read(patch)).map(v => v.message))
      .toContain('name must be "@amadeus-dsh/files"')
    expect(findPackageMetaViolations('packages/files', { ...valid, engines: { dsh: '>=0.2.0' } }, read(patch))).toHaveLength(1)
    expect(findPackageMetaViolations('packages/files', { ...valid, devDependencies: {} }, read(patch))).toHaveLength(1)
  })

  it('rejects cordis as a runtime dependency', () => {
    const manifest = { ...valid, dependencies: { '@deepseek-ai/cordis': '^4.0.5' } }
    expect(findPackageMetaViolations('packages/files', manifest, read(patch))).toHaveLength(1)
  })

  it('rejects a patch that is missing, unlisted in files, or inserts an undeclared package', () => {
    expect(findPackageMetaViolations('packages/files', valid, read(null))).toHaveLength(1)
    expect(findPackageMetaViolations('packages/files', { ...valid, files: ['lib'] }, read(patch))).toHaveLength(1)
    const foreign = '- insert:\n    - id: other\n      name: "@deepseek-ai/dsh-shell"\n'
    expect(findPackageMetaViolations('packages/files', valid, read(foreign))).toHaveLength(1)
  })
})

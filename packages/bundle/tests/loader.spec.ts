import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { bootBundle } from '../../../scripts/test-support/boot-bundle.ts'

it('loads branding and one editor, including when the standalone editor row already exists', async () => {
  const fixture = pathToFileURL(resolve('packages/editor/tests/loader-host.mjs')).href
  for (const standalone of [false, true]) {
    const booted = await bootBundle('packages/bundle', {
      rows: [`- name: '${fixture}'`, '  id: editor-test-host',
        ...standalone ? ['- id: amadeus-editor', "  name: '@amadeus-dsh/editor'"] : []],
    })
    try {
      const entries = [...booted.ctx.loader.entries()]
      expect(entries.filter(entry => entry.options.name === '@amadeus-dsh/editor')).toHaveLength(1)
      for (const id of ['amadeus-brand', 'amadeus-editor']) {
        expect(entries.find(entry => entry.options.id === id)?.fiber?.state).toBe(2)
      }
    } finally { await booted.dispose() }
  }
}, 30000)

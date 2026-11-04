import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { bootBundle } from '../../../scripts/test-support/boot-bundle.ts'

it('composes the editor bundle through the real Loader and disposes it', async () => {
  const fixture = pathToFileURL(resolve('packages/editor/tests/loader-host.mjs')).href
  const booted = await bootBundle('packages/editor', {
    rows: [`- name: '${fixture}'`, '  id: editor-test-host'],
  })
  try {
    const entry = [...booted.ctx.loader.entries()].find(candidate => candidate.options.id === 'amadeus-editor')
    expect(entry?.options.name).toBe('@amadeus-dsh/editor')
    expect(entry?.fiber?.state).toBe(2)
  } finally {
    await booted.dispose()
  }
}, 30000)

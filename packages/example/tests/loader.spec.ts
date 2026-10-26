// Template for a package's real Loader test: the bundle boots from its own cordis.patch.yml through the Loader, and the assertions
// observe what a user would see (the plugin's output and the effect it owns) rather than calling `apply` by hand.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootBundle, type BootedBundle } from '../../../scripts/test-support/boot-bundle.ts'

let booted: BootedBundle | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  vi.restoreAllMocks()
})

describe('@amadeus-dsh/example real Loader composition', () => {
  it('loads from the bundle patch and reverts its effect on disposal', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    booted = await bootBundle('packages/example')

    const entry = [...booted.ctx.loader.entries()].find(candidate => candidate.options.id === 'amadeus-example')
    expect(entry?.options.name).toBe('@amadeus-dsh/example')
    expect(log).toHaveBeenCalledWith('[amadeus-example] plugin loaded')
    expect(log).not.toHaveBeenCalledWith('[amadeus-example] plugin disposed')

    await booted.dispose()
    booted = undefined
    expect(log).toHaveBeenCalledWith('[amadeus-example] plugin disposed')
  }, 30_000)
})

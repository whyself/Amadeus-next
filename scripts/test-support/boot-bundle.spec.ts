import { describe, expect, it } from 'vitest'
import { parsePatchList } from './boot-bundle.ts'

describe('parsePatchList', () => {
  it('keeps every patch mapping in order', () => {
    const patches = [{ id: 'a' }, { id: 'b' }]
    expect(parsePatchList(patches, 'cordis.patch.yml')).toEqual(patches)
  })

  it('rejects a file that is not a list', () => {
    expect(() => parsePatchList({ id: 'a' }, 'cordis.patch.yml')).toThrow('must be a YAML list of patches')
  })

  it.each([null, 'text', ['nested']])('rejects the invalid item %j instead of dropping it', (item) => {
    expect(() => parsePatchList([{ id: 'a' }, item], 'cordis.patch.yml')).toThrow('item 2 must be a patch mapping')
  })
})

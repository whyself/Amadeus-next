import { Context } from '@deepseek-ai/cordis'
import { SlotCore, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.brand.mark': { kind: 'single'; scope: 'root' }
    'sidebar.brand.name': { kind: 'single'; scope: 'root' }
    'conversation.hero.brand.mark': { kind: 'single'; scope: 'root' }
  }
}

afterEach(() => { vi.unstubAllGlobals() })

it('shadows the official brand in public slots and restores all occupants and favicon on disposal', async () => {
  const dom = new JSDOM('<head><link rel="icon" href="/original.svg" type="image/svg+xml"></head>')
  vi.stubGlobal('document', dom.window.document)
  const slots = new SlotCore()
  const ctx = new Context()
  ctx.provide('slots', {
    inject: (_name: string, callback: () => () => void) => callback(),
    register: slots.register.bind(slots),
  })
  const dictionaries = new Set<string>()
  ctx.provide('locale', { register(namespace: string) { dictionaries.add(namespace); return () => { dictionaries.delete(namespace) } } })
  slots.register({ name: 'root', children: {
    'sidebar.brand.mark': { kind: 'single', scope: 'root' },
    'sidebar.brand.name': { kind: 'single', scope: 'root' },
    'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
  } }, (_props: PropsRenderSlots<'sidebar.brand.mark' | 'sidebar.brand.name' | 'conversation.hero.brand.mark'>) => null)
  const official = () => null
  slots.register({ name: 'sidebar.brand.mark' }, official)
  slots.register({ name: 'sidebar.brand.name' }, official)
  try {
    apply(ctx)
    expect(slots.entriesOfSlot('sidebar.brand.mark')[0]?.component).not.toBe(official)
    expect(slots.entriesOfSlot('sidebar.brand.name')[0]?.component).not.toBe(official)
    expect(slots.entriesOfSlot('conversation.hero.brand.mark')).toHaveLength(1)
    expect(dom.window.document.querySelector('link')?.getAttribute('href')).not.toBe('/original.svg')
    await ctx.fiber.dispose()
    expect(slots.entriesOfSlot('sidebar.brand.mark')[0]?.component).toBe(official)
    expect(slots.entriesOfSlot('sidebar.brand.name')[0]?.component).toBe(official)
    expect(slots.entriesOfSlot('conversation.hero.brand.mark')).toHaveLength(0)
    expect(dom.window.document.querySelector('link')?.getAttribute('href')).toBe('/original.svg')
    expect(dictionaries.size).toBe(0)
  } finally { await ctx.fiber.dispose(); dom.window.close() }
})

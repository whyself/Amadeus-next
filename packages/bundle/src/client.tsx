import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import mark from '../assets/mark.png'

import { zh, en } from './locales.ts'

interface BrandHost {
  locale: { register(namespace: string, dictionaries: { zh: typeof zh; en: typeof en }): () => void }
  slots: {
    inject(name: string, callback: () => () => void): () => void
    register(options: { name: string; priority: number; locale?: string },
      component: (props: never) => ReactElement): () => void
  }
}

/** Required browser services. */
export const inject = ['slots', 'locale']

function BrandMark({ size = 24, className }: { size?: number; className?: string }): ReactElement {
  const mask = `url("${mark}") center / contain no-repeat`
  return <span className={className} aria-hidden="true" style={{ display: 'block', width: size, height: size,
    flex: 'none', backgroundColor: 'currentColor', WebkitMask: mask, mask }} />
}

function BrandName({ t }: { t: (key: keyof typeof zh) => string }): ReactElement {
  return <span>{t('brandName')}</span>
}

/**
 * Occupy the public brand slots and restore the browser icons on disposal.
 * @param ctx - Client context owning every registration.
 * @returns No value; resources belong to the context's effects.
 */
export function apply(ctx: Context): void {
  const host = ctx as Context & BrandHost
  ctx.effect(() => host.locale.register('amadeusBrand', { zh, en }))
  for (const [name, component] of [
    ['sidebar.brand.mark', BrandMark], ['sidebar.brand.name', BrandName], ['conversation.hero.brand.mark', BrandMark],
  ] as const) {
    ctx.effect(() => host.slots.inject(name, () => host.slots.register({ name, priority: -100, locale: 'amadeusBrand' }, component)))
  }
  ctx.effect(() => {
    const previous = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')].map(link => ({ link, href: link.getAttribute('href'), type: link.getAttribute('type') }))
    const created = previous.length === 0 ? document.createElement('link') : undefined
    if (created) { created.rel = 'icon'; document.head.append(created) }
    for (const link of created ? [created] : previous.map(item => item.link)) { link.href = mark; link.type = 'image/png' }
    return () => {
      created?.remove()
      for (const { link, href, type } of previous) {
        if (link.getAttribute('href') !== mark) continue
        if (href === null) link.removeAttribute('href'); else link.setAttribute('href', href)
        if (type === null) link.removeAttribute('type'); else link.setAttribute('type', type)
      }
    }
  })
}

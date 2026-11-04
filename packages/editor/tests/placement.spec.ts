import { JSDOM } from 'jsdom'
import { Context } from '@deepseek-ai/cordis'
import { act, createElement, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client.tsx'
import { FramePool } from '../src/frame-pool.ts'

afterEach(() => { vi.unstubAllGlobals() })

function rectangle(left: number, width = 640): DOMRect {
  return { x: left, y: 78, left, top: 78, width, height: 720, right: left + width, bottom: 798, toJSON: () => ({ left }) }
}

it('ignores cleanup from a background or replaced placeholder sharing the same workspace', async () => {
  const dom = new JSDOM('<!doctype html><body data-ds-dark-theme></body>')
  const pool = new FramePool(dom.window.document, 1, {
    state: () => Promise.resolve({ known: true, dirtyCount: 0, instanceCount: 1 }),
    save: () => Promise.resolve(),
    discard: () => Promise.resolve(),
    confirm: () => Promise.resolve('cancel'),
  })
  const oldOwner = {}
  const currentOwner = {}
  const bounds = rectangle(200)
  try {
    const frame = await pool.acquire('/project', '/editor')
    expect(frame?.name).toMatch(/^amadeus-editor-[\da-f-]+$/)
    expect(frame?.dataset.sidebarBrowserFrame).toBe('iframe')
    expect(frame?.style.colorScheme).toBe('dark')
    expect(frame?.style.background).toContain('--dsw-alias-bg-base')
    pool.place('/project', bounds, oldOwner, 'editor', 20)
    pool.place('/project', bounds, currentOwner, 'editor', 20)
    pool.hide('/project', oldOwner)
    expect(frame?.style.display).toBe('block')
    pool.place('/project', rectangle(0, 0), oldOwner, 'editor', 20)
    expect(frame?.style.display).toBe('block')
    pool.place('/project', rectangle(100), oldOwner, 'editor', 20)
    pool.place('/project', bounds, currentOwner, 'editor', 20)
    pool.hide('/project', currentOwner)
    expect(frame?.style.display).toBe('block')
    expect(frame?.style.left).toBe('100px')
    pool.hide('/project', oldOwner)
    expect(frame?.style.display).toBe('none')
    pool.place('/project', bounds, currentOwner, 'editor', 20)
    expect(dom.window.document.querySelector('iframe')).toBe(frame)
    expect(frame?.style.display).toBe('block')
  } finally {
    pool.dispose()
    dom.window.close()
  }
})

it('restores the same iframe after collapse and follows an ancestor transform through its last frame', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('Element', dom.window.Element)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('MutationObserver', dom.window.MutationObserver)
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  let left = 1200
  let moving = false
  let fullscreen = false
  // JSDOM has no layout or CSS animation engine; expose the host's measured geometry.
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => rectangle(left)
  dom.window.Element.prototype.getAnimations = () => moving ? [{ playState: 'running' } as Animation] : []
  let appearanceApplied: (() => void) | undefined
  let appearance = new Promise<void>((resolve) => { appearanceApplied = resolve })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/amadeus/editor/settings')) {
      await appearance
      return new Response(JSON.stringify({ result: { updated: true } }))
    }
    if (url.startsWith('/amadeus/editor/action')) {
      return new Response(JSON.stringify({ known: true, dirtyCount: 0, instanceCount: 1 }))
    }
    const sessionId = new URL(url, 'http://localhost').searchParams.get('sessionId')
    return new Response(JSON.stringify({
      editorOrigin: 'http://127.0.0.1:9000', workspaceRoot: sessionId === 'other' ? '/other' : '/project', bridgeMode: 'required',
      maxHotWorkspaces: 1, bridgeToken: 'a'.repeat(64),
    }))
  }))
  const ctx = new Context()
  type BodyProps = {
    sessionId: string
    useTabInfo(): { sidebar: { fullscreen: boolean }; tab: { id: string; visible: boolean; navigation: object } }
  }
  let Body: ComponentType<BodyProps> | undefined
  ctx.provide('locale', { bind: () => (key: string) => key, register: () => () => {} })
  ctx.provide('sidebarRightTabs', { register: () => () => {} })
  ctx.provide('sidebarRight', { registerCloseHandler: () => () => {} })
  ctx.provide('shortcuts', { register: () => () => {} })
  ctx.provide('slots', {
    inject: (_name: string, run: () => () => void) => run(),
    register(options: { name: string }, component: ComponentType<BodyProps>) {
      if (options.name === 'sidebar.right.pane.tab') Body = component
      return () => {}
    },
  })
  apply(ctx)
  if (!Body) throw new Error('Missing editor body')
  const component = Body
  const root = createRoot(dom.window.document.querySelector('main') as HTMLElement)
  const render = async (visible: boolean, selected = 'session'): Promise<void> => {
    await act(async () => {
      root.render(['session', 'other'].map(sessionId => createElement(component, {
        key: sessionId, sessionId,
        useTabInfo: () => ({ sidebar: { fullscreen }, tab: { id: sessionId, visible: visible && sessionId === selected, navigation: {} } }),
      })))
    })
  }
  try {
    await render(true)
    expect(dom.window.document.querySelector('iframe')?.style.display).toBe('none')
    await act(async () => { appearanceApplied?.() })
    await vi.waitFor(() => { expect(dom.window.document.querySelector('iframe')?.style.display).toBe('block') })
    const original = dom.window.document.querySelector('iframe')
    await render(false)
    expect(original?.style.display).toBe('none')
    moving = true
    await render(true)
    left = 700
    await vi.waitFor(() => { expect(original?.style.left).toBe('700px') })
    moving = false
    left = 200
    dom.window.document.querySelector('main')?.dispatchEvent(new dom.window.Event('transitionend', { bubbles: true }))
    expect(original?.style.left).toBe('200px')
    expect(original?.style.display).toBe('block')
    expect(dom.window.document.querySelector('iframe')).toBe(original)
    fullscreen = true
    await render(true)
    expect(original?.style.zIndex).toBe('50')
    expect(original?.parentElement?.style.display).toBe('contents')
    fullscreen = false
    await render(true)
    expect(original?.style.zIndex).toBe('20')
    await render(false)
    await render(true)
    expect(original?.style.display).toBe('block')
    await render(true, 'other')
    await vi.waitFor(() => { expect(dom.window.document.querySelector('iframe')?.src).toContain('other') })
    appearance = new Promise<void>((resolve) => { appearanceApplied = resolve })
    await render(true)
    await vi.waitFor(() => {
      expect(dom.window.document.querySelector('iframe')?.src).toContain('project')
      expect(dom.window.document.querySelector('iframe')).not.toBe(original)
    })
    expect(dom.window.document.querySelector('iframe')?.style.display).toBe('none')
    await act(async () => { appearanceApplied?.() })
    await vi.waitFor(() => { expect(dom.window.document.querySelector('iframe')?.style.display).toBe('block') })
  } finally {
    await act(async () => { root.unmount() })
    await ctx.fiber.dispose()
    expect(dom.window.document.querySelector('iframe')).toBeNull()
    dom.window.close()
  }
})

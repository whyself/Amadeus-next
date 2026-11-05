import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotCore, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { act, createElement, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { FramePool, type CloseDecision, type WorkspaceDirtyState } from '../src/frame-pool.ts'
import { editorCommand, fetchWorkspace, parseDirtyState } from '../src/client-api.ts'
import { CloseCoordinator } from '../src/client-close.ts'
import { apply } from '../src/client.tsx'
import { en, zh } from '../src/locales.ts'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    root: { kind: 'single'; scope: 'root' }
    'sidebar.right.pane.tab': { kind: 'keyed'; scope: 'session' }
    'sidebar.right.tab.document.actions': { kind: 'list'; scope: 'session' }
    'sidebar.right.tab.document.unpreviewable': { kind: 'list'; scope: 'session' }
    'sidebar.right.tab.files.actions': { kind: 'list'; scope: 'session' }
    'plugins.bundle.config': { kind: 'keyed'; scope: 'root' }
    'plugins.row.config': { kind: 'keyed'; scope: 'root' }
  }
}

afterEach(() => { vi.unstubAllGlobals() })

it('ships a browser bundle that registers the editor client with the module loader', async () => {
  const source = await readFile(resolve('packages/editor/lib/client.js'), 'utf8')
  let registered: { id: string; factory: (requireModule: (id: string) => unknown) => unknown } | undefined
  const window = {
    __ModuleLoader__: {
      load(registration: { id: string; factory: (requireModule: (id: string) => unknown) => unknown }) {
        registered = registration
      },
    },
  }
  runInNewContext(source, { window })
  expect(registered?.id).toBe('@amadeus-dsh/editor')
  const requireModule = createRequire(resolve('packages/editor/package.json'))
  const exported = registered?.factory(id => id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : requireModule(id))
  expect(typeof exported).toBe('object')
  expect(exported).toHaveProperty('apply')
})

it('registers the sidebar, shortcut and three entry slots and removes them on disposal', async () => {
  const ctx = new Context()
  const active = new Set<string>()
  let definition: { kind: string; patterns?: string[] } | undefined
  ctx.provide('locale', {
    bind: () => (key: string) => key,
    register: () => { active.add('locale'); return () => { active.delete('locale') } },
  })
  ctx.provide('sidebarRightTabs', {
    register(value: { kind: string; patterns?: string[] }) {
      definition = value
      active.add('type')
      return () => { active.delete('type') }
    },
  })
  ctx.provide('sidebarRight', {
    registerCloseHandler: () => { active.add('close'); return () => { active.delete('close') } },
  })
  ctx.provide('shortcuts', {
    register: () => { active.add('shortcut'); return () => { active.delete('shortcut') } },
  })
  ctx.provide('slots', {
    inject: (_name: string, run: () => () => void) => run(),
    register: (options: { name: string }) => {
      active.add(options.name)
      return () => { active.delete(options.name) }
    },
  })
  apply(ctx)
  expect(definition).toMatchObject({ kind: 'amadeus-code-server' })
  expect(definition?.patterns).toBeUndefined()
  expect(active).toEqual(new Set([
    'locale', 'type', 'close', 'shortcut', 'sidebar.right.pane.tab',
    'sidebar.right.tab.document.actions', 'sidebar.right.tab.document.unpreviewable', 'sidebar.right.tab.files.actions',
    'plugins.bundle.config', 'plugins.row.config',
  ]))
  await ctx.fiber.dispose()
  expect(active.size).toBe(0)
})

it('contributes valid entries to actual keyed and list slot contracts', async () => {
  const ctx = new Context()
  const slots = new SlotCore()
  slots.register({
    name: 'root',
    children: {
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
      'sidebar.right.tab.document.actions': { kind: 'list', scope: 'session' },
      'sidebar.right.tab.document.unpreviewable': { kind: 'list', scope: 'session' },
      'sidebar.right.tab.files.actions': { kind: 'list', scope: 'session' },
      'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
      'plugins.row.config': { kind: 'keyed', scope: 'root' },
    },
  }, (_props: PropsRenderSlots<
    'sidebar.right.pane.tab' | 'sidebar.right.tab.document.actions' |
    'sidebar.right.tab.document.unpreviewable' | 'sidebar.right.tab.files.actions' | 'plugins.bundle.config' | 'plugins.row.config'
  >) => null)
  ctx.provide('locale', { bind: () => (key: string) => key, register: () => () => {} })
  ctx.provide('sidebarRightTabs', { register: () => () => {} })
  ctx.provide('sidebarRight', { registerCloseHandler: () => () => {} })
  ctx.provide('shortcuts', { register: () => () => {} })
  ctx.provide('slots', { inject: (_name: string, run: () => () => void) => run(), register: slots.register.bind(slots) })
  try {
    apply(ctx)
    expect(slots.entries('sidebar.right.pane.tab')).toHaveLength(1)
    expect(slots.entries('sidebar.right.tab.files.actions')).toHaveLength(1)
    expect(slots.entries('plugins.bundle.config')).toHaveLength(1)
    await ctx.fiber.dispose()
    expect(slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
  } finally {
    await ctx.fiber.dispose()
  }
})

it.each([
  ['http://localhost/', '/amadeus/code/'],
  ['dsh-app://app/', 'http://127.0.0.1:9000/'],
])('mounts the workbench in %s and removes it on disposal', async (pageUrl, expectedPrefix) => {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: pageUrl })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('MutationObserver', dom.window.MutationObserver)
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  dom.window.Element.prototype.getAnimations = () => []
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url)
    return new Response(JSON.stringify(url.startsWith('/amadeus/editor/workspace')
      ? {
        editorOrigin: 'http://127.0.0.1:9000', workspaceRoot: 'd:\\Projects\\Amadeus-next',
        bridgeMode: 'required', maxHotWorkspaces: 3, bridgeToken: 'a'.repeat(64),
      }
      : { result: { opened: true } }))
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
  if (!Body) throw new Error('Editor body was not registered')
  const container = dom.window.document.querySelector('main')
  if (!container) throw new Error('Missing test container')
  const reactRoot = createRoot(container)
  try {
    await act(async () => {
      reactRoot.render(createElement(Body!, {
        sessionId: 'session',
        useTabInfo: () => ({ sidebar: { fullscreen: false }, tab: {
          id: 'tab', visible: true,
          navigation: { params: { address: 'dsh-resource://file/session/session/src%20file.ts', line: 4 } },
        } }),
      }))
    })
    await vi.waitFor(() => { expect(dom.window.document.querySelector('iframe')).not.toBeNull() })
    await vi.waitFor(() => { expect(requests.some(url => url.startsWith('/amadeus/editor/open'))).toBe(true) })
    const src = dom.window.document.querySelector('iframe')?.getAttribute('src')
    expect(src).toBe(`${expectedPrefix}?folder=%2Fd%3A%2FProjects%2FAmadeus-next`)
    await act(async () => { reactRoot.unmount() })
    await ctx.fiber.dispose()
    expect(dom.window.document.querySelector('iframe')).toBeNull()
  } finally {
    await ctx.fiber.dispose()
    dom.window.close()
  }
})

it('recreates an evicted iframe when its retained tab becomes visible again', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'http://localhost/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('MutationObserver', dom.window.MutationObserver)
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  dom.window.Element.prototype.getAnimations = () => []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const session = new URL(url, 'http://localhost').searchParams.get('sessionId')
    return new Response(JSON.stringify({
      editorOrigin: 'http://127.0.0.1:9000', workspaceRoot: session === 'one' ? '/one' : '/two',
      bridgeMode: 'disabled', maxHotWorkspaces: 1, bridgeToken: 'a'.repeat(64),
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
  if (!Body) throw new Error('Editor body was not registered')
  const container = dom.window.document.querySelector('main')
  if (!container) throw new Error('Missing test container')
  const reactRoot = createRoot(container)
  const component = Body
  const draw = async (visible: string): Promise<void> => {
    await act(async () => {
      reactRoot.render(['one', 'two'].map(sessionId => createElement(component, {
        key: sessionId, sessionId,
        useTabInfo: () => ({ sidebar: { fullscreen: false }, tab: { id: sessionId, visible: sessionId === visible, navigation: {} } }),
      })))
    })
  }
  try {
    await draw('one')
    await vi.waitFor(() => { expect(dom.window.document.querySelector('iframe')?.getAttribute('src')).toContain('one') })
    const original = dom.window.document.querySelector('iframe')
    await draw('two')
    await vi.waitFor(() => { expect(dom.window.document.querySelector('iframe')?.getAttribute('src')).toContain('two') })
    expect(original?.isConnected).toBe(false)
    await draw('one')
    await vi.waitFor(() => { expect(dom.window.document.querySelector('iframe')?.getAttribute('src')).toContain('one') })
    expect(dom.window.document.querySelector('iframe')).not.toBe(original)
    await act(async () => { reactRoot.unmount() })
  } finally {
    await ctx.fiber.dispose()
    dom.window.close()
  }
})

it('retains frames on unknown state, cancel and multi-instance discard', async () => {
  const dom = new JSDOM('<!doctype html><body></body>')
  let state: WorkspaceDirtyState = { known: false, dirtyCount: 0, instanceCount: 0 }
  let decision: CloseDecision = 'cancel'
  let discarded = 0
  const pool = new FramePool(dom.window.document, 1, {
    state: () => Promise.resolve(state),
    save: () => Promise.resolve(),
    discard: () => { discarded++; return Promise.resolve() },
    confirm: () => Promise.resolve(decision),
  })
  try {
    const frame = await pool.acquire('/one', '/one')
    expect(frame).toBeDefined()
    expect(await pool.acquire('/two', '/two')).toBeUndefined()
    state = { known: true, dirtyCount: 1, instanceCount: 1 }
    expect(await pool.acquire('/two', '/two')).toBeUndefined()
    decision = 'discard'
    state = { known: true, dirtyCount: 1, instanceCount: 2 }
    expect(await pool.acquire('/two', '/two')).toBeUndefined()
    expect(discarded).toBe(0)
    expect(dom.window.document.querySelector('iframe')).toBe(frame)
  } finally {
    pool.dispose()
    expect(dom.window.document.querySelector('iframe')).toBeNull()
    dom.window.close()
  }
})

it('validates workspace and dirty-state responses from the host', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    editorOrigin: 'http://127.0.0.1:9000', workspaceRoot: '/project', bridgeMode: 'required', maxHotWorkspaces: 3, bridgeToken: 'a'.repeat(64),
  }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const signal = new AbortController().signal
  expect(await fetchWorkspace('session', signal)).toEqual({
    editorOrigin: 'http://127.0.0.1:9000', workspaceRoot: '/project', bridgeMode: 'required', maxHotWorkspaces: 3, bridgeToken: 'a'.repeat(64),
  })
  expect(fetchMock.mock.calls).toHaveLength(1)
  expect(parseDirtyState({ known: true, dirtyCount: 1, instanceCount: 2 })).toEqual({
    known: true, dirtyCount: 1, instanceCount: 2,
  })
  expect(() => parseDirtyState({ known: false, dirtyCount: 0, instanceCount: 0 })).toThrow()
  expect(() => parseDirtyState({ known: true, dirtyCount: 1, instanceCount: 0 })).toThrow()
})

it('rejects workspace responses without a valid editor origin', async () => {
  const base = { workspaceRoot: '/project', bridgeMode: 'required', maxHotWorkspaces: 3, bridgeToken: 'a'.repeat(64) }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(base))))
  await expect(fetchWorkspace('session', new AbortController().signal)).rejects.toThrow('Invalid editor workspace response')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...base, editorOrigin: 'file:///tmp' }))))
  await expect(fetchWorkspace('session', new AbortController().signal)).rejects.toThrow('Invalid editor origin')
})

it('sends session-scoped actions and rejects HTTP errors', async () => {
  const fetchMock = vi.fn(async () => new Response('failure', { status: 403 }))
  vi.stubGlobal('fetch', fetchMock)
  await expect(editorCommand('action', 'session', '/project', { action: 'saveAll' }, new AbortController().signal, 'a'.repeat(64)))
    .rejects.toThrow('403')
  expect(fetchMock).toHaveBeenCalledOnce()
})

it('restores a dirty tab and closes only after save is verified clean', async () => {
  let dirty = true
  const reopen = vi.fn()
  const close = vi.fn()
  const coordinator = new CloseCoordinator({
    state: () => Promise.resolve({ known: true, dirtyCount: dirty ? 1 : 0, instanceCount: 1 }),
    confirm: () => Promise.resolve('save'),
    save: () => { dirty = false; return Promise.resolve() },
    discard: () => Promise.resolve(),
    reopen,
    close,
    report: vi.fn(),
  })
  try {
    coordinator.closeRequested('session', '/project')
    await vi.waitFor(() => { expect(close).toHaveBeenCalledOnce() })
    expect(reopen).toHaveBeenCalledOnce()
    coordinator.closeRequested('session', '/project')
    await Promise.resolve()
    expect(reopen).toHaveBeenCalledOnce()
  } finally {
    coordinator.dispose()
  }
})

it('restores an unknown or unreachable workspace and never discards other windows', async () => {
  const reopen = vi.fn()
  const report = vi.fn()
  const discard = vi.fn(async () => {})
  const coordinator = new CloseCoordinator({
    state: () => Promise.resolve({ known: true, dirtyCount: 1, instanceCount: 2 }),
    confirm: () => Promise.resolve('discard'),
    save: () => Promise.resolve(),
    discard,
    reopen,
    close: vi.fn(),
    report,
  })
  try {
    coordinator.closeRequested('session', '/project')
    await vi.waitFor(() => { expect(report).toHaveBeenCalledOnce() })
    expect(reopen).toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()
  } finally {
    coordinator.dispose()
  }
})

it('does not call host actions after disposal during a pending state query', async () => {
  let finish: ((state: WorkspaceDirtyState) => void) | undefined
  const reopen = vi.fn()
  const close = vi.fn()
  const report = vi.fn()
  const coordinator = new CloseCoordinator({
    state: () => new Promise((resolve) => { finish = resolve }),
    confirm: () => Promise.resolve('save'),
    save: () => Promise.resolve(),
    discard: () => Promise.resolve(),
    reopen,
    close,
    report,
  })
  coordinator.closeRequested('session', '/project')
  coordinator.dispose()
  finish?.({ known: true, dirtyCount: 1, instanceCount: 1 })
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  expect(reopen).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  expect(report).not.toHaveBeenCalled()
})

it('rechecks state after save and only evicts after it becomes clean', async () => {
  const dom = new JSDOM('<!doctype html><body></body>')
  let dirty = true
  let saveWorks = false
  const pool = new FramePool(dom.window.document, 1, {
    state: () => Promise.resolve({ known: true, dirtyCount: dirty ? 1 : 0, instanceCount: 1 }),
    save: () => { if (saveWorks) dirty = false; return Promise.resolve() },
    discard: () => Promise.resolve(),
    confirm: () => Promise.resolve('save'),
  })
  try {
    const original = await pool.acquire('/one', '/one')
    expect(await pool.acquire('/two', '/two')).toBeUndefined()
    expect(dom.window.document.querySelector('iframe')).toBe(original)
    saveWorks = true
    const next = await pool.acquire('/two', '/two')
    expect(next).toBeDefined()
    expect(dom.window.document.querySelector('iframe')).toBe(next)
    expect(original?.isConnected).toBe(false)
  } finally {
    pool.dispose()
    dom.window.close()
  }
})

it('renders localized settings, validates URLs and saves only changed fields', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'http://localhost/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const mutate = vi.fn(async () => true)
  const snapshot = {
    status: 'ready' as const,
    writable: true,
    revision: 1,
    value: { executablePath: 'code-server', maxHotWorkspaces: 3 },
  }
  const ctx = new Context()
  let ConfigForm: ComponentType | undefined
  ctx.provide('locale', {
    bind: () => (key: keyof typeof zh) => zh[key], register: () => () => {},
    subscribe: () => () => {}, getSnapshot: () => ({ revision: 0 }),
  })
  ctx.provide('sidebarRightTabs', { register: () => () => {} })
  ctx.provide('sidebarRight', { registerCloseHandler: () => () => {} })
  ctx.provide('shortcuts', { register: () => () => {} })
  ctx.provide('configForms', {
    get: (id: string) => id === 'amadeus-editor' ? {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      mutate,
    } : undefined,
  })
  ctx.provide('slots', {
    inject: (_name: string, run: () => () => void) => run(),
    register(options: { name: string }, component: ComponentType) {
      if (options.name === 'plugins.bundle.config') ConfigForm = component
      return () => {}
    },
  })
  apply(ctx)
  if (!ConfigForm) throw new Error('Config form was not registered')
  const container = dom.window.document.querySelector('main')
  if (!container) throw new Error('Missing test container')
  const reactRoot = createRoot(container)
  try {
    await act(async () => { reactRoot.render(createElement(ConfigForm!)) })
    expect(container.textContent).toContain('编辑器配置')
    expect(container.textContent).toContain('本机启动')
    expect(container.textContent).toContain('高级选项')
    expect(container.textContent).toContain('默认 15000 毫秒')
    const select = container.querySelector('select')
    if (!select) throw new Error('Missing connection mode')
    await act(async () => {
      select.value = 'external'
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    const button = [...container.querySelectorAll('button')].find(button => button.textContent === zh.configSave)
    expect(button).not.toBeNull()
    await act(async () => { button?.click() })
    expect(container.textContent).toContain('请输入外部服务地址')
    expect(mutate).not.toHaveBeenCalled()
    const input = container.querySelector('input')
    if (!input) throw new Error('Missing external service input')
    await act(async () => {
      input.value = 'http://example.test/path'
      Simulate.change(input)
    })
    await act(async () => { button?.click() })
    expect(container.textContent).toContain('请输入不含路径')
    const numberInput = container.querySelector('input[type="number"]')
    if (!(numberInput instanceof dom.window.HTMLInputElement)) throw new Error('Missing timeout input')
    await act(async () => { numberInput.value = '-1'; Simulate.change(numberInput) })
    await act(async () => {
      input.value = 'http://127.0.0.1:8080'
      Simulate.change(input)
    })
    await act(async () => { button?.click() })
    expect(container.textContent).toContain('请输入大于零的整数')
    expect(mutate).not.toHaveBeenCalled()
    await act(async () => { numberInput.value = ''; Simulate.change(numberInput) })
    await act(async () => { button?.click() })
    expect(mutate).toHaveBeenCalledOnce()
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['upstream'], value: 'http://127.0.0.1:8080' }], 1)
    await act(async () => { reactRoot.unmount() })
  } finally {
    await ctx.fiber.dispose()
    dom.window.close()
  }
})

it('shows loading and read-only states and preserves an edited draft on a concurrent update', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'http://localhost/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let snapshot: {
    status: 'loading' | 'ready' | 'unavailable'
    writable: boolean
    revision: number | undefined
    value: Record<string, unknown> | undefined
  } = { status: 'loading', writable: false, revision: undefined, value: undefined }
  let listener: (() => void) | undefined
  const mutate = vi.fn(async () => true)
  const ctx = new Context()
  let ConfigForm: ComponentType<{ view: 'page' }> | undefined
  let locale: 'zh' | 'en' = 'en'
  let localeRevision = 0
  let localeListener: (() => void) | undefined
  ctx.provide('locale', {
    bind: () => (key: keyof typeof zh) => (locale === 'zh' ? zh[key] : en[key]),
    register: () => () => {},
    subscribe: (callback: () => void) => { localeListener = callback; return () => { localeListener = undefined } },
    getSnapshot: () => ({ revision: localeRevision }),
  })
  ctx.provide('sidebarRightTabs', { register: () => () => {} })
  ctx.provide('sidebarRight', { registerCloseHandler: () => () => {} })
  ctx.provide('shortcuts', { register: () => () => {} })
  ctx.provide('configForms', {
    get: () => ({
      getSnapshot: () => snapshot,
      subscribe: (callback: () => void) => { listener = callback; return () => { listener = undefined } },
      mutate,
    }),
  })
  ctx.provide('slots', {
    inject: (_name: string, run: () => () => void) => run(),
    register(options: { name: string }, component: ComponentType<{ view: 'page' }>) {
      if (options.name === 'plugins.bundle.config') ConfigForm = component
      return () => {}
    },
  })
  apply(ctx)
  if (!ConfigForm) throw new Error('Config form was not registered')
  const container = dom.window.document.querySelector('main')
  if (!container) throw new Error('Missing test container')
  const reactRoot = createRoot(container)
  try {
    await act(async () => { reactRoot.render(createElement(ConfigForm!, { view: 'page' })) })
    expect(container.textContent).toContain('Loading editor configuration')
    snapshot = { status: 'unavailable', writable: false, revision: undefined, value: undefined }
    await act(async () => { listener?.() })
    expect(container.textContent).toContain('Editor configuration is unavailable')
    snapshot = { status: 'ready', writable: false, revision: 1, value: { executablePath: 'code-server' } }
    await act(async () => { listener?.() })
    expect(container.textContent).toContain('This configuration is read-only')
    expect([...container.querySelectorAll('button')].find(button => button.textContent === (locale === 'zh' ? zh.configSave : en.configSave))?.hasAttribute('disabled')).toBe(true)
    snapshot = { ...snapshot, writable: true }
    await act(async () => { listener?.() })
    const input = container.querySelector('input')
    if (!input) throw new Error('Missing executable input')
    await act(async () => { input.value = '/my-editor'; Simulate.change(input) })
    await act(async () => { locale = 'zh'; localeRevision++; localeListener?.() })
    expect(container.textContent).toContain('编辑器配置')
    expect(input.value).toBe('/my-editor')
    snapshot = { ...snapshot, revision: 2, value: { executablePath: '/changed-remotely' } }
    await act(async () => { listener?.() })
    expect(input.value).toBe('/my-editor')
    expect(container.textContent).toContain('配置已在其他位置更改')
    expect([...container.querySelectorAll('button')].find(button => button.textContent === (locale === 'zh' ? zh.configSave : en.configSave))?.hasAttribute('disabled')).toBe(true)
    const reload = [...container.querySelectorAll('button')].find(button => button.textContent === '重新载入')
    if (!reload) throw new Error('Missing reload button')
    await act(async () => { reload.click() })
    expect(input.value).toBe('/changed-remotely')
    expect(mutate).not.toHaveBeenCalled()
    await act(async () => { reactRoot.unmount() })
  } finally {
    await ctx.fiber.dispose()
    dom.window.close()
  }
})

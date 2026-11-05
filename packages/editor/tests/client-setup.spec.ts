import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { EditorSetup } from '../src/client-setup.tsx'
import { zh } from '../src/locales.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('starts and cancels preparation only through explicit settings buttons', async () => {
  const dom = new JSDOM('<main></main>')
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let phase = 'idle'
  const requests: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${url}`)
    if (init?.method === 'POST') {
      expect(init.headers).toEqual({ 'x-amadeus-setup-token': 'test-token' })
      phase = url.endsWith('install') ? 'downloading' : 'cancelled'
    }
    return Response.json({ phase, supported: true, version: '4.145.0', directory: '/editor/runtime',
      source: 'https://github.com/coder/code-server/releases/download', completedBytes: 10, totalBytes: 100, token: 'test-token' })
  })
  const container = dom.window.document.querySelector('main')!
  const root = createRoot(container)
  const t = (key: keyof typeof zh): string => zh[key]
  try {
    await act(async () => { root.render(createElement(EditorSetup, { t, disabled: false })) })
    expect(requests).toEqual(['GET /amadeus/editor/setup'])
    const button = (text: string): HTMLButtonElement => {
      const result = [...container.querySelectorAll('button')].find(element => element.textContent === text)
      if (!result) throw new Error(`Missing button: ${text}`)
      return result
    }
    await act(async () => { button('下载并安装').click() })
    expect(requests).toContain('POST /amadeus/editor/setup?action=install')
    expect(container.querySelector('progress')?.value).toBe(10)
    await act(async () => { button('取消准备').click() })
    expect(requests).toContain('POST /amadeus/editor/setup?action=cancel')
    expect(container.textContent).toContain('安装已取消')
    expect(button('重试准备').disabled).toBe(false)
    await act(async () => { root.render(createElement(EditorSetup, { t, disabled: true })) })
    expect(button('重试准备').disabled).toBe(true)
  } finally { await act(async () => { root.unmount() }); dom.window.close() }
})

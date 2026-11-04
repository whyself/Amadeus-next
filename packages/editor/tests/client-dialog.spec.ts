import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import { confirmClose } from '../src/client-dialog.ts'
import { zh } from '../src/locales.ts'

it('requires an explicit close decision and removes an aborted modal', async () => {
  const dom = new JSDOM('<!doctype html><button id="previous">previous</button>')
  const { document, HTMLDialogElement } = dom.window
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')) }
  const copy = { title: zh.title, dirty: zh.dirty, multiple: zh.multiple, save: zh.save, discard: zh.discard, cancel: zh.cancel }
  const controller = new AbortController()
  try {
    for (const decision of ['save', 'discard', 'cancel'] as const) {
      const pending = confirmClose(document, { known: true, dirtyCount: 1, instanceCount: 1 }, copy, controller.signal)
      const button = document.querySelector<HTMLButtonElement>(`button[data-decision="${decision}"]`)
      expect(button?.textContent).toBe(copy[decision])
      button?.click()
      expect(await pending).toBe(decision)
      expect(document.querySelector('dialog')).toBeNull()
    }
    const multiple = confirmClose(document, { known: true, dirtyCount: 1, instanceCount: 2 }, copy, controller.signal)
    expect(document.querySelector('[data-decision="discard"]')).toBeNull()
    controller.abort()
    expect(await multiple).toBe('cancel')
    expect(document.querySelector('dialog')).toBeNull()
  } finally {
    dom.window.close()
  }
})

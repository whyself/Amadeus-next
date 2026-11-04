import type { CloseDecision, WorkspaceDirtyState } from './frame-pool.ts'

interface CloseCopy {
  title: string
  dirty: string
  multiple: string
  save: string
  discard: string
  cancel: string
}

/**
 * Ask how to close a dirty workbench; cancellation and disposal preserve its drafts.
 * @param document - Workbench owner's document.
 * @param state - Dirty state across the workspace's active windows.
 * @param copy - Localized labels from the host locale.
 * @param signal - Cancellation owned by the close or eviction operation.
 * @returns Explicit close decision, defaulting to cancel.
 */
export function confirmClose(document: Document, state: WorkspaceDirtyState, copy: CloseCopy, signal: AbortSignal): Promise<CloseDecision> {
  if (signal.aborted) return Promise.resolve('cancel')
  const view = document.defaultView
  if (!view) return Promise.resolve('cancel')
  return new Promise((resolve) => {
    const previousFocus = document.activeElement
    const dialog = document.createElement('dialog')
    dialog.setAttribute('aria-label', copy.title)
    dialog.className = 'amadeus-editor-confirm'
    dialog.style.cssText = 'box-sizing:border-box;width:min(440px,calc(100vw - 32px));padding:24px;border:1px solid var(--dsw-alias-border-l4,#666);border-radius:16px;color:var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-background-primary,Canvas);font:inherit;box-shadow:0 16px 64px #0006'
    const style = document.createElement('style')
    style.textContent = '.amadeus-editor-confirm::backdrop{background:rgb(0 0 0 / 55%)}.amadeus-editor-confirm button:focus-visible{outline:2px solid Highlight;outline-offset:3px}'
    dialog.appendChild(style)
    const heading = document.createElement('h2')
    heading.textContent = copy.dirty
    heading.style.cssText = 'margin:0 0 16px;font-size:16px;line-height:1.5'
    dialog.appendChild(heading)
    if (state.instanceCount > 1) {
      const detail = document.createElement('p')
      detail.textContent = copy.multiple
      detail.style.cssText = 'font-size:14px;line-height:1.6'
      dialog.appendChild(detail)
    }
    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-end;gap:12px'
    dialog.appendChild(actions)
    let settled = false
    const finish = (decision: CloseDecision): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      dialog.close()
      dialog.remove()
      if (previousFocus instanceof view.HTMLElement && previousFocus.isConnected) previousFocus.focus()
      resolve(decision)
    }
    const abort = (): void => { finish('cancel') }
    for (const decision of ['save', 'discard', 'cancel'] as const) {
      if (decision === 'discard' && state.instanceCount !== 1) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = copy[decision]
      button.dataset.decision = decision
      button.style.cssText = 'padding:10px 14px;min-height:40px;border:1px solid var(--dsw-alias-border-l4,#666);border-radius:8px;color:inherit;background:transparent;font:inherit;cursor:pointer'
      button.autofocus = decision === 'cancel'
      button.addEventListener('click', () => { finish(decision) })
      actions.appendChild(button)
    }
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish('cancel') })
    dialog.addEventListener('close', () => { finish('cancel') })
    signal.addEventListener('abort', abort, { once: true })
    document.body.appendChild(dialog)
    dialog.showModal()
  })
}

/** Result of querying all bridge instances for one workspace. */
export interface WorkspaceDirtyState {
  known: boolean
  dirtyCount: number
  instanceCount: number
}

/** User decision when a workspace contains unsaved changes. */
export type CloseDecision = 'save' | 'discard' | 'cancel'

/** Operations used to protect a workspace before removing its iframe. */
export interface FrameProtection {
  state(workspace: string, signal: AbortSignal): Promise<WorkspaceDirtyState>
  save(workspace: string, signal: AbortSignal): Promise<void>
  discard(workspace: string, signal: AbortSignal): Promise<void>
  confirm(workspace: string, state: WorkspaceDirtyState, signal: AbortSignal): Promise<CloseDecision>
}

interface Frame {
  element: HTMLIFrameElement
  protected: boolean
  owner?: object
  placements: Map<object, { bounds: DOMRect; title: string; zIndex: number }>
}

/**
 * Owns a bounded set of workbench frames and refuses eviction when their dirty state is unknown.
 */
export class FramePool {
  private readonly frames = new Map<string, Frame>()
  private readonly controller = new AbortController()
  private readonly layer: HTMLDivElement
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param document - Document that owns the retained frames.
   * @param limit - Maximum number of hot workspaces.
   * @param protection - Bridge and confirmation operations.
   */
  constructor(private readonly document: Document, private readonly limit: number, private readonly protection: FrameProtection) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Frame limit must be a positive integer')
    this.layer = document.createElement('div')
    this.layer.style.cssText = 'display:contents;pointer-events:none'
    document.body.appendChild(this.layer)
  }

  /**
   * Get or create a frame, evicting an older workspace only after protection succeeds.
   * @param workspace - Canonical workspace path.
   * @param url - Workbench URL used for a new frame.
   * @returns The retained iframe, or undefined when eviction was refused.
   */
  acquire(workspace: string, url: string): Promise<HTMLIFrameElement | undefined> {
    const result = this.queue.then(() => this.acquireFrame(workspace, url))
    this.queue = result.then(() => {}, () => {})
    return result
  }

  private async acquireFrame(workspace: string, url: string): Promise<HTMLIFrameElement | undefined> {
    this.controller.signal.throwIfAborted()
    const existing = this.frames.get(workspace)
    if (existing) {
      this.frames.delete(workspace)
      this.frames.set(workspace, existing)
      return existing.element
    }
    if (this.frames.size >= this.limit) {
      const oldest = this.frames.entries().next().value
      if (oldest === undefined || !await this.remove(oldest[0])) return undefined
      this.controller.signal.throwIfAborted()
    }
    const element = this.document.createElement('iframe')
    element.name = `amadeus-editor-${crypto.randomUUID()}`
    element.dataset.sidebarBrowserFrame = 'iframe'
    element.src = url
    element.style.cssText = 'position:fixed;border:0;display:none;pointer-events:auto;background:var(--dsw-alias-bg-base,Canvas)'
    element.style.colorScheme = this.document.body.hasAttribute('data-ds-dark-theme')
      || this.document.documentElement.classList.contains('dark')
      || this.document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
    this.layer.appendChild(element)
    this.frames.set(workspace, { element, protected: false, placements: new Map() })
    return element
  }

  /**
   * Check whether a workspace iframe is still retained and attached.
   * @param workspace - Canonical workspace path.
   * @returns Whether the pool owns an attached frame.
   */
  has(workspace: string): boolean {
    return this.frames.get(workspace)?.element.isConnected === true
  }

  /**
   * Show a retained iframe at a measured placeholder and claim its placement.
   * @param workspace - Canonical workspace path.
   * @param bounds - Visible placeholder bounds.
   * @param owner - Identity of this visible placeholder's effect.
   * @param title - Current localized accessible frame title.
   * @param zIndex - Layer above the placeholder's current stacking contexts.
   */
  place(workspace: string, bounds: DOMRect, owner: object, title: string, zIndex: number): void {
    const frame = this.frames.get(workspace)
    if (!frame) return
    if (bounds.width <= 0 || bounds.height <= 0) { this.hide(workspace, owner); return }
    frame.placements.delete(owner)
    frame.placements.set(owner, { bounds, title, zIndex })
    frame.owner = owner
    frame.element.title = title
    Object.assign(frame.element.style, {
      zIndex: String(zIndex),
      display: 'block', left: `${bounds.left}px`, top: `${bounds.top}px`,
      width: `${bounds.width}px`, height: `${bounds.height}px`,
    })
  }

  /**
   * Release placement without allowing another placeholder's cleanup to hide the frame.
   * @param workspace - Canonical workspace path.
   * @param owner - Identity that last claimed this frame's placement.
   */
  hide(workspace: string, owner: object): void {
    const frame = this.frames.get(workspace)
    if (!frame) return
    frame.placements.delete(owner)
    if (frame.owner !== owner) return
    const fallback = [...frame.placements.entries()].at(-1)
    if (fallback) {
      this.place(workspace, fallback[1].bounds, fallback[0], fallback[1].title, fallback[1].zIndex)
      return
    }
    delete frame.owner
    frame.element.style.display = 'none'
  }

  /**
   * Remove a frame after a successful dirty-state check and any necessary user decision.
   * @param workspace - Canonical workspace path.
   * @returns Whether removal succeeded.
   */
  async remove(workspace: string): Promise<boolean> {
    const frame = this.frames.get(workspace)
    if (!frame) return true
    if (frame.protected) return false
    frame.protected = true
    const signal = this.controller.signal
    try {
      let state = await this.protection.state(workspace, signal)
      signal.throwIfAborted()
      if (!state.known) return false
      if (state.dirtyCount > 0) {
        const decision = await this.protection.confirm(workspace, state, signal)
        signal.throwIfAborted()
        if (decision === 'cancel') return false
        if (decision === 'save') await this.protection.save(workspace, signal)
        else {
          if (state.instanceCount !== 1) return false
          await this.protection.discard(workspace, signal)
        }
        state = await this.protection.state(workspace, signal)
        signal.throwIfAborted()
        if (!state.known || state.dirtyCount !== 0) return false
      }
      if (this.frames.get(workspace) !== frame) return false
      this.frames.delete(workspace)
      frame.element.remove()
      return true
    } finally {
      frame.protected = false
    }
  }

  /** Cancel pending work and remove all owned DOM. */
  dispose(): void {
    this.controller.abort()
    this.frames.clear()
    this.layer.remove()
  }
}

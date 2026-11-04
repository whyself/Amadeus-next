import type { CloseDecision, WorkspaceDirtyState } from './frame-pool.ts'

/** Host operations used to restore and resolve an asynchronously checked tab close. */
export interface CloseHost {
  state(sessionId: string, workspace: string, signal: AbortSignal): Promise<WorkspaceDirtyState>
  confirm(sessionId: string, workspace: string, state: WorkspaceDirtyState, signal: AbortSignal): Promise<CloseDecision>
  save(sessionId: string, workspace: string, signal: AbortSignal): Promise<void>
  discard(sessionId: string, workspace: string, signal: AbortSignal): Promise<void>
  reopen(sessionId: string): void
  close(sessionId: string): void
  report(sessionId: string, error: unknown): void
}

/**
 * Coordinates synchronous tab removal with asynchronous draft protection.
 */
export class CloseCoordinator {
  private readonly controller = new AbortController()
  private readonly pending = new Set<string>()
  private readonly bypass = new Set<string>()

  /** @param host - Session-scoped host and bridge operations. */
  constructor(private readonly host: CloseHost) {}

  /**
   * Check a close after the host has synchronously removed the tab.
   * @param sessionId - Session containing the tab.
   * @param workspace - Canonical workspace for the retained iframe.
   */
  closeRequested(sessionId: string, workspace: string): void {
    if (this.controller.signal.aborted || this.bypass.delete(sessionId)) return
    if (this.pending.has(sessionId)) {
      queueMicrotask(() => {
        if (!this.controller.signal.aborted) this.host.reopen(sessionId)
      })
      return
    }
    this.pending.add(sessionId)
    void this.check(sessionId, workspace).catch((error: unknown) => {
      if (!this.controller.signal.aborted) {
        this.host.reopen(sessionId)
        this.host.report(sessionId, error)
      }
    }).finally(() => { this.pending.delete(sessionId) })
  }

  private async check(sessionId: string, workspace: string): Promise<void> {
    const signal = this.controller.signal
    const state = await this.host.state(sessionId, workspace, signal)
    signal.throwIfAborted()
    if (state.known && state.dirtyCount === 0) return
    this.host.reopen(sessionId)
    if (!state.known) {
      this.host.report(sessionId, new Error('Editor draft state is unknown'))
      return
    }
    const decision = await this.host.confirm(sessionId, workspace, state, signal)
    signal.throwIfAborted()
    if (decision === 'cancel') return
    if (decision === 'save') await this.host.save(sessionId, workspace, signal)
    else {
      if (state.instanceCount !== 1) throw new Error('Cannot discard changes in multiple workspace windows')
      await this.host.discard(sessionId, workspace, signal)
    }
    const verified = await this.host.state(sessionId, workspace, signal)
    signal.throwIfAborted()
    if (!verified.known || verified.dirtyCount !== 0) throw new Error('Editor changes remain unsaved')
    this.bypass.add(sessionId)
    this.host.close(sessionId)
  }

  /** Abort pending confirmations and prevent late UI operations. */
  dispose(): void {
    this.controller.abort()
    this.pending.clear()
    this.bypass.clear()
  }
}

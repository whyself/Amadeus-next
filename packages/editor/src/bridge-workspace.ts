import { BridgeClient, type BridgeCommand } from './bridge-client.ts'
import { readBridgeRegistrations, type BridgeRegistration } from './bridge-registry.ts'
import { workspaceTarget } from './security.ts'

function dirty(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('dirty' in value) || typeof value.dirty !== 'boolean') {
    throw new Error('Invalid bridge dirty state')
  }
  return value.dirty
}

/**
 * Coordinates workspace bridge commands and keeps unknown states closed to destructive actions.
 */
export class WorkspaceBridges {
  /**
   * @param directory - Private bridge registration directory.
   * @param client - Request owner shared with the plugin lifecycle.
   * @param timeoutMs - Maximum time per bridge request.
   */
  constructor(private readonly directory: string, private readonly client: BridgeClient, private readonly timeoutMs: number) {}

  /**
   * Query every registered workspace instance.
   * @param workspace - Canonical workspace directory.
   * @returns Instance count and whether any instance has unsaved changes.
   */
  async dirtyState(workspace: string): Promise<{ count: number; dirty: boolean }> {
    const entries = await this.entries(workspace)
    const states = await Promise.all(entries.map(entry => this.state(entry)))
    return { count: entries.length, dirty: states.some(Boolean) }
  }

  /**
   * Save dirty instances and verify a fresh scan is clean.
   * @param workspace - Canonical workspace directory.
   * @returns Whether all instances were saved and are clean.
   */
  async saveAll(workspace: string): Promise<boolean> {
    const entries = await this.entries(workspace)
    for (const entry of entries) {
      if (!await this.state(entry)) continue
      const result = await this.client.request(entry, { action: 'saveAll' }, this.timeoutMs)
      if (typeof result !== 'object' || result === null || !('saved' in result) || result.saved !== true || dirty(result)) return false
    }
    return !(await this.dirtyState(workspace)).dirty
  }

  /**
   * Discard changes only when a single workspace instance is registered, then verify it is clean.
   * @param workspace - Canonical workspace directory.
   * @returns Whether the instance is clean after the operation.
   */
  async revertAndClose(workspace: string): Promise<boolean> {
    const entries = await this.entries(workspace)
    if (entries.length !== 1) throw new Error('Cannot discard changes with multiple workspace instances')
    const entry = entries[0]
    if (!entry) throw new Error('No workspace bridge')
    const result = await this.client.request(entry, { action: 'revertAndClose' }, this.timeoutMs)
    if (dirty(result)) return false
    const fresh = await this.entries(workspace)
    if (fresh.length !== 1 || fresh[0]?.instanceId !== entry.instanceId) return false
    return !await this.state(entry)
  }

  /**
   * Forward a non-destructive command to a workspace instance.
   * @param workspace - Canonical workspace directory.
   * @param command - File-open or appearance command.
   * @returns Bridge response.
   */
  async send(workspace: string, command: Extract<BridgeCommand, { action: 'openFile' | 'appearance' }>): Promise<unknown> {
    const entries = await this.entries(workspace)
    const safe = command.action === 'openFile'
      ? { ...command, path: await workspaceTarget(workspace, command.path) }
      : command
    return Promise.any(entries.map(entry => this.client.request(entry, safe, this.timeoutMs)))
  }

  private async entries(workspace: string): Promise<BridgeRegistration[]> {
    const entries = await readBridgeRegistrations(this.directory, workspace)
    if (entries.length === 0) throw new Error('No workspace bridge')
    return entries
  }

  private async state(entry: BridgeRegistration): Promise<boolean> {
    return dirty(await this.client.request(entry, { action: 'dirtyState' }, this.timeoutMs))
  }
}

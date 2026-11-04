import type { BridgeRegistration } from './bridge-registry.ts'

/** Commands supported by a workspace bridge. */
export type BridgeCommand =
  | { action: 'dirtyState' }
  | { action: 'saveAll' }
  | { action: 'revertAndClose' }
  | { action: 'openFile'; path: string; line?: number; column?: number }
  | { action: 'appearance'; theme: string }

/**
 * Owns cancellable requests to local workspace bridge instances.
 */
export class BridgeClient {
  private readonly controller = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  /**
   * Send a command to a loopback bridge.
   * @param registration - Endpoint and bearer token from a validated registration.
   * @param command - Command to execute.
   * @param timeoutMs - Maximum duration of the request.
   * @returns The parsed response body.
   */
  request(registration: BridgeRegistration, command: BridgeCommand, timeoutMs: number): Promise<unknown> {
    this.controller.signal.throwIfAborted()
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)])
    const operation = this.perform(registration, command, signal)
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }

  /**
   * Abort and settle all requests owned by this client.
   * @returns A promise that resolves when every pending request settles.
   */
  async dispose(): Promise<void> {
    this.controller.abort()
    await Promise.allSettled(this.pending)
  }

  private async perform(registration: BridgeRegistration, command: BridgeCommand, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${registration.port}/command`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(command),
      signal,
    })
    if (!response.ok) throw new Error(`Bridge request failed: ${response.status}`)
    return response.json()
  }
}

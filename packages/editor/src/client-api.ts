import type { WorkspaceDirtyState } from './frame-pool.ts'

/** Host-provided editor workspace and client settings. */
export interface EditorWorkspace {
  editorOrigin: string
  workspaceRoot: string
  bridgeMode: 'required' | 'disabled'
  maxHotWorkspaces: number
  bridgeToken: string
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Editor API failed: ${response.status}`)
  return response.json()
}

/**
 * Request the effective workspace for a session.
 * @param sessionId - Session whose workspace is being opened.
 * @param signal - Cancellation for the request.
 * @returns Validated workspace path and settings.
 */
export async function fetchWorkspace(sessionId: string, signal: AbortSignal): Promise<EditorWorkspace> {
  const params = new URLSearchParams({ sessionId })
  const result = await responseJson(await fetch(`/amadeus/editor/workspace?${params}`, { signal }))
  if (typeof result !== 'object' || result === null
    || !('workspaceRoot' in result) || typeof result.workspaceRoot !== 'string' || !result.workspaceRoot
    || !('editorOrigin' in result) || typeof result.editorOrigin !== 'string'
    || !('bridgeMode' in result) || (result.bridgeMode !== 'required' && result.bridgeMode !== 'disabled')
    || !('maxHotWorkspaces' in result) || typeof result.maxHotWorkspaces !== 'number'
    || !Number.isSafeInteger(result.maxHotWorkspaces) || result.maxHotWorkspaces < 1
    || !('bridgeToken' in result) || typeof result.bridgeToken !== 'string' || !/^[a-f0-9]{64}$/.test(result.bridgeToken)) {
    throw new Error('Invalid editor workspace response')
  }
  const origin = new URL(result.editorOrigin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid editor origin')
  return {
    editorOrigin: origin.origin,
    workspaceRoot: result.workspaceRoot, bridgeMode: result.bridgeMode,
    maxHotWorkspaces: result.maxHotWorkspaces, bridgeToken: result.bridgeToken,
  }
}

/**
 * Send an editor bridge command for one session and workspace.
 * @param endpoint - Editor bridge endpoint.
 * @param sessionId - Session that owns the workspace.
 * @param workspace - Canonical workspace path.
 * @param command - JSON command submitted to the bridge.
 * @param signal - Cancellation for the request.
 * @param token - Capability received from the workspace endpoint.
 * @returns Parsed JSON response.
 */
export async function editorCommand(
  endpoint: 'action' | 'open' | 'settings', sessionId: string, workspace: string,
  command: object, signal: AbortSignal, token: string,
): Promise<unknown> {
  const params = new URLSearchParams({ sessionId, directory: workspace })
  return responseJson(await fetch(`/amadeus/editor/${endpoint}?${params}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-amadeus-bridge-token': token },
    body: JSON.stringify(command), signal,
  }))
}

/**
 * Validate a dirty-state response without treating unknown data as clean.
 * @param result - Untrusted bridge response.
 * @returns Validated state.
 */
export function parseDirtyState(result: unknown): WorkspaceDirtyState {
  if (typeof result !== 'object' || result === null
    || !('known' in result) || result.known !== true
    || !('dirtyCount' in result) || typeof result.dirtyCount !== 'number'
    || !Number.isSafeInteger(result.dirtyCount) || result.dirtyCount < 0
    || !('instanceCount' in result) || typeof result.instanceCount !== 'number'
    || !Number.isSafeInteger(result.instanceCount) || result.instanceCount < 1
    || result.dirtyCount > result.instanceCount) {
    throw new Error('Invalid editor dirty state')
  }
  return { known: true, dirtyCount: result.dirtyCount, instanceCount: result.instanceCount }
}

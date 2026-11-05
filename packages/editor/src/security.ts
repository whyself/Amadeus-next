import { createHash, timingSafeEqual } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingHttpHeaders } from 'node:http'

/**
 * Match a request to an explicitly allowed local or public origin.
 * @param headers - Request Host and optional browser Origin metadata.
 * @param origins - Trusted deployment origins, without paths or credentials.
 * @returns The matching origin, or undefined when Host and Origin do not agree.
 */
export function requestOrigin(headers: IncomingHttpHeaders, origins: readonly string[]): string | undefined {
  for (const value of origins) {
    const origin = new URL(value)
    if (headers.host !== origin.host) continue
    if (headers.origin !== undefined && headers.origin !== origin.origin) continue
    return origin.origin
  }
  return undefined
}

/**
 * Resolve a workspace to its canonical path for bridge registration.
 * @param directory - Existing workspace directory.
 * @returns Canonical path and its SHA-256 registration key.
 */
export async function workspaceIdentity(directory: string): Promise<{ root: string; key: string }> {
  let root = await realpath(directory)
  if (process.platform === 'win32') root = root.replace(/^[A-Z]:/, drive => drive.toLowerCase())
  return { root, key: createHash('sha256').update(root).digest('hex') }
}

/**
 * Resolve a target and reject paths escaping a canonical workspace.
 * @param root - Existing workspace root.
 * @param target - Existing target path.
 * @returns Canonical target path.
 */
export async function workspaceTarget(root: string, target: string): Promise<string> {
  const canonicalRoot = await realpath(root)
  const canonicalTarget = await realpath(path.resolve(canonicalRoot, target))
  const relative = path.relative(canonicalRoot, canonicalTarget)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Target is outside the workspace')
  }
  return canonicalTarget
}

/**
 * Check browser origin metadata for a state-changing request.
 * @param headers - Incoming request headers.
 * @param origin - Expected external origin.
 * @returns Whether the request passes the same-origin policy.
 */
export function isSameOrigin(headers: IncomingHttpHeaders, origin: string): boolean {
  const site = headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const supplied = headers.origin
  if (supplied === undefined) return site === 'same-origin'
  try {
    return new URL(supplied).origin === new URL(origin).origin
  } catch {
    return false
  }
}

/**
 * Compare a bridge bearer token without exposing matching prefix length.
 * @param authorization - Incoming Authorization header.
 * @param token - Expected bridge token.
 * @returns Whether the header contains the expected token.
 */
export function validBearer(authorization: string | undefined, token: string): boolean {
  if (!authorization?.startsWith('Bearer ')) return false
  const actual = Buffer.from(authorization.slice(7))
  const expected = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

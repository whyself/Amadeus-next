import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { workspaceIdentity } from './security.ts'

/** A bridge endpoint discovered in the private registration directory. */
export interface BridgeRegistration {
  instanceId: string
  workspaceRoot: string
  port: number
  token: string
  pid: number
}

function parseRegistration(value: unknown): BridgeRegistration | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('instanceId' in value) || typeof value.instanceId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.instanceId)) return undefined
  if (!('workspaceRoot' in value) || typeof value.workspaceRoot !== 'string' || !path.isAbsolute(value.workspaceRoot)) return undefined
  if (!('port' in value) || typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return undefined
  if (!('token' in value) || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/i.test(value.token)) return undefined
  if (!('pid' in value) || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1) return undefined
  return { instanceId: value.instanceId, workspaceRoot: value.workspaceRoot, port: value.port, token: value.token, pid: value.pid }
}

/**
 * Read validated registrations for a canonical workspace.
 * @param directory - Private bridge registration directory.
 * @param workspace - Existing workspace directory.
 * @returns Registrations whose filename, identity and canonical workspace agree.
 * @throws When a matching registration cannot be verified.
 */
export async function readBridgeRegistrations(directory: string, workspace: string): Promise<BridgeRegistration[]> {
  const identity = await workspaceIdentity(workspace)
  const names = await readdir(directory)
  const registrations: BridgeRegistration[] = []
  for (const name of names) {
    if (!name.startsWith(`${identity.key}-`) || !name.endsWith('.json')) continue
    let value: unknown
    try {
      value = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw new Error(`Invalid bridge registration: ${name}`, { cause: error })
    }
    const registration = parseRegistration(value)
    if (!registration || name !== `${identity.key}-${registration.instanceId}.json`) {
      throw new Error(`Invalid bridge registration: ${name}`)
    }
    let registeredIdentity: { root: string; key: string }
    try {
      registeredIdentity = await workspaceIdentity(registration.workspaceRoot)
    } catch (error) {
      throw new Error(`Invalid bridge workspace: ${name}`, { cause: error })
    }
    if (registeredIdentity.key !== identity.key) throw new Error(`Bridge workspace mismatch: ${name}`)
    registrations.push(registration)
  }
  return registrations
}

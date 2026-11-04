import { afterEach, expect, it, vi } from 'vitest'
import { BridgeClient } from '../src/bridge-client.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('authenticates bridge commands and aborts outstanding requests on disposal', async () => {
  let receivedSignal: AbortSignal | undefined
  const fetchMock = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    receivedSignal = options.signal ?? undefined
    receivedSignal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
  }))
  vi.stubGlobal('fetch', fetchMock)
  const client = new BridgeClient()
  const request = client.request({
    instanceId: 'a0000000-0000-4000-8000-000000000000',
    workspaceRoot: '/',
    port: 1234,
    token: 'a'.repeat(64),
    pid: 1,
  }, { action: 'dirtyState' }, 5000)
  const rejected = expect(request).rejects.toThrow('aborted')
  expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({ authorization: `Bearer ${'a'.repeat(64)}` })
  await client.dispose()
  await rejected
  expect(receivedSignal?.aborted).toBe(true)
  expect(() => client.request({
    instanceId: '', workspaceRoot: '/', port: 1, token: '', pid: 1,
  }, { action: 'dirtyState' }, 1000)).toThrow()
})

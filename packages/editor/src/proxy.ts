import http, { type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import type { Duplex } from 'node:stream'
import { TLSSocket } from 'node:tls'
import { isSameOrigin } from './security.ts'

const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']

/**
 * Creates a reverse proxy whose active requests and upgraded streams are owned by the caller.
 * @param upstream - HTTP or HTTPS upstream origin.
 * @param prefix - Public proxy path prefix.
 * @param registerProduct - Registers the workbench's exact upgrade path before HTML delivery.
 * @param publicOrigin - Resolves the matching trusted browser origin from upgrade headers.
 * @returns Request handlers and a synchronous disposer.
 */
export function createProxy(
  upstream: string, prefix = '/amadeus/code',
  registerProduct?: (path: string) => void, publicOrigin?: (headers: IncomingHttpHeaders) => string | undefined,
) {
  const target = new URL(upstream)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('Editor upstream must be an HTTP(S) origin without credentials')
  }
  const transport = target.protocol === 'https:' ? https : http
  const active = new Set<ClientRequest | Duplex | IncomingMessage>()
  let closed = false

  function track<T extends ClientRequest | Duplex | IncomingMessage>(resource: T): T {
    active.add(resource)
    resource.once('close', () => { active.delete(resource) })
    return resource
  }

  function upstreamPath(url: string | undefined): string | undefined {
    if (!url || /[\x00-\x20\x7f#\\]/.test(url) || /%(?![\da-f]{2})/i.test(url)) return undefined
    const pathname = url.split('?')[0]
    if (!pathname || (pathname !== prefix && !pathname.startsWith(`${prefix}/`))) return undefined
    try {
      const decoded = decodeURIComponent(pathname)
      if (/[\x00-\x1f\x7f\\]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) return undefined
    } catch {
      return undefined
    }
    const result = url.slice(prefix.length)
    return result.startsWith('/') ? result : `/${result}`
  }

  function requestHeaders(req: IncomingMessage, upgrade: boolean, origin?: string): IncomingHttpHeaders {
    const named = (req.headers.connection ?? '').split(',').map(name => name.trim().toLowerCase())
    const blocked = new Set([...hopHeaders, ...named, 'cookie', 'authorization', 'forwarded'])
    const headers: IncomingHttpHeaders = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !blocked.has(name)))
    headers.host = target.host
    headers['x-forwarded-host'] = req.headers.host ?? target.host
    headers['x-forwarded-prefix'] = prefix
    if (upgrade) {
      if (origin !== undefined) headers['x-forwarded-proto'] = new URL(origin).protocol.slice(0, -1)
      headers.connection = 'Upgrade'
      headers.upgrade = 'websocket'
    }
    return headers
  }

  function responseHeaders(source: IncomingHttpHeaders): IncomingHttpHeaders {
    const named = (source.connection ?? '').split(',').map(name => name.trim().toLowerCase())
    const blocked = new Set([...hopHeaders, ...named])
    const headers: IncomingHttpHeaders = Object.fromEntries(Object.entries(source).filter(([name]) => !blocked.has(name)))
    const location = headers.location
    if (location?.startsWith('/') && !location.startsWith('//')) headers.location = prefix + location
    else if (location?.startsWith(`${target.origin}/`)) headers.location = prefix + location.slice(target.origin.length)
    return headers
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const path = upstreamPath(req.url)
    if (!path || closed) {
      res.writeHead(closed ? 503 : 400).end()
      return
    }
    if (req.url?.split('?')[0] === prefix) {
      res.writeHead(307, { location: `${prefix}/${req.url.slice(prefix.length)}` }).end()
      return
    }
    const headers = requestHeaders(req, false)
    const workbench = req.method === 'GET' && path.split('?')[0] === '/'
    if (workbench) headers['accept-encoding'] = 'identity'
    const outgoing = track(transport.request(target, { method: req.method, path, headers }))
    outgoing.on('response', (incoming) => {
      track(incoming)
      if (workbench && registerProduct && incoming.statusCode === 200 && incoming.headers['content-type']?.includes('text/html')) {
        const chunks: Buffer[] = []
        let size = 0
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 4 * 1024 * 1024) {
            incoming.destroy()
            if (!res.headersSent) res.writeHead(502).end('Editor workbench response too large')
            return
          }
          chunks.push(chunk)
        })
        incoming.once('end', () => {
          const body = Buffer.concat(chunks)
          const match = body.toString('utf8').match(/(stable-[0-9a-f]{10,64}|insider-[0-9a-f]{10,64})\/static\/out\/vs\/code\/browser\/workbench\/workbench\.js/)
          if (!match?.[1]) { res.writeHead(502).end('Editor workbench product path missing'); return }
          try {
            registerProduct(`${prefix}/${match[1]}`)
            res.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming.headers)).end(body)
          } catch {
            res.writeHead(502).end('Editor upgrade registration failed')
          }
        })
        incoming.once('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy() })
        return
      }
      res.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming.headers))
      incoming.once('error', () => { res.destroy() })
      incoming.pipe(res)
    })
    outgoing.once('error', () => {
      if (!res.headersSent) res.writeHead(502).end('Editor unavailable')
      else res.destroy()
    })
    req.once('aborted', () => { outgoing.destroy() })
    res.once('close', () => { outgoing.destroy() })
    req.pipe(outgoing)
  }

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = upstreamPath(req.url)
    const host = req.headers.host
    const forwarded = req.headers['x-forwarded-proto']
    const protocol = req.socket instanceof TLSSocket || forwarded === 'https' ? 'https' : 'http'
    const origin = publicOrigin === undefined ? (host ? `${protocol}://${host}` : '') : publicOrigin(req.headers)
    if (!path || closed || !host || !origin || host !== new URL(origin).host
      || !isSameOrigin(req.headers, origin) || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.destroy()
      return
    }
    track(socket)
    const outgoing = track(transport.request(target, { method: req.method, path, headers: requestHeaders(req, true, origin) }))
    const fail = () => { outgoing.destroy(); socket.destroy() }
    socket.once('error', fail)
    socket.once('close', () => { outgoing.destroy() })
    outgoing.once('error', () => { socket.destroy() })
    outgoing.once('response', fail)
    outgoing.once('upgrade', (incoming, remote, upstreamHead) => {
      track(remote)
      if (socket.destroyed) { remote.destroy(); return }
      const headers = responseHeaders(incoming.headers)
      headers.connection = 'Upgrade'
      headers.upgrade = 'websocket'
      const lines = Object.entries(headers).flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value]).filter(item => item !== undefined).map(item => `${key}: ${item}\r\n`))
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('')}\r\n`)
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) remote.write(head)
      socket.once('close', () => { remote.destroy() })
      remote.once('close', () => { socket.destroy() })
      remote.once('error', () => { socket.destroy() })
      socket.pipe(remote).pipe(socket)
    })
    outgoing.end()
  }

  return {
    handle,
    upgrade,
    close() {
      closed = true
      for (const resource of active) resource.destroy()
      active.clear()
    },
  }
}

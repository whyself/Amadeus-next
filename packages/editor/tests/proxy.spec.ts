import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import { createProxy } from '../src/proxy.ts'

const servers: http.Server[] = []

async function listen(server: http.Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No listening address')
  return address.port
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })))
})

it('strips credentials, rewrites redirects, and aborts active HTTP requests on close', async () => {
  let headers: http.IncomingHttpHeaders | undefined
  const upstream = http.createServer((req, res) => {
    headers = req.headers
    if (req.url === '/wait') return
    res.writeHead(302, { location: '/next' }).end()
  })
  const upstreamPort = await listen(upstream)
  const proxy = createProxy(`http://127.0.0.1:${upstreamPort}`)
  const publicPort = await listen(http.createServer(proxy.handle))
  const response = await fetch(`http://127.0.0.1:${publicPort}/amadeus/code/`, {
    headers: { cookie: 'secret=1', authorization: 'secret' }, redirect: 'manual',
  })
  expect(response.headers.get('location')).toBe('/amadeus/code/next')
  expect(headers?.cookie).toBeUndefined()
  expect(headers?.authorization).toBeUndefined()
  const received = once(upstream, 'request')
  const pending = http.get(`http://127.0.0.1:${publicPort}/amadeus/code/wait`)
  const ended = new Promise<void>((resolve) => {
    pending.once('error', () => { resolve() })
    pending.once('response', (response) => { response.resume(); response.once('end', resolve) })
  })
  await received
  proxy.close()
  await ended
})

it('rejects cross-origin upgrades and destroys upgraded streams on close', async () => {
  const upstream = http.createServer()
  upstream.on('upgrade', (req, socket) => {
    expect(req.headers.origin).toBe(`http://127.0.0.1:${upstreamPort}`)
    socket.on('end', () => { socket.destroy() })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  })
  const upstreamPort = await listen(upstream)
  const proxy = createProxy(`http://127.0.0.1:${upstreamPort}`)
  const server = http.createServer(proxy.handle)
  server.on('upgrade', proxy.upgrade)
  const publicPort = await listen(server)
  const rejected = net.connect(publicPort, '127.0.0.1')
  await once(rejected, 'connect')
  const rejectedClose = once(rejected, 'close')
  rejected.write(`GET /amadeus/code/socket HTTP/1.1\r\nHost: 127.0.0.1:${publicPort}\r\nOrigin: http://evil.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)
  await rejectedClose
  const socket = net.connect(publicPort, '127.0.0.1')
  await once(socket, 'connect')
  socket.write(`GET /amadeus/code/socket HTTP/1.1\r\nHost: 127.0.0.1:${publicPort}\r\nOrigin: http://127.0.0.1:${publicPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)
  const chunk = await new Promise<Buffer>((resolve) => { socket.once('data', resolve) })
  expect(String(chunk)).toContain('101 Switching Protocols')
  const ended = once(socket, 'close')
  proxy.close()
  await ended
})

it('registers the workbench upgrade path before delivering uncompressed HTML', async () => {
  let encoding: string | undefined
  const upstream = http.createServer((req, res) => {
    encoding = req.headers['accept-encoding']
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<script src="stable-abcdef123456/static/out/vs/code/browser/workbench/workbench.js"></script>')
  })
  const upstreamPort = await listen(upstream)
  const paths: string[] = []
  const proxy = createProxy(`http://127.0.0.1:${upstreamPort}`, '/amadeus/code', (path) => { paths.push(path) })
  try {
    const publicPort = await listen(http.createServer(proxy.handle))
    const response = await fetch(`http://127.0.0.1:${publicPort}/amadeus/code/?folder=x`)
    expect(response.status).toBe(200)
    expect(encoding).toBe('identity')
    expect(paths).toEqual(['/amadeus/code/stable-abcdef123456'])
    expect(await response.text()).toContain('workbench.js')
  } finally {
    proxy.close()
  }
})

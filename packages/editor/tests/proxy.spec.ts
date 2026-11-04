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
    expect(req.headers.origin).toBe(`http://127.0.0.1:${publicPort}`)
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

it('forwards a trusted HTTPS workbench upgrade without trusting forwarded scheme or accepting a cross-origin socket', async () => {
  const publicOrigin = 'https://amadeus.tailnet.test'
  const product = 'stable-ee31cdbe02c07b3ba718007f221d14c890696c61'
  const targetPath = `/${product}?reconnectionToken=abc&reconnection=false`
  const observed: {
    url?: string | undefined
    origin?: string | undefined
    host?: string | undefined
    proto?: string | string[] | undefined
  } = {}
  const upstream = http.createServer()
  upstream.on('upgrade', (req, socket) => {
    if (req.headers.origin !== publicOrigin || req.headers['x-forwarded-host'] !== 'amadeus.tailnet.test') {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
      return
    }
    observed.url = req.url
    observed.origin = req.headers.origin
    observed.host = req.headers['x-forwarded-host']
    observed.proto = req.headers['x-forwarded-proto']
    socket.on('end', () => { socket.destroy() })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  })
  const upstreamPort = await listen(upstream)
  const proxy = createProxy(`http://127.0.0.1:${upstreamPort}`, '/amadeus/code', undefined, () => publicOrigin)
  const server = http.createServer(proxy.handle)
  server.on('upgrade', proxy.upgrade)
  const port = await listen(server)
  const connect = async (
    origin: string, forwardedProto?: string, host = 'amadeus.tailnet.test', fetchSite?: string,
  ): Promise<{ socket: net.Socket; response: string }> => {
    const socket = net.connect(port, '127.0.0.1')
    await once(socket, 'connect')
    const response = new Promise<string>((resolve, reject) => {
      socket.once('data', (chunk) => { resolve(String(chunk)) })
      socket.once('end', () => { resolve('') })
      socket.once('error', reject)
    })
    socket.write([
      `GET /amadeus/code${targetPath} HTTP/1.1`,
      `Host: ${host}`,
      `Origin: ${origin}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      ...(forwardedProto ? [`X-Forwarded-Proto: ${forwardedProto}`] : []),
      ...(fetchSite ? [`Sec-Fetch-Site: ${fetchSite}`] : []),
      '', '',
    ].join('\r\n'))
    return { socket, response: await response }
  }
  try {
    const rejected = await connect('https://evil.test', 'https')
    expect(rejected.response).toBe('')
    rejected.socket.destroy()
    const spoofedHost = await connect(publicOrigin, 'https', 'attacker.test')
    expect(spoofedHost.response).toBe('')
    spoofedHost.socket.destroy()
    const crossSite = await connect(publicOrigin, 'https', 'amadeus.tailnet.test', 'cross-site')
    expect(crossSite.response).toBe('')
    crossSite.socket.destroy()
    const accepted = await connect(publicOrigin, 'http')
    expect(accepted.response).toContain('101 Switching Protocols')
    expect(observed).toEqual({ url: targetPath, origin: publicOrigin, host: 'amadeus.tailnet.test', proto: 'https' })
    accepted.socket.destroy()
    const noForwarded = await connect(publicOrigin)
    expect(noForwarded.response).toContain('101 Switching Protocols')
    noForwarded.socket.destroy()
  } finally {
    proxy.close()
  }
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

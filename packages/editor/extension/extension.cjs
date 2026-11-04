const vscode = require('vscode')
const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { createCommands } = require('./commands.cjs')

let dispose
const { execute } = createCommands(vscode)

async function activate(context) {
  const directory = process.env.AMADEUS_BRIDGE_DIR
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!directory || !folder) return
  let root = await fs.realpath(folder.uri.fsPath)
  if (process.platform === 'win32') root = root.replace(/^[A-Z]:/, drive => drive.toLowerCase())
  const key = crypto.createHash('sha256').update(root).digest('hex')
  const instanceId = crypto.randomUUID()
  const token = crypto.randomBytes(32).toString('hex')
  const file = path.join(directory, `${key}-${instanceId}.json`)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (req.method !== 'POST' || req.url !== '/command' || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      res.writeHead(403).end()
      return
    }
    let size = 0
    const chunks = []
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > 65536) throw new Error('Request too large')
        chunks.push(chunk)
      }
      const result = await execute(JSON.parse(Buffer.concat(chunks).toString('utf8')), root)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Bridge has no TCP address')
  const temporary = `${file}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify({ instanceId, workspaceRoot: root, port: address.port, token, pid: process.pid }), { mode: 0o600 })
    await fs.rename(temporary, file)
  } catch (error) {
    server.close()
    throw error
  }
  dispose = async () => {
    await new Promise(resolve => {
      server.close(resolve)
      server.closeAllConnections()
    })
    const record = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}'))
    if (record.instanceId === instanceId) await fs.unlink(file).catch(() => {})
  }
  context.subscriptions.push({ dispose: () => { void dispose?.() } })
}

async function deactivate() {
  await dispose?.()
  dispose = undefined
}

module.exports = { activate, deactivate }

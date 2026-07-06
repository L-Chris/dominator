import { existsSync, mkdirSync, watch } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const outDirName = process.env.VITE_OUT_DIR || 'dist-dev'
const dist = resolve(root, outDirName)
const vite = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js')
const reloadPort = process.env.VITE_DEV_RELOAD_PORT || '17321'
const clients = new Set()
const children = []

function encodeFrame(text) {
  const payload = Buffer.from(text)
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  }

  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, payload])
}

function broadcastReload() {
  const frame = encodeFrame(JSON.stringify({ type: 'reload' }))
  for (const socket of clients) {
    if (!socket.destroyed) socket.write(frame)
  }
  console.log('[dev] reload sent')
}

function startReloadServer() {
  const server = createServer()

  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key']
    if (!key) {
      socket.destroy()
      return
    }

    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'))

    clients.add(socket)
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
  })

  server.listen(Number(reloadPort), '127.0.0.1', () => {
    console.log(`[dev] reload server ws://127.0.0.1:${reloadPort}`)
  })

  return server
}

function spawnViteWatch(entry) {
  const child = spawn(process.execPath, [vite, 'build', '--watch', '--mode', 'development'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_ENTRY: entry,
      VITE_OUT_DIR: outDirName,
      VITE_EXTENSION_DEV_RELOAD: 'true',
      VITE_DEV_RELOAD_PORT: reloadPort,
    },
  })

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[dev] ${entry} watcher exited with code ${code}`)
    }
  })

  children.push(child)
}

function startDistWatcher() {
  if (!existsSync(dist)) {
    console.log(`[dev] ${outDirName}/ does not exist yet; run will create it shortly`)
    mkdirSync(dist, { recursive: true })
  }

  let timer
  watch(dist, { recursive: true }, (_event, fileName) => {
    if (!fileName) return
    if (String(fileName).endsWith('.zip')) return
    clearTimeout(timer)
    timer = setTimeout(broadcastReload, 250)
  })
}

const server = startReloadServer()

for (const entry of ['content', 'background', 'popup']) {
  spawnViteWatch(entry)
}

setTimeout(startDistWatcher, 1000)

function shutdown() {
  for (const child of children) child.kill()
  server.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

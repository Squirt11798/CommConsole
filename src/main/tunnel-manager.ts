/**
 * SSH port-forwarding (tunnel) manager.
 *
 * Each tunnel reuses the stored credentials of a saved SSH session and opens
 * its own dedicated ssh2 connection. Two forwarding modes are supported:
 *
 *   • local  — bind a local TCP port; each inbound connection is forwarded
 *              through the SSH server to destHost:destPort (ssh -L).
 *   • remote — ask the SSH server to bind a port; each inbound connection on
 *              the server is forwarded back to destHost:destPort locally (ssh -R).
 *
 * Tunnel definitions are persisted to tunnels.json. Live status is in-memory
 * and pushed to the renderer via the 'tunnels:status' event.
 *
 * Host-key safety: a tunnel will only connect to a host whose fingerprint is
 * already trusted (TOFU). If the host is unknown, the tunnel errors and asks
 * the user to open a terminal to that host first (which runs the trust dialog).
 */

import { ipcMain, BrowserWindow } from 'electron'
import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { createServer, Server, connect as netConnect } from 'net'
import { Client } from 'ssh2'
import { getSessionForConnect, listSshSessions } from './credential-store'
import { computeFingerprint, checkHost } from './known-hosts'

export interface TunnelConfig {
  id: string
  name: string
  type: 'local' | 'remote' | 'dynamic'
  sessionId: string      // saved SSH session that provides host + credentials
  listenHost: string     // local/dynamic: local bind addr; remote: remote bind addr
  listenPort: number
  destHost: string       // unused for dynamic (SOCKS chooses per-request)
  destPort: number
  autoStart: boolean
}

type TunnelState = 'stopped' | 'starting' | 'active' | 'error'

interface RuntimeTunnel {
  client: Client | null
  server: Server | null   // local mode only
  state: TunnelState
  error: string           // last error message ('' when none)
}

const tunnelsPath = (): string => join(app.getPath('userData'), 'tunnels.json')

function loadTunnels(): TunnelConfig[] {
  try {
    if (!existsSync(tunnelsPath())) return []
    return JSON.parse(readFileSync(tunnelsPath(), 'utf-8'))
  } catch { return [] }
}

function saveTunnels(list: TunnelConfig[]): void {
  writeFileSync(tunnelsPath(), JSON.stringify(list, null, 2), 'utf-8')
}

const runtime = new Map<string, RuntimeTunnel>()

function setState(win: BrowserWindow, id: string, state: TunnelState, error = ''): void {
  const rt = runtime.get(id) ?? { client: null, server: null, state, error }
  rt.state = state
  rt.error = error
  runtime.set(id, rt)
  if (!win.isDestroyed()) {
    win.webContents.send('tunnels:status', id, state, error)
  }
}

function stopTunnel(id: string): void {
  const rt = runtime.get(id)
  if (!rt) return
  try { rt.server?.close() } catch { /* ignore */ }
  try { rt.client?.end() } catch { /* ignore */ }
  rt.server = null
  rt.client = null
}

function buildClient(cfg: TunnelConfig): Client {
  const sess = getSessionForConnect(cfg.sessionId)
  if (!sess) throw new Error('The saved SSH session for this tunnel no longer exists.')
  if (!sess.host) throw new Error('The saved session has no host.')

  // Host must already be trusted (TOFU) — tunnels run headless, no dialog.
  // We can only verify inside hostVerifier, so we stash the requirement and
  // reject there if the fingerprint isn't already known-good.
  const client = new Client()

  const connectConfig: Parameters<Client['connect']>[0] = {
    host: sess.host,
    port: sess.port || 22,
    username: sess.username,
    readyTimeout: 20000,
    keepaliveInterval: 10000,
    hostVerifier: (key: Buffer, cb: (ok: boolean) => void) => {
      const fp = computeFingerprint(key)
      const check = checkHost(sess.host, sess.port || 22, fp)
      // Only proceed if this exact host/fingerprint is already trusted.
      cb(check.status === 'ok')
    }
  }

  if (sess.authType === 'key') {
    if (sess.privateKey) {
      connectConfig.privateKey = Buffer.from(sess.privateKey)
    } else if (sess.keyPath && existsSync(sess.keyPath)) {
      connectConfig.privateKey = readFileSync(sess.keyPath)
    } else {
      throw new Error('The saved session uses key auth but no key is available.')
    }
    if (sess.passphrase) connectConfig.passphrase = sess.passphrase
  } else if (sess.password) {
    connectConfig.password = sess.password
  }

  client.connect(connectConfig)
  return client
}

/**
 * Minimal SOCKS5 server for one client socket. Supports no-auth CONNECT to
 * IPv4 / IPv6 / domain destinations, forwarding each through the SSH client.
 * (Greeting and request typically arrive as single TCP segments, which this
 * handler assumes — sufficient for browsers, curl, proxychains, etc.)
 */
function serveSocks(socket: import('net').Socket, client: Client): void {
  socket.once('data', (greeting: Buffer) => {
    if (greeting.length < 2 || greeting[0] !== 0x05) { socket.end(); return }
    // Reply: version 5, method 0x00 (no authentication)
    socket.write(Buffer.from([0x05, 0x00]))

    socket.once('data', (req: Buffer) => {
      // VER CMD RSV ATYP DST.ADDR DST.PORT
      if (req.length < 7 || req[0] !== 0x05 || req[1] !== 0x01) {
        socket.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])) // command not supported
        return
      }
      const atyp = req[3]
      let host = ''
      let offset = 4
      if (atyp === 0x01) {            // IPv4
        host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`
        offset = 8
      } else if (atyp === 0x03) {     // domain name
        const len = req[4]
        host = req.subarray(5, 5 + len).toString('utf-8')
        offset = 5 + len
      } else if (atyp === 0x04) {     // IPv6
        const parts: string[] = []
        for (let i = 0; i < 16; i += 2) parts.push(req.readUInt16BE(4 + i).toString(16))
        host = parts.join(':')
        offset = 20
      } else {
        socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])) // address type not supported
        return
      }
      const port = req.readUInt16BE(offset)

      client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
        if (err) {
          socket.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])) // connection refused
          return
        }
        // Success reply (bound address reported as 0.0.0.0:0)
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        stream.on('error', () => { try { socket.end() } catch { /* ignore */ } })
        socket.pipe(stream).pipe(socket)
      })
    })
  })
}

function startTunnel(win: BrowserWindow, cfg: TunnelConfig): void {
  // Tear down any existing runtime for this id first
  stopTunnel(cfg.id)
  setState(win, cfg.id, 'starting')

  let client: Client
  try {
    client = buildClient(cfg)
  } catch (err) {
    setState(win, cfg.id, 'error', err instanceof Error ? err.message : String(err))
    return
  }

  const rt: RuntimeTunnel = { client, server: null, state: 'starting', error: '' }
  runtime.set(cfg.id, rt)

  client.on('error', (err) => {
    const msg = err.message?.includes('handshake')
      ? 'Connection failed — host key not trusted. Open a terminal to this host first to verify it, then start the tunnel.'
      : (err.message || 'SSH connection error')
    setState(win, cfg.id, 'error', msg)
    stopTunnel(cfg.id)
  })

  client.on('close', () => {
    // Only surface as 'stopped' if we weren't already in an error state.
    const cur = runtime.get(cfg.id)
    if (cur && cur.state !== 'error') setState(win, cfg.id, 'stopped')
  })

  client.on('ready', () => {
    if (cfg.type === 'local') {
      // Local forward: listen locally, forwardOut on each connection.
      const server = createServer((socket) => {
        client.forwardOut(
          socket.remoteAddress || '127.0.0.1',
          socket.remotePort || 0,
          cfg.destHost,
          cfg.destPort,
          (err, stream) => {
            if (err) { socket.destroy(); return }
            socket.pipe(stream).pipe(socket)
          }
        )
      })
      server.on('error', (err) => {
        setState(win, cfg.id, 'error', `Local bind failed: ${err.message}`)
        stopTunnel(cfg.id)
      })
      server.listen(cfg.listenPort, cfg.listenHost || '127.0.0.1', () => {
        rt.server = server
        setState(win, cfg.id, 'active')
      })
    } else if (cfg.type === 'dynamic') {
      // Dynamic forward: run a local SOCKS5 proxy; forwardOut per request.
      const server = createServer((socket) => {
        socket.on('error', () => { /* ignore client resets */ })
        serveSocks(socket, client)
      })
      server.on('error', (err) => {
        setState(win, cfg.id, 'error', `SOCKS bind failed: ${err.message}`)
        stopTunnel(cfg.id)
      })
      server.listen(cfg.listenPort, cfg.listenHost || '127.0.0.1', () => {
        rt.server = server
        setState(win, cfg.id, 'active')
      })
    } else {
      // Remote forward: server binds the port, we connect out locally per stream.
      client.forwardIn(cfg.listenHost || '127.0.0.1', cfg.listenPort, (err) => {
        if (err) {
          setState(win, cfg.id, 'error', `Remote bind failed: ${err.message}`)
          stopTunnel(cfg.id)
          return
        }
        setState(win, cfg.id, 'active')
      })
      client.on('tcp connection', (_info, accept) => {
        const stream = accept()
        const local = netConnect(cfg.destPort, cfg.destHost || '127.0.0.1', () => {
          stream.pipe(local).pipe(stream)
        })
        local.on('error', () => { try { stream.end() } catch { /* ignore */ } })
      })
    }
  })
}

export function registerTunnelHandlers(win: BrowserWindow): void {
  ipcMain.handle('tunnels:list', () => {
    const list = loadTunnels()
    // Attach current live state for each
    return list.map(t => ({
      ...t,
      state: runtime.get(t.id)?.state ?? 'stopped',
      error: runtime.get(t.id)?.error ?? ''
    }))
  })

  ipcMain.handle('tunnels:listSessions', () => listSshSessions())

  ipcMain.handle('tunnels:save', (_e, cfg: Partial<TunnelConfig>) => {
    if (!cfg.sessionId) throw new Error('A saved SSH session is required for the tunnel.')
    if (cfg.type !== 'local' && cfg.type !== 'remote' && cfg.type !== 'dynamic') {
      throw new Error('Tunnel type must be local, remote, or dynamic.')
    }
    const listenPort = parseInt(String(cfg.listenPort), 10)
    if (isNaN(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('Listen port must be 1–65535.')

    const isDynamic = cfg.type === 'dynamic'
    let destPort = 0
    let destHost = ''
    if (!isDynamic) {
      destPort = parseInt(String(cfg.destPort), 10)
      if (isNaN(destPort) || destPort < 1 || destPort > 65535) throw new Error('Destination port must be 1–65535.')
      if (!cfg.destHost) throw new Error('Destination host is required.')
      destHost = cfg.destHost.trim()
    }

    const list = loadTunnels()
    const id = cfg.id || randomUUID()
    const record: TunnelConfig = {
      id,
      name: (cfg.name || '').trim() ||
        (isDynamic ? `SOCKS:${listenPort}` : `${cfg.type}:${listenPort}→${destHost}:${destPort}`),
      type: cfg.type,
      sessionId: cfg.sessionId,
      listenHost: (cfg.listenHost || '127.0.0.1').trim(),
      listenPort,
      destHost,
      destPort,
      autoStart: !!cfg.autoStart
    }
    const idx = list.findIndex(t => t.id === id)
    if (idx >= 0) list[idx] = record
    else list.push(record)
    saveTunnels(list)
    return id
  })

  ipcMain.handle('tunnels:delete', (_e, id: string) => {
    stopTunnel(id)
    runtime.delete(id)
    saveTunnels(loadTunnels().filter(t => t.id !== id))
  })

  ipcMain.handle('tunnels:start', (_e, id: string) => {
    const cfg = loadTunnels().find(t => t.id === id)
    if (!cfg) throw new Error('Tunnel not found')
    startTunnel(win, cfg)
  })

  ipcMain.handle('tunnels:stop', (_e, id: string) => {
    stopTunnel(id)
    setState(win, id, 'stopped')
  })

  // Auto-start any tunnels flagged for it (best-effort, after a short delay so
  // the renderer is listening for status events).
  setTimeout(() => {
    for (const cfg of loadTunnels()) {
      if (cfg.autoStart) startTunnel(win, cfg)
    }
  }, 1500)
}

/** Stop every running tunnel — called on app quit. */
export function shutdownTunnels(): void {
  for (const id of runtime.keys()) stopTunnel(id)
}

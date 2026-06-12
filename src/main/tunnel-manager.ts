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
  type: 'local' | 'remote'
  sessionId: string      // saved SSH session that provides host + credentials
  listenHost: string     // local: local bind addr; remote: remote bind addr
  listenPort: number
  destHost: string
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
    if (cfg.type !== 'local' && cfg.type !== 'remote') throw new Error('Tunnel type must be local or remote.')
    const listenPort = parseInt(String(cfg.listenPort), 10)
    const destPort = parseInt(String(cfg.destPort), 10)
    if (isNaN(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('Listen port must be 1–65535.')
    if (isNaN(destPort) || destPort < 1 || destPort > 65535) throw new Error('Destination port must be 1–65535.')
    if (!cfg.destHost) throw new Error('Destination host is required.')

    const list = loadTunnels()
    const id = cfg.id || randomUUID()
    const record: TunnelConfig = {
      id,
      name: (cfg.name || '').trim() || `${cfg.type}:${listenPort}→${cfg.destHost}:${destPort}`,
      type: cfg.type,
      sessionId: cfg.sessionId,
      listenHost: (cfg.listenHost || '127.0.0.1').trim(),
      listenPort,
      destHost: cfg.destHost.trim(),
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

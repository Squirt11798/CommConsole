import { ipcMain, BrowserWindow, dialog } from 'electron'
import { Client, SFTPWrapper } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import { readFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { getDecryptedCredentials, getSessionForConnect, getJumpSessionId } from './credential-store'
import { computeFingerprint, checkHost, trustHost } from './known-hosts'
import { startLog, appendLog, endLog } from './session-log'

type HostVerifier = (key: Buffer, callback: (result: boolean) => void) => void

/**
 * Build a TOFU host-key verifier for a given host/port. New hosts prompt the
 * user to verify the fingerprint; changed keys raise a possible-MITM warning.
 */
function makeHostVerifier(win: BrowserWindow, host: string, port: number): HostVerifier {
  return (key: Buffer, callback: (result: boolean) => void) => {
    const fp = computeFingerprint(key)
    const check = checkHost(host, port, fp)

    if (check.status === 'ok') { callback(true); return }

    if (check.status === 'new') {
      dialog.showMessageBox(win, {
        type: 'question',
        title: 'Unknown Host — Verify Fingerprint',
        message: `Connect to ${host}:${port}?`,
        detail: `This host has not been seen before.\n\nSHA-256 fingerprint:\n${fp}\n\nVerify this fingerprint out-of-band (e.g. via the server console) before trusting it.`,
        buttons: ['Trust & Connect', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      }).then(({ response }) => {
        if (response === 0) { trustHost(host, port, fp); callback(true) }
        else callback(false)
      })
      return
    }

    // status === 'changed' — potential MITM
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Host Key Changed — Possible MITM Attack',
      message: `WARNING: The host key for ${host}:${port} has changed!`,
      detail: `Stored fingerprint:\n${check.stored}\n\nPresented fingerprint:\n${check.fingerprint}\n\nThis could indicate a man-in-the-middle attack. Do NOT connect unless you know why the host key changed (e.g. the server was rebuilt).`,
      buttons: ['Cancel', 'Connect Anyway (update stored key)'],
      defaultId: 0,
      cancelId: 0
    }).then(({ response }) => {
      if (response === 1) { trustHost(host, port, check.fingerprint); callback(true) }
      else callback(false)
    })
  }
}

/**
 * Connect a jump-host (bastion) chain and return a stream tunneled to the
 * final target host:port. Supports multiple hops — if a jump session itself
 * has a jump configured, it is connected first (bounded to avoid loops).
 * Resolves with the forwarded stream (to use as `sock`) and the list of jump
 * clients so the caller can tear them down when the main connection closes.
 */
function connectJumpChain(
  win: BrowserWindow,
  jumpSessionId: string,
  targetHost: string,
  targetPort: number,
  depth = 0
): Promise<{ sock: NodeJS.ReadableStream; clients: Client[] }> {
  if (depth > 10) return Promise.reject(new Error('Jump-host chain too deep (possible loop).'))

  const sess = getSessionForConnect(jumpSessionId)
  if (!sess) return Promise.reject(new Error('The configured jump-host session no longer exists.'))
  if (!sess.host) return Promise.reject(new Error('The jump-host session has no host.'))

  const jumpPort = sess.port || 22

  const buildJumpConfig = (sock?: NodeJS.ReadableStream): ConnectConfig => {
    const cfg: ConnectConfig = {
      host: sess.host,
      port: jumpPort,
      username: sess.username,
      readyTimeout: 20000,
      keepaliveInterval: 10000,
      tryKeyboard: false,
      hostVerifier: makeHostVerifier(win, sess.host, jumpPort)
    }
    if (sock) cfg.sock = sock as ConnectConfig['sock']
    if (sess.authType === 'key') {
      if (sess.privateKey) cfg.privateKey = Buffer.from(sess.privateKey)
      else if (sess.keyPath && existsSync(sess.keyPath)) cfg.privateKey = readFileSync(sess.keyPath)
      if (sess.passphrase) cfg.passphrase = sess.passphrase
    } else if (sess.password) {
      cfg.password = sess.password
    }
    return cfg
  }

  // If this jump host is itself reached through another jump, resolve that first.
  const upstream = getJumpSessionId(jumpSessionId)

  return new Promise((resolve, reject) => {
    const open = (sock?: NodeJS.ReadableStream, upstreamClients: Client[] = []): void => {
      const jump = new Client()
      jump.on('error', (err) => reject(new Error(`Jump host ${sess.host} failed: ${err.message}`)))
      jump.on('ready', () => {
        jump.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
          if (err) { jump.end(); return reject(new Error(`Jump forward to ${targetHost}:${targetPort} failed: ${err.message}`)) }
          resolve({ sock: stream, clients: [...upstreamClients, jump] })
        })
      })
      jump.connect(buildJumpConfig(sock))
    }

    if (upstream && upstream !== jumpSessionId) {
      connectJumpChain(win, upstream, sess.host, jumpPort, depth + 1)
        .then(({ sock, clients }) => open(sock, clients))
        .catch(reject)
    } else {
      open()
    }
  })
}

interface Connection {
  id: string
  client: Client
  sftp: SFTPWrapper | null
  sessionId: string | null  // saved session id, if launched from one
  cipher?: string           // negotiated client->server cipher (from handshake)
  kex?: string              // negotiated key-exchange algorithm
}

const connections = new Map<string, Connection>()
// keyboard-interactive finish callbacks keyed by promptId
const pendingPrompts = new Map<string, (answers: string[]) => void>()

function send(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) win.webContents.send(channel, ...args)
}

export function registerSshHandlers(win: BrowserWindow): void {

  ipcMain.handle('ssh:connect', async (_e, opts: {
    sessionId?: string       // connect from saved session
    host?: string            // or connect ad-hoc
    port?: number
    username?: string
    authType?: string
    password?: string
    privateKeyPath?: string
    passphrase?: string
  }) => {
    // ── Input validation ────────────────────────────────────────────────────
    const rawHost = typeof opts.host === 'string' ? opts.host.trim() : ''
    if (!rawHost) throw new Error('Host is required')

    const rawPort = parseInt(String(opts.port ?? 22), 10)
    if (isNaN(rawPort) || rawPort < 1 || rawPort > 65535) {
      throw new Error('Port must be between 1 and 65535')
    }

    const rawUsername = typeof opts.username === 'string' ? opts.username.trim() : ''
    if (!rawUsername) throw new Error('Username is required')

    if (opts.authType && opts.authType !== 'password' && opts.authType !== 'key') {
      throw new Error('authType must be "password" or "key"')
    }
    // ────────────────────────────────────────────────────────────────────────

    let host = rawHost
    let port = rawPort
    let username = rawUsername
    let password: string | undefined
    let privateKey: Buffer | undefined
    let passphrase: string | undefined

    const loadKeyFile = (keyPath: string, passphraseHint?: string): { key: Buffer; passphrase?: string } => {
      if (!existsSync(keyPath)) {
        throw new Error(
          `Key file not found:\n${keyPath}\n\nBrowse to the correct key file in the session editor.`
        )
      }
      const key = readFileSync(keyPath)
      // PPK v3 (PuTTY 0.75+) is not supported by ssh2 — must be converted first
      if (key.slice(0, 30).toString('utf-8').startsWith('PuTTY-User-Key-File-3:')) {
        throw new Error(
          'PuTTY PPK v3 format is not supported.\n\n' +
          'Convert the key to OpenSSH format using PuTTYgen:\n' +
          '  1. Open PuTTYgen and load the key\n' +
          '  2. Conversions → Export OpenSSH key\n' +
          '  3. Save the file, then browse to it in CommConsole'
        )
      }
      return { key, passphrase: passphraseHint || undefined }
    }

    if (opts.sessionId) {
      // Load credentials from vault
      const creds = getDecryptedCredentials(opts.sessionId)
      if (!creds) throw new Error('Session not found')
      password = creds.password || undefined
      passphrase = creds.passphrase || undefined

      if (creds.privateKey) {
        // Vault has the key content stored (legacy encrypted blob)
        privateKey = Buffer.from(creds.privateKey)
      } else if (opts.privateKeyPath) {
        // Vault has no key content — read from the file path saved with the session.
        // passphrase comes from vault first (saved on prior connect), then opts fallback.
        const loaded = loadKeyFile(opts.privateKeyPath, passphrase || opts.passphrase)
        privateKey = loaded.key
        passphrase = loaded.passphrase
      }
    } else {
      password = opts.password
      if (opts.privateKeyPath) {
        const loaded = loadKeyFile(opts.privateKeyPath, opts.passphrase)
        privateKey = loaded.key
        passphrase = loaded.passphrase
      }
    }

    const connId = randomUUID()

    return new Promise<{ id: string }>((resolve, reject) => {
      const client = new Client()
      let negCipher: string | undefined
      let negKex: string | undefined

      client.on('ready', () => {
        client.shell({ term: 'xterm-256color' }, (err, stream) => {
          if (err) { client.end(); return reject(err) }

          connections.set(connId, { id: connId, client, sftp: null, sessionId: opts.sessionId ?? null, cipher: negCipher, kex: negKex })
          startLog(connId, `${username}@${host}`)

          stream.on('data', (data: Buffer) => {
            const s = data.toString('binary')
            appendLog(connId, s)
            send(win, 'ssh:data', connId, s)
          })

          stream.stderr.on('data', (data: Buffer) => {
            const s = data.toString('binary')
            appendLog(connId, s)
            send(win, 'ssh:data', connId, s)
          })

          stream.on('close', () => {
            endLog(connId)
            connections.delete(connId)
            send(win, 'ssh:closed', connId)
          })

          ;(connections.get(connId) as Connection & { stream: typeof stream }).stream = stream

          resolve({ id: connId })
        })
      })

      client.on('error', (err) => {
        connections.delete(connId)
        // Dismiss any keyboard-interactive prompt left open for this attempt so
        // its overlay doesn't stay on top and swallow input after a failed login.
        send(win, 'ssh:closed', connId)
        if (err.message?.includes('All configured authentication methods failed')) {
          if (privateKey) {
            reject(new Error(
              'Authentication failed — the server rejected the key.\n\n' +
              'Possible causes:\n' +
              '• The public key is not in ~/.ssh/authorized_keys on the server\n' +
              '• The key requires a passphrase but none was entered\n' +
              '• PPK v2 key not accepted (try converting to OpenSSH format)'
            ))
          } else {
            reject(new Error('Authentication failed — incorrect username or password.'))
          }
        } else {
          reject(err)
        }
      })

      // Whenever the connection ends, tell the renderer so it can drop the tab
      // and clear any keyboard-interactive prompt tied to this connection.
      client.on('close', () => {
        connections.delete(connId)
        send(win, 'ssh:closed', connId)
      })

      // Capture negotiated crypto for the status bar (fires before 'ready')
      client.on('handshake', (neg: { kex?: string; cs?: { cipher?: string } }) => {
        negCipher = neg?.cs?.cipher
        negKex = neg?.kex
        const conn = connections.get(connId)
        if (conn) { conn.cipher = negCipher; conn.kex = negKex }
      })

      // keyboard-interactive: when prompts arrive, forward to renderer and await answers
      client.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
        const promptId = randomUUID()
        pendingPrompts.set(promptId, finish)
        send(win, 'ssh:prompt', connId, promptId, name, instructions, prompts)
      })

      const connectConfig: Parameters<Client['connect']>[0] = {
        host,
        port,
        username,
        // Only fall back to keyboard-interactive when we have nothing else to
        // try. With a password (or key) present, an incorrect one then fails
        // immediately and cleanly instead of triggering a second interactive
        // round that holds the connection open and freezes the retry UI.
        tryKeyboard: !privateKey && !password,
        readyTimeout: 20000,
        keepaliveInterval: 10000,
        hostVerifier: makeHostVerifier(win, host, port)
      }

      if (privateKey) {
        connectConfig.privateKey = privateKey
        if (passphrase) connectConfig.passphrase = passphrase
      } else if (password) {
        connectConfig.password = password
      }

      // ProxyJump: if this saved session routes through a bastion, build the
      // jump chain first and connect over the resulting tunneled socket.
      const jumpSessionId = opts.sessionId ? getJumpSessionId(opts.sessionId) : ''
      if (jumpSessionId) {
        connectJumpChain(win, jumpSessionId, host, port)
          .then(({ sock, clients }) => {
            connectConfig.sock = sock as Parameters<Client['connect']>[0]['sock']
            // Tear down the jump chain when the main connection ends.
            client.on('close', () => { for (const c of clients) { try { c.end() } catch { /* ignore */ } } })
            client.connect(connectConfig)
          })
          .catch(reject)
      } else {
        client.connect(connectConfig)
      }
    })
  })

  ipcMain.on('ssh:data', (_e, connId: string, data: string) => {
    const conn = connections.get(connId) as (Connection & { stream: { write(d: string): void } }) | undefined
    conn?.stream?.write(data)
  })

  ipcMain.on('ssh:resize', (_e, connId: string, cols: number, rows: number) => {
    const conn = connections.get(connId) as (Connection & { stream: { setWindow(r: number, c: number, h: number, w: number): void } }) | undefined
    conn?.stream?.setWindow(rows, cols, 0, 0)
  })

  ipcMain.handle('ssh:disconnect', (_e, connId: string) => {
    const conn = connections.get(connId)
    if (conn) {
      conn.client.end()
      endLog(connId)
      connections.delete(connId)
    }
  })

  ipcMain.on('ssh:promptResponse', (_e, promptId: string, answers: string[]) => {
    const finish = pendingPrompts.get(promptId)
    if (finish) {
      pendingPrompts.delete(promptId)
      finish(answers)
    }
  })

  // ── SFTP ────────────────────────────────────────────────────────────────────

  function getSftp(connId: string): Promise<SFTPWrapper> {
    const conn = connections.get(connId)
    if (!conn) return Promise.reject(new Error('Not connected'))
    if (conn.sftp) return Promise.resolve(conn.sftp)
    return new Promise((resolve, reject) => {
      conn.client.sftp((err, sftp) => {
        if (err) return reject(err)
        conn.sftp = sftp
        resolve(sftp)
      })
    })
  }

  ipcMain.handle('sftp:list', async (_e, connId: string, remotePath: string) => {
    const sftp = await getSftp(connId)
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(err)
        resolve(list.map(f => ({
          name: f.filename,
          longname: f.longname,
          size: f.attrs.size,
          mtime: f.attrs.mtime,
          isDir: (f.attrs.mode! & 0o170000) === 0o040000,
          permissions: f.attrs.mode
        })))
      })
    })
  })

  ipcMain.handle('sftp:download', async (_e, connId: string, remotePath: string, localPath: string) => {
    const sftp = await getSftp(connId)
    return new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, {}, (err) => {
        if (err) return reject(err)
        resolve()
      })
    })
  })

  ipcMain.handle('sftp:upload', async (_e, connId: string, localPath: string, remotePath: string) => {
    const sftp = await getSftp(connId)
    return new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, {}, (err) => {
        if (err) return reject(err)
        resolve()
      })
    })
  })

  ipcMain.handle('sftp:mkdir', async (_e, connId: string, remotePath: string) => {
    const sftp = await getSftp(connId)
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => err ? reject(err) : resolve())
    })
  })

  ipcMain.handle('sftp:delete', async (_e, connId: string, remotePath: string, isDir: boolean) => {
    const sftp = await getSftp(connId)
    return new Promise<void>((resolve, reject) => {
      const fn = isDir ? sftp.rmdir.bind(sftp) : sftp.unlink.bind(sftp)
      fn(remotePath, (err) => err ? reject(err) : resolve())
    })
  })

  ipcMain.handle('sftp:rename', async (_e, connId: string, oldPath: string, newPath: string) => {
    const sftp = await getSftp(connId)
    return new Promise<void>((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => err ? reject(err) : resolve())
    })
  })

  // ── Stats (locked-down exec for ResourceMonitor only) ────────────────────
  // Runs a fixed command — the renderer cannot supply an arbitrary command string.

  const STATS_CMD = [
    'bash -c \'',
    'C1=$(cat /proc/stat | head -1 | tr -s " ");',
    'NR1=$(cat /proc/net/dev 2>/dev/null | awk "NR>2{rx+=$2;tx+=$10} END{print rx,tx}");',
    'sleep 1;',
    'C2=$(cat /proc/stat | head -1 | tr -s " ");',
    'NR2=$(cat /proc/net/dev 2>/dev/null | awk "NR>2{rx+=$2;tx+=$10} END{print rx,tx}");',
    'I1=$(echo $C1 | cut -d" " -f5);',
    'I2=$(echo $C2 | cut -d" " -f5);',
    'T1=$(echo $C1 | awk "{s=0;for(i=2;i<=8;i++)s+=\\$i;print s}");',
    'T2=$(echo $C2 | awk "{s=0;for(i=2;i<=8;i++)s+=\\$i;print s}");',
    'DT=$((T2-T1)); DI=$((I2-I1));',
    '[ $DT -gt 0 ] && CPU=$(awk "BEGIN{printf \\"%.0f\\",(1-$DI/$DT)*100}") || CPU=0;',
    'MT=$(grep MemTotal /proc/meminfo | awk "{print \\$2}");',
    'MA=$(grep MemAvailable /proc/meminfo | awk "{print \\$2}");',
    'MU=$((MT-MA));',
    'RX1=$(echo $NR1 | cut -d" " -f1); TX1=$(echo $NR1 | cut -d" " -f2);',
    'RX2=$(echo $NR2 | cut -d" " -f1); TX2=$(echo $NR2 | cut -d" " -f2);',
    'RXS=$(( (${RX2:-0} - ${RX1:-0}) / 128 ));',
    'TXS=$(( (${TX2:-0} - ${TX1:-0}) / 128 ));',
    'DISK=$(df -Ph / 2>/dev/null | awk "NR==2{print \\$5}" | tr -d "%");',
    'USERS=$(who 2>/dev/null | wc -l | tr -d " ");',
    'UP=$(uptime -p 2>/dev/null | sed "s/up //" || uptime | sed "s/.*up //;s/ load.*//" | xargs);',
    'echo "CPU:$CPU";',
    'echo "MEMTOTAL:$((MT/1024))";',
    'echo "MEMUSED:$((MU/1024))";',
    'echo "DISK:${DISK:-0}";',
    'echo "USERS:${USERS:-0}";',
    'echo "UP:$UP";',
    'echo "RX:${RXS:-0}";',
    'echo "TX:${TXS:-0}";',
    '\''
  ].join(' ')

  ipcMain.handle('ssh:info', (_e, connId: string) => {
    const conn = connections.get(connId)
    if (!conn) return null
    return { cipher: conn.cipher ?? '', kex: conn.kex ?? '' }
  })

  // Round-trip latency: time a trivial exec round trip.
  ipcMain.handle('ssh:ping', (_e, connId: string): Promise<number> => {
    const conn = connections.get(connId)
    if (!conn) return Promise.reject(new Error('Not connected'))
    return new Promise((resolve, reject) => {
      const t0 = Date.now()
      conn.client.exec('true', (err, stream) => {
        if (err) return reject(err)
        stream.on('close', () => resolve(Date.now() - t0))
        stream.on('data', () => {})
        stream.stderr.on('data', () => {})
      })
    })
  })

  ipcMain.handle('ssh:getStats', (_e, connId: string): Promise<string> => {
    const conn = connections.get(connId)
    if (!conn) return Promise.reject(new Error('Not connected'))
    return new Promise((resolve, reject) => {
      conn.client.exec(STATS_CMD, (err, stream) => {
        if (err) return reject(err)
        let out = ''
        stream.on('data', (d: Buffer) => { out += d.toString() })
        stream.stderr.on('data', (d: Buffer) => { out += d.toString() })
        stream.on('close', () => resolve(out))
      })
    })
  })

  ipcMain.handle('sftp:pwd', async (_e, connId: string) => {
    const sftp = await getSftp(connId)
    return new Promise<string>((resolve, reject) => {
      sftp.realpath('.', (err, absPath) => err ? reject(err) : resolve(absPath))
    })
  })
}

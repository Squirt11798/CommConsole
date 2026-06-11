import { ipcMain, BrowserWindow, dialog } from 'electron'
import { Client, SFTPWrapper } from 'ssh2'
import { readFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { getDecryptedCredentials } from './credential-store'
import { computeFingerprint, checkHost, trustHost } from './known-hosts'

interface Connection {
  id: string
  client: Client
  sftp: SFTPWrapper | null
  sessionId: string | null  // saved session id, if launched from one
}

const connections = new Map<string, Connection>()

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

    if (opts.sessionId) {
      // Load from vault
      const creds = getDecryptedCredentials(opts.sessionId)
      if (!creds) throw new Error('Session not found')
      password = creds.password || undefined
      privateKey = creds.privateKey ? Buffer.from(creds.privateKey) : undefined
      passphrase = creds.passphrase || undefined
    } else {
      password = opts.password
      if (opts.privateKeyPath) {
        if (!existsSync(opts.privateKeyPath)) {
          throw new Error(
            `Key file not found:\n${opts.privateKeyPath}\n\nBrowse to the correct key file in the session editor.`
          )
        }
        privateKey = readFileSync(opts.privateKeyPath)
        // PPK v3 (PuTTY 0.75+) is not supported by ssh2 — must be converted first
        if (privateKey.slice(0, 30).toString('utf-8').startsWith('PuTTY-User-Key-File-3:')) {
          throw new Error(
            'PuTTY PPK v3 format is not supported.\n\n' +
            'Convert the key to OpenSSH format using PuTTYgen:\n' +
            '  1. Open PuTTYgen and load the key\n' +
            '  2. Conversions → Export OpenSSH key\n' +
            '  3. Save the file, then browse to it in VaultTerm'
          )
        }
      }
      passphrase = opts.passphrase
    }

    const connId = randomUUID()

    return new Promise<{ id: string }>((resolve, reject) => {
      const client = new Client()

      client.on('ready', () => {
        client.shell({ term: 'xterm-256color' }, (err, stream) => {
          if (err) { client.end(); return reject(err) }

          connections.set(connId, { id: connId, client, sftp: null, sessionId: opts.sessionId ?? null })

          stream.on('data', (data: Buffer) => {
            send(win, 'ssh:data', connId, data.toString('binary'))
          })

          stream.stderr.on('data', (data: Buffer) => {
            send(win, 'ssh:data', connId, data.toString('binary'))
          })

          stream.on('close', () => {
            connections.delete(connId)
            send(win, 'ssh:closed', connId)
          })

          ;(connections.get(connId) as Connection & { stream: typeof stream }).stream = stream

          resolve({ id: connId })
        })
      })

      client.on('error', (err) => {
        connections.delete(connId)
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

      const connectConfig: Parameters<Client['connect']>[0] = {
        host,
        port,
        username,
        readyTimeout: 20000,
        keepaliveInterval: 10000,

        // ── TOFU host key verification ──────────────────────────────────────
        hostVerifier: (key: Buffer, callback: (result: boolean) => void) => {
          const fp = computeFingerprint(key)
          const check = checkHost(host, port, fp)

          if (check.status === 'ok') {
            callback(true)
            return
          }

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
              if (response === 0) {
                trustHost(host, port, fp)
                callback(true)
              } else {
                callback(false)
              }
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
            if (response === 1) {
              trustHost(host, port, check.fingerprint)
              callback(true)
            } else {
              callback(false)
            }
          })
        }
        // ────────────────────────────────────────────────────────────────────
      }

      if (privateKey) {
        connectConfig.privateKey = privateKey
        if (passphrase) connectConfig.passphrase = passphrase
      } else if (password) {
        connectConfig.password = password
      }

      client.connect(connectConfig)
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
      connections.delete(connId)
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

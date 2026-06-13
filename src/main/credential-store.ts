/**
 * Credential storage using Electron safeStorage (Windows DPAPI).
 * Sensitive fields (password, privateKey) are encrypted before writing to disk.
 * The store file is plain JSON but all secret values are opaque base64 blobs
 * that can only be decrypted by the same Windows user account on the same machine.
 */

import { ipcMain, safeStorage, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { randomUUID, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto'
import { parseMobaConf } from './import-moba'

export interface SavedSession {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key' | 'serial'
  keyPath: string             // path to key file on disk (not secret)
  // serial connection settings (authType === 'serial')
  serialPort: string          // COM3, /dev/ttyUSB0, etc.
  baudRate: number            // 9600, 115200, etc.
  dataBits: number            // 5 | 6 | 7 | 8
  parity: string              // none | odd | even
  stopBits: number            // 1 | 2
  color: string               // tag color (hex) for sidebar/tab; '' = none
  jumpSessionId: string       // saved session to tunnel through (ProxyJump); '' = direct
  // stored encrypted (base64) or empty string
  encryptedPassword: string
  encryptedPrivateKey: string
  passphrase: string  // encrypted if set
  group: string
  createdAt: string
}

const storePath   = (): string => join(app.getPath('userData'), 'sessions.json')
const groupsPath  = (): string => join(app.getPath('userData'), 'groups.json')

function loadGroups(): string[] {
  try {
    if (!existsSync(groupsPath())) return []
    return JSON.parse(readFileSync(groupsPath(), 'utf-8'))
  } catch { return [] }
}

function saveGroups(groups: string[]): void {
  writeFileSync(groupsPath(), JSON.stringify(groups, null, 2), 'utf-8')
}

function load(): SavedSession[] {
  try {
    if (!existsSync(storePath())) return []
    return JSON.parse(readFileSync(storePath(), 'utf-8'))
  } catch {
    return []
  }
}

function save(sessions: SavedSession[]): void {
  writeFileSync(storePath(), JSON.stringify(sessions, null, 2), 'utf-8')
}

// ── Optional master-password layer ──────────────────────────────────────────
// When a master password is enabled, each secret is wrapped a second time with
// AES-256-GCM under a key derived from the master password, on top of DPAPI.
// Double-wrapped values are prefixed "m1:". The master key lives in memory only
// after the app is unlocked.
let masterKey: Buffer | null = null
let masterEnabled = false

export function setMasterKey(key: Buffer | null): void { masterKey = key }
export function setMasterEnabled(on: boolean): void { masterEnabled = on }
export function isMasterUnlocked(): boolean { return masterKey !== null }

function aesWrap(buf: Buffer): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', masterKey!, iv)
  const enc = Buffer.concat([c.update(buf), c.final()])
  return 'm1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')
}

function aesUnwrap(stored: string): Buffer {
  const raw = Buffer.from(stored.slice(3), 'base64')
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28)
  const d = createDecipheriv('aes-256-gcm', masterKey!, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(enc), d.final()])
}

function encrypt(plain: string): string {
  if (!plain) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption unavailable — cannot store credentials')
  }
  const dpapi = safeStorage.encryptString(plain)
  if (masterEnabled && masterKey) return aesWrap(dpapi)
  return dpapi.toString('base64')
}

function decrypt(cipher: string): string {
  if (!cipher) return ''
  if (cipher.startsWith('m1:')) {
    if (!masterKey) throw new Error('Vault is locked')
    return safeStorage.decryptString(aesUnwrap(cipher))
  }
  return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
}

/**
 * Add or remove the master-password wrap on every stored secret without ever
 * decrypting to plaintext — we just add/strip the AES layer over the DPAPI blob.
 * Requires masterKey to be set. Called when enabling/disabling the master password.
 */
export function rewrapVault(enable: boolean): void {
  if (!masterKey) throw new Error('Master key not set')
  const sessions = load()
  const fields: Array<'encryptedPassword' | 'encryptedPrivateKey' | 'passphrase'> =
    ['encryptedPassword', 'encryptedPrivateKey', 'passphrase']
  for (const s of sessions) {
    for (const f of fields) {
      const val = s[f]
      if (!val) continue
      if (enable && !val.startsWith('m1:')) {
        s[f] = aesWrap(Buffer.from(val, 'base64'))
      } else if (!enable && val.startsWith('m1:')) {
        s[f] = aesUnwrap(val).toString('base64')
      }
    }
  }
  save(sessions)
}

// ── Passphrase-based backup crypto (portable across machines) ───────────────
// DPAPI blobs are machine+user bound, so for a portable backup we decrypt to
// plaintext and re-encrypt under a key derived from a user passphrase.
interface BackupEnvelope { app: string; v: number; salt: string; iv: string; tag: string; cipher: string }

function encryptBackup(plaintext: string, passphrase: string): string {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([c.update(plaintext, 'utf-8'), c.final()])
  const tag = c.getAuthTag()
  const env: BackupEnvelope = {
    app: 'commconsole', v: 1,
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: tag.toString('base64'), cipher: enc.toString('base64')
  }
  return JSON.stringify(env, null, 2)
}

function decryptBackup(fileContent: string, passphrase: string): string {
  let env: BackupEnvelope
  try { env = JSON.parse(fileContent) } catch { throw new Error('Not a valid backup file.') }
  if (env.app !== 'commconsole' || !env.salt || !env.iv || !env.tag || !env.cipher) {
    throw new Error('Not a valid CommConsole backup file.')
  }
  const key = scryptSync(passphrase, Buffer.from(env.salt, 'base64'), 32)
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'))
  d.setAuthTag(Buffer.from(env.tag, 'base64'))
  try {
    return Buffer.concat([d.update(Buffer.from(env.cipher, 'base64')), d.final()]).toString('utf-8')
  } catch {
    throw new Error('Decryption failed — wrong passphrase or corrupt file.')
  }
}

export function registerCredentialHandlers(): void {
  ipcMain.handle('sessions:list', () => {
    // keyPath is NOT sensitive — it's just a file path — so it flows through in ...rest.
    // hasPassword tells the UI whether a stored password exists (without exposing it),
    // so it can require the user to enter one when none is saved.
    return load().map(({ encryptedPassword, encryptedPrivateKey: _k, passphrase: _pp, ...rest }) => ({
      ...rest,
      hasPassword: !!encryptedPassword
    }))
  })

  ipcMain.handle('sessions:save', (_e, session: {
    id?: string
    name: string
    host: string
    port: number
    username: string
    authType: 'password' | 'key' | 'serial'
    keyPath?: string
    serialPort?: string
    baudRate?: number
    dataBits?: number
    parity?: string
    stopBits?: number
    color?: string
    jumpSessionId?: string
    password?: string
    privateKey?: string
    passphrase?: string
    group?: string
  }) => {
    // Validate fields before persisting
    if (session.authType !== 'serial') {
      if (typeof session.host !== 'string' || !session.host.trim()) {
        throw new Error('Host is required')
      }
      if (typeof session.username !== 'string' || !session.username.trim()) {
        throw new Error('Username is required')
      }
    }
    const port = parseInt(String(session.port), 10)
    if (session.authType !== 'serial' && (isNaN(port) || port < 1 || port > 65535)) {
      throw new Error('Port must be between 1 and 65535')
    }
    if (session.authType !== 'password' && session.authType !== 'key' && session.authType !== 'serial') {
      throw new Error('authType must be "password", "key", or "serial"')
    }

    const sessions = load()
    const id = session.id || randomUUID()
    const idx = sessions.findIndex(s => s.id === id)

    const fallbackName = session.authType === 'serial'
      ? (session.serialPort || 'Serial')
      : `${session.username}@${session.host}`

    const record: SavedSession = {
      id,
      name: String(session.name || '').trim() || fallbackName,
      host: String(session.host || '').trim(),
      port: isNaN(port) ? 0 : port,
      username: String(session.username || '').trim(),
      authType: session.authType,
      keyPath: session.keyPath ?? (sessions[idx]?.keyPath ?? ''),
      serialPort: session.serialPort ?? (sessions[idx]?.serialPort ?? ''),
      baudRate: session.baudRate ?? (sessions[idx]?.baudRate ?? 9600),
      dataBits: session.dataBits ?? (sessions[idx]?.dataBits ?? 8),
      parity: session.parity ?? (sessions[idx]?.parity ?? 'none'),
      stopBits: session.stopBits ?? (sessions[idx]?.stopBits ?? 1),
      color: session.color ?? (sessions[idx]?.color ?? ''),
      jumpSessionId: session.jumpSessionId ?? (sessions[idx]?.jumpSessionId ?? ''),
      encryptedPassword: session.password ? encrypt(session.password) : (sessions[idx]?.encryptedPassword ?? ''),
      encryptedPrivateKey: session.privateKey ? encrypt(session.privateKey) : (sessions[idx]?.encryptedPrivateKey ?? ''),
      passphrase: session.passphrase ? encrypt(session.passphrase) : (sessions[idx]?.passphrase ?? ''),
      group: session.group ?? '',
      createdAt: sessions[idx]?.createdAt ?? new Date().toISOString()
    }

    if (idx >= 0) sessions[idx] = record
    else sessions.push(record)

    save(sessions)
    return id
  })

  ipcMain.handle('sessions:delete', (_e, id: string) => {
    save(load().filter(s => s.id !== id))
  })

  // ── Groups ────────────────────────────────────────────────────────────────
  ipcMain.handle('groups:list', () => loadGroups())

  ipcMain.handle('groups:create', (_e, name: string) => {
    const groups = loadGroups()
    if (!groups.includes(name)) { groups.push(name); saveGroups(groups) }
  })

  ipcMain.handle('groups:rename', (_e, oldName: string, newName: string) => {
    // Rename in groups list
    const groups = loadGroups().map(g => g === oldName ? newName : g)
    saveGroups(groups)
    // Rename on all sessions
    const sessions = load().map(s => s.group === oldName ? { ...s, group: newName } : s)
    save(sessions)
  })

  ipcMain.handle('groups:delete', (_e, name: string) => {
    saveGroups(loadGroups().filter(g => g !== name))
    save(load().map(s => s.group === name ? { ...s, group: '' } : s))
  })

  // ── MobaXterm import ──────────────────────────────────────────────────────
  ipcMain.handle('sessions:importMoba', (_e, filePath: string) => {
    const { sessions: imported, skipped } = parseMobaConf(filePath)
    if (imported.length === 0) return { imported: 0, skipped }

    const existing = load()
    const groups = loadGroups()

    for (const s of imported) {
      // Ensure the group exists
      if (s.group && !groups.includes(s.group)) {
        groups.push(s.group)
      }
      existing.push({
        id: randomUUID(),
        name: s.name,
        host: s.host,
        port: s.port,
        username: s.username,
        authType: s.authType,
        keyPath: s.keyPath || '',
        serialPort: '',
        baudRate: 9600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        color: '',
        jumpSessionId: '',
        encryptedPassword: '',
        encryptedPrivateKey: '',
        passphrase: '',
        group: s.group,
        createdAt: new Date().toISOString()
      })
    }

    saveGroups(groups)
    save(existing)
    return { imported: imported.length, skipped }
  })

  // ── Encrypted backup: export ────────────────────────────────────────────
  // Decrypts each session's secrets (DPAPI) and re-encrypts the whole bundle
  // under a passphrase-derived key so it can be restored on another machine.
  ipcMain.handle('sessions:export', (_e, args: { passphrase: string; filePath: string }) => {
    if (!args.passphrase || args.passphrase.length < 4) throw new Error('Passphrase must be at least 4 characters.')
    const portable = load().map(s => ({
      ...s,
      // replace machine-bound ciphertext with plaintext for the portable bundle
      password: decrypt(s.encryptedPassword),
      privateKey: decrypt(s.encryptedPrivateKey),
      passphraseSecret: decrypt(s.passphrase),
      encryptedPassword: undefined,
      encryptedPrivateKey: undefined,
      passphrase: undefined
    }))
    const payload = JSON.stringify({ sessions: portable, groups: loadGroups() })
    writeFileSync(args.filePath, encryptBackup(payload, args.passphrase), 'utf-8')
    return { exported: portable.length }
  })

  // ── Encrypted backup: import ──────────────────────────────────────────────
  ipcMain.handle('sessions:importBackup', (_e, args: { passphrase: string; filePath: string }) => {
    const content = readFileSync(args.filePath, 'utf-8')
    const json = JSON.parse(decryptBackup(content, args.passphrase))
    const incoming: Array<Record<string, unknown>> = json.sessions || []
    const incomingGroups: string[] = json.groups || []

    const existing = load()
    const byId = new Map(existing.map(s => [s.id, s] as const))

    for (const p of incoming) {
      const rec: SavedSession = {
        id: String(p.id || randomUUID()),
        name: String(p.name || 'Imported'),
        host: String(p.host || ''),
        port: Number(p.port || 0),
        username: String(p.username || ''),
        authType: (p.authType as SavedSession['authType']) || 'password',
        keyPath: String(p.keyPath || ''),
        serialPort: String(p.serialPort || ''),
        baudRate: Number(p.baudRate || 9600),
        dataBits: Number(p.dataBits || 8),
        parity: String(p.parity || 'none'),
        stopBits: Number(p.stopBits || 1),
        color: String(p.color || ''),
        jumpSessionId: String(p.jumpSessionId || ''),
        // re-encrypt secrets with the local machine's DPAPI key
        encryptedPassword: p.password ? encrypt(String(p.password)) : '',
        encryptedPrivateKey: p.privateKey ? encrypt(String(p.privateKey)) : '',
        passphrase: p.passphraseSecret ? encrypt(String(p.passphraseSecret)) : '',
        group: String(p.group || ''),
        createdAt: String(p.createdAt || new Date().toISOString())
      }
      byId.set(rec.id, rec)
    }

    save([...byId.values()])

    const groups = loadGroups()
    for (const g of incomingGroups) if (g && !groups.includes(g)) groups.push(g)
    saveGroups(groups)

    return { imported: incoming.length }
  })

  // Returns decrypted credentials — only called internally by ssh-manager via direct import
}

export function getDecryptedCredentials(id: string): { password: string; privateKey: string; passphrase: string } | null {
  const session = load().find(s => s.id === id)
  if (!session) return null
  return {
    password: decrypt(session.encryptedPassword),
    privateKey: decrypt(session.encryptedPrivateKey),
    passphrase: decrypt(session.passphrase)
  }
}

/**
 * Full connection info for a saved SSH session — non-secret fields plus
 * decrypted credentials. Used by the tunnel manager so tunnels can reuse a
 * session's stored credentials. Returns null for missing or serial sessions.
 */
export function getSessionForConnect(id: string): {
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  keyPath: string
  password: string
  privateKey: string
  passphrase: string
} | null {
  const s = load().find(x => x.id === id)
  if (!s || s.authType === 'serial') return null
  return {
    name: s.name,
    host: s.host,
    port: s.port,
    username: s.username,
    authType: s.authType,
    keyPath: s.keyPath || '',
    password: decrypt(s.encryptedPassword),
    privateKey: decrypt(s.encryptedPrivateKey),
    passphrase: decrypt(s.passphrase)
  }
}

/** The jump-host session id configured for a session, or '' if direct. */
export function getJumpSessionId(id: string): string {
  const s = load().find(x => x.id === id)
  return s?.jumpSessionId || ''
}

/** Lightweight list of SSH (non-serial) sessions for tunnel target pickers. */
export function listSshSessions(): Array<{ id: string; name: string; host: string }> {
  return load()
    .filter(s => s.authType !== 'serial')
    .map(s => ({ id: s.id, name: s.name, host: s.host }))
}

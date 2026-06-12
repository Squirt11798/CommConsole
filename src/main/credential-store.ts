/**
 * Credential storage using Electron safeStorage (Windows DPAPI).
 * Sensitive fields (password, privateKey) are encrypted before writing to disk.
 * The store file is plain JSON but all secret values are opaque base64 blobs
 * that can only be decrypted by the same Windows user account on the same machine.
 */

import { ipcMain, safeStorage, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
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

function encrypt(plain: string): string {
  if (!plain) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption unavailable — cannot store credentials')
  }
  return safeStorage.encryptString(plain).toString('base64')
}

function decrypt(cipher: string): string {
  if (!cipher) return ''
  return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
}

export function registerCredentialHandlers(): void {
  ipcMain.handle('sessions:list', (): Omit<SavedSession, 'encryptedPassword' | 'encryptedPrivateKey' | 'passphrase'>[] => {
    // keyPath is NOT sensitive — it's just a file path — so it flows through in ...rest
    return load().map(({ encryptedPassword: _p, encryptedPrivateKey: _k, passphrase: _pp, ...rest }) => rest)
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

/** Lightweight list of SSH (non-serial) sessions for tunnel target pickers. */
export function listSshSessions(): Array<{ id: string; name: string; host: string }> {
  return load()
    .filter(s => s.authType !== 'serial')
    .map(s => ({ id: s.id, name: s.name, host: s.host }))
}

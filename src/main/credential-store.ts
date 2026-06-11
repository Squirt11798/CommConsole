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

export interface SavedSession {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
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
    return load().map(({ encryptedPassword: _p, encryptedPrivateKey: _k, passphrase: _pp, ...rest }) => rest)
  })

  ipcMain.handle('sessions:save', (_e, session: {
    id?: string
    name: string
    host: string
    port: number
    username: string
    authType: 'password' | 'key'
    password?: string
    privateKey?: string
    passphrase?: string
    group?: string
  }) => {
    const sessions = load()
    const id = session.id || randomUUID()
    const idx = sessions.findIndex(s => s.id === id)

    const record: SavedSession = {
      id,
      name: session.name,
      host: session.host,
      port: session.port,
      username: session.username,
      authType: session.authType,
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
    save(load().filter(s => s.group !== name))
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

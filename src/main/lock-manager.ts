/**
 * App lock — master password + optional TOTP, with idle auto-lock.
 *
 * The master password derives (scrypt) a key that adds a second encryption
 * layer over the credential vault (see credential-store rewrapVault). The key
 * lives only in memory after unlock. A SHA-256 of the key is stored as a
 * verifier so the passphrase can be checked without storing it.
 */

import { ipcMain, BrowserWindow, safeStorage, app, powerMonitor } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { scryptSync, randomBytes, createHash, createHmac } from 'crypto'
import { setMasterKey, setMasterEnabled, rewrapVault } from './credential-store'

interface LockConfig {
  enabled: boolean
  salt: string          // base64
  verifier: string      // base64 sha256(masterKey)
  idleMinutes: number   // 0 = no idle lock
  totpEnabled: boolean
  totpSecretEnc: string // DPAPI-encrypted base32 secret (base64), '' if none
}

const DEFAULTS: LockConfig = { enabled: false, salt: '', verifier: '', idleMinutes: 0, totpEnabled: false, totpSecretEnc: '' }

const cfgPath = (): string => join(app.getPath('userData'), 'lock.json')

function loadCfg(): LockConfig {
  try {
    if (!existsSync(cfgPath())) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(readFileSync(cfgPath(), 'utf-8')) }
  } catch { return { ...DEFAULTS } }
}
function saveCfg(c: LockConfig): void { writeFileSync(cfgPath(), JSON.stringify(c, null, 2), 'utf-8') }

let locked = false   // current runtime lock state

function deriveKey(passphrase: string, saltB64: string): Buffer {
  return scryptSync(passphrase, Buffer.from(saltB64, 'base64'), 32)
}
function verifierFor(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64')
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30s step) ──────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
function base32Decode(s: string): Buffer {
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx; bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Buffer.from(out)
}
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const hmac = createHmac('sha1', secret).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3]
  return String(code % 1_000_000).padStart(6, '0')
}
function verifyTotp(secretB32: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false
  const secret = base32Decode(secretB32)
  const step = Math.floor(Date.now() / 1000 / 30)
  for (let w = -1; w <= 1; w++) {
    if (hotp(secret, step + w) === code) return true
  }
  return false
}

export function isLocked(): boolean { return locked }

export function registerLockHandlers(win: BrowserWindow): void {
  const cfg0 = loadCfg()
  // If a master password is configured, start locked and wrap the vault.
  if (cfg0.enabled) {
    setMasterEnabled(true)
    locked = true
  }

  ipcMain.handle('lock:status', () => {
    const c = loadCfg()
    return { enabled: c.enabled, locked, totpEnabled: c.totpEnabled, idleMinutes: c.idleMinutes }
  })

  ipcMain.handle('lock:unlock', (_e, args: { passphrase: string; totp?: string }) => {
    const c = loadCfg()
    if (!c.enabled) return { ok: true }
    const key = deriveKey(args.passphrase || '', c.salt)
    if (verifierFor(key) !== c.verifier) return { ok: false, error: 'Incorrect master password.' }
    if (c.totpEnabled) {
      const secret = c.totpSecretEnc ? safeStorage.decryptString(Buffer.from(c.totpSecretEnc, 'base64')) : ''
      if (!verifyTotp(secret, args.totp || '')) return { ok: false, error: 'Invalid authenticator code.' }
    }
    setMasterKey(key)
    setMasterEnabled(true)
    locked = false
    return { ok: true }
  })

  ipcMain.handle('lock:enable', (_e, args: { passphrase: string; idleMinutes?: number }) => {
    if (!args.passphrase || args.passphrase.length < 6) throw new Error('Master password must be at least 6 characters.')
    const c = loadCfg()
    if (c.enabled) throw new Error('A master password is already set.')
    const salt = randomBytes(16)
    const key = deriveKey(args.passphrase, salt.toString('base64'))
    setMasterKey(key)
    setMasterEnabled(true)
    rewrapVault(true)   // add the master layer to all stored secrets
    const next: LockConfig = {
      enabled: true,
      salt: salt.toString('base64'),
      verifier: verifierFor(key),
      idleMinutes: Math.max(0, parseInt(String(args.idleMinutes ?? 0), 10) || 0),
      totpEnabled: false,
      totpSecretEnc: ''
    }
    saveCfg(next)
    locked = false
    return { ok: true }
  })

  ipcMain.handle('lock:disable', (_e, args: { passphrase: string }) => {
    const c = loadCfg()
    if (!c.enabled) return { ok: true }
    const key = deriveKey(args.passphrase || '', c.salt)
    if (verifierFor(key) !== c.verifier) throw new Error('Incorrect master password.')
    setMasterKey(key)
    rewrapVault(false)  // strip the master layer back to DPAPI-only
    setMasterEnabled(false)
    setMasterKey(null)
    saveCfg({ ...DEFAULTS })
    locked = false
    return { ok: true }
  })

  ipcMain.handle('lock:lock', () => {
    const c = loadCfg()
    if (!c.enabled) return { ok: false }
    setMasterKey(null)
    locked = true
    if (!win.isDestroyed()) win.webContents.send('lock:locked')
    return { ok: true }
  })

  ipcMain.handle('lock:setIdle', (_e, minutes: number) => {
    const c = loadCfg()
    if (!c.enabled) throw new Error('Set a master password first.')
    c.idleMinutes = Math.max(0, parseInt(String(minutes), 10) || 0)
    saveCfg(c)
    return { idleMinutes: c.idleMinutes }
  })

  // TOTP enrollment — returns the secret + otpauth URI for a QR/manual entry.
  ipcMain.handle('lock:totpBegin', () => {
    const c = loadCfg()
    if (!c.enabled) throw new Error('Set a master password first.')
    const secret = base32Encode(randomBytes(20))
    const label = encodeURIComponent('CommConsole')
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=CommConsole&period=30&digits=6`
    return { secret, uri }
  })

  ipcMain.handle('lock:totpEnable', (_e, args: { secret: string; code: string }) => {
    const c = loadCfg()
    if (!c.enabled) throw new Error('Set a master password first.')
    if (!verifyTotp(args.secret, args.code)) throw new Error('Code did not match — check your authenticator and try again.')
    c.totpEnabled = true
    c.totpSecretEnc = safeStorage.encryptString(args.secret).toString('base64')
    saveCfg(c)
    return { ok: true }
  })

  ipcMain.handle('lock:totpDisable', (_e, args: { passphrase: string }) => {
    const c = loadCfg()
    const key = deriveKey(args.passphrase || '', c.salt)
    if (verifierFor(key) !== c.verifier) throw new Error('Incorrect master password.')
    c.totpEnabled = false
    c.totpSecretEnc = ''
    saveCfg(c)
    return { ok: true }
  })

  // Idle auto-lock — poll the OS idle time.
  setInterval(() => {
    const c = loadCfg()
    if (!c.enabled || locked || c.idleMinutes <= 0) return
    if (powerMonitor.getSystemIdleTime() >= c.idleMinutes * 60) {
      setMasterKey(null)
      locked = true
      if (!win.isDestroyed()) win.webContents.send('lock:locked')
    }
  }, 15000)
}

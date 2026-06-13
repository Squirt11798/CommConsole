/**
 * Application settings store — non-secret UI/behavior preferences persisted to
 * settings.json in the user data dir. Distinct from the credential vault.
 */

import { ipcMain, app, shell } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

export interface AppSettings {
  theme: string          // 'olive' | 'desert' | 'navy' | 'light'
  fontFamily: string     // terminal + UI mono font
  fontSize: number       // terminal font size (px)
  defaultGroup: string   // pre-selected group for new connections
  sessionLogging: boolean // record terminal output to timestamped log files
}

const DEFAULTS: AppSettings = {
  theme: 'olive',
  fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
  fontSize: 14,
  defaultGroup: '',
  sessionLogging: false
}

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

function load(): AppSettings {
  try {
    if (!existsSync(settingsPath())) return { ...DEFAULTS }
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8'))
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

function save(s: AppSettings): void {
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf-8')
}

/** Whether session logging is currently enabled (read by the SSH/serial managers). */
export function isLoggingEnabled(): boolean {
  return load().sessionLogging === true
}

/** Directory where session logs are written (created on demand). */
export function sessionLogsDir(): string {
  const dir = join(app.getPath('userData'), 'session-logs')
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  return dir
}

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', () => load())

  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    const current = load()
    const next: AppSettings = { ...current, ...patch }
    // Coerce/validate
    next.fontSize = Math.min(28, Math.max(8, parseInt(String(next.fontSize), 10) || DEFAULTS.fontSize))
    if (typeof next.theme !== 'string' || !next.theme) next.theme = DEFAULTS.theme
    if (typeof next.fontFamily !== 'string' || !next.fontFamily.trim()) next.fontFamily = DEFAULTS.fontFamily
    if (typeof next.defaultGroup !== 'string') next.defaultGroup = ''
    next.sessionLogging = !!next.sessionLogging
    save(next)
    return next
  })

  // Open the session-logs folder in the OS file manager.
  ipcMain.handle('logs:open', () => shell.openPath(sessionLogsDir()))
  ipcMain.handle('logs:dir', () => sessionLogsDir())
}

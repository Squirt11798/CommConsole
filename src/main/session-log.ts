/**
 * Session output logging. When enabled in settings, every byte written to a
 * terminal (SSH or serial) is appended verbatim to a per-connection log file
 * under <userData>/session-logs/. Files are named <label>_<timestamp>.log.
 *
 * Logging is opt-in (Settings → Security & Backup). The decision is read once
 * per connection at startLog() time, so toggling the setting affects only new
 * connections, not ones already open.
 */

import { join } from 'path'
import { createWriteStream, WriteStream } from 'fs'
import { isLoggingEnabled, sessionLogsDir } from './settings-store'

const streams = new Map<string, WriteStream>()

function sanitize(label: string): string {
  return (label || 'session').replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 60)
}

/** Begin logging for a connection if session logging is enabled. */
export function startLog(connId: string, label: string): void {
  if (!isLoggingEnabled()) return
  if (streams.has(connId)) return
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(sessionLogsDir(), `${sanitize(label)}_${ts}.log`)
  try {
    const ws = createWriteStream(file, { flags: 'a' })
    ws.write(`=== CommConsole session log — ${label} — ${new Date().toISOString()} ===\r\n`)
    streams.set(connId, ws)
  } catch { /* ignore — logging is best-effort */ }
}

/** Append raw terminal data (a 'binary'-encoded string) to the log. */
export function appendLog(connId: string, data: string): void {
  const ws = streams.get(connId)
  if (!ws) return
  try { ws.write(Buffer.from(data, 'binary')) } catch { /* ignore */ }
}

/** Close the log file for a connection. */
export function endLog(connId: string): void {
  const ws = streams.get(connId)
  if (!ws) return
  try { ws.end() } catch { /* ignore */ }
  streams.delete(connId)
}

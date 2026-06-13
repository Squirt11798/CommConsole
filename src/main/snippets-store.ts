/**
 * Command snippets — a small library of reusable commands the user can send
 * into a terminal (and broadcast to all panes). Stored as plain JSON; snippets
 * are not secret. Persisted to snippets.json in the user data dir.
 */

import { ipcMain, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'

export interface Snippet {
  id: string
  name: string
  command: string
}

const snippetsPath = (): string => join(app.getPath('userData'), 'snippets.json')

function load(): Snippet[] {
  try {
    if (!existsSync(snippetsPath())) return []
    return JSON.parse(readFileSync(snippetsPath(), 'utf-8'))
  } catch { return [] }
}

function save(list: Snippet[]): void {
  writeFileSync(snippetsPath(), JSON.stringify(list, null, 2), 'utf-8')
}

export function registerSnippetHandlers(): void {
  ipcMain.handle('snippets:list', () => load())

  ipcMain.handle('snippets:save', (_e, s: { id?: string; name?: string; command?: string }) => {
    const command = String(s.command ?? '')
    if (!command.trim()) throw new Error('Snippet command cannot be empty.')
    const list = load()
    const id = s.id || randomUUID()
    const record: Snippet = {
      id,
      name: String(s.name ?? '').trim() || command.trim().slice(0, 40),
      command
    }
    const idx = list.findIndex(x => x.id === id)
    if (idx >= 0) list[idx] = record
    else list.push(record)
    save(list)
    return id
  })

  ipcMain.handle('snippets:delete', (_e, id: string) => {
    save(load().filter(s => s.id !== id))
  })
}

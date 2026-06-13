import { useState, useEffect, useCallback } from 'react'

interface Snippet {
  id: string
  name: string
  command: string
}

interface Props {
  canSend: boolean      // a terminal is active to send into
  broadcast: boolean    // sends will hit every open terminal
  onSend: (command: string) => void
  onClose: () => void
}

const BLANK = { id: undefined as string | undefined, name: '', command: '' }

export default function SnippetsModal({ canSend, broadcast, onSend, onClose }: Props) {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [editing, setEditing] = useState<typeof BLANK | null>(null)
  const [err, setErr] = useState('')

  const refresh = useCallback(() => {
    window.api.snippets.list().then(setSnippets).catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [refresh, onClose])

  const commit = async () => {
    if (!editing) return
    setErr('')
    try {
      await window.api.snippets.save({ id: editing.id, name: editing.name, command: editing.command })
      setEditing(null)
      refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <div className="modal-header">
          <h2>Snippets</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {!editing && (
            <>
              {snippets.length === 0 && (
                <p className="settings-preview-note">
                  No snippets yet. Save commands you run often, then send them into a terminal with one click.
                </p>
              )}
              {broadcast && snippets.length > 0 && (
                <p className="field-hint" style={{ color: 'var(--danger)' }}>
                  Broadcast is on — sending a snippet types it into every open terminal.
                </p>
              )}
              {snippets.map(s => (
                <div key={s.id} className="snippet-row">
                  <div className="snippet-info">
                    <div className="snippet-name">{s.name}</div>
                    <code className="snippet-cmd">{s.command}</code>
                  </div>
                  <div className="snippet-actions">
                    <button
                      className="btn-go"
                      disabled={!canSend}
                      title={canSend ? 'Send to terminal' : 'No active terminal'}
                      onClick={() => onSend(s.command)}
                    >Send</button>
                    <button onClick={() => { setErr(''); setEditing({ id: s.id, name: s.name, command: s.command }) }}>Edit</button>
                    <button className="danger" onClick={async () => {
                      if (confirm(`Delete snippet "${s.name}"?`)) { await window.api.snippets.delete(s.id); refresh() }
                    }}>🗑</button>
                  </div>
                </div>
              ))}
            </>
          )}

          {editing && (
            <div className="snippet-edit">
              <div className="form-row">
                <label>Name</label>
                <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="(optional — defaults to the command)" autoFocus />
              </div>
              <div className="form-row">
                <label>Command</label>
                <textarea
                  className="snippet-textarea"
                  value={editing.command}
                  onChange={e => setEditing({ ...editing, command: e.target.value })}
                  placeholder="e.g. sudo systemctl status nginx"
                  rows={3}
                />
              </div>
              {err && <div className="tunnel-err">{err}</div>}
            </div>
          )}
        </div>

        <div className="modal-footer">
          {!editing
            ? <button className="btn-primary" onClick={() => { setErr(''); setEditing({ ...BLANK }) }}>+ New Snippet</button>
            : (
              <>
                <button onClick={() => setEditing(null)}>Cancel</button>
                <button className="btn-primary" onClick={commit} disabled={!editing.command.trim()}>Save</button>
              </>
            )}
        </div>
      </div>
    </div>
  )
}

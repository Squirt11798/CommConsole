import { useState, useEffect, useCallback } from 'react'

interface TunnelRow {
  id: string
  name: string
  type: 'local' | 'remote'
  sessionId: string
  listenHost: string
  listenPort: number
  destHost: string
  destPort: number
  autoStart: boolean
  state: 'stopped' | 'starting' | 'active' | 'error'
  error: string
}

interface SessionRef {
  id: string
  name: string
  host: string
}

interface Props {
  onClose: () => void
}

const BLANK = {
  id: undefined as string | undefined,
  name: '',
  type: 'local' as 'local' | 'remote',
  sessionId: '',
  listenHost: '127.0.0.1',
  listenPort: '',
  destHost: '',
  destPort: '',
  autoStart: false
}

export default function TunnelManager({ onClose }: Props) {
  const [tunnels, setTunnels] = useState<TunnelRow[]>([])
  const [sessions, setSessions] = useState<SessionRef[]>([])
  const [editing, setEditing] = useState<typeof BLANK | null>(null)
  const [saveError, setSaveError] = useState('')

  const refresh = useCallback(async () => {
    const [list, sess] = await Promise.all([
      window.api.tunnels.list() as Promise<TunnelRow[]>,
      window.api.tunnels.listSessions()
    ])
    setTunnels(list)
    setSessions(sess)
  }, [])

  useEffect(() => {
    refresh()
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    const unsub = window.api.tunnels.onStatus((id, state, error) => {
      setTunnels(prev => prev.map(t => t.id === id ? { ...t, state: state as TunnelRow['state'], error } : t))
    })
    return () => { window.removeEventListener('keydown', esc); unsub() }
  }, [refresh, onClose])

  const startEdit = (t?: TunnelRow) => {
    setSaveError('')
    if (t) {
      setEditing({
        id: t.id, name: t.name, type: t.type, sessionId: t.sessionId,
        listenHost: t.listenHost, listenPort: String(t.listenPort),
        destHost: t.destHost, destPort: String(t.destPort), autoStart: t.autoStart
      })
    } else {
      setEditing({ ...BLANK, sessionId: sessions[0]?.id ?? '' })
    }
  }

  const commit = async () => {
    if (!editing) return
    setSaveError('')
    try {
      await window.api.tunnels.save({
        id: editing.id,
        name: editing.name,
        type: editing.type,
        sessionId: editing.sessionId,
        listenHost: editing.listenHost,
        listenPort: parseInt(editing.listenPort, 10),
        destHost: editing.destHost,
        destPort: parseInt(editing.destPort, 10),
        autoStart: editing.autoStart
      })
      setEditing(null)
      refresh()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }

  const sessName = (id: string) => sessions.find(s => s.id === id)?.name ?? '(missing session)'

  const stateLabel: Record<TunnelRow['state'], string> = {
    stopped: '○ Stopped', starting: '◐ Starting…', active: '● Active', error: '✕ Error'
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal tunnel-modal">
        <div className="modal-header">
          <h2>SSH Tunnels</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {!editing && (
            <>
              {tunnels.length === 0 && (
                <p className="tunnel-empty">No tunnels yet. Create one to forward a port through a saved SSH session.</p>
              )}
              {tunnels.map(t => (
                <div key={t.id} className={`tunnel-row state-${t.state}`}>
                  <div className="tunnel-info">
                    <div className="tunnel-name">
                      <span className="tunnel-type-badge">{t.type === 'local' ? '-L' : '-R'}</span>
                      {t.name}
                    </div>
                    <div className="tunnel-detail">
                      {t.type === 'local'
                        ? `${t.listenHost}:${t.listenPort} → ${t.destHost}:${t.destPort}`
                        : `remote ${t.listenHost}:${t.listenPort} → ${t.destHost}:${t.destPort}`}
                      {' · via '}{sessName(t.sessionId)}
                    </div>
                    {t.error && <div className="tunnel-err">{t.error}</div>}
                  </div>
                  <div className={`tunnel-state state-${t.state}`}>{stateLabel[t.state]}</div>
                  <div className="tunnel-actions">
                    {t.state === 'active' || t.state === 'starting'
                      ? <button onClick={() => window.api.tunnels.stop(t.id)}>Stop</button>
                      : <button className="btn-go" onClick={() => window.api.tunnels.start(t.id)}>Start</button>}
                    <button onClick={() => startEdit(t)}>Edit</button>
                    <button className="danger" onClick={async () => {
                      if (confirm(`Delete tunnel "${t.name}"?`)) { await window.api.tunnels.delete(t.id); refresh() }
                    }}>🗑</button>
                  </div>
                </div>
              ))}
            </>
          )}

          {editing && (
            <div className="tunnel-edit">
              <div className="form-row">
                <label>Name</label>
                <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="(auto)" autoFocus />
              </div>
              <div className="form-row">
                <label>Forward Type</label>
                <div className="radio-group">
                  <label><input type="radio" checked={editing.type === 'local'} onChange={() => setEditing({ ...editing, type: 'local' })} /> Local (-L)</label>
                  <label><input type="radio" checked={editing.type === 'remote'} onChange={() => setEditing({ ...editing, type: 'remote' })} /> Remote (-R)</label>
                </div>
              </div>
              <div className="form-row">
                <label>Via SSH Session</label>
                <select className="form-select" value={editing.sessionId} onChange={e => setEditing({ ...editing, sessionId: e.target.value })}>
                  {sessions.length === 0 && <option value="">— no SSH sessions saved —</option>}
                  {sessions.map(s => <option key={s.id} value={s.id}>{s.name} ({s.host})</option>)}
                </select>
              </div>
              <div className="form-row two-col">
                <div>
                  <label>{editing.type === 'local' ? 'Local Bind Host' : 'Remote Bind Host'}</label>
                  <input value={editing.listenHost} onChange={e => setEditing({ ...editing, listenHost: e.target.value })} placeholder="127.0.0.1" />
                </div>
                <div>
                  <label>Listen Port</label>
                  <input value={editing.listenPort} onChange={e => setEditing({ ...editing, listenPort: e.target.value })} placeholder="8080" style={{ width: 90 }} />
                </div>
              </div>
              <div className="form-row two-col">
                <div>
                  <label>Destination Host</label>
                  <input value={editing.destHost} onChange={e => setEditing({ ...editing, destHost: e.target.value })} placeholder="10.0.0.5 or localhost" />
                </div>
                <div>
                  <label>Destination Port</label>
                  <input value={editing.destPort} onChange={e => setEditing({ ...editing, destPort: e.target.value })} placeholder="3389" style={{ width: 90 }} />
                </div>
              </div>
              <div className="form-row">
                <label className="checkbox-row">
                  <input type="checkbox" checked={editing.autoStart} onChange={e => setEditing({ ...editing, autoStart: e.target.checked })} />
                  Start automatically on launch
                </label>
              </div>
              {saveError && <div className="tunnel-err">{saveError}</div>}
            </div>
          )}
        </div>

        <div className="modal-footer">
          {!editing
            ? <button className="btn-primary" onClick={() => startEdit()} disabled={sessions.length === 0}>+ New Tunnel</button>
            : (
              <>
                <button onClick={() => setEditing(null)}>Cancel</button>
                <button className="btn-primary" onClick={commit} disabled={!editing.sessionId}>Save</button>
              </>
            )}
        </div>
      </div>
    </div>
  )
}

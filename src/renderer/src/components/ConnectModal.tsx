import { useState, useEffect } from 'react'
import type { SavedSession } from '../App'

interface ConnectOpts {
  sessionId?: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  label: string
}

interface Props {
  prefill: SavedSession | null
  defaultGroup?: string
  groups: string[]
  onConnect: (opts: ConnectOpts) => void
  onSave: (session: object) => Promise<string>
  onClose: () => void
}

export default function ConnectModal({ prefill, defaultGroup, groups, onConnect, onSave, onClose }: Props) {
  const [name, setName] = useState(prefill?.name ?? '')
  const [host, setHost] = useState(prefill?.host ?? '')
  const [port, setPort] = useState(String(prefill?.port ?? 22))
  const [username, setUsername] = useState(prefill?.username ?? '')
  const [authType, setAuthType] = useState<'password' | 'key'>(prefill?.authType ?? 'password')
  const [password, setPassword] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [group, setGroup] = useState(prefill?.group ?? defaultGroup ?? '')
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  const pickKey = async () => {
    const p = await window.api.dialog.openKey()
    if (p) setKeyPath(p)
  }

  const buildSessionObj = (savedId?: string) => ({
    id: savedId ?? prefill?.id,
    name: name || `${username}@${host}`,
    host,
    port: parseInt(port) || 22,
    username,
    authType,
    password: authType === 'password' ? password : undefined,
    group
  })

  // Connect auto-saves so the session always appears in the sidebar
  const handleConnect = async () => {
    if (!host || !username || connecting) return
    setConnecting(true)
    try {
      const savedId = await onSave(buildSessionObj())
      onConnect({
        sessionId: savedId ?? prefill?.id,
        host,
        port: parseInt(port) || 22,
        username,
        authType,
        password: authType === 'password' ? password : undefined,
        privateKeyPath: authType === 'key' ? keyPath : undefined,
        passphrase: authType === 'key' ? passphrase : undefined,
        label: name || `${username}@${host}`
      })
    } catch (err) {
      setConnecting(false)
      throw err
    }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <div className="modal-header">
          <h2>{prefill ? 'Edit / Connect' : 'New Connection'}</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="form-row">
            <label>Session Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="My Server" autoFocus={!prefill} />
          </div>

          <div className="form-row">
            <label>Group</label>
            <select
              className="form-select"
              value={group}
              onChange={e => setGroup(e.target.value)}
            >
              <option value="">Ungrouped</option>
              {groups.map(g => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>

          <div className="form-row two-col">
            <div>
              <label>Host / IP</label>
              <input value={host} onChange={e => setHost(e.target.value)} placeholder="192.168.1.1" autoFocus={!!prefill} />
            </div>
            <div>
              <label>Port</label>
              <input value={port} onChange={e => setPort(e.target.value)} placeholder="22" style={{ width: 70 }} />
            </div>
          </div>

          <div className="form-row">
            <label>Username</label>
            <input value={username} onChange={e => setUsername(e.target.value)} placeholder="root" />
          </div>

          <div className="form-row">
            <label>Authentication</label>
            <div className="radio-group">
              <label>
                <input type="radio" value="password" checked={authType === 'password'} onChange={() => setAuthType('password')} />
                Password
              </label>
              <label>
                <input type="radio" value="key" checked={authType === 'key'} onChange={() => setAuthType('key')} />
                Private Key
              </label>
            </div>
          </div>

          {authType === 'password' && (
            <div className="form-row">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={prefill ? '(stored — enter to change)' : ''}
                onKeyDown={e => { if (e.key === 'Enter') handleConnect() }}
              />
            </div>
          )}

          {authType === 'key' && (
            <>
              <div className="form-row">
                <label>Private Key File</label>
                <div className="file-row">
                  <input value={keyPath} onChange={e => setKeyPath(e.target.value)} placeholder="/home/you/.ssh/id_rsa" readOnly />
                  <button onClick={pickKey}>Browse…</button>
                </div>
              </div>
              <div className="form-row">
                <label>Passphrase</label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={e => setPassphrase(e.target.value)}
                  placeholder="(if key is encrypted)"
                />
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="btn-primary"
            onClick={handleConnect}
            disabled={!host || !username || connecting}
          >
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}

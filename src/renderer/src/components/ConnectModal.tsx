import { useState, useEffect } from 'react'
import type { SavedSession } from '../App'

const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

// Preset tag colors — a labeled set so prod/staging/dev are visually distinct.
const TAG_COLORS: Array<{ value: string; label: string }> = [
  { value: '',        label: 'None' },
  { value: '#cf5a3c', label: 'Red — Production' },
  { value: '#c9a227', label: 'Amber — Staging' },
  { value: '#8bbf3f', label: 'Green — Dev / Safe' },
  { value: '#5f86a8', label: 'Steel — Internal' },
  { value: '#5fae9e', label: 'Teal — Lab' },
  { value: '#a86f9e', label: 'Violet — Special' },
  { value: '#b9a44a', label: 'Brass — Default' }
]

interface ConnectOpts {
  sessionId?: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key' | 'serial'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  serialPort?: string
  baudRate?: number
  dataBits?: number
  parity?: string
  stopBits?: number
  color?: string
  label: string
}

interface Props {
  prefill: SavedSession | null
  defaultGroup?: string
  groups: string[]
  sshSessions: Array<{ id: string; name: string; host: string }>
  onConnect: (opts: ConnectOpts) => Promise<void>
  onSave: (session: object) => Promise<string>
  onClose: () => void
}

export default function ConnectModal({ prefill, defaultGroup, groups, sshSessions, onConnect, onSave, onClose }: Props) {
  const [name, setName] = useState(prefill?.name ?? '')
  const [host, setHost] = useState(prefill?.host ?? '')
  const [port, setPort] = useState(String(prefill?.port ?? 22))
  const [username, setUsername] = useState(prefill?.username ?? '')
  const [authType, setAuthType] = useState<'password' | 'key' | 'serial'>(prefill?.authType ?? 'password')
  const [password, setPassword] = useState('')
  const [keyPath, setKeyPath] = useState(prefill?.keyPath ?? '')
  const [passphrase, setPassphrase] = useState('')
  const [group, setGroup] = useState(prefill?.group ?? defaultGroup ?? '')
  const [color, setColor] = useState(prefill?.color ?? '')
  const [jumpSessionId, setJumpSessionId] = useState(prefill?.jumpSessionId ?? '')
  const [connecting, setConnecting] = useState(false)
  // Serial-specific state
  const [serialPort, setSerialPort] = useState(prefill?.serialPort ?? '')
  const [baudRate, setBaudRate] = useState(String(prefill?.baudRate ?? 9600))
  const [dataBits, setDataBits] = useState(String(prefill?.dataBits ?? 8))
  const [parity, setParity] = useState(prefill?.parity ?? 'none')
  const [stopBits, setStopBits] = useState(String(prefill?.stopBits ?? 1))
  const [availablePorts, setAvailablePorts] = useState<Array<{ path: string; manufacturer: string }>>([])
  const [loadingPorts, setLoadingPorts] = useState(false)

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  const refreshPorts = async () => {
    setLoadingPorts(true)
    try {
      const ports = await window.api.serial.listPorts()
      setAvailablePorts(ports)
      // Auto-select first port if none chosen
      if (ports.length > 0 && !serialPort) setSerialPort(ports[0].path)
    } catch { /* silently ignore — port may not be available */ }
    finally { setLoadingPorts(false) }
  }

  useEffect(() => {
    if (authType === 'serial') refreshPorts()
  }, [authType])  // eslint-disable-line react-hooks/exhaustive-deps

  const pickKey = async () => {
    const p = await window.api.dialog.openKey()
    if (p) setKeyPath(p)
  }

  const isSerial = authType === 'serial'
  // Password auth needs a password — either typed now, or already stored. Don't
  // attempt a passwordless connect: many servers only offer 'password' auth (no
  // keyboard-interactive), so it just hangs on the handshake timeout and fails.
  const hasStoredPassword = !!prefill?.hasPassword
  const needsPassword = authType === 'password' && !password && !hasStoredPassword
  const canConnect = isSerial ? !!serialPort : (!!host && !!username && !needsPassword)

  const buildSessionObj = (savedId?: string) => ({
    id: savedId ?? prefill?.id,
    name: name || (isSerial ? (serialPort || 'Serial') : `${username}@${host}`),
    host: isSerial ? '' : host,
    port: isSerial ? 0 : (parseInt(port) || 22),
    username: isSerial ? '' : username,
    authType,
    password: authType === 'password' ? password : undefined,
    keyPath: authType === 'key' ? keyPath : '',
    passphrase: authType === 'key' ? passphrase : undefined,
    serialPort: isSerial ? serialPort : '',
    baudRate: isSerial ? (parseInt(baudRate) || 9600) : 0,
    dataBits: isSerial ? parseInt(dataBits) : undefined,
    parity: isSerial ? parity : undefined,
    stopBits: isSerial ? parseInt(stopBits) : undefined,
    color,
    jumpSessionId: isSerial ? '' : jumpSessionId,
    group
  })

  // Connect auto-saves so the session always appears in the sidebar
  const handleConnect = async () => {
    if (!canConnect || connecting) return
    setConnecting(true)
    try {
      const savedId = await onSave(buildSessionObj())
      await onConnect({
        sessionId: savedId ?? prefill?.id,
        host: isSerial ? '' : host,
        port: isSerial ? 0 : (parseInt(port) || 22),
        username: isSerial ? '' : username,
        authType,
        password: authType === 'password' ? password : undefined,
        privateKeyPath: authType === 'key' ? keyPath : undefined,
        passphrase: authType === 'key' ? passphrase : undefined,
        serialPort: isSerial ? serialPort : undefined,
        baudRate: isSerial ? (parseInt(baudRate) || 9600) : undefined,
        dataBits: isSerial ? parseInt(dataBits) : undefined,
        parity: isSerial ? parity : undefined,
        stopBits: isSerial ? parseInt(stopBits) : undefined,
        color,
        label: name || (isSerial ? (serialPort || 'Serial') : `${username}@${host}`)
      })
      // Success path: App.tsx closes the modal, component unmounts
    } catch {
      // Error already shown by openConnection alert; just re-enable the button
      setConnecting(false)
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

          <div className="form-row">
            <label>Tag Color</label>
            <div className="color-swatches">
              {TAG_COLORS.map(c => (
                <button
                  key={c.value || 'none'}
                  type="button"
                  className={`color-swatch ${color === c.value ? 'selected' : ''} ${c.value ? '' : 'none'}`}
                  style={c.value ? { background: c.value } : undefined}
                  title={c.label}
                  onClick={() => setColor(c.value)}
                >
                  {c.value ? '' : '∅'}
                </button>
              ))}
            </div>
          </div>

          <div className="form-row">
            <label>Connection Type</label>
            <div className="radio-group">
              <label>
                <input type="radio" value="password" checked={authType === 'password'} onChange={() => setAuthType('password')} />
                SSH — Password
              </label>
              <label>
                <input type="radio" value="key" checked={authType === 'key'} onChange={() => setAuthType('key')} />
                SSH — Private Key
              </label>
              <label>
                <input type="radio" value="serial" checked={authType === 'serial'} onChange={() => setAuthType('serial')} />
                Serial / COM
              </label>
            </div>
          </div>

          {!isSerial && (
            <>
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

              {authType === 'password' && (
                <div className="form-row">
                  <label>Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={hasStoredPassword ? '(stored — enter to change)' : 'Required'}
                    onKeyDown={e => { if (e.key === 'Enter') handleConnect() }}
                  />
                  {needsPassword && (
                    <p className="field-hint">
                      No password is saved for this session — enter one to connect.
                    </p>
                  )}
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

              <div className="form-row">
                <label>Jump Host (ProxyJump)</label>
                <select
                  className="form-select"
                  value={jumpSessionId}
                  onChange={e => setJumpSessionId(e.target.value)}
                >
                  <option value="">Direct connection (no jump)</option>
                  {sshSessions
                    .filter(s => s.id !== prefill?.id)
                    .map(s => (
                      <option key={s.id} value={s.id}>{s.name} ({s.host})</option>
                    ))}
                </select>
              </div>
            </>
          )}

          {isSerial && (
            <div className="serial-config">
              <div className="form-row">
                <label>COM Port</label>
                <div className="serial-port-row">
                  <select
                    className="form-select serial-port-select"
                    value={serialPort}
                    onChange={e => setSerialPort(e.target.value)}
                  >
                    {availablePorts.length === 0 && <option value="">— no ports detected —</option>}
                    {availablePorts.map(p => (
                      <option key={p.path} value={p.path}>
                        {p.path}{p.manufacturer ? ` — ${p.manufacturer}` : ''}
                      </option>
                    ))}
                    {/* Allow manually typed value if not in list */}
                    {serialPort && !availablePorts.find(p => p.path === serialPort) && (
                      <option value={serialPort}>{serialPort} (manual)</option>
                    )}
                  </select>
                  <button
                    className="serial-refresh-btn"
                    onClick={refreshPorts}
                    disabled={loadingPorts}
                    title="Refresh port list"
                  >
                    {loadingPorts ? '…' : '↻'}
                  </button>
                </div>
                <input
                  className="serial-port-manual"
                  value={serialPort}
                  onChange={e => setSerialPort(e.target.value)}
                  placeholder="or type manually: COM3, /dev/ttyUSB0"
                />
              </div>

              <div className="form-row">
                <label>Baud Rate</label>
                <select className="form-select" value={baudRate} onChange={e => setBaudRate(e.target.value)}>
                  {BAUD_RATES.map(b => (
                    <option key={b} value={b}>{b.toLocaleString()}</option>
                  ))}
                </select>
              </div>

              <details className="serial-advanced">
                <summary>Advanced (Data/Parity/Stop)</summary>
                <div className="serial-advanced-grid">
                  <div className="form-row">
                    <label>Data Bits</label>
                    <select className="form-select" value={dataBits} onChange={e => setDataBits(e.target.value)}>
                      <option value="8">8</option>
                      <option value="7">7</option>
                      <option value="6">6</option>
                      <option value="5">5</option>
                    </select>
                  </div>
                  <div className="form-row">
                    <label>Parity</label>
                    <select className="form-select" value={parity} onChange={e => setParity(e.target.value)}>
                      <option value="none">None</option>
                      <option value="odd">Odd</option>
                      <option value="even">Even</option>
                    </select>
                  </div>
                  <div className="form-row">
                    <label>Stop Bits</label>
                    <select className="form-select" value={stopBits} onChange={e => setStopBits(e.target.value)}>
                      <option value="1">1</option>
                      <option value="2">2</option>
                    </select>
                  </div>
                </div>
              </details>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="btn-primary"
            onClick={handleConnect}
            disabled={!canConnect || connecting}
          >
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}

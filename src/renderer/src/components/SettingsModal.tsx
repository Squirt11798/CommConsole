import { useState, useEffect, useCallback } from 'react'

export interface AppSettings {
  theme: string
  fontFamily: string
  fontSize: number
  defaultGroup: string
}

interface Props {
  settings: AppSettings
  groups: string[]
  onApply: (patch: Partial<AppSettings>) => void   // live preview
  onSessionsChanged: () => void                    // after a backup import
  onClose: () => void
}

const THEMES: Array<{ value: string; label: string; swatch: string }> = [
  { value: 'olive',  label: 'Olive Drab', swatch: '#b9a44a' },
  { value: 'desert', label: 'Desert',     swatch: '#c79a5a' },
  { value: 'navy',   label: 'Navy',       swatch: '#5b8fc4' },
  { value: 'light',  label: 'Light',      swatch: '#8a6d1f' }
]

const FONTS = [
  '"Cascadia Code", "Fira Code", "Consolas", monospace',
  '"Fira Code", monospace',
  '"JetBrains Mono", monospace',
  'Consolas, monospace',
  '"Courier New", monospace',
  'monospace'
]

export default function SettingsModal({ settings, groups, onApply, onSessionsChanged, onClose }: Props) {
  const [local, setLocal] = useState<AppSettings>(settings)
  const [tab, setTab] = useState<'appearance' | 'security'>('appearance')
  const [hosts, setHosts] = useState<Array<{ entry: string; fingerprint: string }>>([])
  const [backupMode, setBackupMode] = useState<'idle' | 'export' | 'import'>('idle')
  const [passphrase, setPassphrase] = useState('')
  const [backupMsg, setBackupMsg] = useState('')
  const [backupErr, setBackupErr] = useState('')

  const loadHosts = useCallback(() => {
    window.api.hosts.list().then(setHosts).catch(() => {})
  }, [])

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    loadHosts()
    return () => window.removeEventListener('keydown', esc)
  }, [onClose, loadHosts])

  // Live-preview each change immediately
  const patch = (p: Partial<AppSettings>) => {
    const next = { ...local, ...p }
    setLocal(next)
    onApply(p)
  }

  const forgetHost = async (entry: string) => {
    if (!confirm(`Forget trusted host "${entry}"? You'll be asked to re-verify its fingerprint on next connect.`)) return
    await window.api.hosts.forget(entry)
    loadHosts()
  }

  const runBackup = async () => {
    setBackupErr(''); setBackupMsg('')
    if (passphrase.length < 4) { setBackupErr('Passphrase must be at least 4 characters.'); return }
    try {
      if (backupMode === 'export') {
        const path = await window.api.dialog.saveFile('commconsole-backup.ccbak')
        if (!path) return
        const { exported } = await window.api.sessions.exportBackup(passphrase, path)
        setBackupMsg(`Exported ${exported} session(s).`)
      } else {
        const files = await window.api.dialog.openFile()
        if (!files || files.length === 0) return
        const { imported } = await window.api.sessions.importBackup(passphrase, files[0])
        setBackupMsg(`Imported ${imported} session(s).`)
        onSessionsChanged()
      }
      setPassphrase('')
      setBackupMode('idle')
    } catch (err) {
      setBackupErr(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-tabs">
          <button className={tab === 'appearance' ? 'active' : ''} onClick={() => setTab('appearance')}>Appearance</button>
          <button className={tab === 'security' ? 'active' : ''} onClick={() => setTab('security')}>Security &amp; Backup</button>
        </div>

        <div className="modal-body">
         {tab === 'appearance' && (
          <>
          <div className="form-row">
            <label>Theme</label>
            <div className="theme-grid">
              {THEMES.map(t => (
                <button
                  key={t.value}
                  type="button"
                  className={`theme-card ${local.theme === t.value ? 'selected' : ''}`}
                  onClick={() => patch({ theme: t.value })}
                >
                  <span className="theme-dot" style={{ background: t.swatch }} />
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-row two-col">
            <div>
              <label>Terminal Font</label>
              <select className="form-select" value={local.fontFamily} onChange={e => patch({ fontFamily: e.target.value })}>
                {FONTS.map(f => (
                  <option key={f} value={f}>{f.replace(/"/g, '').split(',')[0]}</option>
                ))}
              </select>
            </div>
            <div>
              <label>Font Size</label>
              <select className="form-select" value={String(local.fontSize)} onChange={e => patch({ fontSize: parseInt(e.target.value, 10) })}>
                {[10, 11, 12, 13, 14, 15, 16, 18, 20, 22].map(s => (
                  <option key={s} value={s}>{s}px</option>
                ))}
              </select>
            </div>
          </div>

          <div className="form-row">
            <label>Default Group for New Connections</label>
            <select className="form-select" value={local.defaultGroup} onChange={e => patch({ defaultGroup: e.target.value })}>
              <option value="">Ungrouped</option>
              {groups.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>

          <p className="settings-preview-note">Changes apply instantly and are saved automatically.</p>
          </>
         )}

         {tab === 'security' && (
          <>
          <div className="form-row">
            <label>Trusted Hosts ({hosts.length})</label>
            <div className="hosts-list">
              {hosts.length === 0 && <p className="settings-preview-note">No trusted hosts yet.</p>}
              {hosts.map(h => (
                <div key={h.entry} className="host-row">
                  <div className="host-info">
                    <span className="host-entry">{h.entry}</span>
                    <span className="host-fp">SHA256:{h.fingerprint.slice(0, 24)}…</span>
                  </div>
                  <button className="danger" onClick={() => forgetHost(h.entry)}>Forget</button>
                </div>
              ))}
            </div>
          </div>

          <div className="form-row">
            <label>Encrypted Backup</label>
            <p className="settings-preview-note">
              Export all sessions (including credentials) to a passphrase-encrypted file you can restore on another machine.
            </p>
            {backupMode === 'idle' ? (
              <div className="backup-btns">
                <button onClick={() => { setBackupErr(''); setBackupMsg(''); setBackupMode('export') }}>Export…</button>
                <button onClick={() => { setBackupErr(''); setBackupMsg(''); setBackupMode('import') }}>Import…</button>
              </div>
            ) : (
              <div className="backup-form">
                <input
                  type="password"
                  autoFocus
                  placeholder={backupMode === 'export' ? 'Set a passphrase for the backup' : 'Backup passphrase'}
                  value={passphrase}
                  onChange={e => setPassphrase(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') runBackup() }}
                />
                <button className="btn-primary" onClick={runBackup}>
                  {backupMode === 'export' ? 'Choose File & Export' : 'Choose File & Import'}
                </button>
                <button onClick={() => { setBackupMode('idle'); setPassphrase(''); setBackupErr('') }}>Cancel</button>
              </div>
            )}
            {backupMsg && <div className="backup-msg">{backupMsg}</div>}
            {backupErr && <div className="tunnel-err">{backupErr}</div>}
          </div>
          </>
         )}
        </div>

        <div className="modal-footer">
          <button className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

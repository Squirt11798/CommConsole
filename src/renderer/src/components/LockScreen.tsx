import { useState, useEffect, useRef } from 'react'

interface Props {
  totpEnabled: boolean
  onUnlocked: () => void
}

export default function LockScreen({ totpEnabled, onUnlocked }: Props) {
  const [passphrase, setPassphrase] = useState('')
  const [totp, setTotp] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const submit = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const res = await window.api.lock.unlock(passphrase, totp)
      if (res.ok) { onUnlocked() }
      else { setError(res.error || 'Unlock failed.'); setPassphrase(''); setTotp('') }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lock-screen">
      <div className="lock-card">
        <div className="lock-logo">🔒</div>
        <h2>CommConsole Locked</h2>
        <p className="lock-sub">Enter your master password to continue.</p>
        <input
          ref={inputRef}
          type="password"
          placeholder="Master password"
          value={passphrase}
          onChange={e => setPassphrase(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { if (totpEnabled && !totp) return; submit() } }}
        />
        {totpEnabled && (
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="6-digit code"
            value={totp}
            onChange={e => setTotp(e.target.value.replace(/\D/g, ''))}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
          />
        )}
        {error && <div className="lock-error">{error}</div>}
        <button className="btn-primary" onClick={submit} disabled={busy || !passphrase || (totpEnabled && totp.length !== 6)}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </div>
    </div>
  )
}

import { useState } from 'react'

interface Props {
  onConnect: (raw: string) => void
  compact?: boolean
}

/**
 * One-line quick-connect input. Accepts `user@host:port` (user and port
 * optional) and hands the raw string to the parent, which parses it and opens
 * the connect dialog pre-filled.
 */
export default function QuickConnect({ onConnect, compact }: Props) {
  const [val, setVal] = useState('')

  const submit = (): void => {
    const s = val.trim()
    if (!s) return
    onConnect(s)
    setVal('')
  }

  return (
    <div className={`quick-connect ${compact ? 'compact' : ''}`}>
      <input
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit() }}
        placeholder="user@host:port"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <button onClick={submit} disabled={!val.trim()} title="Quick connect">→</button>
    </div>
  )
}

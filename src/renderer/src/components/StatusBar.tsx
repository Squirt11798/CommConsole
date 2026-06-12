import { useState, useEffect } from 'react'
import type { Tab } from '../App'

interface Props {
  tab: Tab
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export default function StatusBar({ tab }: Props) {
  const [now, setNow] = useState(Date.now())
  const [cipher, setCipher] = useState('')
  const [latency, setLatency] = useState<number | null>(null)

  // 1s ticker for uptime
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // Fetch cipher once + ping periodically (SSH only)
  useEffect(() => {
    setCipher(''); setLatency(null)
    if (tab.connType !== 'ssh') return

    let active = true
    window.api.ssh.info(tab.id).then(info => { if (active && info) setCipher(info.cipher) }).catch(() => {})

    const doPing = (): void => {
      window.api.ssh.ping(tab.id).then(ms => { if (active) setLatency(ms) }).catch(() => { if (active) setLatency(null) })
    }
    doPing()
    const t = setInterval(doPing, 5000)
    return () => { active = false; clearInterval(t) }
  }, [tab.id, tab.connType])

  const latClass = latency == null ? '' : latency < 80 ? 'good' : latency < 250 ? 'warn' : 'bad'

  return (
    <div className="status-bar">
      <span className="sb-item">
        <span className={`sb-dot ${tab.connType === 'ssh' ? 'ssh' : 'serial'}`} />
        {tab.connType === 'ssh' ? 'SSH' : 'Serial'} · {tab.host}
      </span>
      <span className="sb-sep" />
      {tab.connType === 'ssh' && (
        <>
          <span className="sb-item">
            <span className="sb-label">ping</span>
            <span className={`sb-val ${latClass}`}>{latency == null ? '—' : `${latency} ms`}</span>
          </span>
          <span className="sb-sep" />
          <span className="sb-item">
            <span className="sb-label">cipher</span>
            <span className="sb-val">{cipher || '—'}</span>
          </span>
          <span className="sb-sep" />
        </>
      )}
      <span className="sb-item">
        <span className="sb-label">up</span>
        <span className="sb-val">{fmtUptime(now - tab.openedAt)}</span>
      </span>
    </div>
  )
}

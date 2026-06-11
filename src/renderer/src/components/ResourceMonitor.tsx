import { useState, useEffect, useRef } from 'react'

interface Stats {
  cpu: number        // 0-100
  memUsedMb: number
  memTotalMb: number
  diskPct: number
  users: number
  uptime: string
  rxKbps: number
  txKbps: number
}

interface Props {
  connId: string
}


function parseStats(raw: string): Partial<Stats> {
  const out: Partial<Stats> = {}
  for (const line of raw.split('\n')) {
    const [key, val] = line.split(':')
    if (!key || val === undefined) continue
    const k = key.trim()
    const v = val.trim()
    if (k === 'CPU') out.cpu = Math.min(100, Math.max(0, parseInt(v) || 0))
    if (k === 'MEMTOTAL') out.memTotalMb = parseInt(v) || 0
    if (k === 'MEMUSED') out.memUsedMb = parseInt(v) || 0
    if (k === 'DISK') out.diskPct = Math.min(100, parseInt(v) || 0)
    if (k === 'USERS') out.users = parseInt(v) || 0
    if (k === 'UP') out.uptime = v
    if (k === 'RX') out.rxKbps = parseInt(v) || 0
    if (k === 'TX') out.txKbps = parseInt(v) || 0
  }
  return out
}

function fmtBytes(kbps: number): string {
  if (kbps < 1024) return `${kbps} Kb/s`
  return `${(kbps / 1024).toFixed(1)} Mb/s`
}

function fmtMem(mb: number): string {
  if (mb < 1024) return `${mb} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="rm-bar-track">
      <div className="rm-bar-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

export default function ResourceMonitor({ connId }: Props) {
  const [stats, setStats] = useState<Partial<Stats>>({})
  const [error, setError] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const raw = await window.api.ssh.getStats(connId)
        if (!cancelled) {
          setStats(parseStats(raw))
          setError(false)
        }
      } catch {
        if (!cancelled) setError(true)
      }
      if (!cancelled) timerRef.current = setTimeout(poll, 5000)
    }

    poll()
    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [connId])

  const cpu = stats.cpu ?? 0
  const memUsed = stats.memUsedMb ?? 0
  const memTotal = stats.memTotalMb ?? 1
  const memPct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0
  const disk = stats.diskPct ?? 0

  const cpuColor  = cpu  > 85 ? '#ff6b6b' : cpu  > 60 ? '#ffd93d' : '#6bff9e'
  const memColor  = memPct > 85 ? '#ff6b6b' : memPct > 60 ? '#ffd93d' : '#7c9cff'
  const diskColor = disk > 85 ? '#ff6b6b' : disk > 60 ? '#ffd93d' : '#c47cff'

  if (error) return (
    <div className="resource-monitor error">
      <span>⚠ Resource monitor unavailable</span>
    </div>
  )

  return (
    <div className="resource-monitor">
      <div className="rm-item">
        <span className="rm-icon">⚡</span>
        <span className="rm-label">CPU</span>
        <Bar pct={cpu} color={cpuColor} />
        <span className="rm-value" style={{ color: cpuColor }}>{cpu}%</span>
      </div>

      <div className="rm-divider" />

      <div className="rm-item">
        <span className="rm-icon">🧠</span>
        <span className="rm-label">RAM</span>
        <Bar pct={memPct} color={memColor} />
        <span className="rm-value" style={{ color: memColor }}>
          {fmtMem(memUsed)} / {fmtMem(memTotal)}
        </span>
      </div>

      <div className="rm-divider" />

      <div className="rm-item">
        <span className="rm-icon">💾</span>
        <span className="rm-label">Disk</span>
        <Bar pct={disk} color={diskColor} />
        <span className="rm-value" style={{ color: diskColor }}>{disk}%</span>
      </div>

      <div className="rm-divider" />

      {stats.rxKbps !== undefined && (
        <>
          <div className="rm-item narrow">
            <span className="rm-icon net-down">↓</span>
            <span className="rm-value">{fmtBytes(stats.rxKbps)}</span>
          </div>
          <div className="rm-item narrow">
            <span className="rm-icon net-up">↑</span>
            <span className="rm-value">{fmtBytes(stats.txKbps ?? 0)}</span>
          </div>
          <div className="rm-divider" />
        </>
      )}

      {stats.uptime && (
        <div className="rm-item narrow">
          <span className="rm-icon">🕐</span>
          <span className="rm-value">{stats.uptime}</span>
        </div>
      )}

      {stats.users !== undefined && (
        <div className="rm-item narrow">
          <span className="rm-icon">👤</span>
          <span className="rm-value">{stats.users} user{stats.users !== 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  )
}

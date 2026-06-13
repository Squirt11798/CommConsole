import { useState, useEffect, useCallback } from 'react'
import SessionSidebar from './components/SessionSidebar'
import Terminal from './components/Terminal'
import SftpPanel from './components/SftpPanel'
import ConnectModal from './components/ConnectModal'
import ResourceMonitor from './components/ResourceMonitor'
import ImportMobaModal from './components/ImportMobaModal'
import SshPromptModal from './components/SshPromptModal'
import TunnelManager from './components/TunnelManager'
import SettingsModal from './components/SettingsModal'
import type { AppSettings } from './components/SettingsModal'
import LockScreen from './components/LockScreen'
import StatusBar from './components/StatusBar'

export interface Tab {
  id: string
  label: string
  host: string
  connType: 'ssh' | 'serial'
  color: string   // tag color (hex); '' = none
  openedAt: number // ms epoch when the connection opened (for uptime)
}

export interface SavedSession {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key' | 'serial'
  keyPath: string       // path to key file; empty for non-key auth
  serialPort: string    // COM port path; empty for SSH sessions
  baudRate: number
  dataBits: number
  parity: string
  stopBits: number
  color: string         // tag color (hex); '' = none
  jumpSessionId: string // ProxyJump bastion session id; '' = direct
  group: string
  createdAt: string
}

interface SshPromptData {
  connId: string
  promptId: string
  name: string
  instructions: string
  prompts: Array<{ prompt: string; echo: boolean }>
}

type RightPanel = 'sftp' | 'none'

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SavedSession[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [showConnect, setShowConnect] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showTunnels, setShowTunnels] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState<AppSettings>({
    theme: 'olive',
    fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
    fontSize: 14,
    defaultGroup: '',
    sessionLogging: false
  })
  const [locked, setLocked] = useState(false)
  const [totpEnabled, setTotpEnabled] = useState(false)
  const [lockCfg, setLockCfg] = useState<{ enabled: boolean; idleMinutes: number }>({ enabled: false, idleMinutes: 0 })
  const [sshPrompt, setSshPrompt] = useState<SshPromptData | null>(null)
  const [connectPrefill, setConnectPrefill] = useState<SavedSession | null>(null)
  const [connectDefaultGroup, setConnectDefaultGroup] = useState<string | undefined>()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [rightPanel, setRightPanel] = useState<RightPanel>('none')
  const [showMonitor, setShowMonitor] = useState(true)
  const [tiled, setTiled] = useState(false)        // split/tiled view of all open terminals
  const [broadcast, setBroadcast] = useState(false) // mirror typed input to all terminals

  const loadSessions = useCallback(async () => {
    const [list, grps] = await Promise.all([
      window.api.sessions.list(),
      window.api.groups.list()
    ])
    setSessions(list as SavedSession[])
    setGroups(grps)
  }, [])

  // Load persisted settings once on startup
  useEffect(() => {
    window.api.settings.get().then(s => setSettings(s as AppSettings)).catch(() => {})
  }, [])

  // Re-read lock config (called on startup and whenever Settings closes)
  const refreshLock = useCallback(() => {
    return window.api.lock.status().then(st => {
      setTotpEnabled(st.totpEnabled)
      setLockCfg({ enabled: st.enabled, idleMinutes: st.idleMinutes })
      return st
    }).catch(() => null)
  }, [])

  // Lock status on startup + subscribe to idle/forced locks
  useEffect(() => {
    refreshLock().then(st => { if (st && st.enabled && st.locked) setLocked(true) })
    const unsub = window.api.lock.onLocked(() => {
      window.api.lock.status().then(st => setTotpEnabled(st.totpEnabled)).catch(() => {})
      setLocked(true)
    })
    return unsub
  }, [refreshLock])

  // App-level idle auto-lock: lock when there's been no interaction with
  // CommConsole for the configured time (works even when the window is in the
  // background — that's the point). Activity = mouse/keyboard/scroll/touch.
  useEffect(() => {
    if (!lockCfg.enabled || lockCfg.idleMinutes <= 0 || locked) return
    const ms = lockCfg.idleMinutes * 60 * 1000
    let timer: ReturnType<typeof setTimeout>
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        window.api.lock.lock().catch(() => {})
        setLocked(true)
      }, ms)
    }
    const events: Array<keyof WindowEventMap> = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart']
    events.forEach(ev => window.addEventListener(ev, arm, { capture: true, passive: true }))
    arm()
    return () => {
      clearTimeout(timer)
      events.forEach(ev => window.removeEventListener(ev, arm, { capture: true }))
    }
  }, [lockCfg.enabled, lockCfg.idleMinutes, locked])

  // Broadcast and tiled view only make sense with 2+ connections — turn them
  // off automatically when closing a session drops the count below that.
  useEffect(() => {
    if (tabs.length < 2) {
      setBroadcast(false)
      setTiled(false)
    }
  }, [tabs.length])

  // Apply the active theme to the document root whenever it changes
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  // Persist + live-apply a settings change
  const applySettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings(prev => ({ ...prev, ...patch }))
    window.api.settings.set(patch).catch(() => {})
  }, [])

  useEffect(() => {
    loadSessions()
    const unsubClosed = window.api.ssh.onClosed((connId) => {
      // Clear a keyboard-interactive prompt tied to a closed/failed connection
      // so its overlay can't linger and block input.
      setSshPrompt(prev => (prev && prev.connId === connId ? null : prev))
      setTabs(prev => {
        const next = prev.filter(t => t.id !== connId)
        setActiveTab(prev2 => prev2 === connId ? (next[next.length - 1]?.id ?? null) : prev2)
        return next
      })
    })
    const unsubPrompt = window.api.ssh.onPrompt((connId, promptId, name, instructions, prompts) => {
      setSshPrompt({ connId, promptId, name, instructions, prompts })
    })
    return () => { unsubClosed(); unsubPrompt() }
  }, [loadSessions])

  const openConnection = useCallback(async (opts: {
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
  }): Promise<void> => {
    try {
      let id: string
      let connType: 'ssh' | 'serial'
      let tabHost: string

      if (opts.authType === 'serial') {
        const result = await window.api.serial.connect({
          path: opts.serialPort!,
          baudRate: opts.baudRate ?? 9600,
          dataBits: opts.dataBits,
          parity: opts.parity,
          stopBits: opts.stopBits
        })
        id = result.id
        connType = 'serial'
        tabHost = opts.serialPort!
      } else {
        const result = await window.api.ssh.connect(opts)
        id = result.id
        connType = 'ssh'
        tabHost = opts.host
      }

      const tab: Tab = { id, label: opts.label, host: tabHost, connType, color: opts.color ?? '', openedAt: Date.now() }
      setTabs(prev => [...prev, tab])
      setActiveTab(id)
      setShowConnect(false)
    } catch (err: unknown) {
      alert(`Connection failed:\n\n${err instanceof Error ? err.message : String(err)}`)
      throw err   // rethrow so ConnectModal resets its connecting state
    }
  }, [])

  const moveSession = useCallback(async (sessionId: string, groupName: string) => {
    const session = sessions.find(s => s.id === sessionId)
    if (!session) return
    await window.api.sessions.save({ ...session, group: groupName === 'Ungrouped' ? '' : groupName })
    loadSessions()
  }, [sessions, loadSessions])

  const createGroup = useCallback(async (name: string) => {
    await window.api.groups.create(name)
    loadSessions()
  }, [loadSessions])

  const renameGroup = useCallback(async (oldName: string, newName: string) => {
    await window.api.groups.rename(oldName, newName)
    loadSessions()
  }, [loadSessions])

  const deleteGroup = useCallback(async (name: string) => {
    await window.api.groups.delete(name)
    loadSessions()
  }, [loadSessions])

  const closeTab = useCallback(async (connId: string) => {
    const tab = tabs.find(t => t.id === connId)
    if (tab?.connType === 'serial') {
      await window.api.serial.disconnect(connId)
    } else {
      await window.api.ssh.disconnect(connId)
    }
    setTabs(prev => {
      const next = prev.filter(t => t.id !== connId)
      setActiveTab(cur => cur === connId ? (next[next.length - 1]?.id ?? null) : cur)
      return next
    })
  }, [tabs])

  const toggleRightPanel = (panel: RightPanel) => {
    setRightPanel(prev => prev === panel ? 'none' : panel)
  }

  const activeTabData = tabs.find(t => t.id === activeTab)
  const isConnected = tabs.length > 0 && activeTab !== null
  const isSerialTab = activeTabData?.connType === 'serial'

  if (locked) {
    return <LockScreen totpEnabled={totpEnabled} onUnlocked={() => { setLocked(false); loadSessions() }} />
  }

  return (
    <div className="app">
      {/* Custom title bar */}
      <div className="titlebar" onDoubleClick={() => window.api.window.maximize()}>
        <div className="titlebar-drag" />
        <span className="titlebar-title">CommConsole</span>
        <div className="titlebar-controls">
          <button onClick={() => window.api.window.minimize()}>─</button>
          <button onClick={() => window.api.window.maximize()}>□</button>
          <button className="close-btn" onClick={() => window.api.window.close()}>✕</button>
        </div>
      </div>

      <div className="workspace">
        {/* Session sidebar */}
        <SessionSidebar
          sessions={sessions}
          groups={groups}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(v => !v)}
          onNewConnection={(group) => { setConnectPrefill(null); setConnectDefaultGroup(group ?? (settings.defaultGroup || undefined)); setShowConnect(true) }}
          onOpenSession={(s) => { setConnectPrefill(s); setConnectDefaultGroup(undefined); setShowConnect(true) }}
          onDeleteSession={async (id) => { await window.api.sessions.delete(id); loadSessions() }}
          onMoveSession={moveSession}
          onCreateGroup={createGroup}
          onRenameGroup={renameGroup}
          onDeleteGroup={deleteGroup}
          onImportMoba={() => setShowImport(true)}
          onShowTunnels={() => setShowTunnels(true)}
          onShowSettings={() => setShowSettings(true)}
        />

        {/* Main area */}
        <div className="main-area">
          {/* Tab bar + toolbar */}
          {tabs.length > 0 && (
            <div className="tab-bar">
              {tabs.map(tab => (
                <div
                  key={tab.id}
                  className={`tab ${tab.id === activeTab ? 'active' : ''} ${tab.color ? 'tagged' : ''}`}
                  style={tab.color ? { ['--tag' as string]: tab.color } : undefined}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.color && <span className="tab-color-dot" style={{ background: tab.color }} />}
                  <span className="tab-label">{tab.label}</span>
                  <button
                    className="tab-close"
                    onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                  >✕</button>
                </div>
              ))}
              <button className="tab-new" onClick={() => { setConnectPrefill(null); setConnectDefaultGroup(settings.defaultGroup || undefined); setShowConnect(true) }}>+</button>

              {/* Right-side toolbar icons */}
              <div className="tab-toolbar">
                <button
                  className={`toolbar-btn ${tiled ? 'active' : ''}`}
                  title={tabs.length < 2 ? 'Split view needs 2+ open connections' : 'Split / tile all terminals'}
                  onClick={() => setTiled(v => !v)}
                  disabled={tabs.length < 2}
                >
                  ▦
                </button>
                <button
                  className={`toolbar-btn ${broadcast ? 'active danger-active' : ''}`}
                  title={tabs.length < 2 ? 'Broadcast needs 2+ open connections' : 'Broadcast input to all terminals'}
                  onClick={() => setBroadcast(v => !v)}
                  disabled={tabs.length < 2}
                >
                  📡
                </button>
                <button
                  className={`toolbar-btn ${rightPanel === 'sftp' ? 'active' : ''}`}
                  title={isSerialTab ? 'SFTP not available for serial connections' : 'File Browser (SFTP)'}
                  onClick={() => toggleRightPanel('sftp')}
                  disabled={!isConnected || isSerialTab}
                >
                  📁
                </button>
                <button
                  className={`toolbar-btn ${showMonitor ? 'active' : ''}`}
                  title={isSerialTab ? 'Resource Monitor not available for serial connections' : 'Resource Monitor'}
                  onClick={() => setShowMonitor(v => !v)}
                  disabled={!isConnected || isSerialTab}
                >
                  📊
                </button>
              </div>
            </div>
          )}

          {/* Content: terminals + optional SFTP panel */}
          <div className={`content-area ${tiled ? 'tiled' : ''} ${broadcast ? 'broadcasting' : ''}`}>
            {tabs.map(tab => (
              <div
                key={tab.id}
                className={`tab-content ${tiled ? 'tiled-pane' : ''} ${tiled && tab.id === activeTab ? 'active-pane' : ''} ${tiled || tab.id === activeTab ? 'visible' : 'hidden'}`}
                onClick={tiled ? () => setActiveTab(tab.id) : undefined}
              >
                <div className={`pane-wrapper ${rightPanel === 'sftp' && !tiled ? 'split' : ''}`}>
                  <Terminal
                    connId={tab.id}
                    active={tiled || tab.id === activeTab}
                    fontFamily={settings.fontFamily}
                    fontSize={settings.fontSize}
                    theme={settings.theme}
                    broadcast={broadcast}
                    broadcastTargets={tabs.map(t => t.id)}
                  />
                  {rightPanel === 'sftp' && !tiled && <SftpPanel connId={tab.id} />}
                </div>
              </div>
            ))}

            {tabs.length === 0 && (
              <div className="empty-state">
                <div className="empty-logo">⚡</div>
                <h2>CommConsole</h2>
                <p>No active connections</p>
                <button className="btn-primary" onClick={() => { setConnectPrefill(null); setConnectDefaultGroup(settings.defaultGroup || undefined); setShowConnect(true) }}>
                  New Connection
                </button>
              </div>
            )}
          </div>

          {/* Resource monitor bar — only when connected and enabled */}
          {isConnected && showMonitor && activeTabData && !isSerialTab && (
            <ResourceMonitor connId={activeTabData.id} />
          )}

          {/* Status bar — connection info, latency, cipher, uptime */}
          {isConnected && activeTabData && (
            <StatusBar tab={activeTabData} />
          )}
        </div>
      </div>

      {showImport && (
        <ImportMobaModal
          onImported={loadSessions}
          onClose={() => setShowImport(false)}
        />
      )}

      {showTunnels && <TunnelManager onClose={() => setShowTunnels(false)} />}

      {showSettings && (
        <SettingsModal
          settings={settings}
          groups={groups}
          onApply={applySettings}
          onSessionsChanged={loadSessions}
          onClose={() => { setShowSettings(false); refreshLock() }}
        />
      )}

      {sshPrompt && (
        <SshPromptModal
          promptId={sshPrompt.promptId}
          name={sshPrompt.name}
          instructions={sshPrompt.instructions}
          prompts={sshPrompt.prompts}
          onRespond={(promptId, answers) => {
            window.api.ssh.respondPrompt(promptId, answers)
            setSshPrompt(null)
          }}
          onCancel={(promptId) => {
            window.api.ssh.respondPrompt(promptId, sshPrompt.prompts.map(() => ''))
            setSshPrompt(null)
          }}
        />
      )}

      {showConnect && (
        <ConnectModal
          prefill={connectPrefill}
          defaultGroup={connectDefaultGroup}
          groups={groups}
          sshSessions={sessions.filter(s => s.authType !== 'serial').map(s => ({ id: s.id, name: s.name, host: s.host }))}
          onConnect={openConnection}
          onSave={async (session) => {
            const id = await window.api.sessions.save(session)
            loadSessions()
            return id
          }}
          onClose={() => setShowConnect(false)}
        />
      )}
    </div>
  )
}

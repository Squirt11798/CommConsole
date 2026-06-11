import { useState, useEffect, useCallback } from 'react'
import SessionSidebar from './components/SessionSidebar'
import Terminal from './components/Terminal'
import SftpPanel from './components/SftpPanel'
import ConnectModal from './components/ConnectModal'
import ResourceMonitor from './components/ResourceMonitor'

export interface Tab {
  id: string
  label: string
  host: string
}

export interface SavedSession {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  group: string
  createdAt: string
}

type RightPanel = 'sftp' | 'none'

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SavedSession[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [showConnect, setShowConnect] = useState(false)
  const [connectPrefill, setConnectPrefill] = useState<SavedSession | null>(null)
  const [connectDefaultGroup, setConnectDefaultGroup] = useState<string | undefined>()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [rightPanel, setRightPanel] = useState<RightPanel>('none')
  const [showMonitor, setShowMonitor] = useState(true)

  const loadSessions = useCallback(async () => {
    const [list, grps] = await Promise.all([
      window.api.sessions.list(),
      window.api.groups.list()
    ])
    setSessions(list as SavedSession[])
    setGroups(grps)
  }, [])

  useEffect(() => {
    loadSessions()
    const unsub = window.api.ssh.onClosed((connId) => {
      setTabs(prev => {
        const next = prev.filter(t => t.id !== connId)
        setActiveTab(prev2 => prev2 === connId ? (next[next.length - 1]?.id ?? null) : prev2)
        return next
      })
    })
    return unsub
  }, [loadSessions])

  const openConnection = useCallback(async (opts: {
    sessionId?: string
    host: string
    port: number
    username: string
    authType: 'password' | 'key'
    password?: string
    privateKeyPath?: string
    passphrase?: string
    label: string
  }) => {
    try {
      const { id } = await window.api.ssh.connect(opts)
      const tab: Tab = { id, label: opts.label, host: opts.host }
      setTabs(prev => [...prev, tab])
      setActiveTab(id)
      setShowConnect(false)
    } catch (err: unknown) {
      alert(`Connection failed: ${err instanceof Error ? err.message : String(err)}`)
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
    await window.api.ssh.disconnect(connId)
    setTabs(prev => {
      const next = prev.filter(t => t.id !== connId)
      setActiveTab(cur => cur === connId ? (next[next.length - 1]?.id ?? null) : cur)
      return next
    })
  }, [])

  const toggleRightPanel = (panel: RightPanel) => {
    setRightPanel(prev => prev === panel ? 'none' : panel)
  }

  const activeTabData = tabs.find(t => t.id === activeTab)
  const isConnected = tabs.length > 0 && activeTab !== null

  return (
    <div className="app">
      {/* Custom title bar */}
      <div className="titlebar" onDoubleClick={() => window.api.window.maximize()}>
        <div className="titlebar-drag" />
        <span className="titlebar-title">VaultTerm</span>
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
          onNewConnection={(group) => { setConnectPrefill(null); setConnectDefaultGroup(group); setShowConnect(true) }}
          onOpenSession={(s) => { setConnectPrefill(s); setConnectDefaultGroup(undefined); setShowConnect(true) }}
          onDeleteSession={async (id) => { await window.api.sessions.delete(id); loadSessions() }}
          onMoveSession={moveSession}
          onCreateGroup={createGroup}
          onRenameGroup={renameGroup}
          onDeleteGroup={deleteGroup}
        />

        {/* Main area */}
        <div className="main-area">
          {/* Tab bar + toolbar */}
          {tabs.length > 0 && (
            <div className="tab-bar">
              {tabs.map(tab => (
                <div
                  key={tab.id}
                  className={`tab ${tab.id === activeTab ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className="tab-label">{tab.label}</span>
                  <button
                    className="tab-close"
                    onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                  >✕</button>
                </div>
              ))}
              <button className="tab-new" onClick={() => { setConnectPrefill(null); setConnectDefaultGroup(undefined); setShowConnect(true) }}>+</button>

              {/* Right-side toolbar icons */}
              <div className="tab-toolbar">
                <button
                  className={`toolbar-btn ${rightPanel === 'sftp' ? 'active' : ''}`}
                  title="File Browser (SFTP)"
                  onClick={() => toggleRightPanel('sftp')}
                  disabled={!isConnected}
                >
                  📁
                </button>
                <button
                  className={`toolbar-btn ${showMonitor ? 'active' : ''}`}
                  title="Resource Monitor"
                  onClick={() => setShowMonitor(v => !v)}
                  disabled={!isConnected}
                >
                  📊
                </button>
              </div>
            </div>
          )}

          {/* Content: terminals + optional SFTP panel */}
          <div className="content-area">
            {tabs.map(tab => (
              <div key={tab.id} className={`tab-content ${tab.id === activeTab ? 'visible' : 'hidden'}`}>
                <div className={`pane-wrapper ${rightPanel === 'sftp' ? 'split' : ''}`}>
                  <Terminal connId={tab.id} active={tab.id === activeTab} />
                  {rightPanel === 'sftp' && <SftpPanel connId={tab.id} />}
                </div>
              </div>
            ))}

            {tabs.length === 0 && (
              <div className="empty-state">
                <div className="empty-logo">⚡</div>
                <h2>VaultTerm</h2>
                <p>No active connections</p>
                <button className="btn-primary" onClick={() => { setConnectPrefill(null); setConnectDefaultGroup(undefined); setShowConnect(true) }}>
                  New Connection
                </button>
              </div>
            )}
          </div>

          {/* Resource monitor bar — only when connected and enabled */}
          {isConnected && showMonitor && activeTabData && (
            <ResourceMonitor connId={activeTabData.id} />
          )}
        </div>
      </div>

      {showConnect && (
        <ConnectModal
          prefill={connectPrefill}
          defaultGroup={connectDefaultGroup}
          groups={groups}
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

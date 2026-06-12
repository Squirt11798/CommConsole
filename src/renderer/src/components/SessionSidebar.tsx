import { useState, useCallback, useRef } from 'react'
import type { SavedSession } from '../App'

interface Props {
  sessions: SavedSession[]
  groups: string[]
  collapsed: boolean
  onToggleCollapse: () => void
  onNewConnection: (defaultGroup?: string) => void
  onOpenSession: (s: SavedSession) => void
  onDeleteSession: (id: string) => void
  onMoveSession: (sessionId: string, groupName: string) => void
  onCreateGroup: (name: string) => void
  onRenameGroup: (oldName: string, newName: string) => void
  onDeleteGroup: (name: string) => void
  onImportMoba: () => void
}

type ContextTarget =
  | { type: 'session'; session: SavedSession }
  | { type: 'group';   name: string }
  | { type: 'blank' }

interface ContextMenu {
  x: number
  y: number
  target: ContextTarget
}

export default function SessionSidebar({
  sessions, groups, collapsed, onToggleCollapse,
  onNewConnection, onOpenSession, onDeleteSession,
  onMoveSession, onCreateGroup, onRenameGroup, onDeleteGroup, onImportMoba
}: Props) {
  const [filter, setFilter] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [newGroupValue, setNewGroupValue] = useState('')
  const newGroupInputRef = useRef<HTMLInputElement>(null)
  const [dragSessionId, setDragSessionId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const toggleGroupCollapse = (group: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      next.has(group) ? next.delete(group) : next.add(group)
      return next
    })
  }

  const openCtx = useCallback((e: React.MouseEvent, target: ContextTarget) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, target })
  }, [])

  const closeCtx = useCallback(() => setContextMenu(null), [])

  const startRenameGroup = (name: string) => {
    setRenamingGroup(name)
    setRenameValue(name)
    closeCtx()
    setTimeout(() => renameInputRef.current?.focus(), 30)
  }

  const commitRenameGroup = () => {
    if (renamingGroup && renameValue.trim() && renameValue.trim() !== renamingGroup) {
      onRenameGroup(renamingGroup, renameValue.trim())
    }
    setRenamingGroup(null)
  }

  const startCreatingGroup = () => {
    setCreatingGroup(true)
    setNewGroupValue('')
    closeCtx()
    setTimeout(() => newGroupInputRef.current?.focus(), 30)
  }

  const commitNewGroup = () => {
    const name = newGroupValue.trim()
    if (name) onCreateGroup(name)   // just saves the group, no modal
    setCreatingGroup(false)
    setNewGroupValue('')
  }

  const cancelNewGroup = () => {
    setCreatingGroup(false)
    setNewGroupValue('')
  }

  // Build the combined group list: explicit groups + any group names from sessions
  const sessionGroupNames = new Set(sessions.map(s => s.group || 'Ungrouped'))
  const allGroupNames = [
    ...groups,
    ...[...sessionGroupNames].filter(g => !groups.includes(g) && g !== 'Ungrouped')
  ]
  // Always show Ungrouped last if there are ungrouped sessions
  if (sessionGroupNames.has('Ungrouped') && !allGroupNames.includes('Ungrouped')) {
    allGroupNames.push('Ungrouped')
  }

  const filtered = sessions.filter(s =>
    s.name.toLowerCase().includes(filter.toLowerCase()) ||
    s.host.toLowerCase().includes(filter.toLowerCase())
  )

  const sessionsByGroup = filtered.reduce<Record<string, SavedSession[]>>((acc, s) => {
    const g = s.group || 'Ungrouped'
    ;(acc[g] = acc[g] || []).push(s)
    return acc
  }, {})

  return (
    <>
      <div
        className={`sidebar ${collapsed ? 'collapsed' : ''}`}
        onContextMenu={e => { if (e.target === e.currentTarget) openCtx(e, { type: 'blank' }) }}
      >
        <div className="sidebar-header">
          {!collapsed && <span className="sidebar-title">Sessions</span>}
          {!collapsed && (
            <button className="sidebar-import-btn" onClick={onImportMoba} title="Import from MobaXterm">
              📥
            </button>
          )}
          <button className="sidebar-toggle" onClick={onToggleCollapse} title={collapsed ? 'Expand' : 'Collapse'}>
            {collapsed ? '»' : '«'}
          </button>
        </div>

        {!collapsed && (
          <>
            <button className="btn-new-connection" onClick={() => onNewConnection()}>+ New Connection</button>
            <input
              className="sidebar-search"
              placeholder="Filter sessions…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />

            <div
              className="session-list"
              onContextMenu={e => {
                if ((e.target as HTMLElement).classList.contains('session-list'))
                  openCtx(e, { type: 'blank' })
              }}
            >
              {allGroupNames.map(group => (
                <div key={group} className="session-group">
                  <div
                    className={`session-group-label ${dropTarget === group ? 'drop-active' : ''}`}
                    onContextMenu={e => openCtx(e, { type: 'group', name: group })}
                    onDragOver={e => { e.preventDefault(); setDropTarget(group) }}
                    onDragEnter={e => { e.preventDefault(); setDropTarget(group) }}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={e => {
                      e.preventDefault()
                      const id = e.dataTransfer.getData('sessionId')
                      if (id) onMoveSession(id, group)
                      setDropTarget(null)
                      setDragSessionId(null)
                    }}
                  >
                    {renamingGroup === group ? (
                      <input
                        ref={renameInputRef}
                        className="group-rename-input"
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onBlur={commitRenameGroup}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitRenameGroup()
                          if (e.key === 'Escape') setRenamingGroup(null)
                        }}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <>
                        <span
                          className="group-arrow"
                          onClick={e => { e.stopPropagation(); toggleGroupCollapse(group) }}
                          title={collapsedGroups.has(group) ? 'Expand' : 'Collapse'}
                        >
                          {collapsedGroups.has(group) ? '▸' : '▾'}
                        </span>
                        {group} <span className="group-count">({sessionsByGroup[group]?.length ?? 0})</span>
                      </>
                    )}
                  </div>

                  {!collapsedGroups.has(group) && (sessionsByGroup[group] ?? []).map(s => (
                    <div
                      key={s.id}
                      className={`session-item ${dragSessionId === s.id ? 'dragging' : ''}`}
                      draggable
                      onDragStart={e => {
                        e.dataTransfer.setData('sessionId', s.id)
                        e.dataTransfer.effectAllowed = 'move'
                        setDragSessionId(s.id)
                      }}
                      onDragEnd={() => { setDragSessionId(null); setDropTarget(null) }}
                      onClick={() => onOpenSession(s)}
                      onContextMenu={e => openCtx(e, { type: 'session', session: s })}
                      title={s.authType === 'serial' ? `${s.serialPort} @ ${s.baudRate} baud` : `${s.username}@${s.host}:${s.port}`}
                    >
                      <span className="session-icon">
                        {s.authType === 'serial' ? '🔌' : s.authType === 'key' ? '🔑' : '🔒'}
                      </span>
                      <div className="session-info">
                        <span className="session-name">{s.name}</span>
                        <span className="session-host">{s.host}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ))}

              {sessions.length === 0 && groups.length === 0 && !creatingGroup && (
                <div
                  className="sidebar-empty"
                  onContextMenu={e => openCtx(e, { type: 'blank' })}
                >
                  Right-click to add a session or group
                </div>
              )}

              {creatingGroup && (
                <div className="new-group-row">
                  <span className="session-icon">📁</span>
                  <input
                    ref={newGroupInputRef}
                    className="group-rename-input"
                    value={newGroupValue}
                    placeholder="Group name…"
                    onChange={e => setNewGroupValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitNewGroup()
                      if (e.key === 'Escape') cancelNewGroup()
                    }}
                  />
                  <button className="group-input-confirm" onMouseDown={e => { e.preventDefault(); commitNewGroup() }} title="Confirm">✓</button>
                  <button className="group-input-cancel"  onMouseDown={e => { e.preventDefault(); cancelNewGroup() }}  title="Cancel">✕</button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {contextMenu && (
        <>
          <div className="context-overlay" onClick={closeCtx} />
          <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>

            {contextMenu.target.type === 'session' && (() => {
              const s = contextMenu.target.session
              return (
                <>
                  <div className="context-menu-header">{s.name}</div>
                  <button onClick={() => { onOpenSession(s); closeCtx() }}>⚡ Connect</button>
                  <button onClick={() => { onOpenSession(s); closeCtx() }}>✏ Edit</button>
                  <div className="context-divider" />
                  <button className="danger" onClick={() => {
                    if (confirm(`Delete session "${s.name}"?`)) onDeleteSession(s.id)
                    closeCtx()
                  }}>🗑 Delete Session</button>
                </>
              )
            })()}

            {contextMenu.target.type === 'group' && (() => {
              const name = contextMenu.target.name
              const count = sessionsByGroup[name]?.length ?? 0
              return (
                <>
                  <div className="context-menu-header">{name}</div>
                  <button onClick={() => { onNewConnection(name); closeCtx() }}>+ New Session in Group</button>
                  {name !== 'Ungrouped' && <button onClick={() => startRenameGroup(name)}>✏ Rename Group</button>}
                  <div className="context-divider" />
                  <button className="danger" onClick={() => {
                    const msg = count > 0
                      ? `Delete group "${name}"? Its ${count} session${count !== 1 ? 's' : ''} will be moved to Ungrouped.`
                      : `Delete group "${name}"?`
                    if (confirm(msg)) onDeleteGroup(name)
                    closeCtx()
                  }}>🗑 Delete Group</button>
                </>
              )
            })()}

            {contextMenu.target.type === 'blank' && (
              <>
                <button onClick={() => { onNewConnection(); closeCtx() }}>+ New Session</button>
                <button onClick={startCreatingGroup}>📁 New Group</button>
                <div className="ctx-divider" />
                <button onClick={() => { onImportMoba(); closeCtx() }}>📥 Import from MobaXterm</button>
              </>
            )}

          </div>
        </>
      )}
    </>
  )
}

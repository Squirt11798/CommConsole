import { useState, useEffect, useCallback, useRef } from 'react'

interface FileEntry {
  name: string
  longname: string
  size: number
  mtime: number
  isDir: boolean
  permissions: number
}

interface Props {
  connId: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDate(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString()
}

export default function SftpPanel({ connId }: Props) {
  const [cwd, setCwd] = useState<string>('/')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const newFolderInputRef = useRef<HTMLInputElement>(null)

  const navigate = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    setSelected(new Set())
    try {
      const list = await window.api.sftp.list(connId, path) as FileEntry[]
      list.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      setEntries(list)
      setCwd(path)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [connId])

  useEffect(() => {
    window.api.sftp.pwd(connId).then(p => navigate(p)).catch(() => navigate('/'))
  }, [connId, navigate])

  const goUp = () => {
    const parts = cwd.replace(/\/$/, '').split('/')
    parts.pop()
    navigate(parts.join('/') || '/')
  }

  const handleClick = (entry: FileEntry, e: React.MouseEvent) => {
    if (entry.isDir) {
      navigate(cwd.replace(/\/$/, '') + '/' + entry.name)
      return
    }
    setSelected(prev => {
      const next = new Set(prev)
      if (e.ctrlKey) {
        next.has(entry.name) ? next.delete(entry.name) : next.add(entry.name)
      } else {
        next.clear()
        next.add(entry.name)
      }
      return next
    })
  }

  const download = async (entry: FileEntry) => {
    const localPath = await window.api.dialog.saveFile(entry.name)
    if (!localPath) return
    try {
      await window.api.sftp.download(connId, cwd.replace(/\/$/, '') + '/' + entry.name, localPath)
    } catch (e: unknown) {
      alert(`Download failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const upload = async () => {
    const files = await window.api.dialog.openFile()
    for (const localPath of files) {
      const name = localPath.split(/[/\\]/).pop()!
      try {
        await window.api.sftp.upload(connId, localPath, cwd.replace(/\/$/, '') + '/' + name)
      } catch (e: unknown) {
        alert(`Upload failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    navigate(cwd)
  }

  const startMkdir = () => {
    setCreatingFolder(true)
    setNewFolderName('')
    setTimeout(() => newFolderInputRef.current?.focus(), 20)
  }

  const commitMkdir = async () => {
    const name = newFolderName.trim()
    setCreatingFolder(false)
    setNewFolderName('')
    if (!name) return
    try {
      await window.api.sftp.mkdir(connId, cwd.replace(/\/$/, '') + '/' + name)
      navigate(cwd)
    } catch (e: unknown) {
      alert(`mkdir failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const deleteEntry = async (entry: FileEntry) => {
    if (!confirm(`Delete ${entry.name}?`)) return
    try {
      await window.api.sftp.delete(connId, cwd.replace(/\/$/, '') + '/' + entry.name, entry.isDir)
      navigate(cwd)
    } catch (e: unknown) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const startRename = (entry: FileEntry) => {
    setRenaming(entry.name)
    setRenameValue(entry.name)
  }

  const commitRename = async () => {
    if (!renaming || !renameValue || renameValue === renaming) { setRenaming(null); return }
    const base = cwd.replace(/\/$/, '')
    try {
      await window.api.sftp.rename(connId, base + '/' + renaming, base + '/' + renameValue)
      navigate(cwd)
    } catch (e: unknown) {
      alert(`Rename failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    setRenaming(null)
  }

  return (
    <div className="sftp-panel">
      <div className="sftp-toolbar">
        <button onClick={goUp} title="Up" disabled={cwd === '/'}>↑</button>
        <span className="sftp-cwd" title={cwd}>{cwd}</span>
        <button onClick={() => navigate(cwd)} title="Refresh">⟳</button>
        <button onClick={upload} title="Upload">⬆</button>
        <button onClick={startMkdir} title="New folder">📁+</button>
      </div>

      {creatingFolder && (
        <div className="sftp-mkdir-row">
          <input
            ref={newFolderInputRef}
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            placeholder="Folder name"
            onKeyDown={e => {
              if (e.key === 'Enter') commitMkdir()
              if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName('') }
            }}
          />
          <button onMouseDown={e => { e.preventDefault(); commitMkdir() }} title="Create">✓</button>
          <button onMouseDown={e => { e.preventDefault(); setCreatingFolder(false); setNewFolderName('') }} title="Cancel">✕</button>
        </div>
      )}

      {error && <div className="sftp-error">{error}</div>}

      {loading ? (
        <div className="sftp-loading">Loading…</div>
      ) : (
        <div className="sftp-list">
          <div className="sftp-header-row">
            <span className="col-name">Name</span>
            <span className="col-size">Size</span>
            <span className="col-date">Modified</span>
            <span className="col-actions" />
          </div>
          {entries.map(entry => (
            <div
              key={entry.name}
              className={`sftp-row ${selected.has(entry.name) ? 'selected' : ''} ${entry.isDir ? 'is-dir' : ''}`}
              onClick={e => handleClick(entry, e)}
              onDoubleClick={() => !entry.isDir && download(entry)}
            >
              <span className="col-name">
                {entry.isDir ? '📁 ' : '📄 '}
                {renaming === entry.name ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null) }}
                    onClick={e => e.stopPropagation()}
                  />
                ) : entry.name}
              </span>
              <span className="col-size">{entry.isDir ? '—' : formatSize(entry.size)}</span>
              <span className="col-date">{formatDate(entry.mtime)}</span>
              <span className="col-actions">
                {!entry.isDir && (
                  <button title="Download" onClick={e => { e.stopPropagation(); download(entry) }}>⬇</button>
                )}
                <button title="Rename" onClick={e => { e.stopPropagation(); startRename(entry) }}>✏</button>
                <button title="Delete" onClick={e => { e.stopPropagation(); deleteEntry(entry) }}>🗑</button>
              </span>
            </div>
          ))}
          {entries.length === 0 && <div className="sftp-empty">Empty directory</div>}
        </div>
      )}
    </div>
  )
}

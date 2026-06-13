import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'

interface Props {
  connId: string
  active: boolean
  fontFamily?: string
  fontSize?: number
  theme?: string
  broadcast?: boolean          // when true, typed input is mirrored to broadcastTargets
  broadcastTargets?: string[]  // connIds to mirror input to (includes this one)
  onUpload?: (files: Array<{ path: string; name: string }>) => void  // SSH only: files dropped on the terminal
}

const DARK_ANSI = {
  black: '#1a1e12', brightBlack: '#4a5238',
  red: '#cf5a3c', brightRed: '#e07a5a',
  green: '#8bbf3f', brightGreen: '#a6d65c',
  yellow: '#c9a227', brightYellow: '#e6c34a',
  blue: '#5f86a8', brightBlue: '#7ba3c4',
  magenta: '#a86f9e', brightMagenta: '#c48fbb',
  cyan: '#5fae9e', brightCyan: '#7fcab8',
  white: '#d6d8c2', brightWhite: '#f0f0e0'
}

const LIGHT_ANSI = {
  black: '#20231a', brightBlack: '#6a6c5e',
  red: '#b23a1f', brightRed: '#d4542f',
  green: '#4f7d1f', brightGreen: '#6a9e2f',
  yellow: '#8a6d1f', brightYellow: '#b8902f',
  blue: '#2f5f8a', brightBlue: '#4f7fae',
  magenta: '#7a3f6e', brightMagenta: '#9a5f8e',
  cyan: '#2f7e6e', brightCyan: '#4f9e8e',
  white: '#20231a', brightWhite: '#000000'
}

// Build the xterm theme from the active CSS theme variables so the terminal
// matches whatever app theme is selected.
function buildTermTheme(theme?: string): Record<string, string> {
  const v = (name: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return {
    background: v('--bg-0') || '#0e120b',
    foreground: v('--text') || '#d6d8c2',
    cursor: v('--accent') || '#b9a44a',
    selectionBackground: v('--bg-3') || '#29331d',
    ...(theme === 'light' ? LIGHT_ANSI : DARK_ANSI)
  }
}

export default function Terminal({ connId, active, fontFamily, fontSize, theme, broadcast, broadcastTargets, onUpload }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  // Keep the latest broadcast state in refs so the (mount-time) onData handler
  // reads current values without being re-created.
  const broadcastRef = useRef<boolean>(!!broadcast)
  const targetsRef = useRef<string[]>(broadcastTargets ?? [])
  const onUploadRef = useRef<Props['onUpload']>(onUpload)
  broadcastRef.current = !!broadcast
  targetsRef.current = broadcastTargets ?? []
  onUploadRef.current = onUpload

  // Scrollback search (Ctrl+F)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [searchVal, setSearchVal] = useState('')

  const closeSearch = (): void => {
    setShowSearch(false)
    searchAddonRef.current?.clearDecorations()
    termRef.current?.focus()
  }

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: fontFamily || '"Cascadia Code", "Fira Code", "Consolas", monospace',
      fontSize: fontSize || 14,
      lineHeight: 1.2,
      theme: buildTermTheme(theme),
      allowProposedApi: true
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon

    // Ctrl/Cmd+F opens the in-terminal search box (don't pass the key to the shell)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        setShowSearch(true)
        setTimeout(() => searchInputRef.current?.select(), 0)
        return false
      }
      return true
    })

    // Copy selection to system clipboard on mouse-up
    term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (sel) navigator.clipboard.writeText(sel).catch(() => {})
    })

    // Send keystrokes to SSH. When broadcast is active, mirror input to every
    // target connection; otherwise send only to this one.
    term.onData(data => {
      if (broadcastRef.current && targetsRef.current.length > 0) {
        for (const id of targetsRef.current) window.api.ssh.sendData(id, data)
      } else {
        window.api.ssh.sendData(connId, data)
      }
    })

    // Notify main of resize
    term.onResize(({ cols, rows }) => {
      window.api.ssh.resize(connId, cols, rows)
    })

    // Receive data from SSH
    const unsub = window.api.ssh.onData((id, data) => {
      if (id === connId) term.write(data)
    })

    // Right-click pastes clipboard content into the terminal
    const handleContextMenu = async (e: MouseEvent) => {
      e.preventDefault()
      const text = await navigator.clipboard.readText().catch(() => '')
      if (text) window.api.ssh.sendData(connId, text)
    }
    containerRef.current.addEventListener('contextmenu', handleContextMenu)

    // Drag-and-drop files onto the terminal → SFTP-upload to the remote cwd.
    const container = containerRef.current
    const handleDragOver = (e: DragEvent): void => {
      if (!onUploadRef.current) return
      e.preventDefault()
      container.classList.add('drag-over')
    }
    const handleDragLeave = (): void => container.classList.remove('drag-over')
    const handleDrop = (e: DragEvent): void => {
      container.classList.remove('drag-over')
      if (!onUploadRef.current) return
      e.preventDefault()
      const files = Array.from(e.dataTransfer?.files ?? [])
        .map(f => ({ path: (f as File & { path?: string }).path ?? '', name: f.name }))
        .filter(f => f.path)
      if (files.length) onUploadRef.current(files)
    }
    container.addEventListener('dragover', handleDragOver)
    container.addEventListener('dragleave', handleDragLeave)
    container.addEventListener('drop', handleDrop)

    const ro = new ResizeObserver(() => fitAddon.fit())
    ro.observe(containerRef.current)

    return () => {
      unsub()
      ro.disconnect()
      container.removeEventListener('contextmenu', handleContextMenu)
      container.removeEventListener('dragover', handleDragOver)
      container.removeEventListener('dragleave', handleDragLeave)
      container.removeEventListener('drop', handleDrop)
      term.dispose()
    }
  }, [connId])

  // Re-fit when tab becomes active
  useEffect(() => {
    if (active) {
      setTimeout(() => fitAddonRef.current?.fit(), 50)
    }
  }, [active])

  // Apply live font / theme changes without recreating the terminal
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (fontFamily) term.options.fontFamily = fontFamily
    if (fontSize) term.options.fontSize = fontSize
    term.options.theme = buildTermTheme(theme)
    fitAddonRef.current?.fit()
  }, [fontFamily, fontSize, theme])

  // Focus the search box when it opens
  useEffect(() => { if (showSearch) searchInputRef.current?.focus() }, [showSearch])

  const find = (forward: boolean): void => {
    if (!searchVal) return
    if (forward) searchAddonRef.current?.findNext(searchVal)
    else searchAddonRef.current?.findPrevious(searchVal)
  }

  return (
    <div className="terminal-wrap">
      <div ref={containerRef} className="terminal-container" />
      {showSearch && (
        <div className="term-search">
          <input
            ref={searchInputRef}
            value={searchVal}
            placeholder="Find in scrollback…"
            spellCheck={false}
            onChange={e => {
              setSearchVal(e.target.value)
              searchAddonRef.current?.findNext(e.target.value, { incremental: true })
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); find(!e.shiftKey) }
              else if (e.key === 'Escape') { e.preventDefault(); closeSearch() }
            }}
          />
          <button onClick={() => find(false)} title="Previous (Shift+Enter)">↑</button>
          <button onClick={() => find(true)} title="Next (Enter)">↓</button>
          <button onClick={closeSearch} title="Close (Esc)">✕</button>
        </div>
      )}
    </div>
  )
}

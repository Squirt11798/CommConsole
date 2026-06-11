import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface Props {
  connId: string
  active: boolean
}

export default function Terminal({ connId, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: '#0d0d1a',
        foreground: '#e0e0f0',
        cursor: '#7c7cff',
        selectionBackground: '#3a3a6a',
        black: '#1a1a2e',
        brightBlack: '#4a4a6a',
        red: '#ff6b6b',
        brightRed: '#ff8e8e',
        green: '#6bff9e',
        brightGreen: '#8effc0',
        yellow: '#ffd93d',
        brightYellow: '#ffe066',
        blue: '#7c9cff',
        brightBlue: '#9eb8ff',
        magenta: '#c47cff',
        brightMagenta: '#d89eff',
        cyan: '#7cffee',
        brightCyan: '#9efff5',
        white: '#d0d0e8',
        brightWhite: '#f0f0ff'
      },
      allowProposedApi: true
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Copy selection to system clipboard on mouse-up
    term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (sel) navigator.clipboard.writeText(sel).catch(() => {})
    })

    // Send keystrokes to SSH
    term.onData(data => {
      window.api.ssh.sendData(connId, data)
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

    const ro = new ResizeObserver(() => fitAddon.fit())
    ro.observe(containerRef.current)

    return () => {
      unsub()
      ro.disconnect()
      containerRef.current?.removeEventListener('contextmenu', handleContextMenu)
      term.dispose()
    }
  }, [connId])

  // Re-fit when tab becomes active
  useEffect(() => {
    if (active) {
      setTimeout(() => fitAddonRef.current?.fit(), 50)
    }
  }, [active])

  return <div ref={containerRef} className="terminal-container" />
}

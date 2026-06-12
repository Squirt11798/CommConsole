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
        // Military / tactical palette to match the app shell
        background: '#0e120b',
        foreground: '#d6d8c2',
        cursor: '#b9a44a',
        selectionBackground: '#29331d',
        black: '#1a1e12',
        brightBlack: '#4a5238',
        red: '#cf5a3c',
        brightRed: '#e07a5a',
        green: '#8bbf3f',
        brightGreen: '#a6d65c',
        yellow: '#c9a227',
        brightYellow: '#e6c34a',
        blue: '#5f86a8',
        brightBlue: '#7ba3c4',
        magenta: '#a86f9e',
        brightMagenta: '#c48fbb',
        cyan: '#5fae9e',
        brightCyan: '#7fcab8',
        white: '#d6d8c2',
        brightWhite: '#f0f0e0'
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

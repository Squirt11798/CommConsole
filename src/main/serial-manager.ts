import { ipcMain, BrowserWindow } from 'electron'
import { SerialPort } from 'serialport'
import { randomUUID } from 'crypto'
import { startLog, appendLog, endLog } from './session-log'

interface SerialConnection {
  id: string
  port: SerialPort
}

const serialConnections = new Map<string, SerialConnection>()

function send(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) win.webContents.send(channel, ...args)
}

export function registerSerialHandlers(win: BrowserWindow): void {
  // List available COM ports
  ipcMain.handle('serial:list', async () => {
    const ports = await SerialPort.list()
    return ports.map(p => ({
      path: p.path,
      manufacturer: p.manufacturer ?? '',
      serialNumber: p.serialNumber ?? '',
      pnpId: p.pnpId ?? ''
    }))
  })

  // Open a serial port — returns connId; reuses ssh:data / ssh:closed channels
  // so Terminal.tsx works unchanged.
  ipcMain.handle('serial:connect', (_e, opts: {
    path: string
    baudRate: number
    dataBits?: 5 | 6 | 7 | 8
    parity?: 'none' | 'odd' | 'even'
    stopBits?: 1 | 2
  }) => {
    return new Promise<{ id: string }>((resolve, reject) => {
      const connId = randomUUID()

      const port = new SerialPort({
        path: opts.path,
        baudRate: opts.baudRate,
        dataBits: opts.dataBits ?? 8,
        parity: opts.parity ?? 'none',
        stopBits: opts.stopBits ?? 1,
        autoOpen: false
      })

      port.on('data', (data: Buffer) => {
        const s = data.toString('binary')
        appendLog(connId, s)
        send(win, 'ssh:data', connId, s)
      })

      port.on('close', () => {
        endLog(connId)
        serialConnections.delete(connId)
        send(win, 'ssh:closed', connId)
      })

      port.on('error', (err) => {
        // Only reject during the open phase; after open, log and close.
        if (!serialConnections.has(connId)) {
          reject(new Error(`Failed to open ${opts.path}: ${err.message}`))
        } else {
          serialConnections.delete(connId)
          send(win, 'ssh:closed', connId)
        }
      })

      port.open((err) => {
        if (err) {
          reject(new Error(`Cannot open ${opts.path}: ${err.message}\n\nCheck that the port is not in use by another application.`))
          return
        }
        serialConnections.set(connId, { id: connId, port })
        startLog(connId, opts.path)
        resolve({ id: connId })
      })
    })
  })

  // Route terminal input to the serial port.
  // ssh-manager has its own ssh:data listener that checks its own connections map —
  // if connId is not in that map it no-ops, so dual listeners are safe.
  ipcMain.on('ssh:data', (_e, connId: string, data: string) => {
    const conn = serialConnections.get(connId)
    if (conn) conn.port.write(Buffer.from(data, 'binary'))
  })

  // Explicit disconnect
  ipcMain.handle('serial:disconnect', (_e, connId: string) => {
    const conn = serialConnections.get(connId)
    if (conn && conn.port.isOpen) {
      conn.port.close()
    }
    endLog(connId)
    serialConnections.delete(connId)
  })
}

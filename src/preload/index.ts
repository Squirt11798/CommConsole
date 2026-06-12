import { contextBridge, ipcRenderer } from 'electron'

const api = {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close')
  },

  dialog: {
    openKey: (): Promise<string | null> => ipcRenderer.invoke('dialog:openKey'),
    saveFile: (defaultName: string): Promise<string | null> => ipcRenderer.invoke('dialog:saveFile', defaultName),
    openFile: (): Promise<string[]> => ipcRenderer.invoke('dialog:openFile'),
    openMobaConf: (): Promise<string | null> => ipcRenderer.invoke('dialog:openMobaConf')
  },

  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    save: (session: object) => ipcRenderer.invoke('sessions:save', session),
    delete: (id: string) => ipcRenderer.invoke('sessions:delete', id),
    importMoba: (filePath: string): Promise<{ imported: number; skipped: number }> =>
      ipcRenderer.invoke('sessions:importMoba', filePath)
  },

  groups: {
    list: (): Promise<string[]> => ipcRenderer.invoke('groups:list'),
    create: (name: string) => ipcRenderer.invoke('groups:create', name),
    rename: (oldName: string, newName: string) => ipcRenderer.invoke('groups:rename', oldName, newName),
    delete: (name: string) => ipcRenderer.invoke('groups:delete', name)
  },

  ssh: {
    connect: (opts: object): Promise<{ id: string }> => ipcRenderer.invoke('ssh:connect', opts),
    disconnect: (connId: string) => ipcRenderer.invoke('ssh:disconnect', connId),
    sendData: (connId: string, data: string) => ipcRenderer.send('ssh:data', connId, data),
    resize: (connId: string, cols: number, rows: number) => ipcRenderer.send('ssh:resize', connId, cols, rows),
    onData: (cb: (connId: string, data: string) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, connId: string, data: string) => cb(connId, data)
      ipcRenderer.on('ssh:data', handler)
      return () => ipcRenderer.off('ssh:data', handler)
    },
    getStats: (connId: string): Promise<string> => ipcRenderer.invoke('ssh:getStats', connId),
    onClosed: (cb: (connId: string) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, connId: string) => cb(connId)
      ipcRenderer.on('ssh:closed', handler)
      return () => ipcRenderer.off('ssh:closed', handler)
    },
    onPrompt: (cb: (connId: string, promptId: string, name: string, instructions: string, prompts: Array<{ prompt: string; echo: boolean }>) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, connId: string, promptId: string, name: string, instructions: string, prompts: Array<{ prompt: string; echo: boolean }>) =>
        cb(connId, promptId, name, instructions, prompts)
      ipcRenderer.on('ssh:prompt', handler)
      return () => ipcRenderer.off('ssh:prompt', handler)
    },
    respondPrompt: (promptId: string, answers: string[]) =>
      ipcRenderer.send('ssh:promptResponse', promptId, answers)
  },

  serial: {
    listPorts: (): Promise<Array<{ path: string; manufacturer: string; serialNumber: string; pnpId: string }>> =>
      ipcRenderer.invoke('serial:list'),
    connect: (opts: { path: string; baudRate: number; dataBits?: number; parity?: string; stopBits?: number }): Promise<{ id: string }> =>
      ipcRenderer.invoke('serial:connect', opts),
    disconnect: (connId: string) => ipcRenderer.invoke('serial:disconnect', connId)
  },

  tunnels: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('tunnels:list'),
    listSessions: (): Promise<Array<{ id: string; name: string; host: string }>> =>
      ipcRenderer.invoke('tunnels:listSessions'),
    save: (cfg: object): Promise<string> => ipcRenderer.invoke('tunnels:save', cfg),
    delete: (id: string) => ipcRenderer.invoke('tunnels:delete', id),
    start: (id: string) => ipcRenderer.invoke('tunnels:start', id),
    stop: (id: string) => ipcRenderer.invoke('tunnels:stop', id),
    onStatus: (cb: (id: string, state: string, error: string) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, id: string, state: string, error: string) => cb(id, state, error)
      ipcRenderer.on('tunnels:status', handler)
      return () => ipcRenderer.off('tunnels:status', handler)
    }
  },

  sftp: {
    list: (connId: string, path: string) => ipcRenderer.invoke('sftp:list', connId, path),
    download: (connId: string, remotePath: string, localPath: string) =>
      ipcRenderer.invoke('sftp:download', connId, remotePath, localPath),
    upload: (connId: string, localPath: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:upload', connId, localPath, remotePath),
    mkdir: (connId: string, path: string) => ipcRenderer.invoke('sftp:mkdir', connId, path),
    delete: (connId: string, path: string, isDir: boolean) => ipcRenderer.invoke('sftp:delete', connId, path, isDir),
    rename: (connId: string, oldPath: string, newPath: string) => ipcRenderer.invoke('sftp:rename', connId, oldPath, newPath),
    pwd: (connId: string) => ipcRenderer.invoke('sftp:pwd', connId)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api

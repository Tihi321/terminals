import { contextBridge, ipcRenderer } from 'electron'
import type { TerminalsApi } from '../shared/types'

const inv = (channel: string, ...args: unknown[]): Promise<never> => ipcRenderer.invoke(channel, ...args) as Promise<never>

const api: TerminalsApi = {
  getState: () => inv('state:get'),
  addFolder: () => inv('folders:add'),
  addParentGroup: () => inv('groups:addParent'),
  addGroup: (name) => inv('groups:addManual', name),
  removeFolder: (id) => inv('folders:remove', id),
  removeGroup: (id) => inv('groups:remove', id),
  renameFolder: (id, name) => inv('folders:rename', id, name),
  renameGroup: (id, name) => inv('groups:rename', id, name),
  moveFolder: (id, groupId, beforeId) => inv('folders:move', id, groupId, beforeId),
  setGroupCollapsed: (id, c) => inv('groups:collapsed', id, c),
  setShowHidden: (id, s) => inv('groups:showHidden', id, s),
  setChildHidden: (id, path, h) => inv('groups:childHidden', id, path, h),
  select: (id) => inv('state:select', id),
  saveCommand: (cmd) => inv('commands:save', cmd),
  deleteCommand: (id) => inv('commands:delete', id),
  setSettings: (patch) => inv('settings:set', patch),
  setUi: (patch) => inv('ui:set', patch),
  pickFolder: () => inv('dialog:pickFolder'),

  openInWindowsTerminal: (p) => inv('shell:openWt', p),
  openInExplorer: (p) => inv('shell:openExplorer', p),
  openInEditor: (p) => inv('shell:openEditor', p),
  openDefault: (p) => inv('shell:openDefault', p),
  revealInExplorer: (p) => inv('shell:reveal', p),
  listDir: (p, ignored) => inv('fs:list', p, ignored),
  watchDirs: (paths) => ipcRenderer.send('fs:watch', paths),
  onFsChanged: (cb) => {
    const h = (_: unknown, dir: string): void => cb(dir)
    ipcRenderer.on('fs:changed', h)
    return () => ipcRenderer.removeListener('fs:changed', h)
  },

  clipboardRead: () => inv('clipboard:read'),
  clipboardWrite: (text) => inv('clipboard:write', text),
  ptyCreate: (req) => inv('pty:create', req),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  ptyKill: (id) => ipcRenderer.send('pty:kill', id),
  onPtyData: (cb) => {
    const h = (_: unknown, id: string, data: string): void => cb(id, data)
    ipcRenderer.on('pty:data', h)
    return () => ipcRenderer.removeListener('pty:data', h)
  },
  onPtyExit: (cb) => {
    const h = (_: unknown, id: string, code: number): void => cb(id, code)
    ipcRenderer.on('pty:exit', h)
    return () => ipcRenderer.removeListener('pty:exit', h)
  }
}

contextBridge.exposeInMainWorld('api', api)

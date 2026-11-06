const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('graveyard', {
  get: () => ipcRenderer.invoke('graves:get'),
  update: (id, patch) => ipcRenderer.invoke('grave:update', id, patch),
  hide: (id) => ipcRenderer.invoke('grave:hide', id),
  unhideAll: () => ipcRenderer.invoke('graves:unhideAll'),
  add: (data) => ipcRenderer.invoke('grave:add', data),
  remove: (id) => ipcRenderer.invoke('grave:remove', id),
  quit: () => ipcRenderer.send('app:quit'),
  toggle: () => ipcRenderer.send('view:toggle'),
  capture: (on) => ipcRenderer.send('mouse:capture', on),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag:move', dx, dy),
  dragEnd: () => ipcRenderer.send('drag:end'),
  onState: (fn) => ipcRenderer.on('view:state', (_e, s) => fn(s)),
  onRefresh: (fn) => ipcRenderer.on('refresh', () => fn()),
  onOpenAdd: (fn) => ipcRenderer.on('open-add', () => fn()),
  onCloseDialogs: (fn) => ipcRenderer.on('close-dialogs', () => fn()),
});

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('nooknote', {
  getState: () => ipcRenderer.invoke('state:get'),
  getPosition: () => ipcRenderer.invoke('state:position'),
  saveDraft: (draft) => ipcRenderer.invoke('state:save-draft', draft),
  addNote: (text) => ipcRenderer.invoke('note:add', text),
  deleteNote: (id) => ipcRenderer.invoke('note:delete', id),
  openPanel: () => ipcRenderer.send('panel:open'),
  hidePanel: () => ipcRenderer.send('panel:hide'),
  panelEntered: () => ipcRenderer.send('panel:enter'),
  panelLeft: () => ipcRenderer.send('panel:leave'),
  triggerLeft: () => ipcRenderer.send('trigger:leave'),
  startDrag: () => ipcRenderer.send('edge:drag-start'),
  dragTo: (point) => ipcRenderer.send('edge:drag-move', point),
  finishDrag: (point) => ipcRenderer.invoke('edge:drag-end', point),
  escape: () => ipcRenderer.send('app:escape'),
  onPositionChanged: (callback) => subscribe('edge:position-changed', callback),
  onPanelOpened: (callback) => subscribe('panel:opened', callback),
});

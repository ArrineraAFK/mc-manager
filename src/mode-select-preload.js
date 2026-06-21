const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modeApi', {
  setMode: (mode, connection) => ipcRenderer.invoke('set-app-mode', { mode, connection }),
  testConnection: (opts) => ipcRenderer.invoke('test-remote-connection', opts),
});
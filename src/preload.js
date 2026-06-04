const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mc', {
  // Ordner
  selectFolder:   ()        => ipcRenderer.invoke('select-folder'),

  // Server-Liste
  serversLoad:    ()        => ipcRenderer.invoke('servers-load'),
  serversSave:    (list)    => ipcRenderer.invoke('servers-save', list),

  // Server-Steuerung (alle mit id)
  serverStart:    (opts)    => ipcRenderer.invoke('server-start', opts),
  serverStop:     (id)      => ipcRenderer.invoke('server-stop', id),
  serverCommand:  (opts)    => ipcRenderer.invoke('server-command', opts),

  // RCON
  rconConnect:    (opts)    => ipcRenderer.invoke('rcon-connect', opts),
  rconSend:       (opts)    => ipcRenderer.invoke('rcon-send', opts),

  // Properties
  propsRead:      (p)       => ipcRenderer.invoke('props-read', p),
  propsWrite:     (opts)    => ipcRenderer.invoke('props-write', opts),

  // Mods
  modsScan:       (p)       => ipcRenderer.invoke('mods-scan', p),
  modToggle:      (opts)    => ipcRenderer.invoke('mod-toggle', opts),
  modDelete:      (p)       => ipcRenderer.invoke('mod-delete', p),

  // Backup
  backupCreate:   (opts)    => ipcRenderer.invoke('backup-create', opts),

  // Download
  dlVersions:     (loader)  => ipcRenderer.invoke('dl-versions', loader),
  dlBuilds:       (opts)    => ipcRenderer.invoke('dl-builds', opts),
  dlDownload:     (opts)    => ipcRenderer.invoke('dl-download', opts),

  // Events
  onLog:          (cb)      => ipcRenderer.on('server-log',     (_, d) => cb(d)),
  onStopped:      (cb)      => ipcRenderer.on('server-stopped', (_, d) => cb(d)),
  onDlProgress:   (cb)      => ipcRenderer.on('dl-progress',    (_, p) => cb(p)),
});

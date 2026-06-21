const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mc', {
  // Ordner
  selectFolder:   ()        => ipcRenderer.invoke('select-folder'),

  createServerFolder: (opts) => ipcRenderer.invoke('create-server-folder', opts),

  // Server-Liste
  serversLoad:    ()        => ipcRenderer.invoke('servers-load'),
  serversSave:    (list)    => ipcRenderer.invoke('servers-save', list),

  // Server-Steuerung (alle mit id)
  serverStart:    (opts)    => ipcRenderer.invoke('server-start', opts),
  serverStop:     (id)      => ipcRenderer.invoke('server-stop', id),
  serverCommand:  (opts)    => ipcRenderer.invoke('server-command', opts),
  deleteServerFolder: (p) => ipcRenderer.invoke('delete-server-folder', p),

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

  getStats:       (id)      => ipcRenderer.invoke('get-stats', id),
  getLocalIp:     ()        => ipcRenderer.invoke('get-local-ip'),
  getIpv6:        ()        => ipcRenderer.invoke('get-ipv6'),

  // Diagnose & Reparatur
  diagnose:       (p, j)    => ipcRenderer.invoke('diagnose', p, j),
  repair:         (opts)    => ipcRenderer.invoke('repair', opts),

  // UPnP Port Forwarding
  upnpMap:     (opts) => ipcRenderer.invoke('upnp-map', opts),
  upnpUnmap:   (opts) => ipcRenderer.invoke('upnp-unmap', opts),
  upnpStatus:  (opts) => ipcRenderer.invoke('upnp-status', opts),

  // Server Icon
  iconSelect:     (p)       => ipcRenderer.invoke('icon-select', p),
  iconLoad:       (p)       => ipcRenderer.invoke('icon-load', p),

  // Resourcepacks
  rpScan:         (p)       => ipcRenderer.invoke('rp-scan', p),
  rpToggle:       (opts)    => ipcRenderer.invoke('rp-toggle', opts),
  rpDelete:       (p)       => ipcRenderer.invoke('rp-delete', p),

  // Prefs (Pfad-Persistenz)
  prefsGet:       (k)       => ipcRenderer.invoke('prefs-get', k),
  prefsSet:       (k, v)    => ipcRenderer.invoke('prefs-set', k, v),
  getAppMode:     ()        => ipcRenderer.invoke('get-app-mode'),
  resetAppMode:   ()        => ipcRenderer.invoke('reset-app-mode'),

  // Stats-Persistenz
  statsLoad:          (id)   => ipcRenderer.invoke('stats-load', id),
  statsAppendPoint:   (opts) => ipcRenderer.invoke('stats-append-point', opts),
  statsAppendJoin:    (opts) => ipcRenderer.invoke('stats-append-join', opts),
  statsSaveFile:      (opts) => ipcRenderer.invoke('stats-save-file', opts),

  // Hangar
  hangarSearch:    (opts)   => ipcRenderer.invoke('hangar-search', opts),
  hangarInstall:   (opts)   => ipcRenderer.invoke('hangar-install', opts),

  // Modrinth
  modrinthSearch:  (opts)   => ipcRenderer.invoke('modrinth-search', opts),
  modrinthInstall: (opts)   => ipcRenderer.invoke('modrinth-install', opts),

  // File Browser
  filesList:      (p, r)    => ipcRenderer.invoke('files-list', p, r),
  fileRead:       (p)       => ipcRenderer.invoke('file-read', p),
  fileWrite:      (p, c)    => ipcRenderer.invoke('file-write', p, c),
  fileDelete:     (p, d)    => ipcRenderer.invoke('file-delete', p, d),
  fileRename:     (p, n)    => ipcRenderer.invoke('file-rename', p, n),
  fileCreate:     (p, n, d) => ipcRenderer.invoke('file-create', p, n, d),

  // Whitelist / Banlist
  listRead:       (opts)    => ipcRenderer.invoke('list-read', opts),
  listAdd:        (opts)    => ipcRenderer.invoke('list-add', opts),
  listRemove:     (opts)    => ipcRenderer.invoke('list-remove', opts),

  // EULA
  eulaCheck:      (p)       => ipcRenderer.invoke('eula-check', p),
  eulaAccept:     (p)       => ipcRenderer.invoke('eula-accept', p),

  // Spieler
  playersList:    (id)      => ipcRenderer.invoke('players-list', id),
  playerKick:     (opts)    => ipcRenderer.invoke('player-kick', opts),
  playerBan:      (opts)    => ipcRenderer.invoke('player-ban', opts),
  playerOp:       (opts)    => ipcRenderer.invoke('player-op', opts),

  // Mod Config
  modConfigFiles: (opts)    => ipcRenderer.invoke('mod-config-files', opts),

  // Download
  dlVersions:     (loader)  => ipcRenderer.invoke('dl-versions', loader),
  dlBuilds:       (opts)    => ipcRenderer.invoke('dl-builds', opts),
  dlDownload:     (opts)    => ipcRenderer.invoke('dl-download', opts),

  // Events
  onLog:          (cb)      => ipcRenderer.on('server-log',     (_, d) => cb(d)),
  onStopped:      (cb)      => ipcRenderer.on('server-stopped', (_, d) => cb(d)),
  onDlProgress:   (cb)      => ipcRenderer.on('dl-progress',    (_, p) => cb(p)),

  // DDNS (generisch)
  ddnsGetProviders: () => ipcRenderer.invoke('ddns-get-providers'),
  ddnsUpdate: (opts) => ipcRenderer.invoke('ddns-update', opts),
});

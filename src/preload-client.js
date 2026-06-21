const { contextBridge, ipcRenderer } = require('electron');

let connInfo = null;
let ws = null;
let wsConnected = false;
let logListeners = [];
let stoppedListeners = [];
let connectionListeners = [];
let reconnectTimer = null;

async function getConnInfo() {
  if (connInfo) return connInfo;
  const res = await ipcRenderer.invoke('get-app-mode');
  connInfo = res.connection;
  return connInfo;
}

async function apiCall(endpoint, data = {}, timeoutMs = 5000) {
  const conn = await getConnInfo();
  if (!conn) return { ok: false, error: 'Keine Verbindungsdaten vorhanden.' };
  const url = `http://${conn.host}:${conn.port}${endpoint}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: controller.signal
    });
    clearTimeout(timer);
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      return { ok: false, error: 'Server nicht erreichbar (Zeitüberschreitung). Läuft die App auf dem Server-PC?' };
    }
    return { ok: false, error: 'Verbindung fehlgeschlagen: ' + e.message };
  }
}

function connectWebSocket() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  getConnInfo().then(conn => {
    if (!conn) {
      reconnectTimer = setTimeout(connectWebSocket, 3000);
      return;
    }

    try {
      const wsUrl = `ws://${conn.host}:${conn.port}`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        wsConnected = true;
        connectionListeners.forEach(cb => cb({ connected: true }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'server-log') {
            logListeners.forEach(cb => cb({ id: msg.id, msg: msg.msg }));
          } else if (msg.type === 'server-stopped') {
            stoppedListeners.forEach(cb => cb({ id: msg.id, code: msg.code }));
          }
        } catch (_) {}
      };

      ws.onclose = () => {
        wsConnected = false;
        connectionListeners.forEach(cb => cb({ connected: false }));
        reconnectTimer = setTimeout(connectWebSocket, 3000);
      };

      ws.onerror = () => {
        wsConnected = false;
        // onclose wird i.d.R. danach auch gefeuert, kein doppelter Timer nötig
      };
    } catch (e) {
      reconnectTimer = setTimeout(connectWebSocket, 3000);
    }
  });
}

function manualReconnect() {
  if (ws) { try { ws.close(); } catch(_) {} ws = null; }
  connInfo = null; // Neu von Main-Prozess laden, falls sich was geändert hat
  connectWebSocket();
}

connectWebSocket();

// Platzhalter für noch nicht implementierte Remote-Funktionen
const notImplemented = () => Promise.resolve({ ok: false, error: 'Im Remote-Modus noch nicht verfügbar.' });

contextBridge.exposeInMainWorld('mc', {
  // ── Implementiert ──────────────────────────────────────────────
  serversLoad:    ()        => apiCall('/api/servers-load'),
  serversSave:    (list)    => apiCall('/api/servers-save', { list }),
  serverStart:    (opts)    => apiCall('/api/server-start', opts),
  serverStop:     (id)      => apiCall('/api/server-stop', { id }),
  serverCommand:  (opts)    => apiCall('/api/server-command', opts),
  getServerStatus: ()       => apiCall('/api/server-status'),

  onLog:          (cb)      => logListeners.push(cb),
  onStopped:      (cb)      => stoppedListeners.push(cb),
  onConnectionChange: (cb)  => connectionListeners.push(cb),
  onDlProgress:   (cb)      => {},

  reconnect:      ()        => manualReconnect(),
  isConnected:    ()        => wsConnected,

  getAppMode:     ()        => ipcRenderer.invoke('get-app-mode'),
  resetAppMode:   ()        => ipcRenderer.invoke('reset-app-mode'),
  prefsGet:       ()        => Promise.resolve({ ok: true, value: null }),
  prefsSet:       ()        => Promise.resolve({ ok: true }),

  // ── Via Remote-API implementiert ────────────────────────────────
  deleteServerFolder:  (p)       => apiCall('/api/delete-server-folder', { serverPath: p }),
  rconConnect:         (opts)    => apiCall('/api/rcon-connect', opts),
  rconSend:            (opts)    => apiCall('/api/rcon-send', opts),
  propsRead:           (p)       => apiCall('/api/props-read', { serverPath: p }),
  propsWrite:          (opts)    => apiCall('/api/props-write', opts),
  modsScan:            (p)       => apiCall('/api/mods-scan', { serverPath: p }),
  modToggle:           (opts)    => apiCall('/api/mod-toggle', opts),
  modDelete:           (p)       => apiCall('/api/mod-delete', { modPath: p }),
  backupCreate:        (opts)    => apiCall('/api/backup-create', opts),
  getStats:            (id)      => apiCall('/api/get-stats', { id }),
  getLocalIp:          ()        => apiCall('/api/get-local-ip'),
  getIpv6:             ()        => apiCall('/api/get-ipv6'),
  diagnose:            (p, j)    => apiCall('/api/diagnose', { serverPath: p, jar: j }),
  repair:              (opts)    => apiCall('/api/repair', opts),
  iconLoad:            (p)       => apiCall('/api/icon-load', { serverPath: p }),
  rpScan:              (p)       => apiCall('/api/rp-scan', { serverPath: p }),
  rpToggle:            (opts)    => apiCall('/api/rp-toggle', opts),
  rpDelete:            (p)       => apiCall('/api/rp-delete', { rpPath: p }),
  statsLoad:           (id)      => apiCall('/api/stats-load', { id }),
  statsAppendPoint:    (opts)    => apiCall('/api/stats-append-point', opts),
  statsAppendJoin:     (opts)    => apiCall('/api/stats-append-join', opts),
  hangarSearch:        (opts)    => apiCall('/api/hangar-search', opts),
  hangarInstall:       (opts)    => apiCall('/api/hangar-install', opts),
  modrinthSearch:      (opts)    => apiCall('/api/modrinth-search', opts),
  modrinthInstall:     (opts)    => apiCall('/api/modrinth-install', opts),
  filesList:           (p, r)    => apiCall('/api/files-list', { currentPath: p, rootPath: r }),
  fileRead:            (p)       => apiCall('/api/file-read', { filePath: p }),
  fileWrite:           (p, c)    => apiCall('/api/file-write', { filePath: p, content: c }),
  fileDelete:          (p, d)    => apiCall('/api/file-delete', { filePath: p, isDir: d }),
  fileRename:          (p, n)    => apiCall('/api/file-rename', { filePath: p, newName: n }),
  fileCreate:          (p, n, d) => apiCall('/api/file-create', { parentPath: p, name: n, isDir: d }),
  listRead:            (opts)    => apiCall('/api/list-read', opts),
  listAdd:             (opts)    => apiCall('/api/list-add', opts),
  listRemove:          (opts)    => apiCall('/api/list-remove', opts),
  eulaCheck:           (p)       => apiCall('/api/eula-check', { serverPath: p }),
  eulaAccept:          (p)       => apiCall('/api/eula-accept', { serverPath: p }),
  playersList:         (id)      => apiCall('/api/players-list', { id }),
  playerKick:          (opts)    => apiCall('/api/player-kick', opts),
  playerBan:           (opts)    => apiCall('/api/player-ban', opts),
  playerOp:            (opts)    => apiCall('/api/player-op', opts),
  modConfigFiles:      (opts)    => apiCall('/api/mod-config-files', opts),

  // ── Via Remote-API (Server-Netzwerk) ─────────────────────────────
  upnpMap:             (opts)    => apiCall('/api/upnp-map', opts),
  upnpUnmap:           (opts)    => apiCall('/api/upnp-unmap', opts),
  upnpStatus:          (opts)    => apiCall('/api/upnp-status', opts),
  ddnsGetProviders:    ()        => apiCall('/api/ddns-get-providers'),
  ddnsUpdate:          (opts)    => apiCall('/api/ddns-update', opts),

  // ── Nicht im Remote-Modus verfügbar (benötigen Electron-Dialoge) ──
  selectFolder:        notImplemented,
  createServerFolder:  notImplemented,
  iconSelect:          notImplemented,
  statsSaveFile:       notImplemented,
  dlVersions:          notImplemented,
  dlBuilds:            notImplemented,
  dlDownload:          notImplemented,
});
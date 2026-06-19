// ── State ─────────────────────────────────────────────────────────
let serverList = [];
let activeId = null;
let runningIds = new Set();
let startingIds = new Set(); // Server die gerade hochfahren
let onlineIds = new Set();   // Server die vollständig online sind
let stoppingIds = new Set(); // Server die gerade gestoppt werden
let allMods = [];
let logBuffers = {};
let toastTimer;
let editingId = null;
let pendingStartId = null;
let currentFilePath = null;
const _revealedTexts = {};

// ── Init ──────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  const res = await window.mc.serversLoad();
  if (res.ok) serverList = res.servers;
  renderServerList();

  // Command-History für beide Inputs initialisieren
  setupHistory('cmdInput',  'log',  sendCommand);
  setupHistory('rconCmd',   'rcon', rconSend);
});

// ── IPC Events ────────────────────────────────────────────────────
window.mc.onLog(({ id, msg }) => {
  if (!logBuffers[id]) logBuffers[id] = [];
  const cls = msg.includes('[ERR]') || msg.includes('ERROR') ? 'err'
    : msg.includes('INFO') ? 'info' : '';
  logBuffers[id].push({ cls, text: msg });
  if (id === activeId) appendLog(cls, msg);

  // Join/Leave parsen
  if (id === activeId) parseJoinLeave(msg);

  // Hochfahr-Status erkennen
  if (msg.includes('Starting Minecraft server') || msg.includes('Starting Server')) {
    startingIds.add(id);
    onlineIds.delete(id);
    if (id === activeId) updateDetailHeader();
    renderServerList();
  }
  if (msg.includes('Done (') && msg.includes('For help')) {
    startingIds.delete(id);
    onlineIds.add(id);
    if (id === activeId) {
      updateDetailHeader();
      updateServerAddress();
      startStatsPolling();
      // UPnP falls öffentlich
      const srv = serverList.find(s => s.id === id);
      if (srv?.visibility === 'public') {
        startUpnp(id);
        updateIpv6Display(id);
        if (srv.ddnsProvider) updateDdns(id);
      }
    }
    renderServerList();
  }
});

window.mc.onStopped(({ id, code }) => {
  runningIds.delete(id);
  startingIds.delete(id);
  stoppingIds.delete(id);
  onlineIds.delete(id);
  if (!logBuffers[id]) logBuffers[id] = [];
  logBuffers[id].push({ cls: 'err', text: `\n— Server beendet (Exit ${code}) —` });
  if (id === activeId) {
    appendLog('err', `\n— Server beendet (Exit ${code}) —`);
    updateDetailHeader();
    stopStatsPolling();
  }
  window.mc.upnpUnmap({ id }).catch(() => {});
  renderServerList();
});

window.mc.onDlProgress((pct) => {
  const bar = document.getElementById('dlNotifBar');
  const pctEl = document.getElementById('dlNotifPct');
  if (bar) bar.style.width = pct + '%';
  if (pctEl) pctEl.textContent = pct + '%';
  if (pct === 100 && (_dlNotifLoader === 'forge' || _dlNotifLoader === 'neoforge')) {
    const s = document.getElementById('dlNotifStatus');
    if (s) s.textContent = 'Installer wird ausgeführt...';
  }
});

// ── Navigation ────────────────────────────────────────────────────
function showMainTab(id, btn) {
  document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('main-' + id).classList.add('active');
  btn.classList.add('active');
}

function showSubTab(id, btn) {
  document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sub-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('sub-' + id).classList.add('active');
  btn.classList.add('active');

  // Auto-laden beim Tab-Wechsel
  if (id === 'serversettings') loadProps();
  if (id === 'mods')           { scanMods(); scanPlugins(); scanResourcepacks(); }
  if (id === 'whitelist')      { loadWhitelist(); loadBanlist(); }
  if (id === 'files')          scanFiles();
  if (id === 'stats')          initCharts();
  if (id === 'backup')         prefillBackupPath();
  if (id === 'backup')         {} // nichts zu laden
}

function openServerDetail(id) {
  activeId = id;
  const srv = serverList.find(s => s.id === id);

  // Zur Detail-Ansicht wechseln
  document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('main-detail').classList.add('active');

  // Ersten Sub-Tab aktivieren
  document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sub-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('sub-overview').classList.add('active');
  document.querySelector('.sub-btn').classList.add('active');

  // Log-Buffer laden
  const box = document.getElementById('logBox');
  box.innerHTML = '';
  (logBuffers[id] || []).forEach(e => appendLog(e.cls, e.text));

  updateDetailHeader();
  runDiagnosis();
  loadServerIcon();
  loadNetworkSettings(); 
}

function backToList() {
  activeId = null;
  document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('main-servers').classList.add('active');
  document.querySelectorAll('nav button')[0].classList.add('active');
  document.getElementById('titlebarServer').textContent = '';
  document.getElementById('statusDot').className = 'status-dot';
}

function updateDetailHeader() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  const running  = runningIds.has(activeId);
  const starting = startingIds.has(activeId);
  const online   = onlineIds.has(activeId);

  document.getElementById('detailName').textContent = srv.name;
  document.getElementById('titlebarServer').textContent = srv.name;

  // Status-Dot
  const dot = document.getElementById('detailDot');
  const topDot = document.getElementById('statusDot');
  dot.className = topDot.className = 'status-dot' + (online ? ' running' : starting ? ' starting' : '');

  // Status-Text
  const statusEl = document.getElementById('detailStatus');
  if (online)            { statusEl.textContent = '🟢 Online';      statusEl.style.color = 'var(--running)'; }
  else if (starting)     { statusEl.textContent = '🟡 Startet...';  statusEl.style.color = '#f8c87c'; }
  else if (stoppingIds.has(activeId)) { statusEl.textContent = '🟠 Stoppt...'; statusEl.style.color = '#f87c7c'; }
  else                    { statusEl.textContent = '🔴 Gestoppt';    statusEl.style.color = 'var(--stopped)'; }

  document.getElementById('detailBtnStart').style.display = running ? 'none' : '';
  document.getElementById('detailBtnStop').style.display  = running ? '' : 'none';
  document.getElementById('detailBtnStop').disabled = stoppingIds.has(activeId);

  document.getElementById('detailInfo').innerHTML = `
    <span>Loader: <b style="color:var(--text)">${srv.loader}</b></span>
    <span>Version: <b style="color:var(--text)">${srv.version}</b></span>
    <span>RAM: <b style="color:var(--text)">${srv.ram} MB</b></span>
    <span style="word-break:break-all">Pfad: <b style="color:var(--text)">${srv.path}</b></span>
    <span>JAR: <b style="color:var(--text)">${srv.jar}</b></span>
  `;

  if (online) updateServerAddress();
  else {
    document.getElementById('addressBox').style.display = 'none';
    const duckdnsBox = document.getElementById('duckdnsBox');
    if (duckdnsBox) duckdnsBox.style.display = 'none';
  }

  // UPnP Box zeigen falls öffentlich und online
  const upnpBox = document.getElementById('upnpBox');
  if (upnpBox) {
    const srv2 = serverList.find(s => s.id === activeId);
    upnpBox.style.display = (online && srv2?.visibility === 'public') ? 'flex' : 'none';
  }
}

async function updateServerAddress() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;

  const res = await window.mc.getLocalIp();
  const port = await window.mc.propsRead(srv.path);
  const serverPort = port.ok ? (port.props['server-port'] || '25565') : '25565';
  const ip = res.ip || 'localhost';
  const address = `${ip}:${serverPort}`;

  const box = document.getElementById('addressBox');
  box.style.display = 'flex';
  setMaskedText('addressText', address);
}

function copyAddress() {
  const addr = _revealedTexts['addressText'] || document.getElementById('addressText').textContent;
  navigator.clipboard.writeText(addr);
  toast('Adresse kopiert!');
}

function setMaskedText(elId, value) {
  const el = document.getElementById(elId);
  if (!el) return;
  _revealedTexts[elId] = value;
  el.dataset.revealed = 'false';
  el.textContent = '•'.repeat(Math.min(value.length, 20));
}

function toggleReveal(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const isRevealed = el.dataset.revealed === 'true';
  if (isRevealed) {
    el.dataset.revealed = 'false';
    el.textContent = '•'.repeat(Math.min((_revealedTexts[elId] || '').length, 20));
  } else {
    el.dataset.revealed = 'true';
    el.textContent = _revealedTexts[elId] || el.textContent;
  }
}

// ── Toast ─────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.textContent = msg;
  container.insertBefore(el, container.firstChild);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show', type)));
  setTimeout(() => {
    el.classList.remove('show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, 3000);
}

// ── Download-Benachrichtigung ─────────────────────────────────────
let _dlNotifEl = null;
let _dlNotifLoader = null;

function showDlNotification(name, loader, version) {
  _dlNotifLoader = loader;
  if (_dlNotifEl) { _dlNotifEl.remove(); _dlNotifEl = null; }

  const el = document.createElement('div');
  el.className = 'toast-item dl-notif show';
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span style="font-weight:700;font-size:12px;color:var(--accent)">⬇ Download</span>
      <span style="font-size:11px;color:var(--muted)">${loader} ${version}</span>
    </div>
    <div style="font-size:12px;font-weight:600;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
    <div id="dlNotifStatus" style="font-size:11px;color:var(--muted);margin-bottom:6px">Wird heruntergeladen...</div>
    <div style="background:var(--bg2);border-radius:4px;height:5px;overflow:hidden">
      <div id="dlNotifBar" style="height:100%;width:0%;background:var(--accent);transition:width 0.3s;border-radius:4px"></div>
    </div>
    <div style="text-align:right;font-size:11px;color:var(--muted);margin-top:4px" id="dlNotifPct">0%</div>`;

  document.getElementById('toast-container').appendChild(el);
  _dlNotifEl = el;

  return {
    setStatus(msg) {
      const s = el.querySelector('#dlNotifStatus');
      if (s) s.textContent = msg;
    },
    finish(msg, type) {
      const s = el.querySelector('#dlNotifStatus');
      const bar = el.querySelector('#dlNotifBar');
      const pct = el.querySelector('#dlNotifPct');
      const col = type === 'ok' ? 'var(--accent2)' : 'var(--accent3)';
      if (s)   { s.textContent = msg; s.style.color = col; }
      if (bar) { bar.style.width = '100%'; bar.style.background = col; }
      if (pct) pct.textContent = '100%';
      el.style.borderColor = col;
      setTimeout(() => {
        el.classList.remove('show');
        el.addEventListener('transitionend', () => { el.remove(); if (_dlNotifEl === el) _dlNotifEl = null; }, { once: true });
      }, 4000);
    }
  };
}

// ── Server-Liste rendern ──────────────────────────────────────────
function renderServerList() {
  const list = document.getElementById('serverList');
  if (serverList.length === 0) {
    list.innerHTML = '<p style="color:var(--muted);font-size:13px">Noch keine Server. Klicke auf "+ Server hinzufügen".</p>';
    return;
  }
  list.innerHTML = '';
  serverList.forEach(srv => {
    const running = runningIds.has(srv.id);
    const card = document.createElement('div');
    card.className = 'server-card';
    card.innerHTML = `
      <div class="server-icon-list" id="srvicon_${srv.id}"><span>⬡</span></div>
      <div class="server-card-dot ${running ? 'running' : ''}"></div>
      <div class="server-card-info">
        <div class="server-card-name">${srv.name}</div>
        <div class="server-card-meta">${srv.loader} · ${srv.version} · ${srv.ram} MB</div>
      </div>
      <div class="server-card-actions">
        ${running
          ? `<button class="btn btn-danger" style="padding:6px 14px;font-size:12px" ${stoppingIds.has(srv.id) ? 'disabled' : ''} onclick="event.stopPropagation();stopServer('${srv.id}')">${stoppingIds.has(srv.id) ? '⏳ Stoppt...' : '■ Stopp'}</button>`
          : `<button class="btn btn-primary" style="padding:6px 14px;font-size:12px" onclick="event.stopPropagation();startServer('${srv.id}')">▶ Start</button>`
        }
        <button class="btn btn-ghost" style="padding:6px 14px;font-size:12px" onclick="event.stopPropagation();openEditServer('${srv.id}')">✎</button>
        <button class="btn" style="padding:6px 14px;font-size:12px;background:rgba(248,124,124,0.12);color:var(--accent3)" onclick="event.stopPropagation();deleteServer('${srv.id}')">✕</button>
      </div>`;
    card.addEventListener('click', () => openServerDetail(srv.id));
    list.appendChild(card);
    // Load icon async
    window.mc.iconLoad(srv.path).then(res => {
      const el = document.getElementById('srvicon_' + srv.id);
      if (el && res.ok) el.innerHTML = `<img src="${res.base64}" style="width:100%;height:100%;object-fit:cover;border-radius:6px">`;
    }).catch(() => {});
  });
}

// ── Server starten/stoppen ────────────────────────────────────────
async function startServer(id) {
  const srv = serverList.find(s => s.id === id);
  if (!srv) return;
  const eula = await window.mc.eulaCheck(srv.path);
  if (eula.ok && !eula.accepted) {
    pendingStartId = id;
    document.getElementById('eulaModal').style.display = 'flex';
    return;
  }
  await doStartServer(id);
}

async function doStartServer(id) {
  const srv = serverList.find(s => s.id === id);
  const res = await window.mc.serverStart({ id, serverPath: srv.path, ram: srv.ram, jarName: srv.jar });
  if (res.ok) {
    runningIds.add(id);
    startingIds.add(id);
    renderServerList();
    if (activeId === id) updateDetailHeader();
    toast('Server startet: ' + srv.name);
  } else toast(res.error, 'err');
}

async function startActiveServer() { if (activeId) await startServer(activeId); }
async function stopActiveServer() {
  if (!(await showConfirm('Server wirklich stoppen?', 'Server stoppen'))) return;
  if (activeId) await doStopServer(activeId);
}

async function stopServer(id) {
  if (!(await showConfirm('Server wirklich stoppen?', 'Server stoppen'))) return;
  await doStopServer(id);
}

async function doStopServer(id) {
  const res = await window.mc.serverStop(id);
  if (res.ok) {
    stoppingIds.add(id);
    if (activeId === id) updateDetailHeader();
    renderServerList();
  } else {
    toast(res.error, 'err');
  }
}

function closeEulaModal() {
  document.getElementById('eulaModal').style.display = 'none';
  pendingStartId = null;
}

async function acceptEula() {
  const srv = serverList.find(s => s.id === pendingStartId);
  if (!srv) return closeEulaModal();
  const res = await window.mc.eulaAccept(srv.path);
  if (!res.ok) return toast(res.error, 'err');
  closeEulaModal();
  await doStartServer(pendingStartId);
}

// ── Modal: Server hinzufügen/bearbeiten ──────────────────────────
async function openAddServer() {
  editingId = null;
  document.getElementById('modalTitle').textContent = 'Server hinzufügen';
  document.getElementById('srvName').value = '';
  document.getElementById('srvRam').value = '2048';
  document.getElementById('modalSaveBtn').textContent = 'Erstellen & Herunterladen';
  const last = await window.mc.prefsGet('lastFolderPath');
  document.getElementById('srvPath').value = last?.value || '';
  document.getElementById('modal').style.display = 'flex';
}

function openEditServer(id) {
  const srv = serverList.find(s => s.id === id);
  if (!srv) return;
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Server bearbeiten';
  document.getElementById('srvName').value = srv.name;
  document.getElementById('srvPath').value = srv.path;
  document.getElementById('srvRam').value = srv.ram;
  document.getElementById('srvVersion').value = srv.version || '1.21.4';
  document.getElementById('srvLoader').value = srv.loader || 'vanilla';
  document.getElementById('modalSaveBtn').textContent = 'Speichern';
  const vis = srv.visibility || 'lan';
  document.querySelectorAll('input[name="srvVisibility"]').forEach(r => r.checked = r.value === vis);
  document.getElementById('modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modal').style.display = 'none';
  editingId = null;
}

async function selectSrvFolder() {
  const last = await window.mc.prefsGet('lastFolderPath');
  const p = await window.mc.selectFolder(last?.value);
  if (p) { document.getElementById('srvPath').value = p; window.mc.prefsSet('lastFolderPath', p); }
}

async function selectBackupFolder() {
  const last = await window.mc.prefsGet('lastBackupPath');
  const p = await window.mc.selectFolder(last?.value);
  if (p) { document.getElementById('backupPath').value = p; window.mc.prefsSet('lastBackupPath', p); }
}

async function selectDlFolder() {
  const last = await window.mc.prefsGet('lastDlPath');
  const p = await window.mc.selectFolder(last?.value);
  if (p) { document.getElementById('dlDestPath').value = p; window.mc.prefsSet('lastDlPath', p); }
}

async function saveServer() {
  const name    = document.getElementById('srvName').value.trim();
  const basePath = document.getElementById('srvPath').value.trim();
  const ram     = document.getElementById('srvRam').value;
  const version = document.getElementById('srvVersion').value;
  const loader  = document.getElementById('srvLoader').value;
  const jar     = loader === 'vanilla' ? `server-${version}.jar`
                : loader === 'paper'   ? `paper-${version}.jar`
                : loader === 'fabric'  ? `fabric-server-${version}.jar`
                : `${loader}-installer.jar`;

  const visibility = document.querySelector('input[name="srvVisibility"]:checked')?.value || 'lan';

  if (!name || !basePath) return toast('Name und Pfad sind erforderlich.', 'err');

  if (editingId) {
    const idx = serverList.findIndex(s => s.id === editingId);
    if (idx !== -1) serverList[idx] = { ...serverList[idx], name, ram, version, loader, visibility };
    await window.mc.serversSave(serverList);
    renderServerList();
    closeModal();
    toast('Server aktualisiert!');
    return;
  }

  // Neuer Server: Ordner erstellen
  const folderRes = await window.mc.createServerFolder({ basePath, name });
  if (!folderRes.ok) return toast(folderRes.error, 'err');

  const id = 'srv_' + Date.now();
  const newServer = { id, name, path: folderRes.path, jar, ram, version, loader, visibility };
  serverList.push(newServer);
  await window.mc.serversSave(serverList);
  renderServerList();

  // Modal sofort schließen, Download-Popup anzeigen
  closeModal();
  const dlNotif = showDlNotification(name, loader, version);

  // Build ermitteln
  let build = null;
  const buildsRes = await window.mc.dlBuilds({ loader, version });
  if (buildsRes.ok && buildsRes.builds.length > 0) build = buildsRes.builds[0].id;

  const dlRes = await window.mc.dlDownload({ loader, version, build, destPath: folderRes.path });

  if (dlRes.ok) {
    const idx = serverList.findIndex(s => s.id === id);
    if (idx !== -1) {
      serverList[idx].jar = dlRes.filename;
      await window.mc.serversSave(serverList);
    }
    dlNotif.finish(`✓ ${name} bereit!`, 'ok');
    setTimeout(() => openServerDetail(id), 800);
  } else {
    dlNotif.finish('Fehler: ' + dlRes.error, 'err');
  }
}

async function deleteServer(id) {
  const srv = serverList.find(s => s.id === id);
  if (!srv) return;

  if (!(await showConfirm('Server wirklich entfernen?', 'Server entfernen'))) return;

  const alsoDeleteFiles = await showConfirm(
    'Sollen auch alle Server-Dateien (Welt, Configs, Mods) von der Festplatte gelöscht werden? Das kann NICHT rückgängig gemacht werden!',
    'Dateien löschen?',
    'Ja, Dateien löschen',
    true
  );

  if (alsoDeleteFiles) {
    const delRes = await window.mc.deleteServerFolder(srv.path);
    if (!delRes.ok) toast('Fehler beim Löschen der Dateien: ' + delRes.error, 'err');
  }

  serverList = serverList.filter(s => s.id !== id);
  if (activeId === id) { activeId = null; backToList(); }
  await window.mc.serversSave(serverList);
  renderServerList();
  toast(alsoDeleteFiles ? 'Server und Dateien entfernt.' : 'Server entfernt, Dateien bleiben erhalten.');
}
// ── Diagnose ──────────────────────────────────────────────────────
async function runDiagnosis() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  const res = await window.mc.diagnose(srv.path, srv.jar);
  const list = document.getElementById('diagList');
  list.innerHTML = '';
  let hasIssue = false;

  res.checks.forEach(c => {
    const div = document.createElement('div');
    div.className = 'diag-item';
    const icon = c.ok ? '✓' : (c.warn ? '⚠' : '✗');
    const cls  = c.ok ? 'diag-ok' : (c.warn ? 'diag-warn' : 'diag-err');

    let extra = '';
    if (!c.ok && c.key === 'jar') {
      extra = `<button class="btn btn-ghost" style="padding:4px 10px;font-size:11px;margin-left:auto" onclick="downloadMissingJar()">↓ Herunterladen</button>`;
    }

    div.innerHTML = `<span class="diag-icon ${cls}">${icon}</span><span>${c.label}</span>${extra}`;
    list.appendChild(div);
    if (!c.ok && !c.warn) hasIssue = true;
  });

  const repairBtn = document.getElementById('repairBtn');
  repairBtn.style.display = hasIssue ? '' : 'none';
}

async function downloadMissingJar() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;

  // Fortschritt in der Diagnose-Karte anzeigen
  const diagList = document.getElementById('diagList');
  const progressDiv = document.createElement('div');
  progressDiv.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:8px';
  progressDiv.innerHTML = `
    <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted)">
      <span id="diagDlStatus">Wird heruntergeladen...</span>
      <span id="diagDlPct">0%</span>
    </div>
    <div style="background:var(--bg2);border-radius:6px;height:5px;overflow:hidden">
      <div id="diagDlBar" style="height:100%;width:0%;background:var(--accent);transition:width 0.2s;border-radius:6px"></div>
    </div>`;
  diagList.appendChild(progressDiv);

  // Progress-Event temporär umleiten
  const origProgress = window._diagProgress;
  window._diagProgress = (pct) => {
    const bar = document.getElementById('diagDlBar');
    const pctEl = document.getElementById('diagDlPct');
    if (bar) bar.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
  };

  // Build ermitteln
  let build = null;
  if (srv.loader === 'paper') {
    const b = await window.mc.dlBuilds({ loader: srv.loader, version: srv.version });
    if (b.ok && b.builds.length > 0) build = b.builds[0].id;
  } else if (srv.loader === 'fabric') {
    const b = await window.mc.dlBuilds({ loader: srv.loader, version: srv.version });
    if (b.ok && b.builds.length > 0) build = b.builds[0].id;
  } else if (srv.loader === 'forge' || srv.loader === 'neoforge') {
    const b = await window.mc.dlBuilds({ loader: srv.loader, version: srv.version });
    if (b.ok && b.builds.length > 0) build = b.builds[0].id;
  }

  const res = await window.mc.dlDownload({
    loader: srv.loader,
    version: srv.version,
    build,
    destPath: srv.path
  });

  if (res.ok) {
    // JAR-Namen in Config aktualisieren
    const idx = serverList.findIndex(s => s.id === activeId);
    if (idx !== -1) {
      serverList[idx].jar = res.filename;
      await window.mc.serversSave(serverList);
    }
    document.getElementById('diagDlStatus').textContent = '✓ ' + res.filename;
    document.getElementById('diagDlStatus').style.color = 'var(--accent2)';
    toast('JAR heruntergeladen!');
    setTimeout(() => runDiagnosis(), 1000);
  } else {
    document.getElementById('diagDlStatus').textContent = 'Fehler: ' + res.error;
    document.getElementById('diagDlStatus').style.color = 'var(--accent3)';
    toast(res.error, 'err');
  }
}


async function runRepair() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  document.getElementById('repairBtn').disabled = true;

  const res = await window.mc.repair({
    serverPath: srv.path,
    jar: srv.jar,
    loader: srv.loader,
    version: srv.version
  });

  document.getElementById('repairBtn').disabled = false;

  if (res.ok) {
    toast('Reparatur abgeschlossen!');
    runDiagnosis();
  } else toast(res.error, 'err');
}

// ── Command History ───────────────────────────────────────────────
const cmdHistory    = { log: [], rcon: [] };
const cmdHistoryIdx = { log: -1, rcon: -1 };

function setupHistory(inputId, type, sendFn) {
  const input = document.getElementById(inputId);
  input.addEventListener('keydown', (e) => {
    const hist = cmdHistory[type];
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hist.length === 0) return;
      cmdHistoryIdx[type] = Math.min(cmdHistoryIdx[type] + 1, hist.length - 1);
      input.value = hist[cmdHistoryIdx[type]];
      setTimeout(() => input.selectionStart = input.selectionEnd = input.value.length, 0);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdHistoryIdx[type] = Math.max(cmdHistoryIdx[type] - 1, -1);
      input.value = cmdHistoryIdx[type] === -1 ? '' : hist[cmdHistoryIdx[type]];
    } else if (e.key === 'Enter') {
      sendFn();
    }
  });
}

function pushHistory(type, cmd) {
  if (!cmd) return;
  // Duplikat am Anfang vermeiden
  if (cmdHistory[type][0] === cmd) { cmdHistoryIdx[type] = -1; return; }
  cmdHistory[type].unshift(cmd);
  if (cmdHistory[type].length > 50) cmdHistory[type].pop();
  cmdHistoryIdx[type] = -1;
}

// ── Logs ──────────────────────────────────────────────────────────
function appendLog(cls, text) {
  const box = document.getElementById('logBox');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function clearLog() { document.getElementById('logBox').innerHTML = ''; }

async function sendCommand() {
  if (!activeId) return;
  const input = document.getElementById('cmdInput');
  const cmd = input.value.trim();
  if (!cmd) return;
  pushHistory('log', cmd);
  const res = await window.mc.serverCommand({ id: activeId, cmd });
  if (!res.ok) toast(res.error, 'err');
  input.value = '';
}

// ── Custom Dialogs (ersetzt confirm/prompt) ───────────────────────
function showConfirm(msg, title = 'Bestätigung', okLabel = 'Bestätigen', danger = true) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMsg').textContent = msg;
    const okBtn = document.getElementById('confirmOk');
    okBtn.textContent = okLabel;
    okBtn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    modal.style.display = 'flex';
    const cleanup = (val) => {
      modal.style.display = 'none';
      okBtn.onclick = null;
      document.getElementById('confirmCancel').onclick = null;
      resolve(val);
    };
    okBtn.onclick = () => cleanup(true);
    document.getElementById('confirmCancel').onclick = () => cleanup(false);
  });
}

function showPrompt(msg, defaultVal = '', title = 'Eingabe') {
  return new Promise(resolve => {
    const modal = document.getElementById('promptModal');
    document.getElementById('promptTitle').textContent = title;
    document.getElementById('promptLabel').textContent = msg;
    const input = document.getElementById('promptInput');
    input.value = defaultVal;
    modal.style.display = 'flex';
    setTimeout(() => input.focus(), 50);
    const cleanup = (val) => {
      modal.style.display = 'none';
      document.getElementById('promptOk').onclick = null;
      document.getElementById('promptCancel').onclick = null;
      input.onkeydown = null;
      resolve(val);
    };
    document.getElementById('promptOk').onclick = () => cleanup(input.value);
    document.getElementById('promptCancel').onclick = () => cleanup(null);
    input.onkeydown = (e) => { if (e.key === 'Enter') cleanup(input.value); if (e.key === 'Escape') cleanup(null); };
  });
}

// ── Stats & Persistenz ────────────────────────────────────────────
const CHART_MAX = 60;
let statsInterval = null;
let charts = {};
let joinEvents = [];
// Gespeicherte Zeitreihen { ram: [{ts, v}], cpu: [...], tps: [...] }
let statsHistory = { ram: [], cpu: [], tps: [] };
let fullChartKey = null; // welcher Chart gerade in Vollansicht

function parseJoinLeave(msg) {
  const joined = msg.match(/:\s+(\S+)\s+joined the game/);
  const left   = msg.match(/:\s+(\S+)\s+left the game/);
  if (joined) addJoinEvent(joined[1], 'joined');
  if (left)   addJoinEvent(left[1],   'left');
}

function addJoinEvent(name, type) {
  const now = new Date();
  const entry = { ts: now.toISOString(), time: now.toTimeString().slice(0,8), name, type };
  joinEvents.unshift(entry);
  if (joinEvents.length > 200) joinEvents.pop();
  renderJoinLog();
  // Persistieren
  if (activeId) window.mc.statsAppendJoin({ id: activeId, entry });
}

function renderJoinLog() {
  const el = document.getElementById('joinLog');
  if (!el) return;
  el.innerHTML = '';
  joinEvents.slice(0, 50).forEach(e => {
    const div = document.createElement('div');
    div.className = 'join-entry';
    div.innerHTML = `
      <span class="join-time">${e.time}</span>
      <span class="join-name">${e.name}</span>
      <span class="join-type ${e.type}">${e.type === 'joined' ? '→ Join' : '← Leave'}</span>`;
    el.appendChild(div);
  });
}

// ── Chart-Zeichner ────────────────────────────────────────────────
function makeChartDrawer(canvas, tooltipEl, key, col, maxFixed, showMidline) {
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  let hoverIdx = -1;

  const draw = (pts, labels, full) => {
    const w = canvas.offsetWidth, h = canvas.offsetHeight;
    if (!w || !h) return;
    canvas.width = w; canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    if (pts.length < 2) return;
    const srvRam = key === 'ram' ? parseInt(serverList.find(s => s.id === activeId)?.ram || 2048) : null;
    const maxV = (key === 'ram' ? srvRam : maxFixed) || Math.max(...pts, 1);
    const pad = { t: 16, r: 12, b: 24, l: 44 };
    const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    const avg = pts.reduce((a,b) => a+b, 0) / pts.length;

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (ch / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + cw, y); ctx.stroke();
      ctx.fillStyle = 'rgba(100,116,139,0.8)';
      ctx.font = '10px JetBrains Mono';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxV - (maxV / 4) * i), pad.l - 4, y + 4);
    }

    // Mittellinie (nur Vollansicht)
    if (showMidline) {
      const midY = pad.t + ch - (avg / maxV) * ch;
      ctx.strokeStyle = col + '66'; ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(pad.l, midY); ctx.lineTo(pad.l + cw, midY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.font = '10px JetBrains Mono'; ctx.textAlign = 'left';
      ctx.fillText('Ø ' + avg.toFixed(1), pad.l + 4, midY - 4);
    }

    // Linie + Fläche
    ctx.beginPath();
    pts.forEach((v, i) => {
      const x = pad.l + (cw / (pts.length - 1)) * i;
      const y = pad.t + ch - (v / maxV) * ch;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
    ctx.lineTo(pad.l + cw, pad.t + ch); ctx.lineTo(pad.l, pad.t + ch); ctx.closePath();
    ctx.fillStyle = col + '22'; ctx.fill();

    // Hover-Linie
    if (hoverIdx >= 0 && hoverIdx < pts.length) {
      const x = pad.l + (cw / (pts.length - 1)) * hoverIdx;
      ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ch); ctx.stroke();
      const y = pad.t + ch - (pts[hoverIdx] / maxV) * ch;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    }
  };

  const onMouseMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const pts = statsHistory[key]?.map(p => p.v) || [];
    if (pts.length < 2) return;
    const pad = { l: 44, r: 12 };
    const cw = canvas.width - pad.l - pad.r;
    const idx = Math.round(((mx - pad.l) / cw) * (pts.length - 1));
    if (idx < 0 || idx >= pts.length) { hoverIdx = -1; tooltipEl.style.display = 'none'; return; }
    hoverIdx = idx;
    const pt = statsHistory[key][idx];
    const unit = key === 'ram' ? ' MB' : key === 'cpu' ? '%' : ' TPS';
    tooltipEl.style.display = 'block';
    tooltipEl.style.left = (e.offsetX + 12) + 'px';
    tooltipEl.style.top  = (e.offsetY - 32) + 'px';
    tooltipEl.textContent = `${new Date(pt.ts).toLocaleString('de-DE')}  •  ${pt.v.toFixed(1)}${unit}`;
    redraw();
  };

  const onMouseLeave = () => { hoverIdx = -1; tooltipEl.style.display = 'none'; redraw(); };

  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseleave', onMouseLeave);

  const redraw = () => {
    const pts = statsHistory[key]?.slice(-CHART_MAX).map(p => p.v) || [];
    const labels = statsHistory[key]?.slice(-CHART_MAX).map(p => p.ts) || [];
    draw(pts, labels, showMidline);
  };

  return { redraw, draw,
    drawFull(pts, labels) { draw(pts, labels, true); }
  };
}

function initCharts() {
  const colors = { ram: '#7c8cf8', cpu: '#f8c87c', tps: '#56cfb2' };
  ['ram','cpu','tps'].forEach(key => {
    const canvas = document.getElementById('chart' + key.charAt(0).toUpperCase() + key.slice(1));
    const tooltip = document.getElementById('tooltip' + key.charAt(0).toUpperCase() + key.slice(1));
    const maxFixed = key === 'cpu' ? 100 : key === 'tps' ? 20 : null;
    charts[key] = makeChartDrawer(canvas, tooltip, key, colors[key], maxFixed, false);
  });
  // Gespeicherte History laden
  if (activeId) loadStatsHistory();
}

async function loadStatsHistory() {
  const res = await window.mc.statsLoad(activeId);
  if (res.ok) {
    statsHistory = res.history;
    Object.keys(charts).forEach(k => charts[k]?.redraw());
  }
}

function pushStat(key, value) {
  const ts = new Date().toISOString();
  if (!statsHistory[key]) statsHistory[key] = [];
  statsHistory[key].push({ ts, v: value });
  // Im Speicher nur 7 Tage (RAM/CPU/TPS)
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  statsHistory[key] = statsHistory[key].filter(p => new Date(p.ts).getTime() > cutoff);
  charts[key]?.redraw();
  // Persistieren
  if (activeId) window.mc.statsAppendPoint({ id: activeId, key, ts, v: value });
}

function startStatsPolling() {
  if (statsInterval) return;
  initCharts();
  statsInterval = setInterval(async () => {
    if (!activeId) return;
    const res = await window.mc.getStats(activeId);
    if (!res.ok) return;
    const srv = serverList.find(s => s.id === activeId);

    const ramMB = Math.round(res.memory / 1024 / 1024);
    document.getElementById('statRam').textContent = ramMB + ' MB';
    document.getElementById('statRamSub').textContent = `von ${srv?.ram || '?'} MB`;
    if (charts.ram) { charts.ram.maxFixed = parseInt(srv?.ram || 2048); }
    pushStat('ram', ramMB);

    const cpu = Math.round(res.cpu * 10) / 10;
    document.getElementById('statCpu').textContent = cpu + '%';
    pushStat('cpu', cpu);

    document.getElementById('statPlayers').textContent = res.players ?? '—';

    const online = onlineIds.has(activeId);
    document.getElementById('statsDot').className = 'status-dot' + (online ? ' running' : ' starting');
    document.getElementById('statsStatus').textContent = online ? 'Online' : 'Startet...';

    if (res.tps !== null) {
      document.getElementById('statTps').textContent = res.tps.toFixed(1);
      pushStat('tps', Math.min(res.tps, 20));
    }

    // Vollansicht aktualisieren falls offen
    if (fullChartKey) drawFullChart(fullChartKey);
  }, 2000);
}

function stopStatsPolling() {
  clearInterval(statsInterval);
  statsInterval = null;
  ['statRam','statCpu','statTps','statPlayers'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '—';
  });
  const dot = document.getElementById('statsDot');
  if (dot) dot.className = 'status-dot';
  const st = document.getElementById('statsStatus');
  if (st) st.textContent = 'Nicht aktiv';
}

// ── Chart Vollansicht ─────────────────────────────────────────────
function openChartFull(key) {
  fullChartKey = key;
  const names = { ram: 'RAM-Verlauf', cpu: 'CPU-Verlauf', tps: 'TPS-Verlauf' };
  document.getElementById('chartFullTitle').textContent = names[key] || key;
  document.getElementById('chartFullModal').style.display = 'flex';
  setTimeout(() => drawFullChart(key), 50);
}

function drawFullChart(key) {
  const canvas = document.getElementById('chartFullCanvas');
  const tooltip = document.getElementById('tooltipFull');
  const colors = { ram: '#7c8cf8', cpu: '#f8c87c', tps: '#56cfb2' };
  const maxFixed = key === 'cpu' ? 100 : key === 'tps' ? 20 : null;

  // Canvas neu zeichnen
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  if (!w || !h) return;
  canvas.width = w; canvas.height = h;

  const pts = (statsHistory[key] || []).map(p => p.v);
  if (pts.length < 2) return;

  const col = colors[key];
  const maxV = maxFixed || Math.max(...pts, 1);
  const avg = pts.reduce((a,b) => a+b, 0) / pts.length;
  const pad = { t: 24, r: 16, b: 32, l: 54 };
  const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = pad.t + (ch / 5) * i;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + cw, y); ctx.stroke();
    ctx.fillStyle = 'rgba(100,116,139,0.8)'; ctx.font = '11px JetBrains Mono'; ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxV - (maxV / 5) * i), pad.l - 6, y + 4);
  }

  // Mittellinie
  const midY = pad.t + ch - (avg / maxV) * ch;
  ctx.strokeStyle = col + '55'; ctx.lineWidth = 1.5; ctx.setLineDash([8, 5]);
  ctx.beginPath(); ctx.moveTo(pad.l, midY); ctx.lineTo(pad.l + cw, midY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = col; ctx.font = '11px JetBrains Mono'; ctx.textAlign = 'left';
  ctx.fillText('Ø ' + avg.toFixed(1), pad.l + 8, midY - 6);

  // Linie
  ctx.beginPath();
  pts.forEach((v, i) => {
    const x = pad.l + (cw / (pts.length - 1)) * i;
    const y = pad.t + ch - (v / maxV) * ch;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
  ctx.lineTo(pad.l + cw, pad.t + ch); ctx.lineTo(pad.l, pad.t + ch); ctx.closePath();
  ctx.fillStyle = col + '22'; ctx.fill();

  // Stats unten aktualisieren
  const unit = key === 'ram' ? ' MB' : key === 'cpu' ? '%' : ' TPS';
  const last = pts[pts.length - 1];
  const trend = pts.length > 5 ? last - pts[pts.length - 6] : 0;
  document.getElementById('fullStatMin').textContent     = Math.min(...pts).toFixed(1) + unit;
  document.getElementById('fullStatMax').textContent     = Math.max(...pts).toFixed(1) + unit;
  document.getElementById('fullStatAvg').textContent     = avg.toFixed(1) + unit;
  document.getElementById('fullStatCurrent').textContent = last.toFixed(1) + unit;
  document.getElementById('fullStatTrend').textContent   = (trend >= 0 ? '↑ +' : '↓ ') + trend.toFixed(1) + unit;
  document.getElementById('fullStatTrend').style.color   = trend > 1 ? 'var(--accent3)' : trend < -1 ? 'var(--accent2)' : 'var(--text)';

  // Hover auf Vollansicht
  canvas.onmousemove = (e) => {
    const mx = e.offsetX;
    const idx = Math.round(((mx - pad.l) / cw) * (pts.length - 1));
    if (idx < 0 || idx >= pts.length) { tooltip.style.display = 'none'; return; }
    const pt = statsHistory[key][idx];
    const ts = new Date(pt.ts).toLocaleString('de-DE');
    tooltip.style.display = 'block';
    tooltip.style.left = (mx + 14) + 'px';
    tooltip.style.top  = (e.offsetY - 36) + 'px';
    tooltip.textContent = `${ts}  •  ${pt.v.toFixed(1)}${unit}`;
    drawFullChart(key); // redraw mit hover-linie
    // Hover-Punkt
    const x = pad.l + (cw / (pts.length - 1)) * idx;
    const y = pad.t + ch - (pts[idx] / maxV) * ch;
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  };
  canvas.onmouseleave = () => { tooltip.style.display = 'none'; };
}

function closeChartFull() {
  document.getElementById('chartFullModal').style.display = 'none';
  fullChartKey = null;
}

// ── Stats Export ──────────────────────────────────────────────────
function openExportStats() {
  const now = new Date();
  const from = new Date(now); from.setDate(from.getDate() - 7);
  document.getElementById('exportFrom').value = from.toISOString().slice(0,10);
  document.getElementById('exportTo').value   = now.toISOString().slice(0,10);
  document.getElementById('exportModal').style.display = 'flex';
}

function closeExportModal() {
  document.getElementById('exportModal').style.display = 'none';
}

async function doExportStats() {
  const from   = new Date(document.getElementById('exportFrom').value);
  const to     = new Date(document.getElementById('exportTo').value);
  to.setHours(23, 59, 59);
  const format = document.getElementById('exportFormat').value;
  const inclRam   = document.getElementById('expRam').checked;
  const inclCpu   = document.getElementById('expCpu').checked;
  const inclTps   = document.getElementById('expTps').checked;
  const inclJoins = document.getElementById('expJoins').checked;

  const filter = (arr) => (arr || []).filter(p => {
    const t = new Date(p.ts); return t >= from && t <= to;
  });

  const data = {};
  if (inclRam)   data.ram   = filter(statsHistory.ram);
  if (inclCpu)   data.cpu   = filter(statsHistory.cpu);
  if (inclTps)   data.tps   = filter(statsHistory.tps);
  if (inclJoins) data.joins = filter(joinEvents);

  const srv = serverList.find(s => s.id === activeId);
  const filename = `stats_${srv?.name || 'server'}_${from.toISOString().slice(0,10)}_${to.toISOString().slice(0,10)}.${format}`;

  let content = '';
  if (format === 'json') {
    content = JSON.stringify({ server: srv?.name, from: from.toISOString(), to: to.toISOString(), data }, null, 2);
  } else {
    // CSV: alle Punkte zusammenführen
    const rows = ['timestamp,type,value'];
    const addRows = (arr, type) => arr?.forEach(p => rows.push(`${p.ts},${type},${p.v ?? p.name ?? ''}`));
    addRows(data.ram,   'ram');
    addRows(data.cpu,   'cpu');
    addRows(data.tps,   'tps');
    data.joins?.forEach(j => rows.push(`${j.ts},join_${j.type},${j.name}`));
    content = rows.join('\n');
  }

  const res = await window.mc.statsSaveFile({ content, filename });
  if (res.ok) { toast(`Exportiert: ${filename}`); closeExportModal(); }
  else toast(res.error, 'err');
}

// ── RCON ──────────────────────────────────────────────────────────
async function rconConnect() {
  if (!activeId) return;
  const host = document.getElementById('rconHost').value;
  const port = document.getElementById('rconPort').value;
  const password = document.getElementById('rconPass').value;
  const res = await window.mc.rconConnect({ id: activeId, host, port, password });
  if (res.ok) toast('RCON verbunden!');
  else toast(res.error, 'err');
}

async function rconSend() {
  if (!activeId) return;
  const input = document.getElementById('rconCmd');
  const cmd = input.value.trim();
  if (!cmd) return;
  pushHistory('rcon', cmd);
  const res = await window.mc.rconSend({ id: activeId, cmd });
  const box = document.getElementById('rconLog');
  const div = document.createElement('div');
  if (res.ok) div.textContent = '> ' + cmd + '\n' + res.response;
  else { div.className = 'err'; div.textContent = res.error; }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  input.value = '';
}

async function refreshPlayers() {
  if (!activeId) return;
  const res = await window.mc.playersList(activeId);
  const list = document.getElementById('playerList');
  if (!res.ok) { list.innerHTML = `<p style="font-size:12px;color:var(--accent3)">${res.error}</p>`; return; }
  if (res.players.length === 0) { list.innerHTML = '<p style="font-size:12px;color:var(--muted)">Niemand online.</p>'; return; }
  list.innerHTML = '';
  res.players.forEach(name => {
    const card = document.createElement('div');
    card.className = 'player-card';
    card.innerHTML = `
      <div class="player-name">${name}</div>
      <div class="player-actions">
        <button class="btn-kick" onclick="kickPlayer('${name}')">Kick</button>
        <button class="btn-ban"  onclick="banPlayer('${name}')">Ban</button>
        <button class="btn-op"   onclick="opPlayer('${name}')">OP</button>
      </div>`;
    list.appendChild(card);
  });
}

async function kickPlayer(name) {
  const reason = await showPrompt(`Kick-Grund für "${name}" (optional):`, '', 'Spieler kicken');
  if (reason === null) return;
  const res = await window.mc.playerKick({ id: activeId, name, reason });
  if (res.ok) { toast(`${name} gekickt.`); setTimeout(refreshPlayers, 500); }
  else toast(res.error, 'err');
}

async function banPlayer(name) {
  const reason = await showPrompt(`Ban-Grund für "${name}" (optional):`, '', 'Spieler bannen');
  if (reason === null) return;
  if (!(await showConfirm(`"${name}" wirklich bannen?`, 'Spieler bannen'))) return;
  const res = await window.mc.playerBan({ id: activeId, name, reason });
  if (res.ok) { toast(`${name} gebannt.`); setTimeout(refreshPlayers, 500); }
  else toast(res.error, 'err');
}

async function opPlayer(name) {
  if (!(await showConfirm(`"${name}" OP-Rechte geben?`, 'OP vergeben', 'OP geben', false))) return;
  const res = await window.mc.playerOp({ id: activeId, name });
  if (res.ok) toast(`${name} ist jetzt OP.`);
  else toast(res.error, 'err');
}

function toggleNetPortRow() {
  const isPublic = document.getElementById('netPublic').checked;
  document.getElementById('netPortRow').style.display = isPublic ? 'block' : 'none';
  document.getElementById('netDdnsRow').style.display = isPublic ? 'flex' : 'none';
}

document.addEventListener('change', (e) => {
  if (e.target.name === 'netVisibility') toggleNetPortRow();
});

async function loadNetworkSettings() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  const vis = srv.visibility || 'lan';
  document.getElementById('netLan').checked = vis === 'lan';
  document.getElementById('netPublic').checked = vis === 'public';

  const propsRes = await window.mc.propsRead(srv.path);
  const currentPort = propsRes.ok ? (propsRes.props['server-port'] || '25565') : '25565';
  document.getElementById('netPort').value = srv.publicPort || currentPort;

  await loadDdnsProviderDropdown();
  document.getElementById('netDdnsProvider').value = srv.ddnsProvider || '';
  renderDdnsFields();

  toggleNetPortRow();
}

async function saveNetworkSettings() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return toast('Kein Server aktiv.', 'err');

  const visibility = document.querySelector('input[name="netVisibility"]:checked')?.value || 'lan';
  const port = parseInt(document.getElementById('netPort').value) || 25565;
  const ddns = collectDdnsFields();

  const idx = serverList.findIndex(s => s.id === activeId);
  if (idx !== -1) {
    serverList[idx].visibility = visibility;
    if (visibility === 'public') {
      serverList[idx].publicPort = port;
      serverList[idx].ddnsProvider = ddns?.providerKey || null;
      serverList[idx].ddnsFields = ddns?.fields || null;
    }
    await window.mc.serversSave(serverList);
  }

  if (visibility === 'public') {
    const propsRes = await window.mc.propsRead(srv.path);
    if (propsRes.ok) {
      const props = propsRes.props;
      props['server-port'] = String(port);
      await window.mc.propsWrite({ serverPath: srv.path, props });
    }
  }

  toast('Netzwerk-Einstellungen gespeichert!');

  if (onlineIds.has(activeId)) {
    if (visibility === 'public') {
      await startUpnp(activeId);
      await updateIpv6Display(activeId);
      if (ddns?.providerKey) await updateDdns(activeId);
    } else {
      await window.mc.upnpUnmap({ id: activeId });
      const dBox = document.getElementById('duckdnsBox');
      const iBox = document.getElementById('ipv6Box');
      if (dBox) dBox.style.display = 'none';
      if (iBox) iBox.style.display = 'none';
    }
  }
}

// ── UPnP Port Forwarding ──────────────────────────────────────────
async function startUpnp(id) {
  const srv = serverList.find(s => s.id === id);
  if (!srv || srv.visibility !== 'public') return;

  const box = document.getElementById('upnpBox');
  const status = document.getElementById('upnpStatus');
  if (box) { box.style.display = 'flex'; setMaskedText('upnpText', '⏳ Verbinde...'); status.textContent = ''; }

  const propsRes = await window.mc.propsRead(srv.path);
  const port = parseInt(propsRes.ok ? (propsRes.props['server-port'] || '25565') : '25565');

  const res = await window.mc.upnpMap({ id, port });

  if (res.ok) {
    const addr = `${res.externalIp}:${port}`;
    setMaskedText('upnpText', addr);
    if (status) { status.textContent = '✓ UPnP aktiv'; status.style.color = 'var(--accent2)'; }
    toast('Port Forwarding aktiv!');
  } else {
    setMaskedText('upnpText', 'Fehlgeschlagen');
    if (status) { status.textContent = '✗ ' + res.error; status.style.color = 'var(--accent3)'; }
    toast('UPnP: ' + res.error, 'err');
  }
}

async function retryUpnp() {
  if (activeId) await startUpnp(activeId);
}

function copyUpnpAddress() {
  const addr = _revealedTexts['upnpText'] || document.getElementById('upnpText').textContent;
  if (addr && addr !== '—' && !addr.includes('Verbinde')) {
    navigator.clipboard.writeText(addr);
    toast('Externe Adresse kopiert!');
  }
}


function prefillDiscover() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  document.getElementById('mrVersion').value = srv.version || '';
  const loaderSel = document.getElementById('mrLoader');
  const loaderVal = srv.loader?.toLowerCase();
  for (const opt of loaderSel.options) {
    if (opt.value === loaderVal) { loaderSel.value = loaderVal; break; }
  }
  if (loaderVal === 'paper' || loaderVal === 'purpur') {
    document.getElementById('mrType').value = 'plugin';
  }
}

function switchModView(view, btn) {
  document.getElementById('btnModInstalled').classList.remove('active');
  document.getElementById('btnModDiscover').classList.remove('active');
  btn.classList.add('active');
  const installed = document.getElementById('modViewInstalled');
  const discover  = document.getElementById('modViewDiscoverPanel');
  if (view === 'installed') {
    installed.style.display = 'flex';
    discover.style.display  = 'none';
  } else {
    installed.style.display = 'none';
    discover.style.display  = 'flex';
    prefillDiscover();
    searchModrinth();
  }
}

function switchBrowserTab(tab, btn) {
  document.querySelectorAll('.browser-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('browserModrinth').style.display = tab === 'modrinth' ? 'flex' : 'none';
  document.getElementById('browserHangar').style.display   = tab === 'hangar'   ? 'flex' : 'none';
  if (tab === 'hangar') searchHangar();
}

// ── Hangar (PaperMC) ──────────────────────────────────────────────
async function searchHangar() {
  const query    = document.getElementById('hangarSearch').value.trim();
  const platform = document.getElementById('hangarPlatform').value;
  const grid     = document.getElementById('hangarResults');
  grid.innerHTML = '<p style="color:var(--muted);font-size:13px;grid-column:1/-1">Suche läuft...</p>';

  const res = await window.mc.hangarSearch({ query, platform });
  if (!res.ok) { grid.innerHTML = `<p style="color:var(--accent3);font-size:13px;grid-column:1/-1">Fehler: ${res.error}</p>`; return; }
  if (!res.plugins.length) { grid.innerHTML = '<p style="color:var(--muted);font-size:13px;grid-column:1/-1">Keine Ergebnisse.</p>'; return; }

  grid.innerHTML = '';
  res.plugins.forEach(p => {
    const downloads = p.stats?.downloads > 1000000
      ? (p.stats.downloads/1000000).toFixed(1) + 'M'
      : p.stats?.downloads > 1000 ? (p.stats.downloads/1000).toFixed(0) + 'K'
      : p.stats?.downloads || '?';

    const card = document.createElement('div');
    card.className = 'mr-card';
    card.innerHTML = `
      <div class="mr-card-top">
        ${p.avatarUrl ? `<img class="mr-icon" src="${p.avatarUrl}" alt="" onerror="this.style.display='none'">` : `<div class="mr-icon-placeholder">🔌</div>`}
        <div class="mr-info">
          <div class="mr-name">${p.name}</div>
          <div class="mr-author">von ${p.namespace?.owner || '?'}</div>
        </div>
      </div>
      <div class="mr-desc">${p.description || ''}</div>
      <div class="mr-tags">
        ${(p.category ? [`<span class="mr-tag paper">${p.category}</span>`] : []).join('')}
      </div>
      <div class="mr-footer">
        <span class="mr-downloads">↓ ${downloads}</span>
        <button class="btn btn-primary" style="padding:4px 10px;font-size:11px;margin-left:auto"
          onclick="installHangar('${p.namespace?.owner}','${p.name}')">↓ Installieren</button>
      </div>`;
    grid.appendChild(card);
  });
}

async function installHangar(owner, name) {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return toast('Kein Server ausgewählt.', 'err');

  const statusEl = document.getElementById('hangarInstallStatus');
  statusEl.style.display = 'block';
  statusEl.style.color = 'var(--muted)';
  statusEl.textContent = `"${name}" wird installiert...`;

  const res = await window.mc.hangarInstall({ owner, name, serverPath: srv.path, version: srv.version });
  if (res.ok) {
    statusEl.style.color = 'var(--accent2)';
    statusEl.textContent = `✓ "${name}" installiert als ${res.filename}`;
    toast(`${name} installiert!`);
    await scanPlugins();
  } else {
    statusEl.style.color = 'var(--accent3)';
    statusEl.textContent = `Fehler: ${res.error}`;
    toast(res.error, 'err');
  }
}

// ── Modrinth Suche mit Pagination ────────────────────────────────
let mrPage = 0;
const MR_PAGE_SIZE = 20;
let mrTotalHits = 0;
let mrSearchTimer = null;

function onMrInput() {
  toggleClearBtn('mrSearch','mrSearchClear');
  clearTimeout(mrSearchTimer);
  mrSearchTimer = setTimeout(() => { mrPage = 0; searchModrinth(); }, 350);
}

async function searchModrinth(page) {
  if (page !== undefined) mrPage = page;
  const query   = document.getElementById('mrSearch').value.trim();
  const type    = document.getElementById('mrType').value;
  const loader  = document.getElementById('mrLoader').value;
  const version = document.getElementById('mrVersion').value.trim();
  const grid    = document.getElementById('mrResults');
  const offset  = mrPage * MR_PAGE_SIZE;

  grid.innerHTML = `<p style="color:var(--muted);font-size:13px;grid-column:1/-1">${query ? 'Suche läuft...' : 'Populäre werden geladen...'}</p>`;

  const res = await window.mc.modrinthSearch({ query, type, loader, version, offset, limit: MR_PAGE_SIZE });
  if (!res.ok) { grid.innerHTML = `<p style="color:var(--accent3);font-size:13px;grid-column:1/-1">Fehler: ${res.error}</p>`; return; }

  mrTotalHits = res.total_hits || res.hits.length;

  if (res.hits.length === 0) {
    grid.innerHTML = '<p style="color:var(--muted);font-size:13px;grid-column:1/-1">Keine Ergebnisse.</p>';
    renderMrPagination();
    return;
  }

  // Installierte Mods/Plugins für Badge
  const installedNames = new Set([
    ...allMods.map(m => m.name.toLowerCase()),
    ...allPlugins.map(m => m.name.toLowerCase())
  ]);

  grid.innerHTML = '';
  res.hits.forEach(hit => {
    const card = document.createElement('div');
    card.className = 'mr-card';

    const loaders = (hit.loaders || []);
    const tagHtml = loaders.slice(0,3).map(l =>
      `<span class="mr-tag ${l}">${l}</span>`
    ).join('') + (hit.versions?.length ? `<span class="mr-tag">${hit.versions[0]}</span>` : '');

    const downloads = hit.downloads > 1000000
      ? (hit.downloads/1000000).toFixed(1) + 'M'
      : hit.downloads > 1000 ? (hit.downloads/1000).toFixed(0) + 'K'
      : hit.downloads;

    const updated = new Date(hit.date_modified).toLocaleDateString('de-DE');
    const isInstalled = installedNames.has(hit.title.toLowerCase()) ||
                        installedNames.has(hit.slug?.toLowerCase());

    card.innerHTML = `
      <div class="mr-card-top">
        ${hit.icon_url
          ? `<img class="mr-icon" src="${hit.icon_url}" alt="" onerror="this.style.display='none'">`
          : `<div class="mr-icon-placeholder">🧩</div>`}
        <div class="mr-info">
          <div class="mr-name" style="display:flex;align-items:center;gap:6px">
            ${hit.title}
            ${isInstalled ? `<span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:rgba(86,207,178,0.15);color:var(--accent2)">✓ Installiert</span>` : ''}
          </div>
          <div class="mr-author">von ${hit.author}</div>
        </div>
      </div>
      <div class="mr-desc">${hit.description}</div>
      <div class="mr-tags">${tagHtml}</div>
      <div class="mr-footer">
        <span class="mr-downloads">↓ ${downloads}</span>
        <span class="mr-updated">${updated}</span>
        <button class="btn ${isInstalled ? 'btn-ghost' : 'btn-primary'}" style="padding:4px 10px;font-size:11px;margin-left:8px"
          onclick="installModrinth('${hit.project_id}', '${hit.title.replace(/'/g,"\\'")}')">
          ${isInstalled ? '↺ Neu installieren' : '↓ Installieren'}
        </button>
      </div>`;
    grid.appendChild(card);
  });

  renderMrPagination();
}

function renderMrPagination() {
  const totalPages = Math.ceil(mrTotalHits / MR_PAGE_SIZE);
  if (totalPages <= 1) {
    const existing = document.getElementById('mrPagination');
    if (existing) existing.innerHTML = '';
    return;
  }

  let paginationEl = document.getElementById('mrPagination');
  if (!paginationEl) {
    paginationEl = document.createElement('div');
    paginationEl.id = 'mrPagination';
    paginationEl.className = 'mr-pagination';
    document.getElementById('browserModrinth').appendChild(paginationEl);
  }

  paginationEl.innerHTML = '';

  // Prev
  const prev = document.createElement('button');
  prev.className = 'page-btn' + (mrPage === 0 ? ' disabled' : '');
  prev.textContent = '‹';
  prev.disabled = mrPage === 0;
  prev.onclick = () => searchModrinth(mrPage - 1);
  paginationEl.appendChild(prev);

  // Seitenzahlen — max 7 sichtbar, wie Google
  const maxVisible = 7;
  let startPage = Math.max(0, mrPage - Math.floor(maxVisible / 2));
  let endPage   = Math.min(totalPages - 1, startPage + maxVisible - 1);
  if (endPage - startPage < maxVisible - 1) startPage = Math.max(0, endPage - maxVisible + 1);

  if (startPage > 0) {
    const first = document.createElement('button');
    first.className = 'page-btn';
    first.textContent = '1';
    first.onclick = () => searchModrinth(0);
    paginationEl.appendChild(first);
    if (startPage > 1) {
      const dots = document.createElement('span');
      dots.className = 'page-dots';
      dots.textContent = '…';
      paginationEl.appendChild(dots);
    }
  }

  for (let i = startPage; i <= endPage; i++) {
    const btn = document.createElement('button');
    btn.className = 'page-btn' + (i === mrPage ? ' active' : '');
    btn.textContent = i + 1;
    btn.onclick = () => searchModrinth(i);
    paginationEl.appendChild(btn);
  }

  if (endPage < totalPages - 1) {
    if (endPage < totalPages - 2) {
      const dots = document.createElement('span');
      dots.className = 'page-dots';
      dots.textContent = '…';
      paginationEl.appendChild(dots);
    }
    const last = document.createElement('button');
    last.className = 'page-btn';
    last.textContent = totalPages;
    last.onclick = () => searchModrinth(totalPages - 1);
    paginationEl.appendChild(last);
  }

  // Next
  const next = document.createElement('button');
  next.className = 'page-btn' + (mrPage >= totalPages - 1 ? ' disabled' : '');
  next.textContent = '›';
  next.disabled = mrPage >= totalPages - 1;
  next.onclick = () => searchModrinth(mrPage + 1);
  paginationEl.appendChild(next);

  // Info
  const info = document.createElement('span');
  info.className = 'page-info';
  info.textContent = `${mrTotalHits.toLocaleString('de-DE')} Ergebnisse`;
  paginationEl.appendChild(info);
}

async function installModrinth(projectId, name) {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return toast('Kein Server ausgewählt.', 'err');

  const statusEl = document.getElementById('mrInstallStatus');
  statusEl.style.display = 'block';
  statusEl.style.color = 'var(--muted)';
  statusEl.textContent = `"${name}" wird installiert...`;

  const res = await window.mc.modrinthInstall({
    projectId,
    serverPath: srv.path,
    loader: srv.loader,
    version: srv.version
  });

  if (res.ok) {
    statusEl.style.color = 'var(--accent2)';
    statusEl.textContent = `✓ "${name}" installiert als ${res.filename}`;
    toast(`${name} installiert!`);
    const isPlugin = ['paper','purpur','spigot','bukkit'].includes(
      serverList.find(s => s.id === activeId)?.loader?.toLowerCase()
    ) || document.getElementById('mrType').value === 'plugin';
    if (isPlugin) await scanPlugins(); else await scanMods();
    // Suchergebnisse neu rendern für Badge-Update
    searchModrinth(mrPage);
  } else {
    statusEl.style.color = 'var(--accent3)';
    statusEl.textContent = `Fehler: ${res.error}`;
    toast(res.error, 'err');
  }
}


const EDITABLE_EXT = ['.json','.properties','.txt','.yml','.yaml','.toml','.cfg','.conf','.log','.md','.sh','.bat'];
let editorFilePath = null;
let ctxTarget = null; // { path, name, isDir }

async function scanFiles(subPath) {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  currentFilePath = subPath || srv.path;
  const res = await window.mc.filesList(currentFilePath, srv.path);
  if (!res.ok) return toast(res.error, 'err');

  document.getElementById('fileBreadcrumb').textContent = currentFilePath.replace(srv.path, '~');

  const list = document.getElementById('fileList');
  list.innerHTML = '';

  if (res.canGoUp) {
    const up = document.createElement('div');
    up.className = 'file-item folder';
    up.innerHTML = '<span>📁</span><span>..</span>';
    up.onclick = () => scanFiles(res.parentPath);
    list.appendChild(up);
  }

  res.entries.forEach(e => {
    const item = document.createElement('div');
    item.className = 'file-item ' + (e.isDir ? 'folder' : 'file');
    const editable = !e.isDir && EDITABLE_EXT.some(x => e.name.toLowerCase().endsWith(x));
    item.innerHTML = `
      <span>${e.isDir ? '📁' : (editable ? '📝' : '📄')}</span>
      <span style="flex:1">${e.name}</span>
      <span class="file-size">${e.isDir ? '' : e.size}</span>`;

    if (e.isDir) {
      item.onclick = () => scanFiles(e.path);
    } else if (editable) {
      item.onclick = () => openEditor(e.path, e.name);
      item.style.cursor = 'pointer';
    }

    // Rechtsklick-Kontextmenü
    item.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ctxTarget = e;
      const menu = document.getElementById('fileContextMenu');
      menu.style.display = 'block';
      menu.style.left = ev.clientX + 'px';
      menu.style.top  = ev.clientY + 'px';
    });

    list.appendChild(item);
  });
}

// Kontextmenü schließen bei Klick woanders
document.addEventListener('click', () => {
  document.getElementById('fileContextMenu').style.display = 'none';
});

async function ctxDelete() {
  if (!ctxTarget) return;
  if (!(await showConfirm(`"${ctxTarget.name}" wirklich löschen?`, 'Löschen bestätigen'))) return;
  const res = await window.mc.fileDelete(ctxTarget.path, ctxTarget.isDir);
  if (res.ok) { toast('Gelöscht.'); scanFiles(currentFilePath); }
  else toast(res.error, 'err');
}

async function ctxRename() {
  if (!ctxTarget) return;
  const newName = await showPrompt('Neuer Name:', ctxTarget.name, 'Umbenennen');
  if (!newName || newName === ctxTarget.name) return;
  const res = await window.mc.fileRename(ctxTarget.path, newName);
  if (res.ok) { toast('Umbenannt.'); scanFiles(currentFilePath); }
  else toast(res.error, 'err');
}

async function createNewFile() {
  if (!currentFilePath) return toast('Erst einen Ordner öffnen.', 'err');
  const name = await showPrompt('Dateiname (z.B. config.yml):', '', 'Neue Datei');
  if (!name) return;
  const res = await window.mc.fileCreate(currentFilePath, name, false);
  if (res.ok) { scanFiles(currentFilePath); openEditor(res.path, name); }
  else toast(res.error, 'err');
}

async function createNewFolder() {
  if (!currentFilePath) return toast('Erst einen Ordner öffnen.', 'err');
  const name = await showPrompt('Ordnername:', '', 'Neuer Ordner');
  if (!name) return;
  const res = await window.mc.fileCreate(currentFilePath, name, true);
  if (res.ok) { toast('Ordner erstellt.'); scanFiles(currentFilePath); }
  else toast(res.error, 'err');
}

async function openEditor(filePath, filename) {
  const res = await window.mc.fileRead(filePath);
  if (!res.ok) return toast(res.error, 'err');
  editorFilePath = filePath;
  document.getElementById('editorFilename').textContent = filename;
  document.getElementById('editorFilename').style.color = 'var(--text)';
  const area = document.getElementById('editorArea');
  area.value = res.content;
  document.getElementById('editorSaveBtn').disabled = false;
  document.getElementById('editorCloseBtn').disabled = false;

  // Tab-Taste → einrücken statt Fokus wechseln
  area.onkeydown = (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = area.selectionStart;
      area.value = area.value.substring(0, s) + '  ' + area.value.substring(area.selectionEnd);
      area.selectionStart = area.selectionEnd = s + 2;
    }
    // Strg+S = Speichern
    if (e.key === 's' && e.ctrlKey) { e.preventDefault(); saveEditorFile(); }
  };
}

function closeEditor() {
  editorFilePath = null;
  document.getElementById('editorFilename').textContent = 'Keine Datei geöffnet';
  document.getElementById('editorFilename').style.color = 'var(--muted)';
  document.getElementById('editorArea').value = '';
  document.getElementById('editorSaveBtn').disabled = true;
  document.getElementById('editorCloseBtn').disabled = true;
}

async function saveEditorFile() {
  if (!editorFilePath) return;
  const content = document.getElementById('editorArea').value;
  const res = await window.mc.fileWrite(editorFilePath, content);
  if (res.ok) toast('Gespeichert!');
  else toast(res.error, 'err');
}

// ── Whitelist / Banlist ───────────────────────────────────────────
async function loadWhitelist() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  const res = await window.mc.listRead({ serverPath: srv.path, file: 'whitelist.json' });
  renderListEntries('whitelistEntries', res.entries || [], 'whitelist');
}

async function loadBanlist() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  const res = await window.mc.listRead({ serverPath: srv.path, file: 'banned-players.json' });
  renderListEntries('banlistEntries', res.entries || [], 'banlist');
}

function renderListEntries(containerId, entries, type) {
  const el = document.getElementById(containerId);
  if (entries.length === 0) { el.innerHTML = '<p style="font-size:12px;color:var(--muted)">Leer.</p>'; return; }
  el.innerHTML = '';
  entries.forEach(e => {
    const div = document.createElement('div');
    div.className = 'list-entry';
    div.innerHTML = `<span>${e.name}</span><button onclick="removeFromList('${type}','${e.name}')">✕</button>`;
    el.appendChild(div);
  });
}

async function addToWhitelist() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  const name = document.getElementById('wlInput').value.trim();
  if (!name) return;
  await window.mc.listAdd({ serverPath: srv.path, file: 'whitelist.json', name });
  document.getElementById('wlInput').value = '';
  await loadWhitelist();
  toast(`${name} zur Whitelist hinzugefügt.`);
}

async function addToBanlist() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  const name = document.getElementById('banInput').value.trim();
  if (!name) return;
  await window.mc.listAdd({ serverPath: srv.path, file: 'banned-players.json', name });
  document.getElementById('banInput').value = '';
  await loadBanlist();
  toast(`${name} gebannt.`);
}

async function removeFromList(type, name) {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  const file = type === 'whitelist' ? 'whitelist.json' : 'banned-players.json';
  await window.mc.listRemove({ serverPath: srv.path, file, name });
  if (type === 'whitelist') await loadWhitelist();
  else await loadBanlist();
}

// ── Properties (kategorisiert) ────────────────────────────────────
const PROP_CATEGORIES = [
  {
    label: 'Allgemein',
    icon: '⚙',
    keys: ['server-name','server-ip','server-port','motd','max-players',
           'difficulty','gamemode','force-gamemode','hardcore','level-seed']
  },
  {
    label: 'Welt',
    icon: '🌍',
    keys: ['level-name','level-type','generate-structures','allow-nether',
           'max-world-size','max-build-height','spawn-animals','spawn-monsters',
           'spawn-npcs']
  },
  {
    label: 'Spieler',
    icon: '👤',
    keys: ['online-mode','white-list','enforce-whitelist','pvp','allow-flight',
           'spawn-protection','player-idle-timeout','op-permission-level']
  },
  {
    label: 'Performance',
    icon: '⚡',
    keys: ['view-distance','simulation-distance','max-tick-time',
           'entity-broadcast-range-percentage','network-compression-threshold',
           'rate-limit','sync-chunk-writes']
  },
  {
    label: 'RCON & Query',
    icon: '🔌',
    keys: ['enable-rcon','rcon.port','rcon.password',
           'enable-query','query.port','broadcast-rcon-to-ops']
  },
  {
    label: 'Ressourcenpaket',
    icon: '🎨',
    keys: ['resource-pack','resource-pack-sha1','resource-pack-prompt',
           'require-resource-pack']
  }
];

const PROP_SCHEMA = {
  'difficulty':              { type: 'select', options: ['peaceful','easy','normal','hard'] },
  'gamemode':                { type: 'select', options: ['survival','creative','adventure','spectator'] },
  'level-type':              { type: 'select', options: ['minecraft:normal','minecraft:flat','minecraft:large_biomes','minecraft:amplified'] },
  'online-mode':             { type: 'bool' },
  'pvp':                     { type: 'bool' },
  'enable-rcon':             { type: 'bool' },
  'enable-command-block':    { type: 'bool' },
  'allow-flight':            { type: 'bool' },
  'allow-nether':            { type: 'bool' },
  'white-list':              { type: 'bool' },
  'enforce-whitelist':       { type: 'bool' },
  'hardcore':                { type: 'bool' },
  'spawn-animals':           { type: 'bool' },
  'spawn-monsters':          { type: 'bool' },
  'spawn-npcs':              { type: 'bool' },
  'generate-structures':     { type: 'bool' },
  'force-gamemode':          { type: 'bool' },
  'broadcast-rcon-to-ops':   { type: 'bool' },
  'sync-chunk-writes':       { type: 'bool' },
  'require-resource-pack':   { type: 'bool' },
  'server-port':             { type: 'number', min: 1, max: 65535 },
  'rcon.port':               { type: 'number', min: 1, max: 65535 },
  'query.port':              { type: 'number', min: 1, max: 65535 },
  'max-players':             { type: 'number', min: 1, max: 1000 },
  'view-distance':           { type: 'number', min: 2, max: 32 },
  'simulation-distance':     { type: 'number', min: 2, max: 32 },
  'max-world-size':          { type: 'number', min: 1, max: 29999984 },
  'spawn-protection':        { type: 'number', min: 0, max: 100 },
  'max-tick-time':           { type: 'number', min: -1 },
  'max-build-height':        { type: 'number' },
  'player-idle-timeout':     { type: 'number', min: 0 },
  'op-permission-level':     { type: 'number', min: 1, max: 4 },
  'network-compression-threshold': { type: 'number' },
  'rate-limit':              { type: 'number', min: 0 },
  'entity-broadcast-range-percentage': { type: 'number', min: 10, max: 1000 },
};

function makePropInput(key, val) {
  const schema = PROP_SCHEMA[key];
  if (!schema) {
    return `<input type="text" data-key="${key}" value="${val.replace(/"/g,'&quot;')}" style="width:100%">`;
  }
  if (schema.type === 'bool') {
    const checked = val === 'true' ? 'checked' : '';
    return `
      <label class="toggle-wrap">
        <input type="checkbox" data-key="${key}" ${checked} class="prop-toggle">
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
        <span class="toggle-label">${val === 'true' ? 'true' : 'false'}</span>
      </label>`;
  }
  if (schema.type === 'select') {
    const opts = schema.options.map(o =>
      `<option value="${o}" ${o === val ? 'selected' : ''}>${o}</option>`
    ).join('');
    return `<select data-key="${key}" style="width:100%">${opts}</select>`;
  }
  if (schema.type === 'number') {
    const min = schema.min !== undefined ? `min="${schema.min}"` : '';
    const max = schema.max !== undefined ? `max="${schema.max}"` : '';
    return `<input type="number" data-key="${key}" value="${val}" ${min} ${max} style="width:100%">`;
  }
  return `<input type="text" data-key="${key}" value="${val}" style="width:100%">`;
}

async function loadProps() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return toast('Kein Server aktiv.', 'err');
  const res = await window.mc.propsRead(srv.path);
  if (!res.ok) return toast(res.error, 'err');

  const props = res.props;
  const grid = document.getElementById('propsGrid');
  grid.innerHTML = '';

  // Kategorisierte Abschnitte
  const usedKeys = new Set();

  PROP_CATEGORIES.forEach(cat => {
    const catKeys = cat.keys.filter(k => k in props);
    if (catKeys.length === 0) return;
    catKeys.forEach(k => usedKeys.add(k));

    const section = document.createElement('div');
    section.className = 'props-section';
    section.innerHTML = `<div class="props-section-header"><span>${cat.icon}</span><span>${cat.label}</span></div>`;
    const inner = document.createElement('div');
    inner.className = 'props-section-grid';

    catKeys.forEach(key => {
      const item = document.createElement('div');
      item.className = 'prop-item';
      item.innerHTML = `<label>${key}</label>${makePropInput(key, props[key])}`;
      inner.appendChild(item);
    });

    section.appendChild(inner);
    grid.appendChild(section);
  });

  // Sonstiges — alle nicht kategorisierten Keys
  const otherKeys = Object.keys(props).filter(k => !usedKeys.has(k));
  if (otherKeys.length > 0) {
    const section = document.createElement('div');
    section.className = 'props-section';
    section.innerHTML = `<div class="props-section-header"><span>📄</span><span>Sonstiges</span></div>`;
    const inner = document.createElement('div');
    inner.className = 'props-section-grid';

    otherKeys.forEach(key => {
      const item = document.createElement('div');
      item.className = 'prop-item';
      item.innerHTML = `<label>${key}</label>${makePropInput(key, props[key])}`;
      inner.appendChild(item);
    });

    section.appendChild(inner);
    grid.appendChild(section);
  }

  // Toggle-Labels aktualisieren
  grid.querySelectorAll('.prop-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      cb.nextElementSibling.nextElementSibling.textContent = cb.checked ? 'true' : 'false';
    });
  });

  toast('Properties geladen!');
}

async function saveProps() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return toast('Kein Server aktiv.', 'err');
  const props = {};
  document.querySelectorAll('#propsGrid [data-key]').forEach(el => {
    if (el.type === 'checkbox') props[el.dataset.key] = el.checked ? 'true' : 'false';
    else props[el.dataset.key] = el.value;
  });
  const res = await window.mc.propsWrite({ serverPath: srv.path, props });
  if (res.ok) toast('Gespeichert!');
  else toast(res.error, 'err');
}

// ── Clear-Button Helper ───────────────────────────────────────────
function toggleClearBtn(inputId, btnId) {
  const val = document.getElementById(inputId).value;
  document.getElementById(btnId).style.display = val ? 'block' : 'none';
}

function clearInput(inputId, btnId) {
  document.getElementById(inputId).value = '';
  document.getElementById(btnId).style.display = 'none';
}

// ── Mods ──────────────────────────────────────────────────────────
async function scanMods() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  document.getElementById('modGrid').innerHTML = '<p style="color:var(--muted);font-size:12px">Wird gescannt...</p>';
  const res = await window.mc.modsScan(srv.path);
  if (!res.ok) return toast(res.error, 'err');
  allMods = res.mods.filter(m => m.folder === 'mods');
  renderModList('modGrid', 'modCount', allMods, 'mod');
}

let allPlugins = [];

async function scanPlugins() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  document.getElementById('pluginGrid').innerHTML = '<p style="color:var(--muted);font-size:12px">Wird gescannt...</p>';
  const res = await window.mc.modsScan(srv.path);
  if (!res.ok) return toast(res.error, 'err');
  allPlugins = res.mods.filter(m => m.folder === 'plugins');
  renderModList('pluginGrid', 'pluginCount', allPlugins, 'plugin');
}

function renderModList(gridId, countId, mods, type) {
  const grid = document.getElementById(gridId);
  const countEl = document.getElementById(countId);
  grid.innerHTML = '';
  if (countEl) countEl.textContent = mods.length ? `${mods.length}` : '';
  if (mods.length === 0) {
    grid.innerHTML = `<p style="color:var(--muted);font-size:12px">Keine ${type === 'mod' ? 'Mods' : 'Plugins'} gefunden.</p>`;
    return;
  }
  mods.forEach(mod => {
    const loaderClass = mod.loader === 'Forge' ? 'forge'
      : mod.loader === 'Fabric' || mod.loader === 'Quilt' ? 'fabric'
      : mod.loader === 'Paper' ? 'paper' : '';
    const item = document.createElement('div');
    item.className = 'mod-list-item' + (mod.disabled ? ' mod-disabled' : '');
    const safeId = 'modcb_' + mod.path.replace(/[^a-z0-9]/gi,'_');
    item.innerHTML = `
      <div class="mod-list-top">
        <input type="checkbox" class="mod-toggle-cb" id="${safeId}" ${mod.disabled ? '' : 'checked'}
          onchange="toggleModCb(${JSON.stringify(mod.path)}, this.checked, '${type}')">
        <span class="mod-list-name" style="${mod.disabled ? 'opacity:0.5;text-decoration:line-through' : ''}">${mod.name}</span>
        <span class="mod-tag ${loaderClass}" style="font-size:9px;padding:1px 5px">${mod.loader}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:10px;color:var(--muted);flex:1">${mod.version ? 'v' + mod.version : ''} · ${mod.sizeMB} MB</span>
        <div class="mod-list-actions">
          <button class="danger" onclick='deleteModOrPlugin(${JSON.stringify(mod.path)}, ${JSON.stringify(mod.name)}, "${type}")'>✕</button>
        </div>
      </div>`;
    grid.appendChild(item);
  });
}

function filterMods() {
  const q = document.getElementById('modSearch').value.toLowerCase();
  renderModList('modGrid', 'modCount', allMods.filter(m => m.name.toLowerCase().includes(q)), 'mod');
}

function filterPlugins() {
  const q = document.getElementById('pluginSearch').value.toLowerCase();
  renderModList('pluginGrid', 'pluginCount', allPlugins.filter(m => m.name.toLowerCase().includes(q)), 'plugin');
}

async function toggleModCb(modPath, enabled, type) {
  const disabled = !enabled;
  const actualPath = disabled ? modPath.replace('.jar.disabled', '.jar') : modPath;
  const res = await window.mc.modToggle({ modPath: actualPath, disabled });
  if (!res.ok) { toast(res.error, 'err'); }
  if (type === 'plugin') await scanPlugins(); else await scanMods();
}

async function toggleMod(modPath, disabled) {
  const res = await window.mc.modToggle({ modPath, disabled });
  if (res.ok) { await scanMods(); await scanPlugins(); }
  else toast(res.error, 'err');
}

async function deleteModOrPlugin(modPath, name, type) {
  if (!(await showConfirm(`"${name}" wirklich löschen?`, `${type === 'mod' ? 'Mod' : 'Plugin'} löschen`))) return;
  const res = await window.mc.modDelete(modPath);
  if (res.ok) {
    toast(`${name} gelöscht.`);
    if (type === 'plugin') await scanPlugins(); else await scanMods();
  } else toast(res.error, 'err');
}

async function deleteMod(modPath, name) {
  await deleteModOrPlugin(modPath, name, 'mod');
}

// ── Server Icon ───────────────────────────────────────────────────
async function loadServerIcon() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  const res = await window.mc.iconLoad(srv.path);
  const img = document.getElementById('serverIconImg');
  const placeholder = document.getElementById('serverIconPlaceholder');
  if (res.ok) {
    img.src = res.base64;
    img.style.display = 'block';
    placeholder.style.display = 'none';
  } else {
    img.style.display = 'none';
    placeholder.style.display = 'flex';
  }
}

async function changeServerIcon() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return toast('Kein Server ausgewählt.', 'err');
  const res = await window.mc.iconSelect(srv.path);
  if (!res.ok) return;
  const img = document.getElementById('serverIconImg');
  const placeholder = document.getElementById('serverIconPlaceholder');
  img.src = res.base64;
  img.style.display = 'block';
  placeholder.style.display = 'none';
  toast('Server-Icon gesetzt!');
}

// ── Resourcepacks ─────────────────────────────────────────────────
let allResourcepacks = [];

async function scanResourcepacks() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  document.getElementById('rpGrid').innerHTML = '<p style="color:var(--muted);font-size:12px">Wird gescannt...</p>';
  const res = await window.mc.rpScan(srv.path);
  if (!res.ok) return toast(res.error, 'err');
  allResourcepacks = res.packs;

  // Forced-Pack Status aus server.properties lesen
  const propsRes = await window.mc.propsRead(srv.path);
  if (propsRes.ok) {
    const forced = propsRes.props['require-resource-pack'] === 'true';
    document.getElementById('rpForceToggle').checked = forced;
  }

  renderResourcepacks(allResourcepacks);
}

function renderResourcepacks(packs) {
  const grid = document.getElementById('rpGrid');
  const countEl = document.getElementById('rpCount');
  grid.innerHTML = '';
  if (countEl) countEl.textContent = packs.length ? `${packs.length}` : '';

  if (packs.length === 0) {
    grid.innerHTML = '<p style="color:var(--muted);font-size:12px">Keine Resourcepacks gefunden.</p>';
    return;
  }

  packs.forEach(rp => {
    const item = document.createElement('div');
    item.className = 'mod-list-item' + (rp.disabled ? ' mod-disabled' : '');
    const safeId = 'rpcb_' + rp.path.replace(/[^a-z0-9]/gi,'_');
    item.innerHTML = `
      <div class="mod-list-top">
        <input type="checkbox" class="mod-toggle-cb" id="${safeId}" ${rp.disabled ? '' : 'checked'}
          onchange="toggleResourcepack(${JSON.stringify(rp.path)}, this.checked)">
        <span class="mod-list-name" style="${rp.disabled ? 'opacity:0.5;text-decoration:line-through' : ''}">${rp.name}</span>
        <span class="mod-tag" style="font-size:9px;padding:1px 5px;background:rgba(124,140,248,0.15);color:var(--accent)">ZIP</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:10px;color:var(--muted);flex:1">${rp.sizeMB} MB</span>
        <div class="mod-list-actions">
          <button class="danger" onclick='deleteResourcepack(${JSON.stringify(rp.path)}, ${JSON.stringify(rp.name)})'>✕</button>
        </div>
      </div>`;
    grid.appendChild(item);
  });
}

function filterResourcepacks() {
  const q = document.getElementById('rpSearch').value.toLowerCase();
  renderResourcepacks(allResourcepacks.filter(r => r.name.toLowerCase().includes(q)));
}

async function toggleResourcepack(rpPath, enabled) {
  const disabled = !enabled;
  const res = await window.mc.rpToggle({ rpPath, disabled });
  if (!res.ok) toast(res.error, 'err');
  await scanResourcepacks();
}

async function deleteResourcepack(rpPath, name) {
  if (!(await showConfirm(`"${name}" wirklich löschen?`, 'Resourcepack löschen'))) return;
  const res = await window.mc.rpDelete(rpPath);
  if (res.ok) { toast('Resourcepack gelöscht.'); await scanResourcepacks(); }
  else toast(res.error, 'err');
}

async function toggleForcedResourcepack(enabled) {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return;
  const propsRes = await window.mc.propsRead(srv.path);
  if (!propsRes.ok) return toast(propsRes.error, 'err');
  const props = propsRes.props;
  props['require-resource-pack'] = enabled ? 'true' : 'false';
  const res = await window.mc.propsWrite({ serverPath: srv.path, props });
  if (res.ok) toast(`Forced Resourcepack ${enabled ? 'aktiviert' : 'deaktiviert'}.`);
  else toast(res.error, 'err');
}

async function prefillBackupPath() {
  const last = await window.mc.prefsGet('lastBackupPath');
  if (last?.value) document.getElementById('backupPath').value = last.value;
}

async function selectBackupFolder() {
  const p = await window.mc.selectFolder();
  if (p) document.getElementById('backupPath').value = p;
}

async function createBackup() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return toast('Kein Server aktiv.', 'err');
  const backupPath = document.getElementById('backupPath').value;
  if (!backupPath) return toast('Backup-Pfad erforderlich.', 'err');
  const log = document.getElementById('backupLog');
  log.textContent = 'Backup wird erstellt...';
  const res = await window.mc.backupCreate({ serverPath: srv.path, backupPath });
  if (res.ok) { log.textContent = '✓ Backup erstellt:\n' + res.dest; toast('Backup erfolgreich!'); }
  else { log.textContent = 'Fehler: ' + res.error; toast(res.error, 'err'); }
}

// ── DDNS (generisch über Provider-Templates) ──────────────────────
let ddnsProvidersCache = null;

async function loadDdnsProviderDropdown() {
  if (!ddnsProvidersCache) {
    const res = await window.mc.ddnsGetProviders();
    ddnsProvidersCache = res.ok ? res.providers : [];
  }
  const sel = document.getElementById('netDdnsProvider');
  sel.innerHTML = '<option value="">— Kein DNS —</option>';
  ddnsProvidersCache.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.key;
    opt.textContent = p.label;
    sel.appendChild(opt);
  });
}

// Feld-Definitionen lokal duplizieren (für UI-Rendering ohne extra IPC-Call)
const DDNS_FIELD_DEFS = {
  duckdns: [
    { key: 'domain', label: 'Subdomain', placeholder: 'meinserver', type: 'text' },
    { key: 'token', label: 'Token', placeholder: 'DuckDNS Token', type: 'password' }
  ],
  noip: [
    { key: 'domain', label: 'Hostname', placeholder: 'meinserver.ddns.net', type: 'text' },
    { key: 'user', label: 'Benutzername', placeholder: 'user@email.com', type: 'text' },
    { key: 'pass', label: 'Passwort', placeholder: 'Passwort', type: 'password' }
  ],
  custom: [
    { key: 'displayDomain', label: 'Anzeige-Adresse', placeholder: 'meinserver.beispiel.com', type: 'text' },
    { key: 'customUrl', label: 'Update-URL', placeholder: 'https://anbieter.de/update?host={domain}&key={token}&ip={ip}', type: 'text' },
    { key: 'token', label: 'Token / API-Key (optional)', placeholder: 'Token falls benötigt', type: 'password' }
  ]
};

function renderDdnsFields() {
  const providerKey = document.getElementById('netDdnsProvider').value;
  const container = document.getElementById('netDdnsFields');
  container.innerHTML = '';

  if (!providerKey) return;

  const fields = DDNS_FIELD_DEFS[providerKey] || [];
  fields.forEach(f => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px';

    if (f.type === 'password') {
      wrap.innerHTML = `
        <label style="font-size:11px">${f.label}</label>
        <div style="position:relative">
          <input type="password" id="ddnsField_${f.key}" placeholder="${f.placeholder}" style="font-size:12px;width:100%;padding-right:32px">
          <button type="button" onclick="togglePasswordField('ddnsField_${f.key}')" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--muted);cursor:pointer;font-size:13px;padding:2px">👁</button>
        </div>`;
    } else {
      wrap.innerHTML = `
        <label style="font-size:11px">${f.label}</label>
        <input type="${f.type}" id="ddnsField_${f.key}" placeholder="${f.placeholder}" style="font-size:12px">`;
    }
    container.appendChild(wrap);
  });

  const srv = serverList.find(s => s.id === activeId);
  if (srv?.ddnsProvider === providerKey && srv.ddnsFields) {
    fields.forEach(f => {
      const el = document.getElementById('ddnsField_' + f.key);
      if (el && srv.ddnsFields[f.key]) el.value = srv.ddnsFields[f.key];
    });
  }
}

function togglePasswordField(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

function collectDdnsFields() {
  const providerKey = document.getElementById('netDdnsProvider').value;
  if (!providerKey) return null;
  const fields = DDNS_FIELD_DEFS[providerKey] || [];
  const values = {};
  fields.forEach(f => {
    const el = document.getElementById('ddnsField_' + f.key);
    if (el) values[f.key] = el.value.trim();
  });
  return { providerKey, fields: values };
}

async function updateDdns(id) {
  const srv = serverList.find(s => s.id === id);
  if (!srv || !srv.ddnsProvider) return;

  const box = document.getElementById('duckdnsBox');
  const status = document.getElementById('duckdnsStatus');
  const port = srv.publicPort || 25565;

  if (box) { box.style.display = 'flex'; setMaskedText('duckdnsText', '⏳ Aktualisiere...'); status.textContent = ''; }

  const res = await window.mc.ddnsUpdate({ providerKey: srv.ddnsProvider, fields: srv.ddnsFields });

  if (res.ok) {
    const addr = `${res.fullDomain}:${port}`;
    setMaskedText('duckdnsText', addr);
    if (status) { status.textContent = '✓ Aktualisiert'; status.style.color = 'var(--accent2)'; }
  } else {
    setMaskedText('duckdnsText', 'Fehlgeschlagen');
    if (status) { status.textContent = '✗ ' + res.error; status.style.color = 'var(--accent3)'; }
  }
}

function copyDuckdnsAddress() {
  const addr = _revealedTexts['duckdnsText'] || document.getElementById('duckdnsText').textContent;
  if (addr && addr !== '—') { navigator.clipboard.writeText(addr); toast('Join-Adresse kopiert!'); }
}

// ── IPv6 ───────────────────────────────────────────────────────────
async function updateIpv6Display(id) {
  const srv = serverList.find(s => s.id === id);
  if (!srv) return;
  const box = document.getElementById('ipv6Box');
  if (!box) return;

  const res = await window.mc.getIpv6();
  const port = srv.publicPort || 25565;

  if (res.ok) {
    box.style.display = 'flex';
    setMaskedText('ipv6Text', `[${res.ip}]:${port}`);
  } else {
    box.style.display = 'none';
  }
}

function copyIpv6Address() {
  const addr = _revealedTexts['ipv6Text'] || document.getElementById('ipv6Text').textContent;
  if (addr && addr !== '—') { navigator.clipboard.writeText(addr); toast('IPv6-Adresse kopiert!'); }
}
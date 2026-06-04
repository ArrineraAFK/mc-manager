// ── State ─────────────────────────────────────────────────────────
let serverList = [];      // alle konfigurierten Server
let activeId = null;      // aktuell ausgewählter Server (für Logs/RCON/etc.)
let runningIds = new Set(); // Server die gerade laufen
let allMods = [];
let logBuffers = {};      // { [id]: [{cls, text}] }
let propsCache = {};
let toastTimer;
let editingId = null;     // für Modal (null = neu, sonst id)

// ── Init ──────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  const res = await window.mc.serversLoad();
  if (res.ok) serverList = res.servers;
  renderServerList();
  loadDlVersions();
});

// ── IPC Events ────────────────────────────────────────────────────
window.mc.onLog(({ id, msg }) => {
  if (!logBuffers[id]) logBuffers[id] = [];
  const cls = msg.includes('[ERR]') || msg.includes('ERROR') ? 'err'
    : msg.includes('INFO') ? 'info' : '';
  logBuffers[id].push({ cls, text: msg });
  if (id === activeId) appendLog(cls, msg);
});

window.mc.onStopped(({ id, code }) => {
  runningIds.delete(id);
  if (!logBuffers[id]) logBuffers[id] = [];
  logBuffers[id].push({ cls: 'err', text: `\n— Server beendet (Exit ${code}) —` });
  if (id === activeId) appendLog('err', `\n— Server beendet (Exit ${code}) —`);
  renderServerList();
});

window.mc.onDlProgress((pct) => {
  document.getElementById('dlBar').style.width = pct + '%';
  document.getElementById('dlPct').textContent = pct + '%';
});

// ── Tabs ──────────────────────────────────────────────────────────
function showTab(id, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  btn.classList.add('active');
}

// ── Toast ─────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', 3000);
}

// ── Server-Liste rendern ──────────────────────────────────────────
function renderServerList() {
  const list = document.getElementById('serverList');
  if (serverList.length === 0) {
    list.innerHTML = '<p style="color:var(--muted);font-size:13px">Noch keine Server konfiguriert. Klicke auf "+ Server hinzufügen".</p>';
    return;
  }
  list.innerHTML = '';
  serverList.forEach(srv => {
    const running = runningIds.has(srv.id);
    const isActive = srv.id === activeId;
    const card = document.createElement('div');
    card.className = 'server-card' + (isActive ? ' active-server' : '');
    card.innerHTML = `
      <div class="server-card-dot ${running ? 'running' : ''}"></div>
      <div class="server-card-info">
        <div class="server-card-name">${srv.name}</div>
        <div class="server-card-meta">${srv.loader} · ${srv.version} · ${srv.ram} MB · ${srv.path}</div>
      </div>
      <div class="server-card-actions">
        <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px" onclick="selectServer('${srv.id}')">
          ${isActive ? '✓ Aktiv' : 'Auswählen'}
        </button>
        ${running
          ? `<button class="btn btn-danger" style="padding:6px 12px;font-size:12px" onclick="stopServer('${srv.id}')">■ Stopp</button>`
          : `<button class="btn btn-primary" style="padding:6px 12px;font-size:12px" onclick="startServer('${srv.id}')">▶ Start</button>`
        }
        <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px" onclick="openEditServer('${srv.id}')">✎</button>
        <button class="btn" style="padding:6px 12px;font-size:12px;background:rgba(248,124,124,0.12);color:var(--accent3)" onclick="deleteServer('${srv.id}')">✕</button>
      </div>`;
    list.appendChild(card);
  });

  // Titlebar + Status-Dot oben
  const active = serverList.find(s => s.id === activeId);
  document.getElementById('titlebarServer').textContent = active ? active.name : 'Kein Server ausgewählt';
  const anyRunning = runningIds.has(activeId);
  document.getElementById('statusDot').className = 'status-dot' + (anyRunning ? ' running' : '');
}

function selectServer(id) {
  activeId = id;
  // Log-Buffer des gewählten Servers anzeigen
  const box = document.getElementById('logBox');
  box.innerHTML = '';
  (logBuffers[id] || []).forEach(e => appendLog(e.cls, e.text));
  renderServerList();
  toast('Server ausgewählt: ' + serverList.find(s => s.id === id)?.name);
}

// ── Server starten/stoppen ────────────────────────────────────────
async function startServer(id) {
  const srv = serverList.find(s => s.id === id);
  if (!srv) return;
  const res = await window.mc.serverStart({ id, serverPath: srv.path, ram: srv.ram, jarName: srv.jar });
  if (res.ok) {
    runningIds.add(id);
    if (!activeId) { activeId = id; }
    renderServerList();
    toast('Server gestartet: ' + srv.name);
  } else toast(res.error, 'err');
}

async function stopServer(id) {
  const res = await window.mc.serverStop(id);
  if (!res.ok) toast(res.error, 'err');
}

// ── Modal: Server hinzufügen/bearbeiten ──────────────────────────
function openAddServer() {
  editingId = null;
  document.getElementById('modalTitle').textContent = 'Server hinzufügen';
  document.getElementById('srvName').value = '';
  document.getElementById('srvPath').value = '';
  document.getElementById('srvJar').value = 'server.jar';
  document.getElementById('srvRam').value = '2048';
  document.getElementById('modal').classList.add('open');
}

function openEditServer(id) {
  const srv = serverList.find(s => s.id === id);
  if (!srv) return;
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Server bearbeiten';
  document.getElementById('srvName').value = srv.name;
  document.getElementById('srvPath').value = srv.path;
  document.getElementById('srvJar').value = srv.jar;
  document.getElementById('srvRam').value = srv.ram;
  document.getElementById('srvVersion').value = srv.version || '1.21.4';
  document.getElementById('srvLoader').value = srv.loader || 'vanilla';
  document.getElementById('modal').classList.add('open');
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
}

async function selectSrvFolder() {
  const p = await window.mc.selectFolder();
  if (p) document.getElementById('srvPath').value = p;
}

async function saveServer() {
  const name = document.getElementById('srvName').value.trim();
  const path = document.getElementById('srvPath').value.trim();
  const jar  = document.getElementById('srvJar').value.trim();
  const ram  = document.getElementById('srvRam').value;
  const version = document.getElementById('srvVersion').value;
  const loader  = document.getElementById('srvLoader').value;

  if (!name || !path) return toast('Name und Pfad sind erforderlich.', 'err');

  if (editingId) {
    const idx = serverList.findIndex(s => s.id === editingId);
    if (idx !== -1) serverList[idx] = { ...serverList[idx], name, path, jar, ram, version, loader };
  } else {
    const id = 'srv_' + Date.now();
    serverList.push({ id, name, path, jar, ram, version, loader });
  }

  await window.mc.serversSave(serverList);
  renderServerList();
  closeModal();
  toast(editingId ? 'Server aktualisiert!' : 'Server hinzugefügt!');
}

async function deleteServer(id) {
  if (!confirm('Server wirklich entfernen? (Dateien bleiben erhalten)')) return;
  serverList = serverList.filter(s => s.id !== id);
  if (activeId === id) activeId = null;
  await window.mc.serversSave(serverList);
  renderServerList();
  toast('Server entfernt.');
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

async function sendCommand() {
  if (!activeId) return toast('Kein Server ausgewählt.', 'err');
  const input = document.getElementById('cmdInput');
  const cmd = input.value.trim();
  if (!cmd) return;
  const res = await window.mc.serverCommand({ id: activeId, cmd });
  if (!res.ok) toast(res.error, 'err');
  input.value = '';
}

function clearLog() { document.getElementById('logBox').innerHTML = ''; }

// ── RCON ──────────────────────────────────────────────────────────
async function rconConnect() {
  if (!activeId) return toast('Kein Server ausgewählt.', 'err');
  const host = document.getElementById('rconHost').value;
  const port = document.getElementById('rconPort').value;
  const password = document.getElementById('rconPass').value;
  const res = await window.mc.rconConnect({ id: activeId, host, port, password });
  if (res.ok) toast('RCON verbunden!');
  else toast(res.error, 'err');
}

async function rconSend() {
  if (!activeId) return toast('Kein Server ausgewählt.', 'err');
  const input = document.getElementById('rconCmd');
  const cmd = input.value.trim();
  if (!cmd) return;
  const res = await window.mc.rconSend({ id: activeId, cmd });
  const box = document.getElementById('rconLog');
  const div = document.createElement('div');
  if (res.ok) div.textContent = '> ' + cmd + '\n' + res.response;
  else { div.className = 'err'; div.textContent = res.error; }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  input.value = '';
}

// ── Properties ────────────────────────────────────────────────────
async function loadProps() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return toast('Kein Server ausgewählt.', 'err');
  const res = await window.mc.propsRead(srv.path);
  if (!res.ok) return toast(res.error, 'err');
  propsCache = res.props;
  const grid = document.getElementById('propsGrid');
  grid.innerHTML = '';
  for (const [key, val] of Object.entries(propsCache)) {
    const item = document.createElement('div');
    item.className = 'prop-item';
    item.innerHTML = `<label>${key}</label><input type="text" data-key="${key}" value="${val}">`;
    grid.appendChild(item);
  }
  toast('Properties geladen!');
}

async function saveProps() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return toast('Kein Server ausgewählt.', 'err');
  const inputs = document.querySelectorAll('#propsGrid input');
  const props = {};
  inputs.forEach(i => props[i.dataset.key] = i.value);
  const res = await window.mc.propsWrite({ serverPath: srv.path, props });
  if (res.ok) toast('Gespeichert!');
  else toast(res.error, 'err');
}

// ── Mods ──────────────────────────────────────────────────────────
async function scanMods() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return toast('Kein Server ausgewählt.', 'err');
  const grid = document.getElementById('modGrid');
  grid.innerHTML = '<p style="color:var(--muted);font-size:13px">Wird gescannt...</p>';
  const res = await window.mc.modsScan(srv.path);
  if (!res.ok) return toast(res.error, 'err');
  allMods = res.mods;
  if (allMods.length === 0) {
    grid.innerHTML = '<p style="color:var(--muted);font-size:13px">Keine .jar Dateien gefunden.</p>';
    document.getElementById('modCount').textContent = '';
    return;
  }
  renderMods(allMods);
  toast(`${allMods.length} Mod(s) gefunden!`);
}

function renderMods(mods) {
  const grid = document.getElementById('modGrid');
  grid.innerHTML = '';
  document.getElementById('modCount').textContent = `${mods.length} Mod(s)`;
  mods.forEach(mod => {
    const loaderClass = mod.loader === 'Forge' ? 'forge'
      : mod.loader === 'Fabric' || mod.loader === 'Quilt' ? 'fabric'
      : mod.loader === 'Paper' ? 'paper' : '';
    const card = document.createElement('div');
    card.className = 'mod-card' + (mod.disabled ? ' mod-disabled' : '');
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px">
        <span class="mod-name" style="${mod.disabled ? 'opacity:0.45;text-decoration:line-through' : ''}">${mod.name}</span>
        <span class="mod-tag ${loaderClass}">${mod.loader}</span>
      </div>
      <div style="display:flex;gap:8px;font-size:11px;color:var(--muted);margin-top:2px">
        ${mod.version ? `<span>v${mod.version}</span>` : ''}
        <span>${mod.sizeMB} MB</span>
        <span style="opacity:0.6">${mod.folder}/</span>
      </div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn btn-ghost" style="padding:5px 10px;font-size:11px"
          onclick='toggleMod(${JSON.stringify(mod.path)}, ${mod.disabled})'>
          ${mod.disabled ? '▶ Aktivieren' : '⏸ Deaktivieren'}
        </button>
        <button class="btn" style="padding:5px 10px;font-size:11px;background:rgba(248,124,124,0.12);color:var(--accent3)"
          onclick='deleteMod(${JSON.stringify(mod.path)}, ${JSON.stringify(mod.name)})'>
          ✕ Löschen
        </button>
      </div>`;
    grid.appendChild(card);
  });
}

function filterMods() {
  const q = document.getElementById('modSearch').value.toLowerCase();
  const loader = document.getElementById('modFilterLoader').value;
  renderMods(allMods.filter(m => m.name.toLowerCase().includes(q) && (!loader || m.loader === loader)));
}

async function toggleMod(modPath, disabled) {
  const res = await window.mc.modToggle({ modPath, disabled });
  if (res.ok) { await scanMods(); toast(disabled ? 'Mod aktiviert!' : 'Mod deaktiviert!'); }
  else toast(res.error, 'err');
}

async function deleteMod(modPath, name) {
  if (!confirm(`"${name}" wirklich löschen?`)) return;
  const res = await window.mc.modDelete(modPath);
  if (res.ok) { await scanMods(); toast('Mod gelöscht.'); }
  else toast(res.error, 'err');
}

// ── Backup ────────────────────────────────────────────────────────
async function selectBackupFolder() {
  const p = await window.mc.selectFolder();
  if (p) document.getElementById('backupPath').value = p;
}

async function createBackup() {
  const srv = serverList.find(s => s.id === activeId);
  if (!srv) return toast('Kein Server ausgewählt.', 'err');
  const backupPath = document.getElementById('backupPath').value;
  if (!backupPath) return toast('Backup-Pfad erforderlich.', 'err');
  const log = document.getElementById('backupLog');
  log.textContent = 'Backup wird erstellt...';
  const res = await window.mc.backupCreate({ serverPath: srv.path, backupPath });
  if (res.ok) { log.textContent = '✓ Backup erstellt:\n' + res.dest; toast('Backup erfolgreich!'); }
  else { log.textContent = 'Fehler: ' + res.error; toast(res.error, 'err'); }
}

// ── Download ──────────────────────────────────────────────────────
async function loadDlVersions() {
  const loader = document.getElementById('dlLoader').value;
  const sel = document.getElementById('dlVersion');
  sel.innerHTML = '<option>Lädt...</option>';
  document.getElementById('dlBuildCol').style.display = 'none';

  const res = await window.mc.dlVersions(loader);
  if (!res.ok) { sel.innerHTML = '<option>Fehler</option>'; return toast(res.error, 'err'); }

  sel.innerHTML = res.versions.map(v => `<option value="${v.id}">${v.id}</option>`).join('');
  loadDlBuilds();
}

async function loadDlBuilds() {
  const loader = document.getElementById('dlLoader').value;
  const version = document.getElementById('dlVersion').value;
  const buildCol = document.getElementById('dlBuildCol');
  const buildSel = document.getElementById('dlBuild');

  // Vanilla hat keine Builds
  if (loader === 'vanilla') { buildCol.style.display = 'none'; return; }

  buildCol.style.display = 'flex';
  buildSel.innerHTML = '<option>Lädt...</option>';

  const res = await window.mc.dlBuilds({ loader, version });
  if (!res.ok) { buildSel.innerHTML = '<option>Fehler</option>'; return toast(res.error, 'err'); }

  if (res.builds.length === 0) {
    buildSel.innerHTML = '<option value="latest">Neuester</option>';
    return;
  }
  buildSel.innerHTML = res.builds.map(b => `<option value="${b.id}">${b.id}</option>`).join('');
}

async function selectDlFolder() {
  const p = await window.mc.selectFolder();
  if (p) document.getElementById('dlDestPath').value = p;
}

async function startDownload() {
  const loader  = document.getElementById('dlLoader').value;
  const version = document.getElementById('dlVersion').value;
  const build   = document.getElementById('dlBuild').value;
  const destPath = document.getElementById('dlDestPath').value;

  if (!destPath) return toast('Bitte einen Zielordner auswählen.', 'err');

  const btn = document.getElementById('dlBtn');
  const wrap = document.getElementById('dlProgressWrap');
  const result = document.getElementById('dlResult');

  btn.disabled = true;
  wrap.style.display = 'flex';
  result.style.display = 'none';
  document.getElementById('dlBar').style.width = '0%';
  document.getElementById('dlPct').textContent = '0%';
  document.getElementById('dlStatusText').textContent = 'Wird heruntergeladen...';

  const res = await window.mc.dlDownload({ loader, version, build, destPath });

  btn.disabled = false;
  if (res.ok) {
    document.getElementById('dlBar').style.width = '100%';
    document.getElementById('dlStatusText').textContent = 'Abgeschlossen!';
    result.style.display = 'block';
    result.style.color = 'var(--accent2)';
    result.textContent = '✓ ' + res.filename + ' wurde gespeichert in:\n' + res.fullDest;
    toast('Download abgeschlossen!');
  } else {
    wrap.style.display = 'none';
    result.style.display = 'block';
    result.style.color = 'var(--accent3)';
    result.textContent = 'Fehler: ' + res.error;
    toast(res.error, 'err');
  }
}

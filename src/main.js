const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const { Rcon } = require('rcon-client');

let mainWindow;
let tray = null;
let forceQuit = false;

// ── Multi-Server State ────────────────────────────────────────────
// servers: { [id]: { config, process, rcon } }
const servers = {};

function sid() {
  return 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

// ── Window ────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f1117',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0f1117', symbolColor: '#7c8cf8', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (e) => {
    if (!forceQuit) { e.preventDefault(); mainWindow.hide(); }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  const icon = require('fs').existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('MC Manager');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Öffnen', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Beenden', click: () => { forceQuit = true; app.quit(); } }
  ]));
  tray.on('click', () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
});
app.on('before-quit', (e) => {
  if (!forceQuit) { e.preventDefault(); return; }
  const running = Object.entries(servers).filter(([_, s]) => s.process);
  if (running.length === 0) return;
  e.preventDefault();
  const stops = running.map(([_, s]) => new Promise(resolve => {
    try { s.process.stdin.write('stop\n'); } catch (_) {}
    s.process.once('close', resolve);
    setTimeout(() => { try { s.process.kill(); } catch(_){} resolve(); }, 8000);
  }));
  Promise.all(stops).then(() => app.quit());
});

app.on('window-all-closed', () => {});

// ── Helpers ───────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'mc-manager/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

function httpsDownload(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const download = (u) => {
      https.get(u, { headers: { 'User-Agent': 'mc-manager/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return download(res.headers.location);
        }
        const total = parseInt(res.headers['content-length'] || '0');
        let received = 0;
        const file = fs.createWriteStream(destPath);
        res.on('data', chunk => {
          received += chunk.length;
          file.write(chunk);
          if (total > 0) onProgress(Math.round((received / total) * 100));
        });
        res.on('end', () => { file.end(); resolve(); });
        res.on('error', reject);
      }).on('error', reject);
    };
    download(url);
  });
}

// ── Pfad-Persistenz ──────────────────────────────────────────────
const prefsPath = path.join(app.getPath('userData'), 'prefs.json');
let prefs = {};

function loadPrefs() {
  try { if (fs.existsSync(prefsPath)) prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); }
  catch(_) {}
}
function savePrefs() {
  try { fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), 'utf8'); } catch(_) {}
}
loadPrefs();

ipcMain.handle('prefs-get', async (_, key) => ({ ok: true, value: prefs[key] ?? null }));
ipcMain.handle('prefs-set', async (_, key, value) => { prefs[key] = value; savePrefs(); return { ok: true }; });

// ── Stats-Persistenz ──────────────────────────────────────────────
function statsPath(id) {
  return path.join(app.getPath('userData'), `stats_${id}.json`);
}

function loadStatsFile(id) {
  const p = statsPath(id);
  if (!fs.existsSync(p)) return { ram: [], cpu: [], tps: [], joins: [] };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch(_) { return { ram: [], cpu: [], tps: [], joins: [] }; }
}

function cleanOldStats(data) {
  const now = Date.now();
  const sevenDays = 7 * 24 * 3600 * 1000;
  const oneYear   = 365 * 24 * 3600 * 1000;
  ['ram','cpu','tps'].forEach(k => {
    if (data[k]) data[k] = data[k].filter(p => now - new Date(p.ts).getTime() < sevenDays);
  });
  if (data.joins) data.joins = data.joins.filter(p => now - new Date(p.ts).getTime() < oneYear);
  return data;
}

ipcMain.handle('stats-load', async (_, id) => {
  try {
    const data = cleanOldStats(loadStatsFile(id));
    return { ok: true, history: { ram: data.ram, cpu: data.cpu, tps: data.tps }, joins: data.joins };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('stats-append-point', async (_, { id, key, ts, v }) => {
  try {
    const data = loadStatsFile(id);
    if (!data[key]) data[key] = [];
    data[key].push({ ts, v });
    const cleaned = cleanOldStats(data);
    fs.writeFileSync(statsPath(id), JSON.stringify(cleaned), 'utf8');
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('stats-append-join', async (_, { id, entry }) => {
  try {
    const data = loadStatsFile(id);
    if (!data.joins) data.joins = [];
    data.joins.push(entry);
    const cleaned = cleanOldStats(data);
    fs.writeFileSync(statsPath(id), JSON.stringify(cleaned), 'utf8');
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('stats-save-file', async (_, { content, filename }) => {
  try {
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filename,
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'CSV',  extensions: ['csv']  }
      ]
    });
    if (result.canceled) return { ok: false, error: 'Abgebrochen.' };
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

// ── Server Icon ───────────────────────────────────────────────────
ipcMain.handle('icon-select', async (_, serverPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Bilder', extensions: ['png','jpg','jpeg','gif','webp'] }]
  });
  if (result.canceled) return { ok: false };
  const src = result.filePaths[0];
  const dest = path.join(serverPath, 'server-icon.png');
  // Sharp oder jimp nicht verfügbar — einfach kopieren, Minecraft erwartet 64x64 PNG
  // User muss selbst skalieren oder wir kopieren direkt
  fs.copyFileSync(src, dest);
  // Als base64 zurückgeben für die Vorschau
  const data = fs.readFileSync(dest);
  return { ok: true, base64: 'data:image/png;base64,' + data.toString('base64') };
});

ipcMain.handle('icon-load', async (_, serverPath) => {
  const iconPath = path.join(serverPath, 'server-icon.png');
  if (!fs.existsSync(iconPath)) return { ok: false };
  const data = fs.readFileSync(iconPath);
  return { ok: true, base64: 'data:image/png;base64,' + data.toString('base64') };
});

// ── Resourcepacks scannen ─────────────────────────────────────────
ipcMain.handle('rp-scan', async (_, serverPath) => {
  const rpDir = path.join(serverPath, 'resourcepacks');
  if (!fs.existsSync(rpDir)) return { ok: true, packs: [] };
  try {
    const entries = fs.readdirSync(rpDir, { withFileTypes: true })
      .filter(e => e.isFile() && (e.name.endsWith('.zip') || e.name.endsWith('.zip.disabled')))
      .map(e => {
        const fullPath = path.join(rpDir, e.name);
        const stat = fs.statSync(fullPath);
        const disabled = e.name.endsWith('.zip.disabled');
        const cleanName = e.name.replace('.zip.disabled', '').replace('.zip', '');
        return {
          name: cleanName,
          file: e.name,
          path: fullPath,
          sizeMB: (stat.size / 1024 / 1024).toFixed(2),
          disabled
        };
      });
    return { ok: true, packs: entries };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('rp-toggle', async (_, { rpPath, disabled }) => {
  try {
    if (disabled) fs.renameSync(rpPath, rpPath.replace('.zip.disabled', '.zip'));
    else fs.renameSync(rpPath, rpPath + '.disabled');
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('rp-delete', async (_, rpPath) => {
  try { fs.unlinkSync(rpPath); return { ok: true }; }
  catch(e) { return { ok: false, error: e.message }; }
});

// ── UPnP Port Forwarding ──────────────────────────────────────────
const dgram = require('dgram');
const http  = require('http');

// Aktive UPnP Mappings { serverId: { port, externalIp } }
const upnpMappings = {};

function upnpDiscover() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      'HOST: 239.255.255.250:1900\r\n' +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 3\r\n' +
      'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n'
    );

    let found = null;
    const timeout = setTimeout(() => {
      socket.close();
      resolve(found);
    }, 4000);

    socket.on('message', (data) => {
      const res = data.toString();
      const locationMatch = res.match(/LOCATION:\s*(.+)/i);
      if (locationMatch && !found) {
        found = locationMatch[1].trim();
        clearTimeout(timeout);
        setTimeout(() => { socket.close(); resolve(found); }, 200);
      }
    });

    socket.on('error', () => { clearTimeout(timeout); resolve(null); });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(msg, 0, msg.length, 1900, '239.255.255.250');
    });
  });
}

function upnpFetchControlUrl(locationUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(locationUrl);
    const options = { hostname: url.hostname, port: url.port || 80, path: url.pathname, method: 'GET' };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        // Suche nach WANIPConnection oder WANPPPConnection control URL
        const match = data.match(/<serviceType>urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:1<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>/);
        if (match) {
          const controlPath = match[1].startsWith('/') ? match[1] : '/' + match[1];
          resolve({ host: url.hostname, port: parseInt(url.port) || 80, path: controlPath });
        } else {
          reject(new Error('Keine WAN-Verbindung gefunden'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function upnpSoapRequest(ctrl, action, args) {
  return new Promise((resolve, reject) => {
    const argsXml = Object.entries(args).map(([k,v]) => `<${k}>${v}</${k}>`).join('');
    const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">${argsXml}</u:${action}></s:Body></s:Envelope>`;

    const options = {
      hostname: ctrl.host, port: ctrl.port, path: ctrl.path, method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': `"urn:schemas-upnp-org:service:WANIPConnection:1#${action}"`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

function upnpGetExternalIp(ctrl) {
  return new Promise(async (resolve) => {
    try {
      const res = await upnpSoapRequest(ctrl, 'GetExternalIPAddress', {});
      const match = res.body.match(/<NewExternalIPAddress>([^<]+)<\/NewExternalIPAddress>/);
      resolve(match ? match[1] : null);
    } catch { resolve(null); }
  });
}

ipcMain.handle('upnp-map', async (_, { id, port }) => {
  try {
    // Lokale IP ermitteln
    const os = require('os');
    let localIp = '127.0.0.1';
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const iface of ifaces) {
        if (iface.family === 'IPv4' && !iface.internal) { localIp = iface.address; break; }
      }
    }

    // Router finden
    const location = await upnpDiscover();
    if (!location) return { ok: false, error: 'Router nicht gefunden. UPnP möglicherweise deaktiviert.' };

    // Control URL holen
    const ctrl = await upnpFetchControlUrl(location);

    // Externe IP holen
    const externalIp = await upnpGetExternalIp(ctrl);

    // Port Mapping hinzufügen
    const res = await upnpSoapRequest(ctrl, 'AddPortMapping', {
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: 'TCP',
      NewInternalPort: port,
      NewInternalClient: localIp,
      NewEnabled: 1,
      NewPortMappingDescription: `MC-Manager-${id}`,
      NewLeaseDuration: 0
    });

    if (res.status === 200 || res.status === 204) {
      upnpMappings[id] = { port, externalIp, ctrl };
      return { ok: true, externalIp, localIp };
    } else {
      const errMatch = res.body.match(/<errorDescription>([^<]+)<\/errorDescription>/);
      return { ok: false, error: errMatch ? errMatch[1] : `SOAP Fehler ${res.status}` };
    }
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('upnp-unmap', async (_, { id }) => {
  const mapping = upnpMappings[id];
  if (!mapping) return { ok: true };
  try {
    await upnpSoapRequest(mapping.ctrl, 'DeletePortMapping', {
      NewRemoteHost: '',
      NewExternalPort: mapping.port,
      NewProtocol: 'TCP'
    });
    delete upnpMappings[id];
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('upnp-status', async (_, { id }) => {
  const mapping = upnpMappings[id];
  if (!mapping) return { ok: true, mapped: false };
  return { ok: true, mapped: true, externalIp: mapping.externalIp, port: mapping.port };
});

// ── Ordner auswählen ──────────────────────────────────────────────
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

// ── Server-Ordner erstellen ───────────────────────────────────────
ipcMain.handle('create-server-folder', async (_, { basePath, name }) => {
  try {
    // Ungültige Zeichen aus dem Namen entfernen für den Ordnernamen
    const safeName = name.replace(/[<>:"/\\|?*]/g, '').trim() || 'server';
    const serverPath = path.join(basePath, safeName);
    fs.mkdirSync(serverPath, { recursive: true });
    return { ok: true, path: serverPath };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Server-Liste speichern/laden ──────────────────────────────────
const configPath = path.join(app.getPath('userData'), 'servers.json');

ipcMain.handle('servers-load', async () => {
  try {
    if (!fs.existsSync(configPath)) return { ok: true, servers: [] };
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { ok: true, servers: data };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('servers-save', async (_, list) => {
  try {
    fs.writeFileSync(configPath, JSON.stringify(list, null, 2), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Server starten ────────────────────────────────────────────────
ipcMain.handle('server-start', async (_, { id, serverPath, ram, jarName }) => {
  if (servers[id]?.process) return { ok: false, error: 'Server läuft bereits.' };

  const jar = jarName || 'server.jar';
  const fullJar = path.join(serverPath, jar);
  if (!fs.existsSync(fullJar)) return { ok: false, error: `JAR nicht gefunden: ${fullJar}` };

  const proc = spawn('java', [`-Xmx${ram}M`, `-Xms${ram}M`, '-jar', jar, 'nogui'], { cwd: serverPath });

  if (!servers[id]) servers[id] = {};
  servers[id].process = proc;

  proc.stdout.on('data', d => mainWindow.webContents.send('server-log', { id, msg: d.toString() }));
  proc.stderr.on('data', d => mainWindow.webContents.send('server-log', { id, msg: '[ERR] ' + d.toString() }));
  proc.on('close', code => {
    if (servers[id]) servers[id].process = null;
    mainWindow.webContents.send('server-stopped', { id, code });
  });

  return { ok: true };
});

// ── Server stoppen ────────────────────────────────────────────────
ipcMain.handle('server-stop', async (_, id) => {
  const s = servers[id];
  if (!s?.process) return { ok: false, error: 'Server nicht aktiv.' };
  s.process.stdin.write('stop\n');
  return { ok: true };
});

// ── Befehl senden ─────────────────────────────────────────────────
ipcMain.handle('server-command', async (_, { id, cmd }) => {
  const s = servers[id];
  if (!s?.process) return { ok: false, error: 'Server nicht aktiv.' };
  s.process.stdin.write(cmd + '\n');
  return { ok: true };
});

// ── RCON ─────────────────────────────────────────────────────────
ipcMain.handle('rcon-connect', async (_, { id, host, port, password }) => {
  try {
    if (!servers[id]) servers[id] = {};
    const rcon = new Rcon({ host, port: parseInt(port), password });
    await rcon.connect();
    servers[id].rcon = rcon;
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('rcon-send', async (_, { id, cmd }) => {
  const rcon = servers[id]?.rcon;
  if (!rcon) return { ok: false, error: 'RCON nicht verbunden.' };
  try {
    const response = await rcon.send(cmd);
    return { ok: true, response };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── server.properties ─────────────────────────────────────────────
ipcMain.handle('props-read', async (_, serverPath) => {
  const file = path.join(serverPath, 'server.properties');
  if (!fs.existsSync(file)) return { ok: false, error: 'server.properties nicht gefunden.' };
  const content = fs.readFileSync(file, 'utf8');
  const props = {};
  content.split('\n').forEach(line => {
    if (line.startsWith('#') || !line.includes('=')) return;
    const [key, ...rest] = line.split('=');
    props[key.trim()] = rest.join('=').trim();
  });
  return { ok: true, props };
});

ipcMain.handle('props-write', async (_, { serverPath, props }) => {
  const file = path.join(serverPath, 'server.properties');
  const lines = Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(file, lines, 'utf8');
  return { ok: true };
});

// ── Mods scannen ──────────────────────────────────────────────────
ipcMain.handle('mods-scan', async (_, serverPath) => {
  const scanDir = (dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && (e.name.endsWith('.jar') || e.name.endsWith('.jar.disabled')))
      .map(e => {
        const fullPath = path.join(dir, e.name);
        const stat = fs.statSync(fullPath);
        const disabled = e.name.endsWith('.jar.disabled');
        const cleanName = e.name.replace('.jar.disabled', '').replace('.jar', '');
        const lower = cleanName.toLowerCase();
        let loader = 'Unknown';
        if (lower.includes('fabric') || lower.includes('sodium') || lower.includes('lithium') || lower.includes('iris')) loader = 'Fabric';
        else if (lower.includes('neoforge') || lower.includes('neo')) loader = 'NeoForge';
        else if (lower.includes('forge') || lower.includes('-forge-')) loader = 'Forge';
        else if (lower.includes('paper') || lower.includes('bukkit') || lower.includes('spigot')) loader = 'Paper';
        else if (lower.includes('quilt')) loader = 'Quilt';
        const versionMatch = cleanName.match(/[\-_](\d+\.\d+[\.\d]*)/);
        return {
          name: cleanName, file: e.name, path: fullPath,
          folder: path.basename(dir),
          sizeMB: (stat.size / 1024 / 1024).toFixed(2),
          disabled, loader, version: versionMatch ? versionMatch[1] : null,
        };
      });
  };
  const mods = [...scanDir(path.join(serverPath, 'mods')), ...scanDir(path.join(serverPath, 'plugins'))];
  return { ok: true, mods };
});

ipcMain.handle('mod-toggle', async (_, { modPath, disabled }) => {
  try {
    if (disabled) fs.renameSync(modPath, modPath.replace('.jar.disabled', '.jar'));
    else fs.renameSync(modPath, modPath + '.disabled');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('mod-delete', async (_, modPath) => {
  try { fs.unlinkSync(modPath); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ── Backup ────────────────────────────────────────────────────────
ipcMain.handle('backup-create', async (_, { serverPath, backupPath }) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupPath, `backup-${timestamp}`);
  const copyDir = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name), d = path.join(dst, entry.name);
      if (entry.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
    }
  };
  try { copyDir(serverPath, dest); return { ok: true, dest }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ── Hangar (PaperMC Plugin-Repository) ───────────────────────────
ipcMain.handle('hangar-search', async (_, { query, platform }) => {
  try {
    const params = new URLSearchParams({
      q: query || '',
      platform: platform || 'PAPER',
      limit: '20',
      offset: '0',
      sort: query ? '-relevance' : '-downloads'
    });
    const r = await httpsGet(`https://hangar.papermc.io/api/v1/projects?${params}`);
    if (r.status !== 200) return { ok: false, error: `Hangar API Fehler: ${r.status}` };
    const data = JSON.parse(r.body);
    return { ok: true, plugins: data.result || [] };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('hangar-install', async (_, { owner, name, serverPath, version }) => {
  try {
    // Verfügbare Versionen abrufen
    const versionsUrl = `https://hangar.papermc.io/api/v1/projects/${owner}/${name}/versions`;
    const r = await httpsGet(versionsUrl + '?limit=10&offset=0');
    if (r.status !== 200) return { ok: false, error: 'Versionen nicht gefunden.' };
    const data = JSON.parse(r.body);
    const versions = data.result || [];
    if (!versions.length) return { ok: false, error: 'Keine Version verfügbar.' };

    // Passende Version suchen
    let ver = versions.find(v => v.supportedVersions?.includes(version)) || versions[0];
    const downloadUrl = `https://hangar.papermc.io/api/v1/projects/${owner}/${name}/versions/${ver.name}/PAPER/download`;

    const pluginsDir = path.join(serverPath, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const filename = `${name}-${ver.name}.jar`;
    const destPath = path.join(pluginsDir, filename);

    await httpsDownload(downloadUrl, destPath, (pct) => {
      mainWindow.webContents.send('dl-progress', pct);
    });

    return { ok: true, filename };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Modrinth ──────────────────────────────────────────────────────
ipcMain.handle('modrinth-search', async (_, { query, type, loader, version, offset, limit }) => {
  try {
    const facets = [['project_type:' + type]];
    if (loader) facets.push([`categories:${loader}`]);
    if (version) facets.push([`versions:${version}`]);

    const params = new URLSearchParams({
      query: query || '',
      limit: String(limit || 20),
      offset: String(offset || 0),
      index: query ? 'relevance' : 'downloads',
      facets: JSON.stringify(facets)
    });

    const r = await httpsGet(`https://api.modrinth.com/v2/search?${params}`);
    if (r.status !== 200) return { ok: false, error: `API Fehler: ${r.status}` };
    const data = JSON.parse(r.body);
    return { ok: true, hits: data.hits, total_hits: data.total_hits };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('modrinth-install', async (_, { projectId, serverPath, loader, version }) => {
  try {
    // Versionen des Projekts laden
    const versionsUrl = `https://api.modrinth.com/v2/project/${projectId}/version`;
    const params = new URLSearchParams();
    if (loader) params.set('loaders', JSON.stringify([loader]));
    if (version) params.set('game_versions', JSON.stringify([version]));

    const r = await httpsGet(`${versionsUrl}?${params}`);
    if (r.status !== 200) return { ok: false, error: 'Versionen konnten nicht geladen werden.' };
    const versions = JSON.parse(r.body);
    if (!versions.length) return { ok: false, error: 'Keine kompatible Version gefunden.' };

    // Erste kompatible Version nehmen, erste primäre Datei
    const ver = versions[0];
    const file = ver.files.find(f => f.primary) || ver.files[0];
    if (!file) return { ok: false, error: 'Keine Datei gefunden.' };

    // Zielordner: mods/ oder plugins/ je nach Loader
    const isPlugin = ['paper','purpur','spigot','bukkit'].includes(loader?.toLowerCase());
    const targetDir = path.join(serverPath, isPlugin ? 'plugins' : 'mods');
    fs.mkdirSync(targetDir, { recursive: true });

    const destPath = path.join(targetDir, file.filename);
    await httpsDownload(file.url, destPath, (pct) => {
      mainWindow.webContents.send('dl-progress', pct);
    });

    return { ok: true, filename: file.filename };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Server Stats ──────────────────────────────────────────────────
ipcMain.handle('get-stats', async (_, id) => {
  const s = servers[id];
  if (!s?.process) return { ok: false, error: 'Kein Prozess.' };
  try {
    const pidusage = require('pidusage');
    const stat = await pidusage(s.process.pid);

    // Spieleranzahl aus letztem RCON-list (falls verbunden)
    let players = null;
    let tps = null;
    if (s.rcon) {
      try {
        const listRes = await s.rcon.send('list');
        const m = listRes.match(/There are (\d+)/i);
        if (m) players = parseInt(m[1]);

        const tpsRes = await s.rcon.send('tps');
        // Paper/Spigot: "TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0"
        const tm = tpsRes.match(/([\d.]+),/);
        if (tm) tps = parseFloat(tm[1]);
      } catch (_) {}
    }

    return { ok: true, memory: stat.memory, cpu: stat.cpu, players, tps };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Lokale IP ermitteln ───────────────────────────────────────────
ipcMain.handle('get-local-ip', async () => {
  try {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return { ok: true, ip: iface.address };
        }
      }
    }
    return { ok: true, ip: 'localhost' };
  } catch (e) { return { ok: true, ip: 'localhost' }; }
});

// ── Diagnose ──────────────────────────────────────────────────────
ipcMain.handle('diagnose', async (_, serverPath, jar) => {
  const checks = [];
  const jarPath = path.join(serverPath, jar || 'server.jar');
  const eulaPath = path.join(serverPath, 'eula.txt');
  const propsPath = path.join(serverPath, 'server.properties');
  const worldPath = path.join(serverPath, 'world');

  checks.push({ key: 'jar', label: `JAR (${jar || 'server.jar'})`, ok: fs.existsSync(jarPath) });

  const eulaExists = fs.existsSync(eulaPath);
  const eulaAccepted = eulaExists && fs.readFileSync(eulaPath, 'utf8').includes('eula=true');
  checks.push({ key: 'eula', label: 'EULA akzeptiert', ok: eulaAccepted });

  checks.push({ key: 'props', label: 'server.properties', ok: fs.existsSync(propsPath) });
  checks.push({ key: 'world', label: 'World-Ordner', ok: fs.existsSync(worldPath), warn: !fs.existsSync(worldPath) });

  return { ok: true, checks };
});

// ── Reparatur ─────────────────────────────────────────────────────
ipcMain.handle('repair', async (_, { serverPath, jar, loader, version }) => {
  try {
    // EULA reparieren
    const eulaPath = path.join(serverPath, 'eula.txt');
    if (!fs.existsSync(eulaPath) || !fs.readFileSync(eulaPath, 'utf8').includes('eula=true')) {
      fs.writeFileSync(eulaPath, '# Auto-repaired by MC Manager\neula=true\n', 'utf8');
    }

    // server.properties mit Defaults erstellen falls fehlend
    const propsPath = path.join(serverPath, 'server.properties');
    if (!fs.existsSync(propsPath)) {
      const defaults = [
        'server-port=25565', 'max-players=20', 'level-name=world',
        'online-mode=true', 'difficulty=easy', 'gamemode=survival',
        'enable-rcon=false', 'rcon.port=25575',
      ].join('\n');
      fs.writeFileSync(propsPath, defaults, 'utf8');
    }

    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── File Browser: lesen/schreiben/löschen/umbenennen/erstellen ────
ipcMain.handle('file-read', async (_, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { ok: true, content };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('file-write', async (_, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('file-delete', async (_, filePath, isDir) => {
  try {
    if (isDir) fs.rmSync(filePath, { recursive: true, force: true });
    else fs.unlinkSync(filePath);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('file-rename', async (_, filePath, newName) => {
  try {
    const dir = path.dirname(filePath);
    const newPath = path.join(dir, newName);
    fs.renameSync(filePath, newPath);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('file-create', async (_, parentPath, name, isDir) => {
  try {
    const newPath = path.join(parentPath, name);
    if (isDir) fs.mkdirSync(newPath, { recursive: true });
    else fs.writeFileSync(newPath, '', 'utf8');
    return { ok: true, path: newPath };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── File Browser ──────────────────────────────────────────────────
ipcMain.handle('files-list', async (_, currentPath, rootPath) => {
  try {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true }).map(e => {
      const fullPath = path.join(currentPath, e.name);
      let size = '';
      if (e.isFile()) {
        const stat = fs.statSync(fullPath);
        size = stat.size > 1024 * 1024
          ? (stat.size / 1024 / 1024).toFixed(1) + ' MB'
          : (stat.size / 1024).toFixed(0) + ' KB';
      }
      return { name: e.name, path: fullPath, isDir: e.isDirectory(), size };
    });
    const canGoUp = currentPath !== rootPath;
    const parentPath = path.dirname(currentPath);
    return { ok: true, entries, canGoUp, parentPath };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Whitelist / Banlist ───────────────────────────────────────────
ipcMain.handle('list-read', async (_, { serverPath, file }) => {
  try {
    const filePath = path.join(serverPath, file);
    if (!fs.existsSync(filePath)) return { ok: true, entries: [] };
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { ok: true, entries: data };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('list-add', async (_, { serverPath, file, name }) => {
  try {
    const filePath = path.join(serverPath, file);
    const data = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : [];
    if (!data.find(e => e.name === name)) {
      data.push({ name, uuid: '' });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('list-remove', async (_, { serverPath, file, name }) => {
  try {
    const filePath = path.join(serverPath, file);
    if (!fs.existsSync(filePath)) return { ok: true };
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    fs.writeFileSync(filePath, JSON.stringify(data.filter(e => e.name !== name), null, 2), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── EULA prüfen / akzeptieren ─────────────────────────────────────
ipcMain.handle('eula-check', async (_, serverPath) => {
  const eulaPath = path.join(serverPath, 'eula.txt');
  if (!fs.existsSync(eulaPath)) return { ok: true, accepted: false, exists: false };
  const content = fs.readFileSync(eulaPath, 'utf8');
  const accepted = content.includes('eula=true');
  return { ok: true, accepted, exists: true };
});

ipcMain.handle('eula-accept', async (_, serverPath) => {
  try {
    const eulaPath = path.join(serverPath, 'eula.txt');
    const content = `# Minecraft EULA akzeptiert via MC Manager\n# https://aka.ms/MinecraftEULA\neula=true\n`;
    fs.writeFileSync(eulaPath, content, 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Spielerliste via RCON ─────────────────────────────────────────
ipcMain.handle('players-list', async (_, id) => {
  const rcon = servers[id]?.rcon;
  if (!rcon) return { ok: false, error: 'RCON nicht verbunden.' };
  try {
    const response = await rcon.send('list');
    // Antwort z.B: "There are 2 of a max of 20 players online: Spieler1, Spieler2"
    const match = response.match(/players online:\s*(.+)/i);
    const names = match && match[1].trim() !== ''
      ? match[1].split(',').map(n => n.trim()).filter(Boolean)
      : [];
    const countMatch = response.match(/There are (\d+)/i);
    const count = countMatch ? parseInt(countMatch[1]) : names.length;
    return { ok: true, players: names, count, raw: response };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('player-kick', async (_, { id, name, reason }) => {
  const rcon = servers[id]?.rcon;
  if (!rcon) return { ok: false, error: 'RCON nicht verbunden.' };
  try {
    const cmd = reason ? `kick ${name} ${reason}` : `kick ${name}`;
    await rcon.send(cmd);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('player-ban', async (_, { id, name, reason }) => {
  const rcon = servers[id]?.rcon;
  if (!rcon) return { ok: false, error: 'RCON nicht verbunden.' };
  try {
    const cmd = reason ? `ban ${name} ${reason}` : `ban ${name}`;
    await rcon.send(cmd);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('player-op', async (_, { id, name }) => {
  const rcon = servers[id]?.rcon;
  if (!rcon) return { ok: false, error: 'RCON nicht verbunden.' };
  try {
    await rcon.send(`op ${name}`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Download: Versionen abrufen ───────────────────────────────────
ipcMain.handle('dl-versions', async (_, loader) => {
  try {
    if (loader === 'vanilla') {
      const r = await httpsGet('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
      const data = JSON.parse(r.body);
      const versions = data.versions
        .filter(v => v.type === 'release')
        .map(v => ({ id: v.id, type: v.type }));
      return { ok: true, versions };
    }

    if (loader === 'paper') {
      const r = await httpsGet('https://api.papermc.io/v2/projects/paper');
      const data = JSON.parse(r.body);
      const versions = [...data.versions].reverse().map(v => ({ id: v }));
      return { ok: true, versions };
    }

    if (loader === 'fabric') {
      const r = await httpsGet('https://meta.fabricmc.net/v2/versions/game');
      const data = JSON.parse(r.body);
      const versions = data.filter(v => v.stable).map(v => ({ id: v.version }));
      return { ok: true, versions };
    }

    if (loader === 'forge') {
      const r = await httpsGet('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json');
      const data = JSON.parse(r.body);
      const versions = Object.keys(data).reverse().map(v => ({ id: v }));
      return { ok: true, versions };
    }

    if (loader === 'neoforge') {
      const r = await httpsGet('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
      const data = JSON.parse(r.body);
      const versions = [...data.versions].reverse().slice(0, 40).map(v => ({ id: v }));
      return { ok: true, versions };
    }

    return { ok: false, error: 'Unbekannter Loader.' };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Download: Builds für eine Version (Paper) ─────────────────────
ipcMain.handle('dl-builds', async (_, { loader, version }) => {
  try {
    if (loader === 'paper') {
      const r = await httpsGet(`https://api.papermc.io/v2/projects/paper/versions/${version}`);
      const data = JSON.parse(r.body);
      const builds = [...data.builds].reverse().map(b => ({ id: String(b) }));
      return { ok: true, builds };
    }
    if (loader === 'fabric') {
      const r = await httpsGet(`https://meta.fabricmc.net/v2/versions/loader/${version}`);
      const data = JSON.parse(r.body);
      const builds = data.slice(0, 10).map(b => ({ id: b.loader.version }));
      return { ok: true, builds };
    }
    if (loader === 'forge') {
      const r = await httpsGet('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json');
      const data = JSON.parse(r.body);
      const builds = (data[version] || []).reverse().map(b => ({ id: b }));
      return { ok: true, builds };
    }
    return { ok: true, builds: [] };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Download: JAR herunterladen ───────────────────────────────────
ipcMain.handle('dl-download', async (_, { loader, version, build, destPath }) => {
  try {
    fs.mkdirSync(destPath, { recursive: true });
    let url = '';
    let filename = 'server.jar';

    if (loader === 'vanilla') {
      const manifest = await httpsGet('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
      const mdata = JSON.parse(manifest.body);
      const entry = mdata.versions.find(v => v.id === version);
      if (!entry) return { ok: false, error: 'Version nicht gefunden.' };
      const vdata = JSON.parse((await httpsGet(entry.url)).body);
      url = vdata.downloads.server.url;
      filename = `server-${version}.jar`;
    }

    if (loader === 'paper') {
      const b = build || 'latest';
      const actualBuild = b === 'latest'
        ? JSON.parse((await httpsGet(`https://api.papermc.io/v2/projects/paper/versions/${version}`)).body).builds.slice(-1)[0]
        : parseInt(b);
      const info = JSON.parse((await httpsGet(`https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${actualBuild}`)).body);
      const jarFile = info.downloads.application.name;
      url = `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${actualBuild}/downloads/${jarFile}`;
      filename = `paper-${version}-${actualBuild}.jar`;
    }

    if (loader === 'fabric') {
      const loaderVer = build || JSON.parse((await httpsGet(`https://meta.fabricmc.net/v2/versions/loader/${version}`)).body)[0].loader.version;
      const installerVer = JSON.parse((await httpsGet('https://meta.fabricmc.net/v2/versions/installer')).body)[0].version;
      url = `https://meta.fabricmc.net/v2/versions/loader/${version}/${loaderVer}/${installerVer}/server/jar`;
      filename = `fabric-server-${version}-${loaderVer}.jar`;
    }

    if (loader === 'forge') {
      url = `https://files.minecraftforge.net/net/minecraftforge/forge/${build}/forge-${build}-installer.jar`;
      filename = `forge-${build}-installer.jar`;
    }

    if (loader === 'neoforge') {
      url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${build}/neoforge-${build}-installer.jar`;
      filename = `neoforge-${build}-installer.jar`;
    }

    const fullDest = path.join(destPath, filename);
    await httpsDownload(url, fullDest, (pct) => {
      mainWindow.webContents.send('dl-progress', pct);
    });

    return { ok: true, filename, fullDest };
  } catch (e) { return { ok: false, error: e.message }; }
});

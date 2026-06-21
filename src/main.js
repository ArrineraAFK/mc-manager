const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const { Rcon } = require('rcon-client');

let mainWindow;
let tray = null;
let forceQuit = false;

let modeWindow = null;
const httpServer = require('http');
let remoteServer = null;
let wsServer = null;
const wsClients = new Set();

// ── Multi-Server State ────────────────────────────────────────────
// servers: { [id]: { config, process, rcon } }
const servers = {};

function sid() {
  return 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}
console.log('=== MC MANAGER GESTARTET ===');
// ── Window ────────────────────────────────────────────────────────
function createWindow() {
  const preloadFile = prefs.appMode === 'client' ? 'preload-client.js' : 'preload.js';

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f1117',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0f1117', symbolColor: '#7c8cf8', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, preloadFile),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (e) => {
    if (!forceQuit) { e.preventDefault(); mainWindow.hide(); }
  });
}

function broadcast(channel, data) {
  console.log('BROADCAST:', channel, JSON.stringify(data).slice(0, 100), 'mainWindow vorhanden:', !!mainWindow, 'wsClients:', wsClients.size);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
  wsSend({ type: channel, ...data });
}

// ── App-Modus (Server/Client) ─────────────────────────────────────
function createModeSelectWindow() {
  modeWindow = new BrowserWindow({
    width: 600,
    height: 480,
    resizable: false,
    backgroundColor: '#0f1117',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0f1117', symbolColor: '#7c8cf8', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'mode-select-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  modeWindow.loadFile(path.join(__dirname, 'mode-select.html'));
}

function startRemoteServer(port) {
  if (remoteServer) return; // läuft schon

  remoteServer = httpServer.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const data = body ? JSON.parse(body) : {};
        const result = await handleRemoteRequest(url.pathname, data);
        res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  });

  remoteServer.listen(port, () => {
    console.log(`=== Remote-Server läuft auf Port ${port} ===`);
  });

  // ── WebSocket (simple, ohne externe Lib) ──────────────────────
  remoteServer.on('upgrade', (req, socket, head) => {
    const crypto = require('crypto');
    const key = req.headers['sec-websocket-key'];
    const acceptKey = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
    );

    wsClients.add(socket);
    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));
  });
}

function wsSend(obj) {
  const json = JSON.stringify(obj);
  const payload = Buffer.from(json);
  const len = payload.length;

  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }

  const frame = Buffer.concat([header, payload]);
  for (const socket of wsClients) {
    try { socket.write(frame); } catch (_) { wsClients.delete(socket); }
  }
}

function stopRemoteServer() {
  if (remoteServer) { remoteServer.close(); remoteServer = null; }
  wsClients.forEach(s => { try { s.destroy(); } catch(_){} });
  wsClients.clear();
}

// ── Remote-Request-Router ────────────────────────────────────────
async function handleRemoteRequest(pathname, data) {
  if (pathname === '/api/ping') {
    return { status: 200, body: { ok: true } };
  }

  if (pathname === '/api/servers-load') {
    if (!fs.existsSync(configPath)) return { status: 200, body: { ok: true, servers: [] } };
    const list = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { status: 200, body: { ok: true, servers: list } };
  }

  if (pathname === '/api/server-start') {
    const res = await remoteServerStart(data);
    return { status: 200, body: res };
  }

  if (pathname === '/api/server-status') {
    const status = {};
    for (const [id, s] of Object.entries(servers)) {
      if (s.process) {
        status[id] = { running: true, phase: s.phase || 'starting' };
      }
    }
    return { status: 200, body: { ok: true, status } };
  }

  if (pathname === '/api/server-stop') {
    const res = await remoteServerStop(data.id);
    return { status: 200, body: res };
  }

  if (pathname === '/api/server-command') {
    const s = servers[data.id];
    if (!s?.process) return { status: 200, body: { ok: false, error: 'Server nicht aktiv.' } };
    s.process.stdin.write(data.cmd + '\n');
    return { status: 200, body: { ok: true } };
  }

  if (pathname === '/api/servers-save') {
    try {
      fs.writeFileSync(configPath, JSON.stringify(data.list, null, 2), 'utf8');
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── Properties ──────────────────────────────────────────────────
  if (pathname === '/api/props-read') {
    const file = path.join(data.serverPath, 'server.properties');
    if (!fs.existsSync(file)) return { status: 200, body: { ok: true, props: {} } };
    const content = fs.readFileSync(file, 'utf8');
    const props = {};
    content.split('\n').forEach(l => {
      const line = l.trim();
      if (!line || line.startsWith('#')) return;
      const idx = line.indexOf('=');
      if (idx > 0) props[line.slice(0, idx)] = line.slice(idx + 1);
    });
    return { status: 200, body: { ok: true, props } };
  }

  if (pathname === '/api/props-write') {
    try {
      const file = path.join(data.serverPath, 'server.properties');
      const lines = [];
      for (const [k, v] of Object.entries(data.props)) lines.push(`${k}=${v}`);
      fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── Mods ────────────────────────────────────────────────────────
  if (pathname === '/api/mods-scan') {
    try {
      const scanDir = dir => {
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
      const mods = [...scanDir(path.join(data.serverPath, 'mods')), ...scanDir(path.join(data.serverPath, 'plugins'))];
      return { status: 200, body: { ok: true, mods } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/mod-toggle') {
    try {
      if (data.disabled) fs.renameSync(data.modPath, data.modPath.replace('.jar.disabled', '.jar'));
      else fs.renameSync(data.modPath, data.modPath + '.disabled');
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/mod-delete') {
    try { fs.unlinkSync(data.modPath); return { status: 200, body: { ok: true } }; }
    catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/mod-config-files') {
    const EDITABLE_EXT = ['.json','.properties','.txt','.yml','.yaml','.toml','.cfg','.conf','.md','.sh','.bat'];
    const clean = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const files = [];
    try {
      if (data.type === 'plugins') {
        const pluginDir = path.join(data.serverPath, 'plugins', data.modName);
        if (fs.existsSync(pluginDir)) {
          const walk = dir => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, e.name);
              if (e.isDirectory()) walk(full);
              else if (EDITABLE_EXT.some(ext => e.name.endsWith(ext))) {
                files.push({ name: path.relative(pluginDir, full), path: full });
              }
            }
          };
          walk(pluginDir);
        }
      } else {
        const configDir = path.join(data.serverPath, 'config');
        if (fs.existsSync(configDir)) {
          const modClean = clean(data.modName);
          const walk = dir => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, e.name);
              if (e.isDirectory()) {
                if (clean(e.name).includes(modClean) || modClean.includes(clean(e.name))) walk(full);
              } else if (clean(e.name).includes(modClean) && EDITABLE_EXT.some(ext => e.name.endsWith(ext))) {
                files.push({ name: path.relative(configDir, full), path: full });
              }
            }
          };
          walk(configDir);
        }
      }
      return { status: 200, body: { ok: true, files } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── RCON ────────────────────────────────────────────────────────
  if (pathname === '/api/rcon-connect') {
    try {
      if (!servers[data.id]) servers[data.id] = {};
      const rcon = new Rcon({ host: data.host || '127.0.0.1', port: parseInt(data.port), password: data.password });
      await rcon.connect();
      servers[data.id].rcon = rcon;
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/rcon-send') {
    const rcon = servers[data.id]?.rcon;
    if (!rcon) return { status: 200, body: { ok: false, error: 'RCON nicht verbunden.' } };
    try {
      const response = await rcon.send(data.cmd);
      return { status: 200, body: { ok: true, response } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── File Browser ────────────────────────────────────────────────
  if (pathname === '/api/files-list') {
    try {
      const entries = fs.readdirSync(data.currentPath, { withFileTypes: true }).map(e => {
        const fullPath = path.join(data.currentPath, e.name);
        let size = '';
        if (e.isFile()) {
          const stat = fs.statSync(fullPath);
          size = stat.size > 1024 * 1024
            ? (stat.size / 1024 / 1024).toFixed(1) + ' MB'
            : (stat.size / 1024).toFixed(0) + ' KB';
        }
        return { name: e.name, path: fullPath, isDir: e.isDirectory(), size };
      });
      const canGoUp = data.currentPath !== data.rootPath;
      const parentPath = path.dirname(data.currentPath);
      return { status: 200, body: { ok: true, entries, canGoUp, parentPath } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/file-read') {
    try {
      const content = fs.readFileSync(data.filePath, 'utf8');
      return { status: 200, body: { ok: true, content } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/file-write') {
    try {
      fs.writeFileSync(data.filePath, data.content, 'utf8');
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/file-delete') {
    try {
      if (data.isDir) fs.rmSync(data.filePath, { recursive: true, force: true });
      else fs.unlinkSync(data.filePath);
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/file-rename') {
    try {
      const dir = path.dirname(data.filePath);
      const newPath = path.join(dir, data.newName);
      fs.renameSync(data.filePath, newPath);
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/file-create') {
    try {
      const newPath = path.join(data.parentPath, data.name);
      if (data.isDir) fs.mkdirSync(newPath, { recursive: true });
      else fs.writeFileSync(newPath, '', 'utf8');
      return { status: 200, body: { ok: true, path: newPath } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── Whitelist / Banlist ─────────────────────────────────────────
  if (pathname === '/api/list-read') {
    try {
      const filePath = path.join(data.serverPath, data.file);
      if (!fs.existsSync(filePath)) return { status: 200, body: { ok: true, entries: [] } };
      const entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { status: 200, body: { ok: true, entries } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/list-add') {
    try {
      const filePath = path.join(data.serverPath, data.file);
      const arr = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : [];
      if (!arr.find(e => e.name === data.name)) {
        arr.push({ name: data.name, uuid: '' });
        fs.writeFileSync(filePath, JSON.stringify(arr, null, 2), 'utf8');
      }
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/list-remove') {
    try {
      const filePath = path.join(data.serverPath, data.file);
      if (!fs.existsSync(filePath)) return { status: 200, body: { ok: true } };
      const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      fs.writeFileSync(filePath, JSON.stringify(arr.filter(e => e.name !== data.name), null, 2), 'utf8');
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── EULA ────────────────────────────────────────────────────────
  if (pathname === '/api/eula-check') {
    const eulaPath = path.join(data.serverPath, 'eula.txt');
    if (!fs.existsSync(eulaPath)) return { status: 200, body: { ok: true, accepted: false, exists: false } };
    const accepted = fs.readFileSync(eulaPath, 'utf8').includes('eula=true');
    return { status: 200, body: { ok: true, accepted, exists: true } };
  }

  if (pathname === '/api/eula-accept') {
    try {
      const eulaPath = path.join(data.serverPath, 'eula.txt');
      fs.writeFileSync(eulaPath, '# Minecraft EULA akzeptiert via MC Manager\n# https://aka.ms/MinecraftEULA\neula=true\n', 'utf8');
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── Players (RCON) ──────────────────────────────────────────────
  if (pathname === '/api/players-list') {
    const rcon = servers[data.id]?.rcon;
    if (!rcon) return { status: 200, body: { ok: false, error: 'RCON nicht verbunden.' } };
    try {
      const response = await rcon.send('list');
      const match = response.match(/players online:\s*(.+)/i);
      const names = match && match[1].trim() !== '' ? match[1].split(',').map(n => n.trim()).filter(Boolean) : [];
      const countMatch = response.match(/There are (\d+)/i);
      const count = countMatch ? parseInt(countMatch[1]) : names.length;
      return { status: 200, body: { ok: true, players: names, count, raw: response } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/player-kick') {
    const rcon = servers[data.id]?.rcon;
    if (!rcon) return { status: 200, body: { ok: false, error: 'RCON nicht verbunden.' } };
    try { await rcon.send(data.reason ? `kick ${data.name} ${data.reason}` : `kick ${data.name}`); return { status: 200, body: { ok: true } }; }
    catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/player-ban') {
    const rcon = servers[data.id]?.rcon;
    if (!rcon) return { status: 200, body: { ok: false, error: 'RCON nicht verbunden.' } };
    try { await rcon.send(data.reason ? `ban ${data.name} ${data.reason}` : `ban ${data.name}`); return { status: 200, body: { ok: true } }; }
    catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/player-op') {
    const rcon = servers[data.id]?.rcon;
    if (!rcon) return { status: 200, body: { ok: false, error: 'RCON nicht verbunden.' } };
    try { await rcon.send(`op ${data.name}`); return { status: 200, body: { ok: true } }; }
    catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── Stats ───────────────────────────────────────────────────────
  if (pathname === '/api/get-stats') {
    const s = servers[data.id];
    if (!s?.process) return { status: 200, body: { ok: false, error: 'Kein Prozess.' } };
    try {
      const pidusage = require('pidusage');
      const stat = await pidusage(s.process.pid);
      let players = null, tps = null;
      if (s.rcon) {
        try {
          const listRes = await s.rcon.send('list');
          const m = listRes.match(/There are (\d+)/i);
          if (m) players = parseInt(m[1]);
          const tpsRes = await s.rcon.send('tps');
          const tm = tpsRes.match(/([\d.]+),/);
          if (tm) tps = parseFloat(tm[1]);
        } catch (_) {}
      }
      return { status: 200, body: { ok: true, memory: stat.memory, cpu: stat.cpu, players, tps } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── Diagnose / Repair ───────────────────────────────────────────
  if (pathname === '/api/diagnose') {
    const checks = [];
    const jarPath = path.join(data.serverPath, data.jar || 'server.jar');
    checks.push({ key: 'jar', label: `JAR (${data.jar || 'server.jar'})`, ok: fs.existsSync(jarPath) });
    const eulaPath = path.join(data.serverPath, 'eula.txt');
    const eulaAccepted = fs.existsSync(eulaPath) && fs.readFileSync(eulaPath, 'utf8').includes('eula=true');
    checks.push({ key: 'eula', label: 'EULA akzeptiert', ok: eulaAccepted });
    checks.push({ key: 'props', label: 'server.properties', ok: fs.existsSync(path.join(data.serverPath, 'server.properties')) });
    checks.push({ key: 'world', label: 'World-Ordner', ok: fs.existsSync(path.join(data.serverPath, 'world')), warn: !fs.existsSync(path.join(data.serverPath, 'world')) });
    return { status: 200, body: { ok: true, checks } };
  }

  if (pathname === '/api/repair') {
    try {
      const eulaPath = path.join(data.serverPath, 'eula.txt');
      if (!fs.existsSync(eulaPath) || !fs.readFileSync(eulaPath, 'utf8').includes('eula=true')) {
        fs.writeFileSync(eulaPath, '# Auto-repaired by MC Manager\neula=true\n', 'utf8');
      }
      const propsPath = path.join(data.serverPath, 'server.properties');
      if (!fs.existsSync(propsPath)) {
        fs.writeFileSync(propsPath, ['server-port=25565','max-players=20','level-name=world','online-mode=true','difficulty=easy','gamemode=survival','enable-rcon=false','rcon.port=25575'].join('\n'), 'utf8');
      }
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── Backup ──────────────────────────────────────────────────────
  if (pathname === '/api/backup-create') {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(data.backupPath, `backup-${timestamp}`);
      const copyDir = (src, dst) => {
        fs.mkdirSync(dst, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const s = path.join(src, entry.name), d = path.join(dst, entry.name);
          if (entry.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
        }
      };
      copyDir(data.serverPath, dest);
      return { status: 200, body: { ok: true, dest } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── Resource Packs ──────────────────────────────────────────────
  if (pathname === '/api/rp-scan') {
    try {
      const rpDir = path.join(data.serverPath, 'resourcepacks');
      if (!fs.existsSync(rpDir)) return { status: 200, body: { ok: true, packs: [] } };
      const packs = fs.readdirSync(rpDir, { withFileTypes: true })
        .filter(e => e.isFile() && (e.name.endsWith('.zip') || e.name.endsWith('.zip.disabled')))
        .map(e => {
          const fullPath = path.join(rpDir, e.name);
          const stat = fs.statSync(fullPath);
          const disabled = e.name.endsWith('.zip.disabled');
          return { name: e.name.replace('.zip.disabled', '').replace('.zip', ''), file: e.name, path: fullPath, sizeMB: (stat.size / 1024 / 1024).toFixed(2), disabled };
        });
      return { status: 200, body: { ok: true, packs } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/rp-toggle') {
    try {
      if (data.disabled) fs.renameSync(data.rpPath, data.rpPath.replace('.zip.disabled', '.zip'));
      else fs.renameSync(data.rpPath, data.rpPath + '.disabled');
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/rp-delete') {
    try { fs.unlinkSync(data.rpPath); return { status: 200, body: { ok: true } }; }
    catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── Icon ────────────────────────────────────────────────────────
  if (pathname === '/api/icon-load') {
    try {
      const iconPath = path.join(data.serverPath, 'server-icon.png');
      if (!fs.existsSync(iconPath)) return { status: 200, body: { ok: false } };
      const base64 = fs.readFileSync(iconPath).toString('base64');
      return { status: 200, body: { ok: true, data: `data:image/png;base64,${base64}` } };
    } catch (_) { return { status: 200, body: { ok: false } }; }
  }

  // ── Hangar / Modrinth ───────────────────────────────────────────
  if (pathname === '/api/hangar-search') {
    try {
      const params = new URLSearchParams({ q: data.query || '', platform: data.platform || 'PAPER', limit: '20', offset: '0', sort: data.query ? '-relevance' : '-downloads' });
      const r = await httpsGet(`https://hangar.papermc.io/api/v1/projects?${params}`);
      if (r.status !== 200) return { status: 200, body: { ok: false, error: `Hangar API Fehler: ${r.status}` } };
      return { status: 200, body: { ok: true, plugins: JSON.parse(r.body).result || [] } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/hangar-install') {
    try {
      const versionsUrl = `https://hangar.papermc.io/api/v1/projects/${data.owner}/${data.name}/versions`;
      const r = await httpsGet(versionsUrl + '?limit=10&offset=0');
      if (r.status !== 200) return { status: 200, body: { ok: false, error: 'Versionen nicht gefunden.' } };
      const versions = (JSON.parse(r.body).result || []);
      if (!versions.length) return { status: 200, body: { ok: false, error: 'Keine Version verfügbar.' } };
      let ver = versions.find(v => v.supportedVersions?.includes(data.version)) || versions[0];
      const downloadUrl = `https://hangar.papermc.io/api/v1/projects/${data.owner}/${data.name}/versions/${ver.name}/PAPER/download`;
      const pluginsDir = path.join(data.serverPath, 'plugins');
      fs.mkdirSync(pluginsDir, { recursive: true });
      const filename = `${data.name}-${ver.name}.jar`;
      await httpsDownload(downloadUrl, path.join(pluginsDir, filename), () => {});
      return { status: 200, body: { ok: true, filename } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/modrinth-search') {
    try {
      const facets = [['project_type:' + data.type]];
      if (data.loader) facets.push([`categories:${data.loader}`]);
      if (data.version) facets.push([`versions:${data.version}`]);
      const params = new URLSearchParams({ query: data.query || '', limit: String(data.limit || 20), offset: String(data.offset || 0), index: data.query ? 'relevance' : 'downloads', facets: JSON.stringify(facets) });
      const r = await httpsGet(`https://api.modrinth.com/v2/search?${params}`);
      if (r.status !== 200) return { status: 200, body: { ok: false, error: `API Fehler: ${r.status}` } };
      const d = JSON.parse(r.body);
      return { status: 200, body: { ok: true, hits: d.hits, total_hits: d.total_hits } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/modrinth-install') {
    try {
      const versionsUrl = `https://api.modrinth.com/v2/project/${data.projectId}/version`;
      const params = new URLSearchParams();
      if (data.loader) params.set('loaders', JSON.stringify([data.loader]));
      if (data.version) params.set('game_versions', JSON.stringify([data.version]));
      const r = await httpsGet(`${versionsUrl}?${params}`);
      if (r.status !== 200) return { status: 200, body: { ok: false, error: 'Versionen konnten nicht geladen werden.' } };
      const versions = JSON.parse(r.body);
      if (!versions.length) return { status: 200, body: { ok: false, error: 'Keine kompatible Version gefunden.' } };
      const ver = versions[0];
      const file = ver.files.find(f => f.primary) || ver.files[0];
      if (!file) return { status: 200, body: { ok: false, error: 'Keine Datei gefunden.' } };
      const isPlugin = ['paper','purpur','spigot','bukkit'].includes(data.loader?.toLowerCase());
      const targetDir = path.join(data.serverPath, isPlugin ? 'plugins' : 'mods');
      fs.mkdirSync(targetDir, { recursive: true });
      await httpsDownload(file.url, path.join(targetDir, file.filename), () => {});
      return { status: 200, body: { ok: true, filename: file.filename } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── Stats Persistence ───────────────────────────────────────────
  if (pathname === '/api/stats-load') {
    try {
      const d = cleanOldStats(loadStatsFile(data.id));
      return { status: 200, body: { ok: true, history: { ram: d.ram, cpu: d.cpu, tps: d.tps }, joins: d.joins } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/stats-append-point') {
    try {
      const d = loadStatsFile(data.id);
      if (!d[data.key]) d[data.key] = [];
      d[data.key].push({ ts: data.ts, v: data.v });
      const cleaned = cleanOldStats(d);
      fs.writeFileSync(statsPath(data.id), JSON.stringify(cleaned), 'utf8');
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/stats-append-join') {
    try {
      const d = loadStatsFile(data.id);
      d.joins.push(data.entry);
      const cleaned = cleanOldStats(d);
      fs.writeFileSync(statsPath(data.id), JSON.stringify(cleaned), 'utf8');
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── Delete Server Folder ────────────────────────────────────────
  if (pathname === '/api/delete-server-folder') {
    try {
      fs.rmSync(data.serverPath, { recursive: true, force: true });
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  // ── Get Local/IPv6 (Host-Seite) ─────────────────────────────────
  if (pathname === '/api/get-local-ip') {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return { status: 200, body: { ok: true, ip: iface.address } };
      }
    }
    return { status: 200, body: { ok: true, ip: 'localhost' } };
  }

  if (pathname === '/api/get-ipv6') {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv6' && !iface.internal && !iface.address.startsWith('fe80')) {
          return { status: 200, body: { ok: true, ip: iface.address } };
        }
      }
    }
    return { status: 200, body: { ok: false, error: 'Keine öffentliche IPv6 gefunden.' } };
  }

  // ── UPnP ─────────────────────────────────────────────────────────
  if (pathname === '/api/upnp-map') {
    try {
      const os = require('os');
      let localIp = '127.0.0.1';
      for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces) {
          if (iface.family === 'IPv4' && !iface.internal) { localIp = iface.address; break; }
        }
      }
      const location = await upnpDiscover();
      if (!location) return { status: 200, body: { ok: false, error: 'Router nicht gefunden. UPnP möglicherweise deaktiviert.' } };
      const ctrl = await upnpFetchControlUrl(location);
      const externalIp = await upnpGetExternalIp(ctrl);
      const res = await upnpSoapRequest(ctrl, 'AddPortMapping', {
        NewRemoteHost: '', NewExternalPort: data.port, NewProtocol: 'TCP',
        NewInternalPort: data.port, NewInternalClient: localIp, NewEnabled: 1,
        NewPortMappingDescription: `MC-Manager-${data.id}`, NewLeaseDuration: 0
      });
      if (res.status === 200 || res.status === 204) {
        upnpMappings[data.id] = { port: data.port, externalIp, ctrl };
        return { status: 200, body: { ok: true, externalIp, localIp } };
      } else {
        const errMatch = res.body.match(/<errorDescription>([^<]+)<\/errorDescription>/);
        return { status: 200, body: { ok: false, error: errMatch ? errMatch[1] : `SOAP Fehler ${res.status}` } };
      }
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/upnp-unmap') {
    const mapping = upnpMappings[data.id];
    if (!mapping) return { status: 200, body: { ok: true } };
    try {
      await upnpSoapRequest(mapping.ctrl, 'DeletePortMapping', {
        NewRemoteHost: '', NewExternalPort: mapping.port, NewProtocol: 'TCP'
      });
      delete upnpMappings[data.id];
      return { status: 200, body: { ok: true } };
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  if (pathname === '/api/upnp-status') {
    const mapping = upnpMappings[data.id];
    if (!mapping) return { status: 200, body: { ok: true, mapped: false } };
    return { status: 200, body: { ok: true, mapped: true, externalIp: mapping.externalIp, port: mapping.port } };
  }

  // ── DDNS ────────────────────────────────────────────────────────
  if (pathname === '/api/ddns-get-providers') {
    return { status: 200, body: { ok: true, providers: getProviderList() } };
  }

  if (pathname === '/api/ddns-update') {
    try {
      const provider = getProvider(data.providerKey);
      if (!provider) return { status: 200, body: { ok: false, error: 'Unbekannter Provider.' } };
      const built = provider.buildUrl(data.fields);
      let url, headers = {};
      if (typeof built === 'string') { url = built; } else { url = built.url; headers = built.headers || {}; }
      const r = await httpsGetWithHeaders(url, headers);
      const result = provider.parseResponse(r.body, r.status);
      if (result.ok) {
        return { status: 200, body: { ok: true, fullDomain: provider.fullDomain(data.fields) } };
      } else {
        return { status: 200, body: { ok: false, error: result.error } };
      }
    } catch (e) { return { status: 200, body: { ok: false, error: e.message } }; }
  }

  return { status: 404, body: { ok: false, error: 'Unbekannter Endpunkt: ' + pathname } };
}

// Wiederverwendung der bestehenden Start/Stop-Logik, aber mit WS-Broadcast statt webContents.send
async function remoteServerStart({ id, serverPath, ram, jarName }) {
  if (servers[id]?.process) return { ok: false, error: 'Server läuft bereits.' };

  const jar = jarName || 'server.jar';
  const isScript = jar === 'run.bat' || jar === 'run.sh';
  const fullPath = path.join(serverPath, jar);
  if (!fs.existsSync(fullPath)) return { ok: false, error: `Datei nicht gefunden: ${fullPath}` };

  let proc;
  if (isScript) {
    const argsFile = path.join(serverPath, 'user_jvm_args.txt');
    if (fs.existsSync(argsFile)) {
      let content = fs.readFileSync(argsFile, 'utf8');
      content = content.replace(/-Xmx\S+/g, '').replace(/-Xms\S+/g, '');
      content += `\n-Xmx${ram}M -Xms${ram}M\n`;
      fs.writeFileSync(argsFile, content, 'utf8');
    }
    proc = process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', jar, 'nogui'], { cwd: serverPath })
      : spawn('bash', [jar, 'nogui'], { cwd: serverPath });
  } else {
    proc = spawn('java', [`-Xmx${ram}M`, `-Xms${ram}M`, '-jar', jar, 'nogui'], { cwd: serverPath });
  }

  if (!servers[id]) servers[id] = {};
  servers[id].process = proc;
  servers[id].isScript = isScript;
  servers[id].phase = 'starting';

  if (mainWindow) mainWindow.webContents.send('server-log', { id, msg: '[MC Manager] Starting Server...\n' });
  wsSend({ type: 'server-log', id, msg: '[MC Manager] Starting Server...\n' });

  proc.stdout.on('data', d => {
    const msg = d.toString();
    if (msg.includes('Done (') && msg.includes('For help')) {
      servers[id].phase = 'online'; // ← NEU
    }
    if (mainWindow) mainWindow.webContents.send('server-log', { id, msg });
    wsSend({ type: 'server-log', id, msg });
  });
  proc.stderr.on('data', d => {
    const msg = '[ERR] ' + d.toString();
    if (mainWindow) mainWindow.webContents.send('server-log', { id, msg });
    wsSend({ type: 'server-log', id, msg });
  });
  proc.on('close', code => {
    if (servers[id]) { servers[id].process = null; servers[id].phase = null; }
    if (mainWindow) mainWindow.webContents.send('server-stopped', { id, code });
    wsSend({ type: 'server-stopped', id, code });
  });

  return { ok: true };
}

async function remoteServerStop(id) {
  const s = servers[id];
  if (!s?.process) return { ok: false, error: 'Server nicht aktiv.' };
  try {
    if (s.isScript) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(s.process.pid), '/f', '/t'], { shell: false });
      } else {
        s.process.kill('SIGTERM');
      }
    } else {
      if (s.process.stdin?.writable) {
        s.process.stdin.write('stop\n');
      } else {
        s.process.kill('SIGTERM');
      }
    }
  } catch (e) {
    try { s.process.kill(); } catch (_) {}
  }
  return { ok: true };
}

ipcMain.handle('set-app-mode', async (_, { mode, connection }) => {
  prefs.appMode = mode;
  if (mode === 'client' && connection) {
    prefs.remoteConnection = connection;
  }
  savePrefs();

  if (modeWindow) { modeWindow.close(); modeWindow = null; }
  createWindow();
  createTray();

  if (mode === 'server') {
    startRemoteServer(4127);
  }

  return { ok: true };
});

ipcMain.handle('test-remote-connection', async (_, { host, port }) => {
  try {
    const url = `http://${host}:${port}/api/ping`;
    const result = await new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'POST', timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
    if (result.status === 200) return { ok: true };
    return { ok: false, error: `Server antwortete mit Status ${result.status}` };
  } catch (e) { return { ok: false, error: e.message || 'Server nicht erreichbar.' }; }
});

ipcMain.handle('get-app-mode', async () => {
  return { ok: true, mode: prefs.appMode || null, connection: prefs.remoteConnection || null };
});

ipcMain.handle('reset-app-mode', async () => {
  delete prefs.appMode;
  delete prefs.remoteConnection;
  savePrefs();

  // Hauptfenster schließen, Mode-Select öffnen
  if (mainWindow) {
    forceQuit = true; // verhindert dass close-Handler das Fenster nur versteckt
    mainWindow.close();
    mainWindow = null;
    forceQuit = false;
  }
  if (tray) { tray.destroy(); tray = null; }
  createModeSelectWindow();

  return { ok: true };
});

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
  if (prefs.appMode) {
    createWindow();
    createTray();
    if (prefs.appMode === 'server') {
      startRemoteServer(4127);
    }
  } else {
    createModeSelectWindow();
  }
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
        if (res.statusCode !== 200) {
          return reject(new Error(`Download fehlgeschlagen: HTTP ${res.statusCode} für ${u}`));
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

ipcMain.handle('delete-server-folder', async (_, serverPath) => {
  try {
    fs.rmSync(serverPath, { recursive: true, force: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
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
ipcMain.handle('server-start', async (_, opts) => {
  return await remoteServerStart(opts);
});

// ── Server stoppen ────────────────────────────────────────────────
ipcMain.handle('server-stop', async (_, id) => {
  return await remoteServerStop(id);
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

ipcMain.handle('get-ipv6', async () => {
  try {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // Öffentliche (nicht link-local, nicht internal) IPv6 suchen
        if (iface.family === 'IPv6' && !iface.internal && !iface.address.startsWith('fe80')) {
          return { ok: true, ip: iface.address };
        }
      }
    }
    return { ok: false, error: 'Keine öffentliche IPv6 gefunden.' };
  } catch (e) { return { ok: false, error: e.message }; }
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

// ── Forge/NeoForge Installer ausführen ────────────────────────────
function runForgeInstaller(installerPath, destPath) {
  return new Promise((resolve) => {
    const proc = spawn('java', ['-jar', path.basename(installerPath), '--installServer'], {
      cwd: destPath
    });

    let output = '';
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => output += d.toString());

    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve({ ok: false, error: `Installer fehlgeschlagen (Code ${code}): ${output.slice(-300)}` });
      }

      // Nach Installation: Start-Skript oder JAR finden
      // Neuere Forge/NeoForge (1.17+) erzeugen run.bat / run.sh
      const runBat = path.join(destPath, 'run.bat');
      const runSh  = path.join(destPath, 'run.sh');

      if (fs.existsSync(runBat) || fs.existsSync(runSh)) {
        resolve({ ok: true, startJar: process.platform === 'win32' ? 'run.bat' : 'run.sh', isScript: true });
        return;
      }

      // Ältere Versionen: direktes Server-JAR suchen (forge-X-universal.jar o.ä.)
      const files = fs.readdirSync(destPath);
      const serverJar = files.find(f =>
        f.endsWith('.jar') &&
        !f.includes('installer') &&
        (f.includes('forge') || f.includes('neoforge')) &&
        (f.includes('universal') || f.includes('server'))
      );

      if (serverJar) {
        resolve({ ok: true, startJar: serverJar, isScript: false });
      } else {
        resolve({ ok: false, error: 'Server-JAR nach Installation nicht gefunden. Installer-Output: ' + output.slice(-300) });
      }
    });

    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

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
      const r = await httpsGet('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
      const matches = [...r.body.matchAll(/<version>(\d+)\.(\d+)\.\d+<\/version>/g)];
      const mcVersions = [...new Set(matches.map(m => `1.${m[1]}.${m[2]}`))].reverse();
      return { ok: true, versions: mcVersions.map(v => ({ id: v })) };
    }

    if (loader === 'purpur') {
      const r = await httpsGet('https://api.purpurmc.org/v2/purpur');
      const data = JSON.parse(r.body);
      const versions = [...data.versions].reverse().map(v => ({ id: v }));
      return { ok: true, versions };
    }

    return { ok: false, error: `Unbekannter Loader: ${loader}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Download: Builds für eine Version (Paper) ─────────────────────
ipcMain.handle('dl-builds', async (_, { loader, version }) => {
  console.log('=== dl-builds aufgerufen mit loader:', JSON.stringify(loader), 'version:', JSON.stringify(version));
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
    if (loader === 'neoforge') {
      const r = await httpsGet('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
      const matches = [...r.body.matchAll(/<version>([^<]+)<\/version>/g)];
      const allVersions = matches.map(m => m[1]);
      const parts = (version || '').match(/^1\.(\d+)\.(\d+)$/);
      const prefix = parts ? `${parts[1]}.${parts[2]}.` : '';
      const filtered = prefix ? allVersions.filter(v => v.startsWith(prefix)).reverse() : allVersions.slice().reverse();
      return { ok: true, builds: filtered.map(b => ({ id: b })) };
    }
    if (loader === 'purpur') {
      const r = await httpsGet(`https://api.purpurmc.org/v2/purpur/${version}`);
      const data = JSON.parse(r.body);
      const builds = [...data.builds.all].reverse().map(b => ({ id: b }));
      return { ok: true, builds };
    }
    return { ok: true, builds: [] };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Mod/Plugin Config-Dateien finden ─────────────────────────────
ipcMain.handle('mod-config-files', async (_, { serverPath, modName, type }) => {
  const EDITABLE_EXT = ['.json','.properties','.txt','.yml','.yaml','.toml','.cfg','.conf','.md','.sh','.bat'];
  const clean = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const files = [];

  try {
    if (type === 'plugin') {
      const dir = path.join(serverPath, 'plugins', modName);
      if (fs.existsSync(dir)) {
        const scan = (d) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const fp = path.join(d, e.name);
            if (e.isDirectory()) scan(fp);
            else if (EDITABLE_EXT.some(x => e.name.endsWith(x)))
              files.push({ path: fp, name: path.relative(dir, fp) });
          }
        };
        scan(dir);
      }
    } else {
      const dir = path.join(serverPath, 'config');
      if (fs.existsSync(dir)) {
        const modLower = clean(modName);
        const scan = (d) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const fp = path.join(d, e.name);
            if (e.isDirectory()) {
              if (clean(e.name).includes(modLower)) scan(fp);
            } else if (EDITABLE_EXT.some(x => e.name.endsWith(x))) {
              if (clean(e.name).includes(modLower))
                files.push({ path: fp, name: path.relative(dir, fp) });
            }
          }
        };
        scan(dir);
      }
    }
    return { ok: true, files };
  } catch(e) { return { ok: false, error: e.message }; }
});

// ── Download: JAR herunterladen ───────────────────────────────────
ipcMain.handle('dl-download', async (_, { loader, version, build, destPath }) => {
  console.log('=== dl-download aufgerufen mit loader:', JSON.stringify(loader), 'version:', JSON.stringify(version), 'build:', JSON.stringify(build), 'destPath:', JSON.stringify(destPath));
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
      url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${build}/forge-${build}-installer.jar`;
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

    if (loader === 'forge' || loader === 'neoforge') {
      mainWindow.webContents.send('dl-progress', 100);
      const installResult = await runForgeInstaller(fullDest, destPath);
      if (!installResult.ok) return { ok: false, error: installResult.error };
      return { ok: true, filename: installResult.startJar, fullDest, isScript: installResult.isScript };
    }

    if (loader === 'purpur') {
      const b = build || 'latest';
      url = `https://api.purpurmc.org/v2/purpur/${version}/${b}/download`;
      filename = `purpur-${version}-${b}.jar`;
    }

    return { ok: true, filename, fullDest };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── DDNS (generisch über Templates) ────────────────────────────────
const { getProvider, getProviderList } = require('./ddns-providers');

ipcMain.handle('ddns-get-providers', async () => {
  return { ok: true, providers: getProviderList() };
});

ipcMain.handle('ddns-update', async (_, { providerKey, fields }) => {
  try {
    const provider = getProvider(providerKey);
    if (!provider) return { ok: false, error: 'Unbekannter Provider.' };

    const built = provider.buildUrl(fields);
    let url, headers = {};
    if (typeof built === 'string') {
      url = built;
    } else {
      url = built.url;
      headers = built.headers || {};
    }

    const r = await httpsGetWithHeaders(url, headers);
    const result = provider.parseResponse(r.body, r.status);

    if (result.ok) {
      const fullDomain = provider.fullDomain(fields);
      return { ok: true, fullDomain };
    } else {
      return { ok: false, error: result.error };
    }
  } catch(e) { return { ok: false, error: e.message }; }
});

// Helper: httpsGet mit zusätzlichen Headers (für No-IP Basic-Auth etc.)
function httpsGetWithHeaders(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'mc-manager/1.0', ...extraHeaders } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGetWithHeaders(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}
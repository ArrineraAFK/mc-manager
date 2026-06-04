const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const { Rcon } = require('rcon-client');

let mainWindow;

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
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  Object.values(servers).forEach(s => { if (s.process) s.process.kill(); });
  app.quit();
});

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

// ── Ordner auswählen ──────────────────────────────────────────────
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

// ── Server-Liste speichern/laden (JSON im App-Datenordner) ────────
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

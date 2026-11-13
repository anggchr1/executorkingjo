const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, clipboard, dialog, Notification, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = __dirname;
const CFG = path.join(ROOT, 'config.ini');
const STAT = path.join(ROOT, 'status.ini');
const SLOTS = path.join(ROOT, 'presets.json');
const TOOLS = path.join(ROOT, 'tools.json');
const ENGINE = path.join(ROOT, 'engine.ahk');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const AHK = 'C:\\Program Files\\AutoHotkey\\v1.1.37.02\\AutoHotkeyU64.exe';

let engine = null;
let win = null;
let tray = null;
let quitting = false;

function readIni(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const buf = fs.readFileSync(file);
  // AHK menulis UTF-16 (BOM FF FE), Electron menulis UTF-8. Deteksi keduanya.
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
  let sec = 'app';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ';' || line[0] === '#') continue;
    const h = /^\[(.+)\]$/.exec(line);
    if (h) { sec = h[1].trim(); out[sec] = out[sec] || {}; continue; }
    const i = line.indexOf('=');
    if (i < 0) continue;
    (out[sec] = out[sec] || {})[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function readConfig() {
  const ini = readIni(CFG);
  const a = ini.app || {};
  const macros = [];
  for (let i = 1; i <= Number(a.count || 0); i++) {
    const m = ini['m' + i];
    if (!m) continue;
    macros.push({
      trigger: m.trigger || 'XButton1',
      mode: m.mode === 'toggle' ? 'toggle' : 'hold',
      action: m.action === 'key' ? 'key' : 'mouse',
      value: m.value || 'left',
      cps: Number(m.cps || 0),
      enabled: m.enabled !== '0',
    });
  }
  return {
    app: {
      master: a.master || 'RControl',
      panic: a.panic || 'AppsKey',
      enabled: a.enabled === '1',
      paused: a.paused === '1',
    },
    macros,
  };
}

function writeConfig(cfg) {
  const L = ['[app]'];
  L.push('master=' + cfg.app.master);
  L.push('panic=' + cfg.app.panic);
  L.push('enabled=' + (cfg.app.enabled ? 1 : 0));
  L.push('paused=' + (cfg.app.paused ? 1 : 0));
  L.push('count=' + cfg.macros.length);
  cfg.macros.forEach((m, i) => {
    L.push('', '[m' + (i + 1) + ']');
    L.push('trigger=' + m.trigger);
    L.push('mode=' + m.mode);
    L.push('action=' + m.action);
    L.push('value=' + m.value);
    L.push('cps=' + (Number(m.cps) || 0));
    L.push('enabled=' + (m.enabled ? 1 : 0));
  });
  fs.writeFileSync(CFG, L.join('\r\n') + '\r\n', 'utf8');
  
  // Also update status.ini
  const S = ['[app]'];
  S.push('enabled=' + (cfg.app.enabled ? 1 : 0));
  S.push('paused=' + (cfg.app.paused ? 1 : 0));
  cfg.macros.forEach((m, i) => {
    S.push('', '[m' + (i + 1) + ']');
    S.push('running=' + (m.running ? 1 : 0));
  });
  fs.writeFileSync(STAT, S.join('\r\n') + '\r\n', 'utf8');
}

function readStatus() {
  const ini = readIni(STAT);
  const running = [];
  for (let i = 1; i <= 32; i++) {
    if (ini['m' + i]) running.push(ini['m' + i].running === '1');
  }
  return { enabled: (ini.app || {}).enabled === '1', running };
}

function startEngine() {
  if (engine || !fs.existsSync(AHK) || !fs.existsSync(ENGINE)) return;
  engine = spawn(AHK, [ENGINE, String(process.pid)], { cwd: ROOT, windowsHide: true, stdio: 'ignore' });
  engine.on('exit', () => { engine = null; });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 780,
    height: 780,
    minWidth: 640,
    minHeight: 560,
    backgroundColor: '#0e1013',
    autoHideMenuBar: true,
    title: 'Executor Kingjo',
    icon: ICON,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(ROOT, 'index.html'));
  win.once('ready-to-show', () => { if (!HIDDEN) win.show(); });
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Buka Executor Kingjo', click: showWindow },
    { type: 'separator' },
    {
      label: 'Overlay HUD', type: 'checkbox',
      checked: readTools().overlay === true,
      click: (item) => setOverlay(item.checked),
    },
    { type: 'separator' },
    { label: 'Keluar', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Executor Kingjo');
  buildTrayMenu();
  tray.on('click', showWindow);
}

ipcMain.handle('load', () => ({ cfg: readConfig(), status: readStatus() }));
ipcMain.handle('save', (_e, cfg) => { writeConfig(cfg); return true; });
ipcMain.handle('status', () => readStatus());

// ---------- preset slot macro ----------
function readSlots() {
  try { return JSON.parse(fs.readFileSync(SLOTS, 'utf8')) || {}; } catch { return {}; }
}

ipcMain.handle('preset:list', () => {
  const p = readSlots();
  const out = {};
  for (const s of ['1', '2']) out[s] = p[s] ? { n: (p[s].macros || []).length, at: p[s].at || 0 } : null;
  return out;
});

ipcMain.handle('preset:save', (_e, slot, macros) => {
  const p = readSlots();
  p[slot] = { macros, at: Date.now() };
  fs.writeFileSync(SLOTS, JSON.stringify(p, null, 2), 'utf8');
  return { ok: true, at: p[slot].at };
});

ipcMain.handle('preset:load', (_e, slot) => {
  const p = readSlots();
  return p[slot] ? p[slot].macros : null;
});

// ---------- tools: launcher, clipboard, cleaner, wifi, overlay ----------
function readTools() {
  try { return JSON.parse(fs.readFileSync(TOOLS, 'utf8')) || {}; } catch { return {}; }
}
function writeTools(t) { fs.writeFileSync(TOOLS, JSON.stringify(t, null, 2), 'utf8'); }

// satu keybind boleh membuka beberapa app: targets = daftar path/appid
function launcherTargets(l) {
  return (l && (l.targets || (l.target ? [l.target] : []))) || [];
}

function normLauncher(l) {
  return {
    name: l.name || '',
    targets: launcherTargets(l),
    key: l.key || '',
    enabled: l.enabled !== false,
  };
}

function runTargets(list) {
  for (const target of list || []) runTarget(target);
}

// start otomatis saat login Windows + mulai tersembunyi di tray
const HIDDEN = process.argv.includes('--hidden');

function applyLoginItem(s) {
  if (!app.isReady()) return;
  const st = s || {};
  try {
    app.setLoginItemSettings({
      openAtLogin: !!st.autostart,
      path: process.execPath,
      args: st.startHidden ? [ROOT, '--hidden'] : [ROOT],
    });
  } catch {}
}

let soundboardFailed = [];

ipcMain.handle('tools:get', () => {
  const t = readTools();
  const failed = registerLaunchers();
  const soundboard = t.soundboard || {};
  return {
    launchers: (t.launchers || []).map(normLauncher),
    alert: { on: false, ms: 120, via: 'both', ...(t.alert || {}) },
    settings: { autostart: false, startHidden: false, accent: '#6c5ce7', saveSettings: true, ...(t.settings || {}) },
    download: {
      mode: t.download && t.download.mode === 'mp3' ? 'mp3' : 'mp4',
      quality: t.download && ['best', '1080', '720', '480'].includes(t.download.quality) ? t.download.quality : 'best',
      url: t.download && typeof t.download.url === 'string' ? t.download.url : '',
    },
    soundboard: {
      volume: Number.isFinite(Number(soundboard.volume)) ? Number(soundboard.volume) : 0.8,
      personalOutputId: soundboard.personalOutputId || soundboard.outputId || '',
      targetOutputId: soundboard.targetOutputId || '',
      sounds: (soundboard.sounds || []).filter((s) => s && s.path).map((s) => ({
        ...s,
        src: fs.existsSync(s.path) ? pathToFileURL(s.path).href : '',
        missing: !fs.existsSync(s.path),
        failed: soundboardFailed.includes(s.id),
      })),
    },
    overlay: t.overlay === true,
    failed,
    soundboardFailed,
  };
});

ipcMain.handle('tools:save', (_e, patch) => {
  const t = readTools();
  Object.assign(t, patch);
  writeTools(t);
  if (patch && patch.settings) applyLoginItem(t.settings);
  const failed = registerLaunchers();
  return { failed, soundboardFailed };
});

ipcMain.handle('soundboard:pick', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Pilih file suara',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'wma'] }],
  });
  if (result.canceled) return [];
  const soundDir = path.join(app.getPath('userData'), 'soundboard');
  fs.mkdirSync(soundDir, { recursive: true });
  return result.filePaths.map((file) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const localPath = path.join(soundDir, id + path.extname(file).toLowerCase());
    fs.copyFileSync(file, localPath);
    return {
      id,
      path: localPath,
      name: path.basename(file, path.extname(file)),
      src: pathToFileURL(localPath).href,
      key: '',
      missing: false,
      enabled: true,
    };
  });
});

ipcMain.handle('tools:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Pilih aplikasi',
    properties: ['openFile'],
    filters: [{ name: 'Program', extensions: ['exe', 'lnk', 'bat', 'cmd'] }, { name: 'Semua file', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  return { target: p, name: path.basename(p, path.extname(p)) };
});

// buka target: path file biasa, atau appid: untuk app Store/UWP
function runTarget(target) {
  if (!target) return;
  if (target.startsWith('appid:')) {
    spawn('explorer.exe', ['shell:AppsFolder\\' + target.slice(6)], { windowsHide: true });
    return;
  }
  shell.openPath(target);
}

ipcMain.handle('tools:run', (_e, target) => { runTargets(Array.isArray(target) ? target : [target]); return true; });

// daftar aplikasi: Get-StartApps ikut memuat app Store/UWP, .lnk sebagai cadangan
let appCache = null;

function startMenuLnk() {
  const roots = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  const found = new Map();
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.lnk$/i.test(e.name)) continue;
      const name = e.name.replace(/\.lnk$/i, '');
      const k = name.toLowerCase();
      if (!found.has(k)) found.set(k, { name, target: full });
    }
  };
  roots.forEach(walk);
  return [...found.values()];
}

function startMenuApps() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', 'Get-StartApps | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 20000 }, (_e, out) => {
        let list = [];
        try {
          const j = JSON.parse(String(out || '[]'));
          list = (Array.isArray(j) ? j : [j])
            .filter((a) => a && a.Name && a.AppID)
            .map((a) => ({ name: String(a.Name), target: 'appid:' + a.AppID }));
        } catch {}
        if (!list.length) list = startMenuLnk();
        const seen = new Set();
        resolve(list
          .filter((a) => {
            const k = a.name.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .sort((a, b) => a.name.localeCompare(b.name, 'id')));
      });
  });
}

ipcMain.handle('tools:apps', async () => (appCache = appCache || await startMenuApps()));

function registerLaunchers() {
  const failed = [];
  soundboardFailed = [];
  if (!app.isReady()) return failed;
  try { globalShortcut.unregisterAll(); } catch {}
  (readTools().launchers || []).forEach((l, i) => {
    if (!l.key || l.enabled === false) return;
    try {
      if (!globalShortcut.register(l.key, () => { runTargets(launcherTargets(l)); })) failed.push(i);
    } catch { failed.push(i); }
  });
  const sounds = (readTools().soundboard || {}).sounds || [];
  sounds.forEach((sound) => {
    if (!sound.key || sound.enabled === false || !sound.path || !fs.existsSync(sound.path)) return;
    try {
      if (!globalShortcut.register(sound.key, () => {
        if (win && !win.isDestroyed()) win.webContents.send('soundboard:play', sound.id);
      })) soundboardFailed.push(sound.id);
    } catch { soundboardFailed.push(sound.id); }
  });
  return failed;
}

// clipboard: simpan 50 teks terakhir (API clipboard Electron 45 berbentuk Promise)
let clips = [];
let clipSkip = null;
async function clipPoll() {
  const txt = await clipboard.readText();
  if (!txt || txt.length > 5000) return;
  // setelah "Bersihkan", teks yang masih ada di clipboard jangan langsung masuk lagi
  if (txt === clipSkip) return;
  clipSkip = null;
  if (clips.length && clips[0].text === txt) return;
  const i = clips.findIndex((c) => c.text === txt);
  if (i >= 0) clips.splice(i, 1);
  clips.unshift({ text: txt, at: Date.now() });
  if (clips.length > 50) clips.length = 50;
}
ipcMain.handle('clip:list', () => clips);
ipcMain.handle('clip:copy', async (_e, i) => {
  if (!clips[i]) return false;
  await clipboard.writeText(clips[i].text);
  return true;
});
ipcMain.handle('clip:clear', async () => {
  clipSkip = await clipboard.readText();
  clips = [];
  return true;
});

// cleaner: hanya folder temp yang dikenal, tidak menyentuh folder lain
function dirStats(p) {
  let bytes = 0, files = 0;
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else { try { bytes += fs.statSync(full).size; files++; } catch {} }
    }
  };
  walk(p);
  return { bytes, files };
}

const TEMPS = () => [os.tmpdir(), path.join(process.env.WINDIR || 'C:\\Windows', 'Temp')];

ipcMain.handle('clean:scan', () => {
  const list = TEMPS().map((p) => ({ path: p, ...dirStats(p) }));
  return { list, bytes: list.reduce((a, b) => a + b.bytes, 0), files: list.reduce((a, b) => a + b.files, 0) };
});

function wipeDir(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      else fs.unlinkSync(full);
    } catch {}
  }
}

ipcMain.handle('clean:run', async () => {
  const before = TEMPS().reduce((a, p) => a + dirStats(p).bytes, 0);
  TEMPS().forEach(wipeDir);
  await new Promise((r) => execFile('powershell', ['-NoProfile', '-Command', 'Clear-RecycleBin -Force -ErrorAction SilentlyContinue'], { windowsHide: true }, () => r()));
  const after = TEMPS().reduce((a, p) => a + dirStats(p).bytes, 0);
  return { freed: Math.max(0, before - after) };
});

// ---------- downloader (yt-dlp + ffmpeg) ----------
let dlTools = null;
let dlProc = null;
let dlStopFlag = false;

function dlDir() {
  const d = path.join(app.getPath('downloads'), 'Executor Kingjo');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function probeTool(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10000 }, (e, out) => {
      resolve({ ok: !e, version: String(out || '').split(/\r?\n/)[0].trim() });
    });
  });
}

async function findTool(cmd, args, candidates) {
  const first = await probeTool(cmd, args);
  if (first.ok) return { path: cmd, version: first.version };
  for (const p of candidates) {
    if (!p || !fs.existsSync(p)) continue;
    const r = await probeTool(p, args);
    if (r.ok) return { path: p, version: r.version };
  }
  return null;
}

async function checkTools() {
  if (dlTools) return dlTools;
  const home = os.homedir();
  const [ytdlp, ffmpeg] = await Promise.all([
    findTool('yt-dlp', ['--version'], [
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
      path.join(home, 'scoop', 'shims', 'yt-dlp.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'Scripts', 'yt-dlp.exe'),
      path.join(ROOT, 'yt-dlp.exe'),
    ]),
    findTool('ffmpeg', ['-version'], [
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      path.join(home, 'scoop', 'shims', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'D:\\ffmpeg\\bin\\ffmpeg.exe',
      path.join(ROOT, 'ffmpeg.exe'),
    ]),
  ]);
  dlTools = { ytdlp, ffmpeg };
  return dlTools;
}

ipcMain.handle('dl:check', async () => {
  dlTools = null;
  const t = await checkTools();
  return { ...t, dir: dlDir() };
});

ipcMain.handle('dl:update', async () => {
  const t = await checkTools();
  if (!t.ytdlp) return { ok: false, error: 'yt-dlp belum terpasang' };
  const resolvedPath = path.isAbsolute(t.ytdlp.path) ? t.ytdlp.path : await new Promise((resolve) => {
    execFile('where.exe', [t.ytdlp.path], { windowsHide: true }, (_error, stdout) => {
      resolve(String(stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || t.ytdlp.path);
    });
  });
  const pythonInstall = /[\\/]Scripts[\\/]yt-dlp(?:\.exe)?$/i.test(resolvedPath);
  const python = pythonInstall ? path.resolve(path.dirname(resolvedPath), '..', 'python.exe') : '';
  const updateCommand = pythonInstall && fs.existsSync(python) ? python : resolvedPath;
  const updateArgs = pythonInstall && fs.existsSync(python)
    ? ['-m', 'pip', 'install', '--upgrade', '--pre', 'yt-dlp']
    : ['--update-to', 'nightly'];
  const result = await new Promise((resolve) => {
    execFile(updateCommand, updateArgs, { windowsHide: true, timeout: 120000 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
  dlTools = null;
  const updated = await checkTools();
  const output = (result.stdout + '\n' + result.stderr).trim();
  if (result.error) return { ok: false, error: output || result.error.message, tools: updated };
  return { ok: true, message: output || 'Pemeriksaan update selesai.', tools: updated };
});

ipcMain.handle('dl:site', (_e, which) => {
  const urls = {
    ytdlp: 'https://github.com/yt-dlp/yt-dlp/releases/latest',
    ffmpeg: 'https://www.gyan.dev/ffmpeg/builds/',
  };
  if (urls[which]) shell.openExternal(urls[which]);
  return true;
});

ipcMain.handle('dl:analyze', async (_e, rawUrl) => {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Link harus diawali http:// atau https://' };
  const t = await checkTools();
  if (!t.ytdlp) return { ok: false, error: 'yt-dlp belum terpasang' };

  // terabox tidak didukung yt-dlp sama sekali
  if (/terabox/i.test(url)) {
    return { ok: false, error: 'Terabox tidak didukung yt-dlp. Gunakan link YouTube, TikTok (video), X, Instagram, Facebook, atau file langsung.' };
  }

  // konversi link foto tiktok ke video (yt-dlp tidak support /photo/)
  let analyzeUrl = url;
  const photo = /^(.+tiktok\.com\/@[^\/]+\/)photo\/(\d+)/.exec(url);
  if (photo) {
    analyzeUrl = photo[1] + 'video/' + photo[2];
  }

  const args = ['-J', '--no-warnings', '--playlist-end', '200', '--extractor-retries', '3', '--socket-timeout', '20', analyzeUrl];
  const json = await new Promise((resolve) => {
    execFile(t.ytdlp.path, args, { windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 },
      (e, out, err) => resolve({ e, out, err }));
  });
  if (json.e) {
    const errText = [json.err, json.out, json.e && json.e.message].filter(Boolean).join('\n');
    const msg = errText.split(/\r?\n/).filter((l) => /ERROR/i.test(l)).pop()
      || errText.split(/\r?\n/).filter(Boolean).pop() || 'Gagal membaca link';
    let clean = msg.replace(/^ERROR:\s*/i, '');
    // pesan lebih jelas untuk kasus yang dikenal
    if (/Unsupported URL/i.test(clean)) clean = 'Link tidak didukung yt-dlp. Coba link video (bukan foto/album) atau situs lain.';
    if (/blocked from accessing this post/i.test(clean)) clean = 'TikTok memblokir akses dari IP ini ke postingan ini. Coba link lain.';
    if (/photo/i.test(url) && /Unsupported URL/i.test(clean)) clean = 'TikTok foto tidak didukung. Coba gunakan link video TikTok.';
    return { ok: false, error: clean };
  }
  let j;
  try { j = JSON.parse(json.out); } catch { return { ok: false, error: 'Jawaban yt-dlp tidak bisa dibaca' }; }
  const pick = (e) => {
    const u = e.webpage_url || e.url || '';
    return {
      url: /^https?:\/\//i.test(u) ? u : url,
      title: e.title || e.id || 'Tanpa judul',
      duration: Math.round(Number(e.duration) || 0),
    };
  };
  const list = Array.isArray(j.entries) ? j.entries.filter(Boolean).map(pick) : [pick(j)];
  return {
    ok: true,
    title: j.title || (list[0] && list[0].title) || 'Tanpa judul',
    uploader: j.uploader || j.channel || '',
    count: list.length,
    entries: list,
  };
});

function dlFormatArgs(mode, quality, hasFfmpeg) {
  if (mode === 'mp3') return ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  const h = quality && quality !== 'best' ? `[height<=${quality}]` : '';
  if (!hasFfmpeg) return ['-f', `best${h}[ext=mp4]/best${h}/best`];
  return [
    '-f', `bv*${h}[ext=mp4]+ba[ext=m4a]/b${h}[ext=mp4]/bv*${h}+ba/b${h}/b`,
    '--merge-output-format', 'mp4',
  ];
}

function dlOne(item, i, total, opts) {
  return new Promise((resolve) => {
    const args = [
      ...dlFormatArgs(opts.mode, opts.quality, !!opts.ffmpeg),
      '--no-playlist', '--newline', '--no-warnings',
      '-o', path.join(opts.dir, '%(title).150B [%(id)s].%(ext)s'),
    ];
    if (opts.ffmpeg && opts.ffmpeg.includes(path.sep)) args.push('--ffmpeg-location', opts.ffmpeg);
    args.push(item.url);
    const p = spawn(opts.ytdlp, args, { windowsHide: true });
    dlProc = p;
    let buf = '';
    let errTail = '';
    const send = (patch) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('dl:progress', { index: i, total, key: item.key, title: item.title, ...patch });
      }
    };
    send({ status: 'downloading', percent: 0 });
    p.stdout.on('data', (chunk) => {
      buf += String(chunk);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const m = /^\[download\]\s+([\d.]+)%/.exec(line);
        if (m) {
          const speed = /\bat\s+(\S+)/.exec(line);
          const eta = /\bETA\s+(\S+)/.exec(line);
          send({ status: 'downloading', percent: Math.round(Number(m[1])), speed: speed ? speed[1] : '', eta: eta ? eta[1] : '' });
        } else if (/^\[(Merger|ExtractAudio|VideoConvertor|Fixup)/.test(line)) {
          send({ status: 'processing', percent: 100 });
        }
      }
    });
    p.stderr.on('data', (chunk) => { errTail = (errTail + String(chunk)).slice(-800); });
    p.on('error', (e) => { dlProc = null; send({ status: 'error', error: e.message }); resolve({ ok: false, error: e.message }); });
    p.on('close', (code) => {
      dlProc = null;
      if (dlStopFlag) { send({ status: 'cancelled' }); return resolve({ ok: false, cancelled: true }); }
      if (code === 0) { send({ status: 'done', percent: 100 }); return resolve({ ok: true }); }
      const msg = (errTail.split(/\r?\n/).filter((l) => /ERROR/i.test(l)).pop()
        || errTail.split(/\r?\n/).filter(Boolean).pop() || 'Gagal mengunduh').replace(/^ERROR:\s*/i, '');
      send({ status: 'error', error: msg });
      resolve({ ok: false, error: msg });
    });
  });
}

ipcMain.handle('dl:start', async (_e, opts) => {
  if (dlProc) return { ok: false, error: 'Masih ada download berjalan' };
  const t = await checkTools();
  if (!t.ytdlp) return { ok: false, error: 'yt-dlp belum terpasang' };
  const mode = opts && opts.mode === 'mp3' ? 'mp3' : 'mp4';
  const items = ((opts && opts.items) || []).filter((x) => x && x.url);
  if (!items.length) return { ok: false, error: 'Pilih minimal satu item' };
  if (mode === 'mp3' && !t.ffmpeg) return { ok: false, error: 'MP3 butuh ffmpeg. Pasang ffmpeg dulu, lalu klik Cek ulang.' };
  const dir = dlDir();
  dlStopFlag = false;
  const job = {
    mode,
    quality: (opts && opts.quality) || 'best',
    dir,
    ytdlp: t.ytdlp.path,
    ffmpeg: t.ffmpeg && t.ffmpeg.path,
  };
  (async () => {
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < items.length; i++) {
      if (dlStopFlag) break;
      const r = await dlOne(items[i], i, items.length, job);
      if (r.ok) ok++;
      else if (!r.cancelled) fail++;
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send('dl:progress', { done: true, ok, fail, cancelled: dlStopFlag });
    }
  })();
  return { ok: true, dir };
});

ipcMain.handle('dl:stop', () => {
  dlStopFlag = true;
  if (dlProc) {
    try { execFile('taskkill', ['/PID', String(dlProc.pid), '/T', '/F'], { windowsHide: true }); } catch {}
    try { dlProc.kill(); } catch {}
  }
  return true;
});

ipcMain.handle('dl:folder', () => {
  const d = dlDir();
  shell.openPath(d);
  return d;
});

// wifi + dns
function wifiInfo() {
  return new Promise((resolve) => {
    execFile('netsh', ['wlan', 'show', 'interfaces'], { windowsHide: true }, (_e, out) => {
      const s = String(out || '');
      const pick = (re) => { const m = re.exec(s); return m ? m[1].trim() : null; };
      resolve({
        ssid: pick(/^\s*SSID\s*:\s*(.+)$/mi),
        signal: Number(pick(/^\s*Signal\s*:\s*(\d+)/mi)) || null,
        state: pick(/^\s*State\s*:\s*(.+)$/mi),
        iface: pick(/^\s*Name\s*:\s*(.+)$/mi),
      });
    });
  });
}

function localIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return null;
}

function currentDns() {
  return new Promise((resolve) => {
    execFile('netsh', ['interface', 'ip', 'show', 'dnsservers'], { windowsHide: true }, (_e, out) => {
      const ips = String(out || '').match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [];
      resolve(ips.slice(0, 2));
    });
  });
}

ipcMain.handle('net:wifi', async () => {
  const w = await wifiInfo();
  let ip = null;
  try {
    const res = await fetch('https://cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(4000) });
    const t = await res.text();
    const m = /ip=([0-9a-f.:]+)/i.exec(t);
    ip = m ? m[1] : null;
  } catch {}
  return { ...w, local: localIp(), public: ip, dns: await currentDns() };
});

ipcMain.handle('net:dnsSet', (_e, which) => new Promise((resolve) => {
  wifiInfo().then((w) => {
    if (!w.iface) return resolve({ ok: false, error: 'Tidak ada adapter Wi-Fi aktif.' });
    const name = w.iface;
    const cmds = which === 'auto'
      ? [['interface', 'ip', 'set', 'dns', 'name=' + name, 'source=dhcp']]
      : which === 'google'
        ? [['interface', 'ip', 'set', 'dns', 'name=' + name, 'static', '8.8.8.8'],
           ['interface', 'ip', 'add', 'dns', 'name=' + name, '8.8.4.4', 'index=2']]
        : [['interface', 'ip', 'set', 'dns', 'name=' + name, 'static', '1.1.1.1'],
           ['interface', 'ip', 'add', 'dns', 'name=' + name, '1.0.0.1', 'index=2']];
    let err = '';
    const run = (i) => {
      if (i >= cmds.length) {
        if (err) return resolve({ ok: false, error: 'Gagal (butuh admin?): ' + (err.split(/\r?\n/).filter(Boolean)[0] || 'ditolak') });
        return resolve({ ok: true });
      }
      execFile('netsh', cmds[i], { windowsHide: true }, (e, so, se) => {
        if (e) err += (se || so || '');
        run(i + 1);
      });
    };
    run(0);
  });
}));

// overlay HUD
let overlay = null;

const HUD_DEF = { pos: 'tr', opacity: 84, scale: 100, items: { macro: true, run: true, ping: true, cpu: true } };
const HUD_BASE = { w: 300, h: 122 };

function hudCfg() {
  const t = readTools();
  const h = t.hud || {};
  return {
    ...HUD_DEF, ...h,
    on: t.overlay === true,
    items: { ...HUD_DEF.items, ...(h.items || {}) },
  };
}

function hudBounds() {
  const h = hudCfg();
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.round(HUD_BASE.w * h.scale / 100);
  const ht = Math.round(HUD_BASE.h * h.scale / 100);
  const m = 16;
  return {
    x: h.pos[1] === 'l' ? wa.x + m : wa.x + wa.width - w - m,
    y: h.pos[0] === 't' ? wa.y + m : wa.y + wa.height - ht - m,
    width: w, height: ht,
  };
}

function applyHud() {
  if (overlay) overlay.setBounds(hudBounds());
}

ipcMain.handle('ovl:cfg', () => hudCfg());

ipcMain.handle('ovl:save', (_e, patch) => {
  const t = readTools();
  t.hud = { ...(t.hud || {}), ...patch };
  writeTools(t);
  applyHud();
  return hudCfg();
});

function createOverlay() {
  if (overlay) { overlay.showInactive(); return; }
  overlay = new BrowserWindow({
    ...hudBounds(),
    frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, focusable: false, hasShadow: false, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.loadFile(path.join(ROOT, 'overlay.html'));
  overlay.once('ready-to-show', () => { if (overlay) overlay.showInactive(); });
  overlay.on('closed', () => { overlay = null; });
}

function setOverlay(on) {
  const t = readTools();
  t.overlay = !!on;
  writeTools(t);
  if (on) createOverlay();
  else if (overlay) { overlay.destroy(); overlay = null; }
  if (tray) buildTrayMenu();
}

ipcMain.handle('ovl:set', (_e, on) => { setOverlay(on); return true; });

// alert jaringan
let lastAlert = 0;
function maybeAlert(st, ms) {
  const a = readTools().alert || {};
  if (!a.on) return;
  const limit = Number(a.ms) || 120;
  if (ms != null && ms <= limit) return;
  if (Date.now() - lastAlert < 20000) return;
  lastAlert = Date.now();
  const title = ms == null ? 'Tidak ada balasan' : 'Ping ' + ms + ' ms';
  const body = st.host + (ms == null ? ' — paket hilang' : ' — di atas batas ' + limit + ' ms');
  const via = a.via || 'both';
  if ((via === 'hud' || via === 'both') && overlay) {
    overlay.webContents.send('ovl:alert', { title, body });
  }
  if ((via === 'win' || via === 'both') && Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

function cleanHost(h) {
  return String(h || '').trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/[^a-zA-Z0-9.\-:]/g, '');
}

function pingHost(host) {
  return new Promise((resolve) => {
    if (!host) return resolve({ ok: false, error: 'Host masih kosong.' });
    execFile('ping', ['-n', '4', '-w', '1500', host], { windowsHide: true, timeout: 20000 }, (_err, stdout) => {
      // ambil hanya baris balasan (punya TTL), supaya baris ringkasan min/maks/rata-rata tidak ikut
      const times = String(stdout || '').split(/\r?\n/)
        .filter((l) => /ttl/i.test(l))
        .map((l) => /([=<])\s*(\d+)\s*ms/i.exec(l))
        .filter(Boolean)
        .map((m) => Number(m[2]));
      if (!times.length) return resolve({ ok: false, error: 'Tidak ada balasan dari ' + host });
      resolve({
        ok: true,
        host,
        min: Math.min(...times),
        max: Math.max(...times),
        avg: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
        loss: Math.round((1 - times.length / 4) * 100),
      });
    });
  });
}

async function speedTest() {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30000);
  try {
    const t0 = Date.now();
    const res = await fetch('https://speed.cloudflare.com/__down?bytes=10000000', { signal: ctrl.signal });
    const buf = await res.arrayBuffer();
    const secs = Math.max((Date.now() - t0) / 1000, 0.05);
    return {
      ok: true,
      mbps: Math.round(((buf.byteLength * 8) / secs / 1e6) * 10) / 10,
      mb: Math.round(buf.byteLength / 1e6),
      secs: Math.round(secs * 10) / 10,
    };
  } catch {
    return { ok: false, error: 'Gagal mengunduh data uji (jaringan lambat atau diblokir).' };
  } finally {
    clearTimeout(to);
  }
}

ipcMain.handle('net:ping', (_e, host) => pingHost(cleanHost(host)));
ipcMain.handle('net:speed', () => speedTest());

// ---------- live ping ----------
let live = null;

function liveStart(host) {
  liveStop();
  if (!host) return { ok: false, error: 'Host masih kosong.' };
  const st = { host, proc: null, buf: '', samples: [], ok: 0, bad: 0, min: null, max: null, sum: 0, error: null };
  const proc = spawn('ping', ['-t', '-w', '1000', host], { windowsHide: true });
  st.proc = proc;
  live = st;
  proc.stdout.on('data', (d) => {
    st.buf += d.toString();
    const lines = st.buf.split(/\r?\n/);
    st.buf = lines.pop() || '';
    for (const line of lines) {
      const t = /([=<])\s*(\d+)\s*ms/i.exec(line);
      if (/ttl/i.test(line) && t) {
        const ms = Number(t[2]);
        st.ok++;
        st.sum += ms;
        st.min = st.min === null ? ms : Math.min(st.min, ms);
        st.max = st.max === null ? ms : Math.max(st.max, ms);
        st.samples.push(ms);
        maybeAlert(st, ms);
      } else if (/timed out|timeout|unreachable|tidak dapat menjangkau/i.test(line)) {
        st.bad++;
        st.samples.push(null);
        maybeAlert(st, null);
      } else if (/could not find host/i.test(line)) {
        st.error = 'Host tidak ditemukan: ' + host;
      }
      if (st.samples.length > 40) st.samples.shift();
    }
  });
  proc.on('error', () => { st.error = 'Gagal menjalankan ping.'; });
  proc.on('exit', () => { st.proc = null; });
  return { ok: true };
}

function liveStop() {
  if (live && live.proc) { try { live.proc.kill(); } catch {} }
  live = null;
  return { ok: true };
}

function liveState() {
  if (!live) return { on: false };
  return {
    on: !!live.proc,
    host: live.host,
    cur: live.samples.length ? live.samples[live.samples.length - 1] : null,
    samples: live.samples.slice(),
    min: live.min,
    max: live.max,
    avg: live.ok ? Math.round(live.sum / live.ok) : null,
    loss: live.ok + live.bad ? Math.round((live.bad / (live.ok + live.bad)) * 100) : 0,
    error: live.error,
  };
}

ipcMain.handle('net:liveStart', (_e, host) => liveStart(cleanHost(host)));
ipcMain.handle('net:liveStop', () => liveStop());
ipcMain.handle('net:live', () => liveState());

// ---------- system monitor ----------
let gpu = null;
let gpuProc = null;
let cpuPrev = os.cpus().map((c) => ({ ...c.times }));

function cpuPerCore() {
  const now = os.cpus().map((c) => c.times);
  const per = now.map((t, i) => {
    const p = cpuPrev[i] || t;
    const idle = t.idle - p.idle;
    const total = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq) + idle;
    return total > 0 ? Math.min(100, Math.round((1 - idle / total) * 100)) : 0;
  });
  cpuPrev = now;
  return per;
}

function sysStats() {
  const cpus = os.cpus();
  const per = cpuPerCore();
  const total = os.totalmem();
  return {
    cpu: {
      model: cpus[0].model.replace(/\s+/g, ' ').trim(),
      speed: cpus[0].speed,
      cores: cpus.length,
      load: Math.round(per.reduce((a, b) => a + b, 0) / per.length),
      per,
    },
    mem: { total, used: total - os.freemem() },
    gpu,
  };
}

function startGpu() {
  try {
    gpuProc = spawn('nvidia-smi', [
      '--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,clocks.current.graphics',
      '--format=csv,noheader,nounits', '-l', '1',
    ], { windowsHide: true });
  } catch {
    gpuProc = null;
    return;
  }
  let buf = '';
  gpuProc.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    const line = lines.filter((l) => l.trim()).pop();
    if (!line) return;
    const p = line.split(',').map((s) => s.trim());
    gpu = {
      name: p[0],
      load: Number(p[1]) || 0,
      temp: Number.isFinite(Number(p[2])) ? Math.round(Number(p[2])) : null,
      vramUsed: Number(p[3]) || 0,
      vramTotal: Number(p[4]) || 0,
      clock: Number(p[5]) || 0,
    };
  });
  gpuProc.on('error', () => { gpu = null; gpuProc = null; });
  gpuProc.on('exit', () => { gpu = null; gpuProc = null; });
}

ipcMain.handle('sys:stats', () => sysStats());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    if ((readTools().settings || {}).saveSettings === false) {
      writeConfig({
        app: { master: 'RControl', panic: 'AppsKey', enabled: false, paused: false },
        macros: [],
      });
      writeTools({ settings: { autostart: false, startHidden: false, accent: '#6c5ce7', saveSettings: false } });
    }
    if (!fs.existsSync(CFG)) {
      writeConfig({
        app: { master: 'RControl', panic: 'AppsKey', enabled: false, paused: false },
        macros: [],
      });
    }
    // aplikasi dibuka = macro belum jalan, harus klik Run
    const cfg = readConfig();
    cfg.app.enabled = false;
    writeConfig(cfg);

    startEngine();
    startGpu();
    applyLoginItem(readTools().settings);
    createWindow();
    createTray();
    registerLaunchers();
    clipPoll();
    setInterval(clipPoll, 900);
    if (readTools().overlay === true) createOverlay();
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    if (engine) { try { engine.kill(); } catch {} }
    if (gpuProc) { try { gpuProc.kill(); } catch {} }
    liveStop();
    try { globalShortcut.unregisterAll(); } catch {}
  });
}

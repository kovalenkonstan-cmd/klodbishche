const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { constants: FS } = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Where vibe-coding projects live: every subfolder is one project.
const PROJECTS_DIR = path.join(os.homedir(), 'Claude');
// Claude Code keeps notes and chat logs for that folder here.
const CLAUDE_PROJECT_DIR = path.join(os.homedir(), '.claude', 'projects', PROJECTS_DIR.replace(/[\/.]/g, '-'));
// A project with no file changes for this long is considered dead.
const DEAD_AFTER_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

// Folders that change on their own and say nothing about real work.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'target',
  '.venv', 'venv', '__pycache__', '.cache', '.turbo', '.vercel', '.claude',
]);
// Finder touches .DS_Store just by opening a folder.
const SKIP_FILES = new Set(['.DS_Store']);

let storePath;

// ---------- store ----------
async function loadStore() {
  try {
    const s = JSON.parse(await fs.readFile(storePath, 'utf8'));
    return {
      overrides: s.overrides || {},
      manual: s.manual || [],
      names: s.names || {},
      nameFail: s.nameFail || {},
      ui: s.ui || {},
    };
  } catch {
    return { overrides: {}, manual: [], names: {}, nameFail: {}, ui: {} };
  }
}

async function saveStore(store) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
}

// ---------- scanning ----------
async function walk(dir, acc) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(p, acc);
    } else if (e.isFile() && !SKIP_FILES.has(e.name)) {
      try {
        const st = await fs.stat(p);
        acc.files++;
        if (st.mtimeMs > acc.last) acc.last = st.mtimeMs;
        const born = Math.min(st.birthtimeMs || Infinity, st.mtimeMs);
        if (born > 0 && born < acc.born) acc.born = born;
      } catch {
        // file vanished mid-scan, ignore
      }
    }
  }
}

async function scanProjects() {
  let entries = [];
  try {
    entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const acc = { files: 0, last: 0, born: Infinity };
    const dir = path.join(PROJECTS_DIR, e.name);
    await walk(dir, acc);
    if (acc.files === 0) continue;
    // Prefer the folder's own creation date: copied-in files keep old dates.
    try {
      const st = await fs.stat(dir);
      if (st.birthtimeMs > 0) acc.born = Math.min(st.birthtimeMs, acc.last);
    } catch {}
    projects.push({ name: e.name, born: acc.born, last: acc.last });
  }
  return projects;
}

async function getGraves() {
  const store = await loadStore();
  const projects = await scanProjects();
  const now = Date.now();

  let alive = 0;
  let hidden = 0;
  const graves = [];

  for (const p of projects) {
    const id = 'dir:' + p.name;
    const o = store.overrides[id] || {};
    if (o.hidden) { hidden++; continue; }
    if (now - p.last < DEAD_AFTER_DAYS * DAY) { alive++; continue; }
    graves.push({
      id,
      auto: true,
      folder: p.name,
      name: o.name || (store.names[id] && store.names[id].name) || p.name,
      named: Boolean(o.name || store.names[id]),
      born: p.born,
      died: p.last,
      epitaph: o.epitaph || '',
      cause: o.cause || '',
    });
  }
  for (const m of store.manual) graves.push({ ...m, auto: false, named: true });

  graves.sort((a, b) => b.died - a.died);
  scheduleNaming(graves, store);
  return { graves, alive, hidden, deadAfterDays: DEAD_AFTER_DAYS };
}

// ---------- human names from Claude ----------
// Uses the local `claude` command (the user's own Claude Code login), no API key in the app.
const CLAUDE_BINS = [
  path.join(os.homedir(), '.local/bin/claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  path.join(os.homedir(), '.claude/local/claude'),
];
const NAME_PROMPT =
  'Ниже заметки и переписка о заброшенном вайбкодерском проекте. ' +
  'Придумай для него короткое человеческое название на русском, как будто так его зовут друзья: ' +
  'максимум 3 слова, без кавычек и точки, не повторяй техническое имя папки. Ответь только названием.';
let naming = false;

async function findClaude() {
  for (const p of CLAUDE_BINS) {
    try {
      await fs.access(p, FS.X_OK);
      return p;
    } catch {}
  }
  return null;
}

async function readHead(file, max) {
  try {
    return (await fs.readFile(file, 'utf8')).slice(0, max);
  } catch {
    return '';
  }
}

function userTexts(jsonl, limit) {
  const out = [];
  for (const line of jsonl.split('\n')) {
    if (out.length >= limit) break;
    if (!line.includes('"type":"user"')) continue;
    try {
      const m = JSON.parse(line).message;
      let t = typeof m.content === 'string' ? m.content
        : (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');
      t = t.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
      if (t.length > 15) out.push(t.slice(0, 300));
    } catch {}
  }
  return out;
}

async function projectContext(folder) {
  const parts = [`Папка: ${folder}`];
  const dir = path.join(PROJECTS_DIR, folder);
  for (const f of ['CLAUDE.md', 'README.md']) {
    const t = await readHead(path.join(dir, f), 1200);
    if (t) parts.push(`${f}:\n${t}`);
  }
  try {
    const pkg = JSON.parse(await readHead(path.join(dir, 'package.json'), 20000));
    if (pkg.description) parts.push(`Описание: ${pkg.description}`);
  } catch {}

  // Claude's memory notes that mention this folder
  try {
    const memDir = path.join(CLAUDE_PROJECT_DIR, 'memory');
    for (const f of await fs.readdir(memDir)) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      const t = await readHead(path.join(memDir, f), 4000);
      if (t.includes(`/${folder}`)) parts.push(`Заметка:\n${t.slice(0, 1200)}`);
    }
  } catch {}

  // First requests from chats that touched this folder
  try {
    const chats = [];
    for (const f of await fs.readdir(CLAUDE_PROJECT_DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const t = await readHead(path.join(CLAUDE_PROJECT_DIR, f), 5_000_000);
      if (t.includes(`/Claude/${folder}`)) chats.push(...userTexts(t, 3));
      if (chats.length >= 6) break;
    }
    if (chats.length) parts.push('Из переписки:\n' + chats.slice(0, 6).join('\n'));
  } catch {}

  return parts.join('\n\n').slice(0, 6000);
}

function askClaude(bin, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', '--model', 'haiku', NAME_PROMPT], { cwd: os.tmpdir() });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(err || out || `exit ${code}`));
    });
    child.stdin.end(input);
  });
}

function cleanName(raw) {
  const line = raw.split('\n').map((s) => s.trim()).find(Boolean) || '';
  return line.replace(/^["«'“]+|["»'”.]+$/g, '').split(/\s+/).slice(0, 3).join(' ').slice(0, 32);
}

async function scheduleNaming(graves, store) {
  if (naming) return;
  const todo = graves.filter((g) => g.auto && !g.named && !(Date.now() - (store.nameFail[g.id] || 0) < DAY));
  if (!todo.length) return;
  const bin = await findClaude();
  if (!bin) return;
  naming = true;
  try {
    for (const g of todo) {
      try {
        const name = cleanName(await askClaude(bin, await projectContext(g.folder)));
        if (!name) throw new Error('empty name');
        const s = await loadStore();
        s.names[g.id] = { name, at: Date.now() };
        await saveStore(s);
        refreshAll();
      } catch (e) {
        // Most likely the terminal login expired: stop and retry tomorrow.
        const s = await loadStore();
        s.nameFail[g.id] = Date.now();
        await saveStore(s);
        console.warn('naming failed:', String(e.message).slice(0, 200));
        break;
      }
    }
  } finally {
    naming = false;
  }
}

// ---------- IPC ----------
ipcMain.handle('graves:get', () => getGraves());

ipcMain.handle('grave:update', async (_e, id, patch) => {
  const store = await loadStore();
  const clean = {
    epitaph: String(patch.epitaph || '').slice(0, 80),
    cause: String(patch.cause || '').slice(0, 60),
  };
  const name = String(patch.name || '').trim().slice(0, 40);
  const manual = store.manual.find((m) => m.id === id);
  if (manual) {
    Object.assign(manual, clean);
    if (name) manual.name = name;
  } else {
    const o = { ...(store.overrides[id] || {}), ...clean };
    const auto = store.names[id] ? store.names[id].name : id.replace(/^dir:/, '');
    if (name && name !== auto) o.name = name;
    else delete o.name;
    store.overrides[id] = o;
  }
  await saveStore(store);
});

ipcMain.handle('grave:hide', async (_e, id) => {
  const store = await loadStore();
  store.overrides[id] = { ...(store.overrides[id] || {}), hidden: true };
  await saveStore(store);
});

async function unhideAll() {
  const store = await loadStore();
  for (const o of Object.values(store.overrides)) delete o.hidden;
  await saveStore(store);
}
ipcMain.handle('graves:unhideAll', () => unhideAll());

ipcMain.handle('grave:add', async (_e, data) => {
  const store = await loadStore();
  const died = Date.now();
  let born = Date.parse(data.born);
  if (!Number.isFinite(born) || born > died) born = died;
  store.manual.push({
    id: 'manual:' + crypto.randomUUID(),
    name: String(data.name || 'Безымянный').slice(0, 40),
    epitaph: String(data.epitaph || '').slice(0, 80),
    cause: String(data.cause || '').slice(0, 60),
    born,
    died,
  });
  await saveStore(store);
});

ipcMain.handle('grave:remove', async (_e, id) => {
  const store = await loadStore();
  store.manual = store.manual.filter((m) => m.id !== id);
  await saveStore(store);
});

ipcMain.on('app:quit', () => app.quit());
ipcMain.on('view:toggle', () => setCollapsed(!collapsed));
// While collapsed the window lets clicks through everywhere except the tombstone icon.
ipcMain.on('mouse:capture', (_e, on) => {
  if (win && collapsed) win.setIgnoreMouseEvents(!on, { forward: true });
});

// Dragging the tombstone moves the whole (mostly transparent) window.
let dragOrigin = null;
ipcMain.on('drag:start', () => {
  if (win) dragOrigin = win.getPosition();
});
ipcMain.on('drag:move', (_e, dx, dy) => {
  if (win && dragOrigin) win.setPosition(Math.round(dragOrigin[0] + dx), Math.round(dragOrigin[1] + dy));
});
ipcMain.on('drag:end', async () => {
  dragOrigin = null;
  if (!win) return;
  const [x, y] = win.getPosition();
  homePos = { x, y };
  const store = await loadStore();
  store.ui.pos = homePos;
  await saveStore(store);
});

// ---------- window ----------
// One floating window in the top-right corner. Collapsed, only the tombstone logo is visible
// and stays in exactly the same spot, so it can be clicked again to unfold the card.
const CARD_W = 360;
const CARD_H = 357;
let win = null;
let tray = null;
let collapsed = false;
// Where the user left the tombstone (window top-left). The card may shift to fit the screen
// when it unfolds, and goes back here when it folds.
let homePos = null;

function cardBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - CARD_W - 20, y: workArea.y + 20, width: CARD_W, height: CARD_H };
}

function fitOnScreen(pos) {
  const { workArea: a } = screen.getDisplayMatching({ ...pos, width: CARD_W, height: CARD_H });
  return {
    x: Math.min(Math.max(pos.x, a.x), a.x + a.width - CARD_W),
    y: Math.min(Math.max(pos.y, a.y), a.y + a.height - CARD_H),
  };
}

function setCollapsed(value) {
  collapsed = value;
  if (!win) return;
  if (homePos) {
    const p = collapsed ? homePos : fitOnScreen(homePos);
    win.setPosition(p.x, p.y);
  }
  win.setIgnoreMouseEvents(collapsed, { forward: true });
  win.webContents.send('view:state', collapsed ? 'collapsed' : 'expanded');
  if (!collapsed) win.focus();
  updateTray();
}

function refreshAll() {
  if (win) win.webContents.send('refresh');
}

function createWindow() {
  const start = homePos ? { ...fitOnScreen(homePos), width: CARD_W, height: CARD_H } : cardBounds();
  win = new BrowserWindow({
    ...start,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    title: 'Клодбище',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: collapsed ? 'Развернуть' : 'Свернуть', accelerator: 'CommandOrControl+Alt+G', click: () => setCollapsed(!collapsed) },
    { label: 'Похоронить проект…', click: () => { setCollapsed(false); win && win.webContents.send('open-add'); } },
    { label: 'Обновить', click: () => refreshAll() },
    { label: 'Вернуть скрытые', click: async () => { await unhideAll(); refreshAll(); } },
    { type: 'separator' },
    { label: 'Выйти', click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('🪦');
  tray.setToolTip('Клодбище');
  updateTray();
}

async function snapshot(file) {
  const img = await win.webContents.capturePage();
  await fs.writeFile(file, img.toPNG());
}

app.whenReady().then(async () => {
  storePath = path.join(app.getPath('userData'), 'graveyard.json');
  const saved = (await loadStore()).ui.pos;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) homePos = saved;
  createWindow();
  createTray();
  globalShortcut.register('CommandOrControl+Alt+G', () => setCollapsed(!collapsed));
  app.on('activate', () => setCollapsed(false));

  // Dev helper: GRAVEYARD_SNAPSHOT=/tmp/x.png npm start saves x.png, x-feed.png, x-add.png, x-collapsed.png and quits.
  const shot = process.env.GRAVEYARD_SNAPSHOT;
  if (shot) {
    const later = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      await later(3000);
      await snapshot(shot);
      await win.webContents.executeJavaScript('feedAt(15)');
      await later(4000);
      await snapshot(shot.replace(/\.png$/, '-feed.png'));
      win.webContents.send('open-add');
      await later(800);
      await snapshot(shot.replace(/\.png$/, '-add.png'));
      win.webContents.send('close-dialogs');
      setCollapsed(true);
      await later(800);
      await snapshot(shot.replace(/\.png$/, '-collapsed.png'));
      app.quit();
    })();
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

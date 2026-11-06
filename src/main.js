const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { constants: FS } = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { findProjects, projectContext } = require('./projects');

// A project with no file changes and no Claude chats for this long is considered dead.
const DEAD_AFTER_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const HOME = os.homedir();

let storePath;

// ---------- store ----------
function emptyStore() {
  return { overrides: {}, manual: [], names: {}, nameFail: {}, ui: {} };
}

async function loadStore() {
  try {
    const s = JSON.parse(await fs.readFile(storePath, 'utf8'));
    return { ...emptyStore(), ...s, ui: s.ui || {} };
  } catch {
    return emptyStore();
  }
}

async function saveStore(store) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
}

// Early versions kept data under another app name and keyed graves by folder name inside ~/Claude.
async function migrateStore() {
  const oldPath = path.join(app.getPath('appData'), 'Кладбище проектов', 'graveyard.json');
  try {
    await fs.access(storePath);
  } catch {
    try {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.copyFile(oldPath, storePath);
    } catch {}
  }
  const store = await loadStore();
  let changed = false;
  for (const key of ['overrides', 'names', 'nameFail']) {
    for (const id of Object.keys(store[key])) {
      if (!id.startsWith('dir:')) continue;
      const next = 'path:' + path.join(HOME, 'Claude', id.slice(4));
      if (!(next in store[key])) store[key][next] = store[key][id];
      delete store[key][id];
      changed = true;
    }
  }
  if (changed) await saveStore(store);
}

// ---------- graves ----------
const tilde = (p) => (p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);

async function getGraves() {
  const store = await loadStore();
  const projects = await findProjects(store.ui.roots || []);
  const now = Date.now();

  let alive = 0;
  let hidden = 0;
  const graves = [];

  for (const p of projects) {
    const id = 'path:' + p.path;
    const o = store.overrides[id] || {};
    if (o.hidden) { hidden++; continue; }
    if (now - p.last < DEAD_AFTER_DAYS * DAY) { alive++; continue; }
    graves.push({
      id,
      auto: true,
      path: p.path,
      folder: tilde(p.path),
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
  return { graves, alive, hidden, found: projects.length, deadAfterDays: DEAD_AFTER_DAYS };
}

// ---------- human names from Claude ----------
// Uses the local `claude` command (the user's own Claude Code login), no API key in the app.
const NAME_PROMPT =
  'Ниже заметки и переписка о заброшенном вайбкодерском проекте. ' +
  'Придумай для него короткое человеческое название на русском, как будто так его зовут друзья: ' +
  'максимум 3 слова, без кавычек и точки, не повторяй техническое имя папки. Ответь только названием.';
// Apps opened from Finder don't get the shell's PATH, so look in the usual places too.
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local/bin'), path.join(HOME, '.npm-global/bin'), path.join(HOME, '.bun/bin')];
const CLAUDE_BINS = [...EXTRA_PATH.map((d) => path.join(d, 'claude')), path.join(HOME, '.claude/local/claude')];
let naming = false;
let claudeBin;

async function findClaude() {
  if (claudeBin !== undefined) return claudeBin;
  for (const p of CLAUDE_BINS) {
    try {
      await fs.access(p, FS.X_OK);
      return (claudeBin = p);
    } catch {}
  }
  // last resort: ask the user's login shell
  claudeBin = await new Promise((resolve) => {
    execFile('/bin/zsh', ['-lc', 'command -v claude'], { timeout: 5000 }, (err, out) => {
      const p = String(out || '').trim().split('\n').pop();
      resolve(!err && p.startsWith('/') ? p : null);
    });
  });
  return claudeBin;
}

function askClaude(bin, input) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: [process.env.PATH, ...EXTRA_PATH].filter(Boolean).join(':') };
    const child = spawn(bin, ['-p', '--model', 'haiku', NAME_PROMPT], { cwd: os.tmpdir(), env });
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
        const name = cleanName(await askClaude(bin, await projectContext(g.path)));
        if (!name || /not logged|login|authenticat/i.test(name)) throw new Error('no usable name');
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
    const auto = store.names[id] ? store.names[id].name : path.basename(id.replace(/^path:/, ''));
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

async function addProjectsFolder() {
  const r = await dialog.showOpenDialog({
    title: 'Папка, где лежат твои проекты',
    buttonLabel: 'Выбрать',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return;
  const store = await loadStore();
  store.ui.roots = [...new Set([...(store.ui.roots || []), r.filePaths[0]])];
  await saveStore(store);
  refreshAll();
}

function updateTray() {
  if (!tray) return;
  const items = [
    { label: collapsed ? 'Развернуть' : 'Свернуть', accelerator: 'CommandOrControl+Alt+G', click: () => setCollapsed(!collapsed) },
    { label: 'Похоронить проект…', click: () => { setCollapsed(false); win && win.webContents.send('open-add'); } },
    { label: 'Добавить папку с проектами…', click: () => addProjectsFolder() },
    { label: 'Обновить', click: () => refreshAll() },
    { label: 'Вернуть скрытые', click: async () => { await unhideAll(); refreshAll(); } },
    { type: 'separator' },
  ];
  if (app.isPackaged) {
    items.push({
      label: 'Запускать при входе',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    });
  }
  items.push({ label: 'Выйти', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
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
  await migrateStore();
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
      await later(4000);
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

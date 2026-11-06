// Finds a user's vibe-coding projects by reading Claude Code's local history.
//
// Claude Code writes every chat to ~/.claude/projects/<encoded-folder>/<session>.jsonl and each
// line records the working folder ("cwd") and a timestamp. From that we learn which folders the
// user worked in and when. Some people start Claude from one big folder full of projects
// (e.g. ~/Claude), so such "container" folders are opened up and each subfolder becomes a project.

const path = require('path');
const fs = require('fs/promises');
const os = require('os');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');

// Folders that change on their own and say nothing about real work.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'target',
  '.venv', 'venv', '__pycache__', '.cache', '.turbo', '.vercel', '.claude',
]);
// Finder touches .DS_Store just by opening a folder.
const SKIP_FILES = new Set(['.DS_Store']);
// A folder holding one of these is a project root.
const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Package.swift', 'CLAUDE.md'];
// Never treat these as a project or as a folder of projects.
const NOT_PROJECTS = new Set(
  ['', 'Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public', 'Applications']
    .map((d) => path.join(HOME, d)),
);

const isUnder = (p, dir) => p === dir || p.startsWith(dir + path.sep);

function ignoredPath(p) {
  if (!isUnder(p, HOME) || NOT_PROJECTS.has(p)) return true;
  if (isUnder(p, path.join(HOME, 'Library'))) return true;
  // anything inside a hidden folder (.claude, .cache, worktrees under dot-folders...)
  return path.relative(HOME, p).split(path.sep).some((seg) => seg.startsWith('.'));
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function hasMarker(dir) {
  for (const m of MARKERS) if (await exists(path.join(dir, m))) return true;
  return false;
}

// ---------- reading Claude history ----------
// Cache per log file so hourly refreshes only re-read files that changed.
const logCache = new Map();
const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;
const TS_RE = /"timestamp":"([^"]+)"/;

async function listLogs() {
  const files = [];
  let dirs = [];
  try {
    dirs = await fs.readdir(CLAUDE_DIR, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(CLAUDE_DIR, d.name);
    let entries = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of entries) if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
  }
  return files;
}

async function readLog(file) {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return null;
  }
  const cached = logCache.get(file);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached;

  const cwds = new Map(); // cwd -> { first, last }
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const c = CWD_RE.exec(line);
    if (!c) continue;
    const t = TS_RE.exec(line);
    const ts = t ? Date.parse(t[1]) : NaN;
    if (!Number.isFinite(ts)) continue;
    let cwd;
    try {
      cwd = JSON.parse(`"${c[1]}"`);
    } catch {
      continue;
    }
    const r = cwds.get(cwd);
    if (!r) cwds.set(cwd, { first: ts, last: ts });
    else {
      if (ts < r.first) r.first = ts;
      if (ts > r.last) r.last = ts;
    }
  }
  const entry = { mtime: st.mtimeMs, size: st.size, cwds };
  logCache.set(file, entry);
  return entry;
}

// All working folders from Claude history with first/last activity.
async function claudeActivity() {
  const all = new Map();
  for (const file of await listLogs()) {
    const log = await readLog(file);
    if (!log) continue;
    for (const [cwd, r] of log.cwds) {
      const a = all.get(cwd);
      if (!a) all.set(cwd, { ...r, files: new Set([file]) });
      else {
        a.first = Math.min(a.first, r.first);
        a.last = Math.max(a.last, r.last);
        a.files.add(file);
      }
    }
  }
  return all;
}

// ---------- file activity ----------
async function walk(dir, acc, depth = 0) {
  if (depth > 12) return;
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
      if (!SKIP_DIRS.has(e.name)) await walk(p, acc, depth + 1);
    } else if (e.isFile() && !SKIP_FILES.has(e.name)) {
      try {
        const st = await fs.stat(p);
        acc.files++;
        if (st.mtimeMs > acc.last) acc.last = st.mtimeMs;
      } catch {
        // file vanished mid-scan
      }
    }
  }
}

async function fileActivity(dir) {
  const acc = { files: 0, last: 0 };
  await walk(dir, acc);
  let born = Infinity;
  try {
    const st = await fs.stat(dir);
    if (st.birthtimeMs > 0) born = st.birthtimeMs;
  } catch {}
  return { files: acc.files, last: acc.last, born };
}

// ---------- putting it together ----------
// Folder that holds several projects: picked by the user, or a Claude working folder that is
// itself not a project but has project-looking subfolders, or one that Claude visited
// through two or more of its subfolders.
async function insideProject(dir) {
  for (let p = dir; isUnder(p, HOME) && p !== HOME; p = path.dirname(p)) {
    if (await hasMarker(p)) return true;
  }
  return false;
}

async function findContainers(cwds, extraRoots) {
  const containers = new Set();
  for (const r of extraRoots) if (await isDir(r)) containers.add(r);

  // shallowest first, so a folder inside a container is never a container itself
  const sorted = [...new Set(cwds)].sort((a, b) => a.length - b.length);
  for (const c of sorted) {
    if (ignoredPath(c) || containers.has(c) || !(await isDir(c))) continue;
    if ([...containers].some((k) => isUnder(c, k))) continue;
    if (await insideProject(c)) continue;
    // distinct direct children Claude visited (directly or deeper)
    const kids = new Set();
    for (const other of cwds) {
      if (other !== c && isUnder(other, c)) kids.add(path.relative(c, other).split(path.sep)[0]);
    }
    if (kids.size >= 2) { containers.add(c); continue; }
    let projectKids = 0;
    try {
      for (const e of await fs.readdir(c, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.') && await hasMarker(path.join(c, e.name))) projectKids++;
        if (projectKids >= 2) break;
      }
    } catch {}
    if (projectKids >= 2) containers.add(c);
  }
  return containers;
}

// Which project a working folder belongs to.
async function projectRootFor(cwd, containers) {
  for (const c of containers) {
    if (cwd !== c && isUnder(cwd, c)) return path.join(c, path.relative(c, cwd).split(path.sep)[0]);
  }
  if (containers.has(cwd)) return null;
  // outermost folder upwards that looks like a project root (repo root beats its app/ subfolder)
  let root = null;
  for (let p = cwd; isUnder(p, HOME) && p !== HOME && !NOT_PROJECTS.has(p); p = path.dirname(p)) {
    if (await hasMarker(p)) root = p;
  }
  return root || cwd;
}

/**
 * Returns [{ path, name, born, last }] for every project found.
 * `extraRoots` are folders the user added by hand; each subfolder there is a project.
 */
async function findProjects(extraRoots = []) {
  const activity = await claudeActivity();
  const cwds = [...activity.keys()].filter((c) => !ignoredPath(c));
  const containers = await findContainers(cwds, extraRoots);

  const projects = new Map(); // root -> { first, last }
  const touch = (root, first, last) => {
    const p = projects.get(root);
    if (!p) projects.set(root, { first, last });
    else {
      p.first = Math.min(p.first, first);
      p.last = Math.max(p.last, last);
    }
  };

  for (const c of cwds) {
    if (!(await isDir(c))) continue;
    const root = await projectRootFor(c, containers);
    if (!root || ignoredPath(root)) continue;
    const a = activity.get(c);
    touch(root, a.first, a.last);
  }
  // Every subfolder of a container is a candidate, even if Claude never opened it directly.
  for (const c of containers) {
    try {
      for (const e of await fs.readdir(c, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.')) touch(path.join(c, e.name), Infinity, 0);
      }
    } catch {}
  }

  const out = [];
  for (const [root, a] of projects) {
    if (!(await isDir(root))) continue;
    const f = await fileActivity(root);
    if (f.files === 0) continue;
    const last = Math.max(f.last, a.last);
    const born = Math.min(f.born, a.first, last);
    out.push({ path: root, name: path.basename(root), born, last });
  }
  return out;
}

// ---------- context for naming ----------
async function readHead(file, max) {
  try {
    return (await fs.readFile(file, 'utf8')).slice(0, max);
  } catch {
    return '';
  }
}

function userTexts(jsonl, limit, keep) {
  const out = [];
  for (const line of jsonl.split('\n')) {
    if (out.length >= limit) break;
    if (!line.includes('"type":"user"') || !keep(line)) continue;
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

async function projectContext(projectPath) {
  const name = path.basename(projectPath);
  const parts = [`Папка: ${name}`];
  for (const f of ['CLAUDE.md', 'README.md']) {
    const t = await readHead(path.join(projectPath, f), 1200);
    if (t) parts.push(`${f}:\n${t}`);
  }
  try {
    const pkg = JSON.parse(await readHead(path.join(projectPath, 'package.json'), 20000));
    if (pkg.description) parts.push(`Описание: ${pkg.description}`);
  } catch {}

  let dirs = [];
  try {
    dirs = await fs.readdir(CLAUDE_DIR, { withFileTypes: true });
  } catch {}

  // Claude's memory notes that mention this project
  const needle = [projectPath, `/${name}`];
  let notes = 0;
  for (const d of dirs) {
    if (!d.isDirectory() || notes >= 3) continue;
    const mem = path.join(CLAUDE_DIR, d.name, 'memory');
    let files = [];
    try {
      files = await fs.readdir(mem);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.md') || f === 'MEMORY.md' || notes >= 3) continue;
      const t = await readHead(path.join(mem, f), 4000);
      if (needle.some((n) => t.includes(n))) {
        parts.push(`Заметка:\n${t.slice(0, 1200)}`);
        notes++;
      }
    }
  }

  // The user's own requests from chats about this project
  const chats = [];
  const activity = await claudeActivity();
  const own = new Set();
  for (const [cwd, a] of activity) if (isUnder(cwd, projectPath)) a.files.forEach((f) => own.add(f));
  for (const file of own) {
    if (chats.length >= 6) break;
    chats.push(...userTexts(await readHead(file, 5_000_000), 3, () => true));
  }
  if (chats.length < 3) {
    for (const file of await listLogs()) {
      if (chats.length >= 6) break;
      if (own.has(file)) continue;
      const t = await readHead(file, 5_000_000);
      if (t.includes(projectPath)) chats.push(...userTexts(t, 3, (l) => l.includes(name)));
    }
  }
  if (chats.length) parts.push('Из переписки:\n' + chats.slice(0, 6).join('\n'));

  return parts.join('\n\n').slice(0, 6000);
}

module.exports = { findProjects, projectContext, CLAUDE_DIR };

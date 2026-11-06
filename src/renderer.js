const DAY = 24 * 60 * 60 * 1000;
const CAUSES = [
  'Потерял интерес',
  'Придумал новый проект',
  'Застрял на деплое',
  'Ждал API-ключ',
  'Работало только у меня',
  'Не хватило времени',
];

const api = window.graveyard;
const $ = (id) => document.getElementById(id);

// ---------- palette (Claude-ish sunrise) ----------
const C = {
  sky: ['#f1eadf', '#eed9c4', '#ebbf9f', '#e39e7c', '#d97757'],
  sun: '#f6e7d3',
  hill: '#4a3a33',
  soil: '#2b2320',
  soilDot: '#362c28',
  ink: '#141413',
  outline: '#1f1a17',
  stone: '#e6ddcf',
  stoneLight: '#f4efe6',
  stoneShade: '#c7bba8',
  stoneBase: '#b9ac98',
  mound: '#3f322c',
  orange: '#d97757',
  orangeLight: '#f2b08f',
  orangeDark: '#8a3f27',
  bone: '#efe7da',
  steel: '#8d8a86',
  steelDark: '#5c5955',
  bsod: '#2a5bd7',
  white: '#ffffff',
};

// ---------- layout in art pixels (scaled x3 on screen) ----------
const SCALE = 3;
const ART_W = 108;
const ART_H = 90;
const HORIZON = 25;
const GROUND = 30;
const PER_PAGE = 3;
const COL_W = 36;
const STONE_W = 28;
const STONE_H = 36;
const STONE_TOP = 44;

let graves = [];
let lastData = null;
let page = 0;
let current = null;
let collapsed = false;

// ---------- helpers ----------
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const days = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;
const fmt = (ms) => new Date(ms).toLocaleDateString('ru-RU');
const fmtShort = (ms) => new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
const lived = (g) => Math.max(1, Math.round((g.died - g.born) / DAY) + 1);
const restingFor = (g) => Math.max(0, Math.floor((Date.now() - g.died) / DAY));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function place(node, x, y) {
  node.style.left = x * SCALE + 'px';
  node.style.top = y * SCALE + 'px';
  return node;
}

// Small deterministic random so the ground texture never flickers between redraws.
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

// ---------- pixel drawing ----------
function px(ctx, color, x, y, w = 1, h = 1) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

// Draw a sprite from text rows; `colors` maps characters to colors, anything else is empty.
function sprite(ctx, rows, x, y, colors) {
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const c = colors[row[dx]];
      if (c) px(ctx, c, x + dx, y + dy);
    }
  });
}

// Tombstone mask: rounded arch on top, straight body below.
function archMask(w, h) {
  const R = w / 2;
  return (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    if (y < R) {
      const dx = x + 0.5 - R;
      const dy = R - (y + 0.5);
      return dx * dx + dy * dy <= R * R;
    }
    return true;
  };
}

// Logo: black tombstone with an orange spark on it.
function drawLogo() {
  const ctx = $('logoArt').getContext('2d');
  const inside = archMask(11, 13);
  for (let y = 0; y < 13; y++) for (let x = 0; x < 11; x++) if (inside(x, y)) px(ctx, C.ink, x, y);
  sprite(ctx, [
    '...#...',
    '.#.#.#.',
    '..###..',
    '#######',
    '..###..',
    '.#.#.#.',
    '...#...',
  ], 2, 4, { '#': C.orange });
}

function drawSky(ctx) {
  // Horizontal bands with a dithered seam between neighbours.
  const bands = [0, 6, 11, 16, 20, HORIZON + 1];
  for (let i = 0; i < C.sky.length; i++) {
    px(ctx, C.sky[i], 0, bands[i], ART_W, bands[i + 1] - bands[i]);
    if (i > 0) {
      for (let x = 0; x < ART_W; x++) {
        if (x % 2 === 0) px(ctx, C.sky[i - 1], x, bands[i]);
        if (x % 4 === 1) px(ctx, C.sky[i - 1], x, bands[i] + 1);
      }
    }
  }
  // Sun sitting on the horizon
  const cx = 82, cy = HORIZON, r = 7;
  for (let y = cy - r; y <= cy; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r + 2) px(ctx, C.sun, x, y);
    }
  }
  // Thin pixel clouds
  px(ctx, C.sky[0], 8, 13, 22, 1);
  px(ctx, C.sky[0], 14, 14, 16, 1);
  px(ctx, C.sky[1], 40, 8, 18, 1);
  px(ctx, C.sky[1], 44, 9, 10, 1);
  px(ctx, C.sky[1], 88, 18, 14, 1);
}

function drawHill(ctx) {
  for (let x = 0; x < ART_W; x++) {
    const top = HORIZON - 1 + Math.round(1.4 * Math.sin(x / 9) + 1 * Math.sin(x / 4 + 1));
    px(ctx, C.hill, x, top, 1, GROUND + 1 - top);
  }
  // distant crosses
  for (const x of [22, 31, 47, 58, 68, 97]) {
    px(ctx, C.soil, x, 19, 1, 5);
    px(ctx, C.soil, x - 1, 20, 3, 1);
  }
  // bare trees at the edges
  const tree = (x, flip) => {
    const f = flip ? -1 : 1;
    px(ctx, C.soil, x, 10, 1, 17);
    px(ctx, C.soil, x + f, 17); px(ctx, C.soil, x + 2 * f, 16); px(ctx, C.soil, x + 3 * f, 15);
    px(ctx, C.soil, x - f, 14); px(ctx, C.soil, x - 2 * f, 13); px(ctx, C.soil, x - 2 * f, 12);
    px(ctx, C.soil, x + f, 10); px(ctx, C.soil, x + 2 * f, 9);
    px(ctx, C.soil, x - f, 20); px(ctx, C.soil, x - 2 * f, 19);
  };
  tree(5, false);
  tree(103, true);
}

function drawGround(ctx) {
  px(ctx, C.soil, 0, GROUND, ART_W, ART_H - GROUND);
  const r = rng(7);
  for (let i = 0; i < 160; i++) {
    px(ctx, C.soilDot, Math.floor(r() * ART_W), GROUND + 1 + Math.floor(r() * (ART_H - GROUND - 1)));
  }
}

const inStone = archMask(STONE_W, STONE_H);

function drawStone(ctx, ox, oy) {
  // mound
  px(ctx, C.mound, ox - 3, oy + STONE_H - 1, STONE_W + 6, 2);
  px(ctx, C.mound, ox - 1, oy + STONE_H + 1, STONE_W + 2, 1);
  for (let y = 0; y < STONE_H; y++) {
    for (let x = 0; x < STONE_W; x++) {
      if (!inStone(x, y)) continue;
      const edge = !inStone(x - 1, y) || !inStone(x + 1, y) || !inStone(x, y - 1) || !inStone(x, y + 1);
      let c = C.stone;
      if (edge) c = C.outline;
      else if (!inStone(x - 2, y)) c = C.stoneLight;
      else if (!inStone(x + 2, y) || !inStone(x + 3, y)) c = C.stoneShade;
      else if (y >= STONE_H - 3) c = C.stoneBase;
      px(ctx, c, ox + x, oy + y);
    }
  }
  // small carved cross
  px(ctx, C.ink, ox + 13, oy + 3, 2, 6);
  px(ctx, C.ink, ox + 11, oy + 5, 6, 2);
}

// ---------- food and the crabs that eat it ----------
// Each food is a sprite; it gets eaten from the top down, then the next one is served.
const SPINE = ['.', '.', '#', '.', '.'];
function joinCols(...parts) {
  return parts[0].map((_, row) => parts.map((p) => p[row]).join(''));
}
const FOODS = [
  {
    // skeleton made of curly braces: skull { } { } legs
    rows: joinCols(
      ['.##.', '#.##', '####', '.#.#', '....'],
      SPINE, ['.##', '.#.', '##.', '.#.', '.##'],
      SPINE, ['##.', '.#.', '.##', '.#.', '##.'],
      SPINE, ['.##', '.#.', '##.', '.#.', '.##'],
      SPINE, ['##.', '.#.', '.##', '.#.', '##.'],
      SPINE, ['....', '....', '###.', '#..#', '#..#'],
    ),
    colors: { '#': C.bone },
    crumb: C.bone,
  },
  {
    // pile of tokens
    rows: [
      '.....bbb.....',
      '.....aaa.....',
      '...bbbdbbb...',
      '...aaadaaa...',
      '.bbbdbbbdbbb.',
      '.aaadaaadaaa.',
    ],
    colors: { a: C.orange, b: C.orangeLight, d: C.orangeDark },
    crumb: C.orangeLight,
  },
  {
    // laptop with a blue screen of death
    rows: [
      '.ggggggggggg.',
      '.guuuuuuuuug.',
      '.guwuuwuuuug.',
      '.guuuwuuuuug.',
      '.guwuuwuuuug.',
      '.guuuuuuuuug.',
      '.guwwwwwuuug.',
      '.ggggggggggg.',
      'kkkkkkkkkkkkk',
    ],
    colors: { g: C.steel, u: C.bsod, w: C.white, k: C.steelDark },
    crumb: C.steel,
  },
];
const FOOD_BOTTOM = 41;
const FOOD_HP = 90;
const CRAB_W = 11;
const CRAB_BODY = [
  '..#######..',
  '..#e###e#..',
  '###########',
  '..#######..',
];
const CRAB_LEGS = ['..#.#.#.#..', '...#.#.#.#.'];
const CRAB_ARMS_UP = '#.#######.#';

const MAX_FOODS = 3;
let foodIndex = 0;
let foods = [];
let foodPause = 0;

// Put the next dish from the menu at art x (centred there), or in the middle of the field.
function serveFood(atX) {
  const f = FOODS[foodIndex % FOODS.length];
  foodIndex++;
  const w = f.rows[0].length;
  const cx = atX == null ? ART_W / 2 : atX;
  const x = Math.max(2, Math.min(ART_W - w - 2, Math.round(cx - w / 2)));
  const food = { ...f, w, x, y: FOOD_BOTTOM - f.rows.length + 1, hp: FOOD_HP };
  food.spots = [x - CRAB_W + 2, x + w - 2];
  foods.push(food);
  if (foods.length > MAX_FOODS) foods.shift();
  return food;
}
serveFood();

const crabs = [
  { x: 4, lane: 33 },
  { x: 90, lane: 35 },
  { x: 70, lane: 33 },
].map((c) => ({ ...c, state: 'idle', timer: 6, target: c.x, food: null, frame: 0 }));
const crumbs = [];

const taken = (crab, x) => crabs.some((o) => o !== crab && o.target === x && o.food);

// Head for a free seat at the nearest dish (or the given one); otherwise just wander.
function pickTarget(crab, hungry = false, only = null) {
  const seats = [];
  for (const f of only ? [only] : foods) {
    for (const x of f.spots) if (!taken(crab, x)) seats.push({ x, food: f });
  }
  if (seats.length && (hungry || Math.random() < 0.65)) {
    seats.sort((a, b) => Math.abs(a.x - crab.x) - Math.abs(b.x - crab.x));
    return seats[0];
  }
  return { x: rand(0, ART_W - CRAB_W), food: null };
}

function goTo(crab, t) {
  crab.state = 'walk';
  crab.target = t.x;
  crab.food = t.food;
}

function stepCrab(crab) {
  crab.frame++;
  const food = crab.food && foods.includes(crab.food) ? crab.food : null;
  if (crab.state === 'walk') {
    if (crab.food && !food) { goTo(crab, pickTarget(crab)); return; }
    if (crab.x === crab.target) {
      crab.state = food ? 'eat' : 'idle';
      crab.timer = food ? rand(40, 90) : rand(8, 30);
    } else if (crab.frame % 2 === 0) {
      crab.x += Math.sign(crab.target - crab.x);
    }
    return;
  }
  if (crab.state === 'eat') {
    if (!food) {
      crab.timer = 0;
    } else if (crab.frame % 3 === 0 && Math.random() < 0.5) {
      const fromLeft = crab.x < food.x;
      crumbs.push({
        x: fromLeft ? food.x + 1 : food.x + food.w - 2,
        y: food.y + Math.floor((1 - food.hp / FOOD_HP) * food.rows.length),
        vx: fromLeft ? -1 : 1,
        vy: -2,
        life: 6,
        color: food.crumb,
      });
      food.hp--;
    }
  }
  if (--crab.timer <= 0) goTo(crab, pickTarget(crab));
}

// Click on the field: drop a dish there and call everyone who isn't busy eating.
function feedAt(artX) {
  const food = serveFood(artX);
  const free = crabs.filter((c) => c.state !== 'eat')
    .sort((a, b) => Math.abs(a.x - artX) - Math.abs(b.x - artX));
  for (const c of free) {
    const t = pickTarget(c, true, food);
    if (t.food) goTo(c, t);
  }
}

function drawCrab(ctx, crab) {
  const chewing = crab.state === 'eat' && crab.frame % 4 < 2;
  const y = crab.lane + (chewing ? 1 : 0);
  const body = CRAB_BODY.slice();
  if (chewing) body[2] = CRAB_ARMS_UP;
  sprite(ctx, body, crab.x, y, { '#': C.orange, e: C.ink });
  const legs = crab.state === 'walk' ? CRAB_LEGS[Math.floor(crab.frame / 2) % 2] : CRAB_LEGS[0];
  sprite(ctx, [legs], crab.x, y + 4, { '#': C.orange });
}

function tickFx() {
  if (collapsed) return;
  const ctx = $('fx').getContext('2d');
  ctx.clearRect(0, 0, ART_W, ART_H);

  foods = foods.filter((f) => f.hp > 0);
  if (!foods.length) {
    if (foodPause <= 0) foodPause = 40; // ~5 s of wandering before the next course
    else if (--foodPause <= 0) serveFood();
  }

  for (const f of foods) {
    // eaten from the top down
    const gone = Math.floor((1 - f.hp / FOOD_HP) * f.rows.length);
    sprite(ctx, f.rows.slice(gone), f.x, f.y + gone, f.colors);
  }

  crabs.forEach(stepCrab);
  // farther lane first so nearer crabs overlap
  [...crabs].sort((a, b) => a.lane - b.lane).forEach((c) => drawCrab(ctx, c));

  for (let i = crumbs.length - 1; i >= 0; i--) {
    const b = crumbs[i];
    b.x += b.vx;
    b.y += b.vy;
    b.vy += 1;
    if (--b.life <= 0) { crumbs.splice(i, 1); continue; }
    px(ctx, b.color, b.x, b.y);
  }
}

// ---------- render ----------
function render(data) {
  lastData = data;
  graves = data.graves;
  const pages = Math.max(1, Math.ceil(graves.length / PER_PAGE));
  if (page >= pages) page = pages - 1;
  if (page < 0) page = 0;
  const shown = graves.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

  $('title').title = `${graves.length} ${plural(graves.length, 'покоится', 'покоятся', 'покоятся')} · ` +
    `${data.alive} ${plural(data.alive, 'живой', 'живых', 'живых')}`;

  $('pager').classList.toggle('on', pages > 1);
  $('pageNum').textContent = `${page + 1}/${pages}`;
  $('prevBtn').disabled = page === 0;
  $('nextBtn').disabled = page >= pages - 1;

  const ctx = $('art').getContext('2d');
  ctx.clearRect(0, 0, ART_W, ART_H);
  drawSky(ctx);
  drawHill(ctx);
  drawGround(ctx);

  const labels = $('labels');
  labels.replaceChildren();

  if (!graves.length) {
    labels.append(place(el('div', 'name', 'Все живы. Пока.'), 0, 60));
    labels.lastChild.style.width = '324px';
    return;
  }

  shown.forEach((g, col) => {
    const x = col * COL_W + (COL_W - STONE_W) / 2;
    const y = STONE_TOP;
    drawStone(ctx, x, y);

    const d = el('div', 'days');
    d.append(el('b', null, String(lived(g))), el('small', null, 'дн'));
    labels.append(place(d, x + 2, y + 10));

    labels.append(place(el('div', 'face', `${fmtShort(g.born)} —\n${fmtShort(g.died)}`), x + 2, y + 21));

    const note = g.epitaph ? `«${g.epitaph}»` : g.cause;
    if (note) {
      const n = place(el('div', 'face cause', note), x + 2, y + 29);
      n.title = note;
      labels.append(n);
    }

    labels.append(place(el('div', 'name', g.name), col * COL_W, y + STONE_H + 2));

    const hit = place(el('button', 'hit'), col * COL_W, y - 1);
    hit.style.height = (STONE_H + 11) * SCALE + 'px';
    hit.title = `${g.name}\nпрожил ${days(lived(g))}, покоится ${days(restingFor(g))}` +
      (g.epitaph ? `\n«${g.epitaph}»` : '') + (g.cause ? `\n${g.cause}` : '');
    hit.addEventListener('click', () => openEdit(g));
    labels.append(hit);
  });
}

async function refresh() {
  render(await api.get());
}

// ---------- collapse / expand ----------
function setCollapsed(value) {
  collapsed = value;
  document.body.classList.toggle('collapsed', collapsed);
  if (collapsed) for (const d of document.querySelectorAll('dialog[open]')) d.close('cancel');
}
api.onState((s) => setCollapsed(s === 'collapsed'));
// The tombstone: click folds/unfolds, drag moves the widget around the screen.
const logo = $('logo');
let drag = null;
let justDragged = false;
logo.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag = { sx: e.screenX, sy: e.screenY, moved: false };
  logo.setPointerCapture(e.pointerId);
  api.dragStart();
});
logo.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.sx;
  const dy = e.screenY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return; // small jitter is still a click
  drag.moved = true;
  logo.classList.add('dragging');
  api.dragMove(dx, dy);
});
logo.addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.moved) {
    justDragged = true;
    api.dragEnd();
  }
  drag = null;
  logo.classList.remove('dragging');
});
logo.addEventListener('click', () => {
  if (justDragged) { justDragged = false; return; }
  api.toggle();
});
// While collapsed the window ignores clicks; hovering the logo lets them through again.
logo.addEventListener('mouseenter', () => api.capture(true));
logo.addEventListener('mouseleave', () => { if (!drag) api.capture(false); });
$('closeBtn').addEventListener('click', () => api.toggle());
$('feeder').addEventListener('click', (e) => {
  const r = $('scene').getBoundingClientRect();
  feedAt(Math.floor((e.clientX - r.left) / SCALE));
});

// ---------- dialogs ----------
function fillCauses(select, value) {
  select.replaceChildren(el('option', null, '— не указана —'));
  select.firstChild.value = '';
  for (const c of CAUSES) {
    const o = el('option', null, c);
    o.value = c;
    select.append(o);
  }
  if (value && !CAUSES.includes(value)) {
    const o = el('option', null, value);
    o.value = value;
    select.append(o);
  }
  select.value = value || '';
}

function openEdit(g) {
  current = g;
  const f = $('editForm');
  $('editMeta').textContent =
    (g.folder ? `Папка ${g.folder} · ` : '') +
    `${fmt(g.born)} — ${fmt(g.died)} · прожил ${days(lived(g))} · покоится ${days(restingFor(g))}`;
  f.name.value = g.name;
  f.epitaph.value = g.epitaph || '';
  fillCauses(f.cause, g.cause);
  $('dropBtn').textContent = g.auto ? 'Это не проект, убрать' : 'Выкопать';
  $('editDlg').returnValue = '';
  $('editDlg').showModal();
}

$('editDlg').addEventListener('close', async () => {
  if ($('editDlg').returnValue === 'save' && current) {
    const f = $('editForm');
    await api.update(current.id, {
      name: f.name.value.trim(),
      epitaph: f.epitaph.value.trim(),
      cause: f.cause.value,
    });
    await refresh();
  }
  current = null;
});

$('dropBtn').addEventListener('click', async () => {
  if (!current) return;
  if (current.auto) await api.hide(current.id);
  else await api.remove(current.id);
  $('editDlg').close('dropped');
  await refresh();
});

function openAdd() {
  const f = $('addForm');
  f.reset();
  f.born.value = new Date().toISOString().slice(0, 10);
  fillCauses(f.cause, '');
  $('addDlg').returnValue = '';
  $('addDlg').showModal();
}
$('addBtn').addEventListener('click', openAdd);
api.onOpenAdd(openAdd);
api.onCloseDialogs(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close('cancel')));

$('addDlg').addEventListener('close', async () => {
  if ($('addDlg').returnValue !== 'save') return;
  const f = $('addForm');
  await api.add({
    name: f.name.value.trim(),
    epitaph: f.epitaph.value.trim(),
    born: f.born.value,
    cause: f.cause.value,
  });
  page = 0;
  await refresh();
});

$('prevBtn').addEventListener('click', () => { page--; render(lastData); });
$('nextBtn').addEventListener('click', () => { page++; render(lastData); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || collapsed) return;
  if (document.querySelector('dialog[open]')) return;
  api.toggle();
});

api.onRefresh(refresh);

drawLogo();
refresh();
setInterval(refresh, 60 * 60 * 1000);

// Living layer: ~8 fps is enough for pixel art and easy on the battery.
setInterval(tickFx, 125);

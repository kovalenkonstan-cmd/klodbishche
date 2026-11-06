// Draws the app icon as 32x32 pixel art scaled to 1024x1024 and writes build/icon.png.
// No dependencies: a tiny PNG encoder on top of zlib.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 32;
const S = 32; // 32 * 32 = 1024
const grid = Array.from({ length: N }, () => Array(N).fill(null));
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < N && y < N) grid[y][x] = c; };

// Rounded square with stepped pixel corners, cells 3..28
const L = 3, R = 28, T = 3, B = 28;
const corner = [3, 2, 1]; // cells cut from each corner row
const inside = (x, y) => {
  if (x < L || x > R || y < T || y > B) return false;
  const dy = Math.min(y - T, B - y);
  if (dy < corner.length) {
    const cut = corner[dy];
    if (x < L + cut || x > R - cut) return false;
  }
  return true;
};

const sky = ['#f1eadf', '#eed9c4', '#ebbf9f', '#e39e7c', '#d97757'];
const bands = [3, 8, 12, 15, 18, 20];
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (!inside(x, y)) continue;
    let c = '#2b2320';
    if (y < 21) {
      let i = 0;
      while (i < sky.length - 1 && y >= bands[i + 1]) i++;
      c = sky[i];
      if (i > 0 && y === bands[i] && x % 2 === 0) c = sky[i - 1];
    }
    set(x, y, c);
  }
}
// sun on the horizon
for (let y = 15; y <= 20; y++) for (let x = 20; x <= 27; x++) {
  if ((x - 23.5) ** 2 + (y - 20.5) ** 2 <= 14 && inside(x, y)) set(x, y, '#f6e7d3');
}
// ground texture
for (const [x, y] of [[6, 24], [9, 27], [14, 26], [22, 25], [25, 27], [19, 27], [5, 26]]) set(x, y, '#362c28');

// black tombstone, 13 wide x 15 tall, standing on the ground
const TW = 13, TH = 15, TX = 9, TY = 8;
const RAD = TW / 2;
for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
  let ok = true;
  if (y < RAD) ok = (x + 0.5 - RAD) ** 2 + (RAD - (y + 0.5)) ** 2 <= RAD * RAD;
  if (ok) set(TX + x, TY + y, '#141413');
}
// mound
for (let x = TX - 2; x < TX + TW + 2; x++) set(x, TY + TH, '#3f322c');
for (let x = TX - 1; x < TX + TW + 1; x++) set(x, TY + TH + 1, '#3f322c');
// orange spark
const spark = [
  '...#...',
  '.#.#.#.',
  '..###..',
  '#######',
  '..###..',
  '.#.#.#.',
  '...#...',
];
spark.forEach((row, dy) => [...row].forEach((ch, dx) => ch === '#' && set(TX + 3 + dx, TY + 4 + dy, '#d97757')));

// encode
const W = N * S;
const raw = Buffer.alloc((W * 4 + 1) * W);
for (let py = 0; py < W; py++) {
  raw[py * (W * 4 + 1)] = 0;
  for (let px = 0; px < W; px++) {
    const c = grid[Math.floor(py / S)][Math.floor(px / S)];
    const rgba = c ? hex(c) : [0, 0, 0, 0];
    rgba.forEach((v, i) => { raw[py * (W * 4 + 1) + 1 + px * 4 + i] = v; });
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');

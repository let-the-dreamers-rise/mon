// Generates HALDEN: a 64x64 grid of 3 m cells (192 m square) — streets, Main Street shops,
// the Archive (office maze), St. Agnes Hospital, Halden Station, the park & cemetery, and the
// bridge gate. Packs walls/spawns/objectives the way Hollow.sol stores them and writes a
// richer description (tiles, buildings, props, lights) for the renderer.
// Usage: node tools/map/gen.mjs [seed] -> tools/map/hollow-map.json
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const G = 64;
const CELL = 300;
const seed = Number(process.argv[2] ?? 1337);
let st = seed >>> 0 || 1;
const rand = () => {
  st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0;
  return st / 0x100000000;
};
const ri = (n) => Math.floor(rand() * n);

// ---------------------------------------------------------------- tiles
// solid: # building, W interior wall, T tree, ~ water, F fence
// open:  . street, , sidewalk, a alley, p park, A archive, H hospital, S station, 0/1/2 shops, G gate
const T = Array.from({ length: G }, () => Array(G).fill('#'));
const SOLID = new Set(['#', 'W', 'T', '~', 'F']);
const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < G && y < G) T[y][x] = c; };
const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c); };
const get = (x, y) => (x < 0 || y < 0 || x >= G || y >= G ? '#' : T[y][x]);

// river along the east edge, fence along the others
rect(58, 0, 63, 63, '~');
for (let i = 0; i < G; i++) { set(0, i, 'F'); set(i, 0, 'F'); set(i, 63, 'F'); }

// streets: Main Street (rows 30-32) and the avenue (cols 30-32), secondary streets
const streets = [
  { x0: 1, y0: 30, x1: 57, y1: 32 }, // Main Street
  { x0: 30, y0: 1, x1: 32, y1: 62 }, // Halden Avenue
  { x0: 1, y0: 22, x1: 29, y1: 23 }, // Archive Row
  { x0: 33, y0: 22, x1: 57, y1: 23 }, // Hospital Row
  { x0: 1, y0: 40, x1: 29, y1: 41 }, // Station Road
  { x0: 33, y0: 40, x1: 57, y1: 41 }, // Cemetery Lane
  { x0: 22, y0: 1, x1: 23, y1: 62 }, // Mill Street
  { x0: 44, y0: 1, x1: 45, y1: 62 }, // Church Street
];
for (const s of streets) rect(s.x0, s.y0, s.x1, s.y1, '.');
// sidewalks: the outer rows/cols of the wide streets
for (let x = 1; x <= 57; x++) { set(x, 30, ','); set(x, 32, ','); }
for (let y = 1; y <= 62; y++) { if (get(30, y) === '.') set(30, y, ','); if (get(32, y) === '.') set(32, y, ','); }

// ---------------------------------------------------------------- landmarks
const landmarks = [];
// The Archive: an office maze (NW) — backrooms carved with a recursive backtracker
const AR = { name: 'THE ARCHIVE', x0: 2, y0: 2, x1: 20, y1: 20, floor: 'A', door: [11, 21] };
// St. Agnes Hospital (NE): corridors and wards
const HO = { name: 'ST. AGNES HOSPITAL', x0: 34, y0: 2, x1: 56, y1: 20, floor: 'H', door: [42, 21] };
// Halden Station (SW): pillared hall + platform
const STN = { name: 'HALDEN STATION', x0: 2, y0: 43, x1: 20, y1: 61, floor: 'S', door: [11, 42] };
landmarks.push(AR, HO, STN);

function carveMaze(L) {
  rect(L.x0, L.y0, L.x1, L.y1, 'W');
  const seen = new Set();
  const start = [L.x0 + 1, L.y0 + 1];
  const stack = [start];
  seen.add(start.join());
  set(...start, L.floor);
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const dirs = [[2, 0], [-2, 0], [0, 2], [0, -2]].filter(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      return nx > L.x0 && ny > L.y0 && nx < L.x1 && ny < L.y1 && !seen.has(`${nx},${ny}`);
    });
    if (!dirs.length) { stack.pop(); continue; }
    const [dx, dy] = dirs[ri(dirs.length)];
    set(x + dx / 2, y + dy / 2, L.floor);
    set(x + dx, y + dy, L.floor);
    seen.add(`${x + dx},${y + dy}`);
    stack.push([x + dx, y + dy]);
  }
  // loops and open office halls
  for (let i = 0; i < 70; i++) {
    const x = L.x0 + 1 + ri(L.x1 - L.x0 - 1), y = L.y0 + 1 + ri(L.y1 - L.y0 - 1);
    if (get(x, y) === 'W' && ((get(x - 1, y) === L.floor && get(x + 1, y) === L.floor) || (get(x, y - 1) === L.floor && get(x, y + 1) === L.floor))) set(x, y, L.floor);
  }
  for (let r = 0; r < 4; r++) {
    const w = 3 + ri(3), h = 3 + ri(3);
    const x0 = L.x0 + 1 + ri(L.x1 - L.x0 - w - 1), y0 = L.y0 + 1 + ri(L.y1 - L.y0 - h - 1);
    rect(x0, y0, x0 + w - 1, y0 + h - 1, L.floor);
  }
}
carveMaze(AR);

// hospital: a central corridor spine with wards off both sides
rect(HO.x0, HO.y0, HO.x1, HO.y1, 'W');
rect(HO.x0 + 1, 10, HO.x1 - 1, 12, 'H'); // main corridor
rect(42, 12, 43, HO.y1 - 1, 'H'); // corridor to the entrance
for (let x = HO.x0 + 1; x < HO.x1 - 2; x += 4) {
  rect(x, HO.y0 + 1, x + 2, 8, 'H'); // north ward
  set(x + 1, 9, 'H'); // ward door
  if (x + 2 < 41 || x > 44) {
    rect(x, 14, x + 2, HO.y1 - 1, 'H'); // south ward
    set(x + 1, 13, 'H');
  }
}
rect(HO.x1 - 3, HO.y0 + 1, HO.x1 - 1, 8, 'H');

// station: a pillared ticket hall and a long platform
rect(STN.x0, STN.y0, STN.x1, STN.y1, 'W');
rect(STN.x0 + 1, STN.y0 + 1, STN.x1 - 1, STN.y0 + 8, 'S'); // hall
for (let x = STN.x0 + 3; x < STN.x1 - 1; x += 4) for (let y = STN.y0 + 3; y < STN.y0 + 8; y += 4) set(x, y, 'W');
rect(STN.x0 + 8, STN.y0 + 9, STN.x0 + 10, STN.y0 + 11, 'S'); // stairs down
rect(STN.x0 + 1, STN.y0 + 12, STN.x1 - 1, STN.y0 + 16, 'S'); // platform
for (let x = STN.x0 + 2; x < STN.x1 - 1; x += 3) set(x, STN.y0 + 14, 'W'); // platform pillars
// doors onto the street
for (const L of landmarks) set(L.door[0], L.door[1], L.floor);
// thresholds: punch through each landmark's outer wall to its interior
set(11, 21, 'A'); set(11, 20, 'A'); set(11, 22, '.');
set(42, 21, 'H'); set(42, 20, 'H');
set(11, 42, 'S'); set(11, 43, 'S');

// ---------------------------------------------------------------- park & cemetery (SE)
rect(34, 43, 56, 61, 'p');
for (let i = 0; i < 46; i++) {
  const x = 35 + ri(21), y = 44 + ri(17);
  if (get(x, y) === 'p' && !(x >= 44 && x <= 45)) set(x, y, 'T');
}
// a path through the park
rect(34, 51, 56, 51, 'p');
rect(44, 43, 45, 61, 'p');

// ---------------------------------------------------------------- Main Street shops
const shops = [
  { name: '24/7 MART', x0: 14, y0: 26, x1: 18, y1: 29, floor: '0', door: [16, 29], counter: [16, 27] },
  { name: 'ST. AGNES PHARMACY', x0: 34, y0: 26, x1: 38, y1: 29, floor: '1', door: [36, 29], counter: [36, 27] },
  { name: 'KODA PHOTO', x0: 24, y0: 33, x1: 28, y1: 36, floor: '2', door: [26, 33], counter: [26, 35] },
];
for (const s of shops) {
  rect(s.x0, s.y0, s.x1, s.y1, 'W');
  rect(s.x0 + 1, s.y0 + 1, s.x1 - 1, s.y1 - 1, s.floor);
  set(...s.door, s.floor);
}

// alleys through the generic blocks
for (let i = 0; i < 18; i++) {
  const vertical = rand() < 0.5;
  const x = 2 + ri(55), y = 2 + ri(59);
  const len = 4 + ri(8);
  for (let k = 0; k < len; k++) {
    const cx = vertical ? x : x + k, cy = vertical ? y + k : y;
    if (get(cx, cy) === '#') set(cx, cy, 'a');
  }
}

// bridge gate at the east end of Main Street
rect(57, 30, 57, 32, 'G');
const gate = [57, 31];

// ---------------------------------------------------------------- connectivity
const open = (x, y) => !SOLID.has(get(x, y));
const bfs = (sx, sy) => {
  const d = Array.from({ length: G }, () => Array(G).fill(-1));
  const q = [[sx, sy]]; d[sy][sx] = 0;
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!open(nx, ny) || d[ny][nx] >= 0) continue;
      d[ny][nx] = d[y][x] + 1; q.push([nx, ny]);
    }
  }
  return d;
};
const d0 = bfs(31, 31);
// alleys that dead-end into nothing are fine; cells unreachable from Main Street become solid
for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (open(x, y) && d0[y][x] < 0) T[y][x] = get(x, y) === 'a' ? '#' : 'W';

// fuses: deepest reachable floor cell of each landmark
const deepest = (floor) => {
  let best = null, bd = -1;
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (T[y][x] === floor && d0[y][x] > bd) { bd = d0[y][x]; best = [x, y]; }
  return best;
};
const fuses = [deepest('A'), deepest('H'), deepest('S')];
for (const [x, y] of [...fuses, gate, ...shops.map((s) => s.counter)]) if (d0[y][x] < 0) throw new Error(`unreachable ${x},${y}`);

// spawns: 8 street cells spread around town
const streetCells = [];
for (let y = 1; y < G - 1; y++) for (let x = 1; x < G - 1; x++) if ((T[y][x] === '.' || T[y][x] === ',') && d0[y][x] >= 0) streetCells.push([x, y]);
const spawns = [];
const away = [gate, ...fuses];
while (spawns.length < 8) {
  let best = null, bd = -1;
  for (const c of streetCells) {
    const md = Math.min(...[...away, ...spawns].map(([x, y]) => Math.abs(x - c[0]) + Math.abs(y - c[1])));
    const centre = Math.abs(c[0] - 31) + Math.abs(c[1] - 31);
    const score = Math.min(md, 14) * 3 - centre * 0.6; // spread out, but near the middle of town
    if (score > bd) { bd = score; best = c; }
  }
  spawns.push(best);
}

// ---------------------------------------------------------------- render description
const buildings = [];
// generic blocks: flood-fill '#' regions into rectangles-ish (bounding boxes per connected region)
const seenB = new Set();
for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
  if (T[y][x] !== '#' || seenB.has(`${x},${y}`)) continue;
  // greedy rectangle
  let w = 0; while (x + w < G && T[y][x + w] === '#' && !seenB.has(`${x + w},${y}`)) w++;
  let h = 0;
  outer: while (y + h < G) {
    for (let k = 0; k < w; k++) if (T[y + h][x + k] !== '#' || seenB.has(`${x + k},${y + h}`)) break outer;
    h++;
  }
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) seenB.add(`${xx},${yy}`);
  buildings.push({ x, y, w, h, floors: 2 + ri(5), style: rand() < 0.55 ? 'brick' : 'concrete', litChance: 0.04 + rand() * 0.06 });
}

const props = [];
const lamps = [];
// street lamps every ~4 cells on sidewalks along streets, many dead
for (let y = 1; y < G - 1; y++) for (let x = 1; x < G - 1; x++) {
  const c = T[y][x];
  if ((c === ',' && (x + y) % 5 === 0) || (c === '.' && (x * 7 + y * 3) % 23 === 0 && (get(x + 1, y) === '#' || get(x - 1, y) === '#' || get(x, y + 1) === '#' || get(x, y - 1) === '#'))) {
    const r = rand();
    lamps.push({ cell: [x, y], state: r < 0.32 ? 'dead' : r < 0.5 ? 'flicker' : 'on' });
  }
}
// cars parked along streets, debris, hydrants, benches, headstones
for (let i = 0; i < 26; i++) {
  const c = streetCells[ri(streetCells.length)];
  if (T[c[1]][c[0]] !== '.' || spawns.some((s) => s[0] === c[0] && s[1] === c[1])) continue;
  props.push({ kind: 'car', cell: c, rot: (ri(4) * Math.PI) / 2 + (rand() - 0.5) * 0.4 });
}
for (let i = 0; i < 40; i++) {
  const c = streetCells[ri(streetCells.length)];
  props.push({ kind: ['hydrant', 'barrel', 'crate', 'boxes', 'cone'][ri(5)], cell: c, rot: rand() * Math.PI * 2 });
}
for (let y = 44; y < 61; y++) for (let x = 35; x < 56; x++) if (T[y][x] === 'p' && rand() < 0.18 && !(x >= 44 && x <= 45) && y !== 51) props.push({ kind: 'headstone', cell: [x, y], rot: (rand() - 0.5) * 0.3 });
for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
  if (T[y][x] === 'H' && rand() < 0.08) props.push({ kind: rand() < 0.5 ? 'bed' : 'wheelchair', cell: [x, y], rot: rand() * Math.PI * 2 });
  if (T[y][x] === 'A' && rand() < 0.05) props.push({ kind: 'boxes', cell: [x, y], rot: rand() * Math.PI * 2 });
}

const cm = ([x, y]) => [x * CELL + CELL / 2, y * CELL + CELL / 2];
const pack32 = ([x, y]) => BigInt(x) | (BigInt(y) << 16n);
const packList = (list) => list.reduce((acc, c, i) => acc | (pack32(cm(c)) << BigInt(32 * i)), 0n);
const words = Array(16).fill(0n);
for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
  if (!SOLID.has(T[y][x])) continue;
  const bit = y * G + x;
  words[bit >> 8] |= 1n << BigInt(bit & 255);
}
const hex = (v) => '0x' + v.toString(16).padStart(64, '0');

const out = {
  seed, grid: G, cellCm: CELL, name: 'HALDEN',
  walls: words.map(hex),
  spawns: hex(packList(spawns)),
  objectives: hex(packList([...fuses, gate, ...shops.map((s) => s.counter)])),
  spawnCells: spawns, fuseCells: fuses, exitCell: gate,
  fuseNames: ['THE ARCHIVE', 'ST. AGNES HOSPITAL', 'HALDEN STATION'],
  shops: shops.map(({ name, door, counter, x0, y0, x1, y1, floor }) => ({ name, door, counter, rect: [x0, y0, x1, y1], floor })),
  landmarks: landmarks.map(({ name, x0, y0, x1, y1, floor, door }) => ({ name, rect: [x0, y0, x1, y1], floor, door })),
  buildings, props, lamps,
  rows: T.map((r) => r.join('')),
};
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'hollow-map.json'), JSON.stringify(out));
console.log(T.map((r, y) => r.map((c, x) => {
  if (spawns.some((s) => s[0] === x && s[1] === y)) return '@';
  if (fuses.some((s) => s[0] === x && s[1] === y)) return '*';
  return c === '#' ? '█' : c === 'W' ? '▓' : c === '~' ? '≈' : c;
}).join('')).join('\n'));
console.log(`buildings ${buildings.length} · lamps ${lamps.length} · props ${props.length} · fuses ${JSON.stringify(fuses)} · gate ${gate}`);

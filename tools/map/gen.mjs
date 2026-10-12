// Generates the Archive: a 32x32 grid of 2.5m cells (maze corridors + open rooms),
// 8 spawn points, 3 fuses and an exit, packed the way Hollow.sol stores them.
// Usage: node tools/map/gen.mjs [seed]  -> writes tools/map/hollow-map.json
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GRID = 32;
const CELL = 250;
const seed = Number(process.argv[2] ?? 1337);

let state = seed >>> 0 || 1;
const rand = () => {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state / 0x100000000;
};
const ri = (n) => Math.floor(rand() * n);

const solid = Array.from({ length: GRID }, () => Array(GRID).fill(true));
const open = (x, y) => { if (x > 0 && y > 0 && x < GRID - 1 && y < GRID - 1) solid[y][x] = false; };

// 1. recursive-backtracker maze on odd coordinates
const nodes = [];
for (let y = 1; y < GRID - 1; y += 2) for (let x = 1; x < GRID - 1; x += 2) nodes.push([x, y]);
const seen = new Set();
const stack = [[1, 1]];
seen.add('1,1');
open(1, 1);
while (stack.length) {
  const [x, y] = stack[stack.length - 1];
  const dirs = [[2, 0], [-2, 0], [0, 2], [0, -2]].filter(([dx, dy]) => {
    const nx = x + dx, ny = y + dy;
    return nx > 0 && ny > 0 && nx < GRID - 1 && ny < GRID - 1 && !seen.has(`${nx},${ny}`);
  });
  if (!dirs.length) { stack.pop(); continue; }
  const [dx, dy] = dirs[ri(dirs.length)];
  open(x + dx / 2, y + dy / 2);
  open(x + dx, y + dy);
  seen.add(`${x + dx},${y + dy}`);
  stack.push([x + dx, y + dy]);
}

// 2. knock out extra walls for loops (so you can be cut off from either side)
for (let i = 0; i < 140; i++) {
  const x = 1 + ri(GRID - 2), y = 1 + ri(GRID - 2);
  const horiz = !solid[y][x - 1] && !solid[y][x + 1];
  const vert = y > 0 && y < GRID - 1 && !solid[y - 1][x] && !solid[y + 1][x];
  if (solid[y][x] && (horiz || vert)) open(x, y);
}

// 3. carve open rooms (the liminal office halls)
for (let r = 0; r < 9; r++) {
  const w = 3 + ri(4), h = 3 + ri(4);
  const x0 = 1 + ri(GRID - 2 - w), y0 = 1 + ri(GRID - 2 - h);
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) open(x, y);
  // leave a few pillars inside bigger rooms
  if (w >= 5 && h >= 5) { solid[y0 + 2][x0 + 2] = true; }
}

// BFS distances from the spawn corner
const bfs = (sx, sy) => {
  const d = Array.from({ length: GRID }, () => Array(GRID).fill(-1));
  const q = [[sx, sy]]; d[sy][sx] = 0;
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID || solid[ny][nx] || d[ny][nx] >= 0) continue;
      d[ny][nx] = d[y][x] + 1; q.push([nx, ny]);
    }
  }
  return d;
};

// spawns: 8 open cells spread around the map (souls wake up apart from each other)
const openCells = [];
for (let y = 1; y < GRID - 1; y++) for (let x = 1; x < GRID - 1; x++) if (!solid[y][x]) openCells.push([x, y]);
const d0 = bfs(1, 1);
// prune unreachable cells (shouldn't exist, but be safe)
for (const [x, y] of openCells) if (d0[y][x] < 0) solid[y][x] = true;
const reachable = openCells.filter(([x, y]) => d0[y][x] >= 0);

const farthestFrom = (pts, pool, count) => {
  const out = [...pts];
  const picked = [];
  while (picked.length < count) {
    let best = null, bestD = -1;
    for (const c of pool) {
      const md = Math.min(...out.map(([x, y]) => Math.abs(x - c[0]) + Math.abs(y - c[1])));
      if (md > bestD) { bestD = md; best = c; }
    }
    out.push(best); picked.push(best);
  }
  return picked;
};

// exit: the reachable border-adjacent cell farthest (by path) from the centre spawn ring
const centre = [16, 16];
const dc = bfs(...(reachable.reduce((b, c) => (Math.abs(c[0] - 16) + Math.abs(c[1] - 16) < Math.abs(b[0] - 16) + Math.abs(b[1] - 16) ? c : b))));
let exit = reachable[0];
for (const c of reachable) if (dc[c[1]][c[0]] > dc[exit[1]][exit[0]]) exit = c;
// fuses: far from each other and from the exit
const fuses = farthestFrom([exit, centre], reachable, 3);
// spawns: spread out, away from fuses and exit
const spawnCells = farthestFrom([exit, ...fuses], reachable, 8);

const cm = ([x, y]) => [x * CELL + CELL / 2, y * CELL + CELL / 2];
const pack32 = ([x, y]) => BigInt(x) | (BigInt(y) << 16n);
const packList = (list) => list.reduce((acc, c, i) => acc | (pack32(cm(c)) << BigInt(32 * i)), 0n);

const words = [0n, 0n, 0n, 0n];
for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
  if (!solid[y][x]) continue;
  const bit = y * GRID + x;
  words[bit >> 8] |= 1n << BigInt(bit & 255);
}
const hex = (v) => '0x' + v.toString(16).padStart(64, '0');

const out = {
  seed, grid: GRID, cellCm: CELL,
  walls: words.map(hex),
  spawns: hex(packList(spawnCells)),
  objectives: hex(packList([...fuses, exit])),
  spawnCells, fuseCells: fuses, exitCell: exit,
  rows: solid.map((r) => r.map((s) => (s ? '#' : '.')).join('')),
};
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'hollow-map.json'), JSON.stringify(out, null, 2));
const art = solid.map((r, y) => r.map((s, x) => {
  if (spawnCells.some((c) => c[0] === x && c[1] === y)) return 'S';
  if (fuses.some((c) => c[0] === x && c[1] === y)) return 'F';
  if (exit[0] === x && exit[1] === y) return 'E';
  return s ? '█' : ' ';
}).join('')).join('\n');
console.log(art);
console.log(`open cells: ${reachable.length}, exit ${exit}, fuses ${JSON.stringify(fuses)}`);

// End-to-end win path in the real client on a local chain: open a night alone, walk a computed
// route (BFS over the contract's own wall bitmap) to all three fuses — the game proves each one —
// then out through the powered gate (the game proves the escape) and check the ending.
//   anvil --block-time 0.3 & (deploy) ; cd web && npm run dev ; cd tools/qa && node winpath.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const map = JSON.parse(readFileSync(new URL('../../web/src/map.json', import.meta.url), 'utf8'));
const walls = map.walls.map((w) => BigInt(w));
const GRID = 64;
const solid = (x, y) => x < 0 || y < 0 || x >= GRID || y >= GRID || ((walls[(y * GRID + x) >> 8] >> BigInt((y * GRID + x) & 255)) & 1n) === 1n;
const word = (w, i) => Number((BigInt(w) >> BigInt(32 * i)) & 0xffffffffn);
const cellOf = (v) => [Math.floor((v & 0xffff) / 300), Math.floor((v >>> 16) / 300)];
function bfs(a, b) {
  const key = (c) => c[1] * GRID + c[0];
  const prev = new Map([[key(a), null]]);
  const q = [a];
  while (q.length) {
    const c = q.shift();
    if (c[0] === b[0] && c[1] === b[1]) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = [c[0] + dx, c[1] + dy];
      if (solid(n[0], n[1]) || prev.has(key(n))) continue;
      prev.set(key(n), c);
      q.push(n);
    }
  }
  const out = [];
  for (let c = b; c; c = prev.get(key(c))) out.unshift(c);
  return out;
}

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror ' + String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.addInitScript(() => {
  // anvil's account #0 (a well-known test key, local chain only)
  localStorage.setItem('hollow.burner.31337', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  localStorage.setItem('hollow.name', 'QA');
});
await page.goto(`${process.env.URL ?? 'http://localhost:5173'}/?local=1&norender=1&quality=low`);
await page.waitForTimeout(3000);
await page.click('#btn-play');
await page.waitForTimeout(2500);
await page.click('#btn-create');
await page.waitForFunction(() => !document.getElementById('btn-start')?.classList.contains('hidden'), null, { timeout: 30000 });
await page.click('#btn-start');
await page.waitForFunction(() => window.__hollow?.night?.phase?.() === 'night', null, { timeout: 60000 });
console.log('night started');
const g = (fn, arg) => page.evaluate(fn, arg);


const spawn = cellOf(word(map.spawns, 0));
const fuses = [0, 1, 2].map((i) => cellOf(word(map.objectives, i)));
const exit = cellOf(word(map.objectives, 3));
// route: station fuse, Archive fuse, hospital fuse, then the gate; wait at each stop for its proof
const legs = [];
let at = spawn;
const mart = cellOf(word(map.objectives, 4));
for (const [to, kind, bit] of [[fuses[2], 'fuse', 4], [fuses[0], 'fuse', 1], [fuses[1], 'fuse', 2], [exit, 'exit', 0]]) {
  legs.push({ cells: bfs(at, to), kind, bit });
  at = to;
}
await g((legs) => {
  const h = window.__hollow;
  let leg = 0, cell = 0, waitUntil = 0;
  window.__route = { leg: 0, done: false, log: [] };
  const timer = setInterval(() => {
    const L = legs[leg];
    if (!L) { window.__route.done = true; clearInterval(timer); return; }
    const p = h.player;
    if (cell >= L.cells.length) {
      // at the stop: wait for the proof (fuse bit, or escape), at most 15 s
      if (!waitUntil) waitUntil = performance.now() + 15000;
      const hd = h.night.header;
      if (L.kind === 'shop' && (!window.__buyAt || performance.now() > window.__buyAt)) {
        window.__buyAt = performance.now() + 3000;
        void h.town.buy(0);
      }
      const ok = L.kind === 'fuse' ? (hd.fuses & L.bit) !== 0 : L.kind === 'shop' ? (h.night.pockets?.[h.pilot.body]?.[0] ?? 0) > 0 : hd.escapedCount > 0;
      if (ok || performance.now() > waitUntil) {
        window.__route.log.push(`${L.kind}${L.bit} ${ok ? 'proven' : 'timeout'} fuses=${hd.fuses} exit=${hd.exitOpenBlock}`);
        leg++; cell = 0; waitUntil = 0; window.__route.leg = leg;
      }
      return;
    }
    const c = L.cells[cell];
    const tx = (c[0] + 0.5) * 3, tz = (c[1] + 0.5) * 3;
    const dx = tx - p.position.x, dz = tz - p.position.z, d = Math.hypot(dx, dz);
    const step = 0.3; // per 50 ms = 6 m/s, under the 7 m/s cap
    if (d <= step) { p.position.x = tx; p.position.z = tz; cell++; }
    else { p.position.x += (dx / d) * step; p.position.z += (dz / d) * step; }
  }, 50);
}, legs);
for (;;) {
  await page.waitForTimeout(5000);
  const r = await g(() => ({ ...window.__route, phase: window.__hollow.night.phase(), pos: [window.__hollow.player.position.x.toFixed(1), window.__hollow.player.position.z.toFixed(1)] }));
  console.log(JSON.stringify(r));
  if (r.done || r.phase === 'over') break;
}
await page.waitForFunction(() => !document.getElementById('end')?.classList.contains('hidden'), null, { timeout: 60000 }).catch(() => console.log('no end screen'));
await page.waitForTimeout(6000);
console.log('end:', await g(() => [document.getElementById('end-title')?.textContent, document.getElementById('btn-claim')?.textContent, document.getElementById('btn-claim')?.classList.contains('hidden')]));
const claimVisible = await g(() => !document.getElementById('btn-claim')?.classList.contains('hidden'));
if (claimVisible) {
  await page.click('#btn-claim');
  await page.waitForTimeout(5000);
  console.log('after claim, toast:', await g(() => document.getElementById('toast')?.textContent));
}
await page.screenshot({ path: 'winpath-end.png' });
const fns = await g(() => window.__hollow.wallet.sent.map((t) => t.fn));
const tally = {};
for (const f of fns) tally[f] = (tally[f] ?? 0) + 1;
console.log('txs', JSON.stringify(tally));
console.log(JSON.stringify(await g(() => window.__hollow.wallet.sent.filter((t) => t.fn !== 'record').map((t) => t.fn + ':' + t.hash))));
console.log(errors.slice(0, 10).join('\n') || 'no errors');
await browser.close();

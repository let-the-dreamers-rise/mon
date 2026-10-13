// Deterministic film capture: time inside the page only moves when we step it, one rendered frame
// per film frame, so slow software rendering still yields smooth footage. Sounds are logged with
// their film time for an offline mix.
//   node film.mjs --url 'http://127.0.0.1:5173/?replay=4&local=1' --out dir --seconds 20 [--fps 24]
//                 [--w 1280 --h 720] [--ready replay|roam] [--tour tour.js] [--skip 0]
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const fps = Number(args.fps ?? 24);
const seconds = Number(args.seconds ?? 10);
const W = Number(args.w ?? 1280), H = Number(args.h ?? 720);
const out = args.out;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

await page.addInitScript(() => {
  const real = {
    now: performance.now.bind(performance),
    dateNow: Date.now,
    st: window.setTimeout.bind(window),
    si: window.setInterval.bind(window),
    ct: window.clearTimeout.bind(window),
    ci: window.clearInterval.bind(window),
    raf: window.requestAnimationFrame.bind(window),
  };
  let virtual = false;
  let t = 0;
  let dateBase = 0;
  let nextId = 1e7;
  const timers = new Map();
  let rafs = [];
  window.__audioLog = [];
  performance.now = () => (virtual ? t : real.now());
  Date.now = () => (virtual ? dateBase + t : real.dateNow());
  window.setTimeout = (fn, ms = 0, ...a) => {
    if (!virtual) return real.st(fn, ms, ...a);
    const id = nextId++;
    timers.set(id, { at: t + Math.max(0, ms || 0), fn, a });
    return id;
  };
  window.setInterval = (fn, ms = 0, ...a) => {
    if (!virtual) return real.si(fn, ms, ...a);
    const id = nextId++;
    const every = Math.max(1, ms || 0);
    timers.set(id, { at: t + every, fn, a, every });
    return id;
  };
  window.clearTimeout = (id) => (timers.has(id) ? timers.delete(id) : real.ct(id));
  window.clearInterval = (id) => (timers.has(id) ? timers.delete(id) : real.ci(id));
  window.requestAnimationFrame = (cb) => {
    if (!virtual) return real.raf(cb);
    rafs.push(cb);
    return rafs.length;
  };
  window.__film = {
    start() {
      t = real.now();
      dateBase = real.dateNow() - t;
      virtual = true;
    },
    get t() {
      return t;
    },
    step(ms) {
      const end = t + ms;
      for (let guard = 0; guard < 10000; guard++) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        const [id, x] = next;
        t = Math.max(t, x.at);
        if (x.every) x.at += x.every;
        else timers.delete(id);
        try {
          if (typeof x.fn === 'function') x.fn(...x.a);
        } catch (e) {
          console.error(String(e));
        }
      }
      t = end;
      const q = rafs;
      rafs = [];
      for (const cb of q) {
        try {
          cb(t);
        } catch (e) {
          console.error(String(e));
        }
      }
    },
  };
});

await page.goto(args.url);
const ready = args.ready ?? 'replay';
if (ready === 'replay') await page.waitForFunction(() => window.__replayReady === true, null, { timeout: 180000 });
else await page.waitForTimeout(Number(args.warm ?? 8000));
if (args.tour) await page.evaluate(readFileSync(args.tour, 'utf8'));
// let the first real frames settle (shaders compiled, textures uploaded)
await page.waitForTimeout(3000);
await page.evaluate(() => window.__film.start());
// a replay starts from its first block on the first film frame, not when it finished loading
await page.evaluate(() => window.__replay?.play(performance.now()));
const t0 = await page.evaluate(() => window.__film.t);
// optionally fast-forward (cheap: logic only, a frame every 100ms)
const skip = Number(args.skip ?? 0);
for (let s = 0; s < skip * 10; s++) await page.evaluate(() => window.__film.step(100));
await page.evaluate(() => (window.__audioLog.length = 0));
const tStart = await page.evaluate(() => window.__film.t);

const total = Math.round(seconds * fps);
const began = Date.now();
for (let f = 0; f < total; f++) {
  await page.evaluate((ms) => window.__film.step(ms), 1000 / fps);
  for (let attempt = 0; ; attempt++) {
    try {
      await page.screenshot({ path: `${out}/f${String(f).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 88, timeout: 180000 });
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      console.log(`frame ${f}: screenshot retry (${String(e.message).slice(0, 60)})`);
    }
  }
  if (f % 48 === 0) console.log(`frame ${f}/${total} · ${((Date.now() - began) / (f + 1)).toFixed(0)} ms/frame`);
}
const log = await page.evaluate(() => window.__audioLog);
writeFileSync(`${out}/audio.json`, JSON.stringify({ fps, seconds, t0: tStart, skipped: skip, sounds: log.map((s) => ({ ...s, t: (s.t - tStart) / 1000 })) }, null, 1));
console.log(`done: ${total} frames in ${((Date.now() - began) / 1000).toFixed(0)}s; ${log.length} sounds; started ${(tStart - t0) / 1000}s in`);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
await browser.close();

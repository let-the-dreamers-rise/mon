// HOLLOW bots: fill a night with souls that play by the contract's rules.
// Living bots pathfind to fuses and the exit and speak lure lines; Hollow bots hunt the
// nearest living body. Every bot records its samples onchain, follows shifts, and submits
// proofs (turns, fuses, escapes) it can see.
//
//   node scripts/bots.mjs --rpc http://127.0.0.1:8545 --hollow 0x5FbD... --count 5 --night 1
//   node scripts/bots.mjs --create --start-after 40 --count 6            (host a night)
//   BOT_MNEMONIC="..." FUNDER_KEY=0x.. node scripts/bots.mjs --fund 0.6 ... (testnet)
import { readFileSync } from 'node:fs';
import {
  createPublicClient, encodeAbiParameters, encodeFunctionData, http, keccak256, hexToBigInt, parseEther, formatEther,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []),
);
const RPC = args.rpc ?? process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const HOLLOW = args.hollow ?? process.env.HOLLOW ?? '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const COUNT = Number(args.count ?? 5);
const BATCH = Number(args.batch ?? 5);
const root = new URL('../../', import.meta.url);
const abi = JSON.parse(readFileSync(new URL('contracts/out/Hollow.sol/Hollow.json', root))).abi;
const map = JSON.parse(readFileSync(new URL('tools/map/hollow-map.json', root)));
const GRID = 64, CELL = 300, SAMPLE = 2, SHIFT_MIN = 100, SHIFT_RANGE = 150, NIGHT = 2400, LATE = 40;

const client = createPublicClient({ transport: http(RPC, { batch: false, retryCount: 2 }) });
const chainId = await client.getChainId();
const isLocal = chainId === 31337;
const ANVIL_KEYS = [
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
];
const NAMES = ['MARA', 'TOBIAS', 'NADIA', 'ELI', 'RUTH', 'OKONJO', 'IRIS', 'KAITO'];

const accounts = Array.from({ length: COUNT }, (_, i) => {
  if (process.env.BOT_MNEMONIC) return mnemonicToAccount(process.env.BOT_MNEMONIC, { addressIndex: i });
  if (isLocal) return privateKeyToAccount(ANVIL_KEYS[(i + Number(args.offset ?? 0)) % ANVIL_KEYS.length]);
  throw new Error('set BOT_MNEMONIC for non-local chains');
});

// ---------------------------------------------------------------- tx engine
const nonces = new Map();
const FEES = { maxFeePerGas: 130_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const GAS = { record: 120_000n, sync: 140_000n, turn: 160_000n, collectFuse: 160_000n, escape: 160_000n, join: 140_000n, createNight: 120_000n, start: 260_000n, setName: 60_000n, buy: 170_000n, use: 110_000n };
let sentCount = 0;
async function send(account, fn, fnArgs, extra = {}) {
  const data = encodeFunctionData({ abi, functionName: fn, args: fnArgs });
  let n = nonces.get(account.address);
  if (n === undefined) n = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
  nonces.set(account.address, n + 1);
  const raw = await account.signTransaction({ chainId, type: 'eip1559', to: HOLLOW, data, gas: extra.gas ?? GAS[fn] ?? 200_000n, nonce: n, value: extra.value ?? 0n, ...FEES });
  try {
    const hash = await client.request({ method: 'eth_sendRawTransaction', params: [raw] });
    sentCount++;
    return hash;
  } catch (e) {
    if (/nonce/i.test(String(e.message))) nonces.delete(account.address);
    if (!/already known/i.test(String(e.message))) console.error(`[${fn}]`, String(e.shortMessage ?? e.message).slice(0, 140));
    return null;
  }
}
async function sendWait(account, fn, fnArgs) {
  const hash = await send(account, fn, fnArgs);
  if (!hash) throw new Error(`${fn} not sent`);
  const r = await client.waitForTransactionReceipt({ hash, pollingInterval: 300 });
  if (r.status !== 'success') throw new Error(`${fn} reverted`);
  return r;
}
const read = (functionName, a = []) => client.readContract({ address: HOLLOW, abi, functionName, args: a });

// ---------------------------------------------------------------- funding (testnet)
if (args.fund && process.env.FUNDER_KEY) {
  const funder = privateKeyToAccount(process.env.FUNDER_KEY);
  const target = parseEther(String(args.fund));
  let fn = await client.getTransactionCount({ address: funder.address, blockTag: 'pending' });
  for (const a of accounts) {
    const bal = await client.getBalance({ address: a.address });
    if (bal >= target) continue;
    const raw = await funder.signTransaction({ chainId, type: 'eip1559', to: a.address, value: target - bal, gas: 21_000n, nonce: fn++, ...FEES });
    await client.request({ method: 'eth_sendRawTransaction', params: [raw] });
    console.log(`funded ${a.address} with ${formatEther(target - bal)} MON`);
  }
  await new Promise((r) => setTimeout(r, 2500));
}

// ---------------------------------------------------------------- map helpers
const solidWords = map.walls.map((w) => BigInt(w));
const solid = (cx, cy) => {
  if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) return true;
  const bit = cy * GRID + cx;
  return ((solidWords[bit >> 8] >> BigInt(bit & 255)) & 1n) === 1n;
};
const unpack = (p) => ({ x: p & 0xffff, y: p >>> 16 });
const pack = (v) => (((Math.round(v.y) & 0xffff) << 16) >>> 0) + (Math.round(v.x) & 0xffff);
const spawnOf = (b) => Number((BigInt(map.spawns) >> BigInt(32 * b)) & 0xffffffffn);
const objective = (i) => Number((BigInt(map.objectives) >> BigInt(32 * i)) & 0xffffffffn);
const cellOf = (v) => [Math.floor(v.x / CELL), Math.floor(v.y / CELL)];
const centre = ([cx, cy]) => ({ x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 });
function path(from, to) {
  const [sx, sy] = cellOf(from), [tx, ty] = cellOf(to);
  const prev = new Map([[`${sx},${sy}`, null]]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift();
    if (x === tx && y === ty) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${x + dx},${y + dy}`;
      if (solid(x + dx, y + dy) || prev.has(k)) continue;
      prev.set(k, [x, y]);
      q.push([x + dx, y + dy]);
    }
  }
  const out = [];
  let cur = [tx, ty];
  if (!prev.has(`${tx},${ty}`)) return [];
  while (cur) {
    out.unshift(cur);
    cur = prev.get(`${cur[0]},${cur[1]}`);
  }
  return out.map(centre);
}
const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

// ---------------------------------------------------------------- night selection
let nightId = args.night ? BigInt(args.night) : null;
if (args.create) {
  await sendWait(accounts[0], 'createNight', []);
  nightId = await read('nightCount');
  console.log(`opened night ${nightId}`);
}
if (nightId === null) nightId = await read('nightCount');
console.log(`chain ${chainId} · hollow ${HOLLOW} · night ${nightId} · ${COUNT} bots`);

for (let i = 0; i < accounts.length; i++) {
  const a = accounts[i];
  const nm = NAMES[(i + Number(args.offset ?? 0)) % NAMES.length];
  const hex = '0x' + Buffer.from(nm.padEnd(16, '\0')).toString('hex');
  await send(a, 'setName', [hex]);
  const idx = await read('soulIndexPlus1', [nightId, a.address]);
  if (idx === 0n) {
    try {
      await sendWait(a, 'join', [nightId]);
      console.log(`${nm} joined`);
    } catch (e) {
      console.log(`${nm} could not join: ${e.message}`);
    }
  }
}

if (args.create && args['start-when']) {
  const want = Number(args['start-when']);
  console.log(`waiting for ${want} souls in night ${nightId}…`);
  for (;;) {
    const n = await read('nights', [nightId]);
    if (Number(n[2]) >= want) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await new Promise((r) => setTimeout(r, 2000));
  await sendWait(accounts[0], 'start', [nightId]);
  console.log('night started');
} else if (args.create && args['start-after']) {
  const wait = Number(args['start-after']);
  console.log(`starting in ${wait}s (humans: join night ${nightId} now)`);
  await new Promise((r) => setTimeout(r, wait * 1000));
  await sendWait(accounts[0], 'start', [nightId]);
  console.log('night started');
}

// ---------------------------------------------------------------- the night
const bots = [];
for (let i = 0; i < accounts.length; i++) {
  const s = Number(await read('soulIndexPlus1', [nightId, accounts[i].address])) - 1;
  if (s >= 0) bots.push({ acct: accounts[i], soul: s, body: -1, epoch: -1, pos: null, next: -1, pending: [], target: null, route: [], lastSend: 0, wander: Math.random() * 1e9, voiceAt: Date.now() + 8000 + Math.random() * 20000 });
}

let header, epochs = [], bodies = [], souls = [], chainBlock = 0, blockAt = Date.now(), msPerBlock = isLocal ? 300 : 300;
const samples = []; // per body Map(index -> pos)
const proven = new Set();
const claimed = new Set();

async function poll() {
  const [n, , bn, bodyList, tails] = await read('snapshot', [nightId, 16n]);
  header = n;
  const b = Number(bn);
  if (b > chainBlock) {
    const now = Date.now();
    if (chainBlock) msPerBlock = msPerBlock * 0.8 + ((now - blockAt) / (b - chainBlock)) * 0.2;
    chainBlock = b;
    blockAt = now;
  }
  bodies = bodyList;
  for (let i = 0; i < bodies.length; i++) {
    samples[i] ??= new Map();
    for (let t = 0; t < 16; t++) {
      const v = tails[i * 16 + t];
      if (v && (v & 0xffffffffn)) samples[i].set(Number(v >> 32n), Number(v & 0xffffffffn));
    }
  }
  if (Number(header.startBlock) && epochs.length <= Number(header.epoch)) {
    const words = await read('getEpochs', [nightId, BigInt(epochs.length)]);
    for (const w of words) {
      const assign = [];
      for (let k = 0; k < 8; k++) assign.push(Number((w >> BigInt(4 * k)) & 0xfn));
      epochs.push({ assign, start: Number((w >> 32n) & 0xffffffffffffffffn) });
    }
  }
  const [addrs, , hollowSince, escapedRel] = await read('getSouls', [nightId]);
  souls = addrs.map((a, i) => ({ addr: a, hollowSince: Number(hollowSince[i]), escapedRel: Number(escapedRel[i]) }));
}

const est = () => chainBlock + (Date.now() - blockAt) / msPerBlock;
const start = () => Number(header.startBlock);
const epochAt = (blk) => {
  for (let k = epochs.length - 1; k >= 0; k--) if (epochs[k].start <= blk) return k;
  return 0;
};
const posAt = (body, i) => {
  for (let k = Math.floor(i); k >= Math.max(0, i - 300); k--) {
    const v = samples[body]?.get(k);
    if (v) return v;
  }
  const b = bodies[body];
  return b && Number(b.nSamples) > 0 ? Number(b.lastPos) : spawnOf(body);
};
const hollowAt = (s, blk) => souls[s] && souls[s].hollowSince !== 0 && souls[s].hollowSince < blk;
const livingNow = (s) => souls[s] && souls[s].hollowSince === 0 && souls[s].escapedRel === 0;
const gone = (b) => ((Number(header.goneMask) >> b) & 1) === 1;

let syncAsked = 0;
let lastLog = 0;
const tickMs = 100;
for (;;) {
  try {
    await poll();
  } catch (e) {
    console.error('poll', String(e.message).slice(0, 100));
    await new Promise((r) => setTimeout(r, 600));
    continue;
  }
  const h = header;
  if (!Number(h.startBlock) || chainBlock < start()) {
    await new Promise((r) => setTimeout(r, 500));
    continue;
  }
  const endBlk = start() + NIGHT;
  if (Number(h.endBlock) || chainBlock >= endBlk) {
    console.log(`night over · living ${h.living} · escaped ${h.escapedCount} · ${sentCount} txs sent`);
    break;
  }
  // materialize due shifts so bots switch bodies on time
  if (chainBlock >= Number(h.nextShift) && Number(h.nextShift) !== syncAsked) {
    syncAsked = Number(h.nextShift);
    await send(bots[0].acct, 'sync', [nightId]);
  }
  const e = est();
  const ei = epochAt(Math.floor(e));
  const ep = epochs[ei];
  if (!ep) continue;

  for (const bot of bots) {
    if (!livingNow(bot.soul) && !hollowAt(bot.soul, e)) continue; // escaped
    const myBody = ep.assign.findIndex((s, b) => s === bot.soul && b < Number(h.nSouls));
    if (ei !== bot.epoch) {
      bot.pending = bot.pending.filter((p) => start() + p.index * SAMPLE < ep.start);
      bot.epoch = ei;
      if (myBody !== bot.body) {
        bot.body = myBody;
        bot.pos = unpack(posAt(myBody, (e - start()) / SAMPLE));
        bot.route = [];
        bot.next = Math.ceil((e - start()) / SAMPLE);
      }
    }
    if (bot.body < 0 || gone(bot.body)) continue;
    if (bot.next < 0) bot.next = Math.ceil((e - start()) / SAMPLE);
    if (!bot.pos) bot.pos = unpack(posAt(bot.body, bot.next - 1));

    // choose a target
    const hollow = hollowAt(bot.soul, e);
    const idxNow = (e - start()) / SAMPLE;
    if (hollow) {
      let best = null, bd = Infinity;
      for (let b = 0; b < Number(h.nSouls); b++) {
        if (b === bot.body || gone(b)) continue;
        const s = ep.assign[b];
        if (!livingNow(s)) continue;
        const p = unpack(posAt(b, idxNow));
        const dd = d2(p, bot.pos);
        if (dd < bd) { bd = dd; best = p; }
      }
      if (best && (!bot.target || d2(bot.target, best) > 250 ** 2 || !bot.route.length)) {
        bot.target = best;
        bot.route = path(bot.pos, best);
      }
    } else if (!bot.route.length) {
      const fuses = Number(h.fuses);
      let goal = null;
      if (Number(h.exitOpenBlock)) goal = unpack(objective(3));
      else {
        const open = [0, 1, 2].filter((f) => !(fuses & (1 << f))).map((f) => unpack(objective(f)));
        if (open.length) goal = open.sort((a, b) => d2(a, bot.pos) - d2(b, bot.pos))[Math.floor(bot.wander) % Math.min(2, open.length)];
      }
      if (goal) bot.route = path(bot.pos, goal);
    }

    // speed: living walk 2.4 m/s, hollow 3.3 m/s, cap well under MAX_STEP
    const perSample = (hollow ? 330 : 240) * (msPerBlock * SAMPLE / 1000);
    while (start() + bot.next * SAMPLE <= e) {
      let budget = Math.min(perSample, 400);
      while (budget > 0 && bot.route.length) {
        const wp = bot.route[0];
        const dx = wp.x - bot.pos.x, dy = wp.y - bot.pos.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= budget) {
          bot.pos = { x: wp.x, y: wp.y };
          bot.route.shift();
          budget -= dist;
        } else {
          bot.pos = { x: bot.pos.x + (dx / dist) * budget, y: bot.pos.y + (dy / dist) * budget };
          budget = 0;
        }
      }
      const p = pack(bot.pos);
      let voice = 0;
      if (!hollow && Date.now() > bot.voiceAt) {
        bot.voiceAt = Date.now() + 20000 + Math.random() * 30000;
        voice = 1 + Math.floor(Math.random() * 6);
      } else if (hollow && Date.now() > bot.voiceAt) {
        bot.voiceAt = Date.now() + 15000 + Math.random() * 20000;
        voice = [1, 2, 3][Math.floor(Math.random() * 3)]; // lures
      }
      bot.pending.push({ index: bot.next, pos: p, voice, body: bot.body });
      samples[bot.body] ??= new Map();
      samples[bot.body].set(bot.next, p);
      bot.next++;
    }
    // flush
    const nS = Number(bodies[bot.body]?.nSamples ?? 0);
    const ready = bot.pending.filter((p) => p.body === bot.body && start() + p.index * SAMPLE <= chainBlock + 1 && p.index >= nS);
    bot.pending = bot.pending.filter((p) => p.body === bot.body && p.index >= nS && start() + p.index * SAMPLE + LATE > chainBlock);
    if (ready.length >= BATCH || (ready.length && Date.now() - bot.lastSend > 1500)) {
      const run = [];
      for (const p of ready) {
        if (run.length && p.index !== run[run.length - 1].index + 1) break;
        if (epochAt(start() + p.index * SAMPLE) !== epochAt(start() + ready[0].index * SAMPLE)) break;
        run.push(p);
        if (run.length === 8) break;
      }
      let packed = 0n, voice = 0;
      run.forEach((p, k) => {
        packed |= BigInt(p.pos) << BigInt(32 * k);
        if (p.voice) voice = p.voice;
      });
      bot.pending = bot.pending.filter((p) => !run.includes(p));
      bot.lastSend = Date.now();
      const newSlot = run.some((p) => p.index % 8 === 0) || (run[0].index >> 3) !== (nS >> 3);
      const shiftDue = chainBlock + 1 >= Number(h.nextShift);
      void send(bot.acct, 'record', [nightId, bot.body, run[0].index, packed, run.length, voice], { gas: 78_000n + (newSlot ? 24_000n : 0n) + (shiftDue ? 85_000n : 0n) + (voice ? 6_000n : 0n) });
    }

    // proofs for my own body: fuses, exit
    if (livingNow(bot.soul)) {
      for (let f = 0; f < 4; f++) {
        if (f < 3 && Number(h.fuses) & (1 << f)) continue;
        if (f === 3 && !Number(h.exitOpenBlock)) continue;
        const key = `${bot.soul}:${f}`;
        if (claimed.has(key)) continue;
        const latest = nS - 1;
        for (let i = latest; i >= Math.max(0, latest - 6); i--) {
          const v = samples[bot.body]?.get(i);
          const blk = start() + i * SAMPLE;
          if (!v || d2(unpack(v), unpack(objective(f))) > 150 ** 2) continue;
          if (f === 3 && blk < Number(h.exitOpenBlock)) continue;
          claimed.add(key);
          setTimeout(() => claimed.delete(key), 5000);
          if (f < 3) void send(bot.acct, 'collectFuse', [nightId, epochAt(blk), bot.body, i, f]);
          else void send(bot.acct, 'escape', [nightId, epochAt(blk), bot.body, i]);
          break;
        }
      }
    }
  }

  // touch proofs (anyone may submit; bots do it for everyone)
  const common = Math.min(...bodies.map((b, i) => (gone(i) ? Infinity : Number(b.nSamples) - 1)));
  for (let i = Math.max(0, common - 12); i <= common; i++) {
    const blk = start() + i * SAMPLE;
    const ek = epochAt(blk);
    const epw = epochs[ek];
    if (!epw || blk < epw.start + 10 || blk < start() + 30) continue;
    for (let hb = 0; hb < Number(h.nSouls); hb++) {
      if (!hollowAt(epw.assign[hb], blk)) continue;
      for (let vb = 0; vb < Number(h.nSouls); vb++) {
        const vs = epw.assign[vb];
        if (vb === hb || gone(vb) || !livingNow(vs) || proven.has(vs)) continue;
        if (d2(unpack(posAt(vb, i)), unpack(posAt(hb, i))) <= 120 ** 2) {
          proven.add(vs);
          setTimeout(() => proven.delete(vs), 6000);
          console.log(`touch! soul ${epw.assign[hb]} (body ${hb}) → soul ${vs} (body ${vb}) at sample ${i}`);
          void send(bots[0].acct, 'turn', [nightId, ek, vb, hb, i]);
        }
      }
    }
  }

  if (Date.now() - lastLog > 5000) {
    lastLog = Date.now();
    console.log(`block ${chainBlock} · epoch ${epochs.length - 1} · living ${h.living} · fuses ${Number(h.fuses).toString(2)} · txs ${sentCount}`);
  }
  await new Promise((r) => setTimeout(r, tickMs));
}

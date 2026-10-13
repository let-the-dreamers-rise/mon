import { encodeAbiParameters, hexToBigInt, keccak256, parseAbiItem, type Log } from 'viem';
import {
  LATE_BLOCKS,
  NET,
  NIGHT_BLOCKS,
  OBJECTIVE_RADIUS_CM,
  SAMPLE_BLOCKS,
  SHIFT_GRACE_BLOCKS,
  SHIFT_MIN,
  SHIFT_RANGE,
  START_GRACE_BLOCKS,
  TURN_RADIUS_CM,
  type Hex,
} from '../config';
import map from '../map.json';
import { hollowAbi } from './abi';
import { publicClient, type Burner } from './wallet';

export interface NightHeader {
  host: Hex;
  lobbyEnd: number;
  nSouls: number;
  living: number;
  fuses: number;
  goneMask: number;
  startBlock: number;
  nextShift: number;
  exitOpenBlock: number;
  endBlock: number;
  epoch: number;
  escapedCount: number;
  lastForcedShift: number;
}

export interface SoulInfo {
  addr: Hex;
  name: string;
  hollowSince: number;
  escapedRel: number;
}

export interface BodyInfo {
  nSamples: number;
  lastPos: number;
  goneRel: number;
  voice: number;
  voiceIndex: number;
}

export interface Epoch {
  index: number;
  assign: number[]; // body -> soul
  start: number;
  mask: number;
  nextShift: number; // block of the shift that ends this epoch (only known for the latest)
  predicted: boolean;
}

export interface UsedEvent {
  body: number;
  soul: number;
  item: number;
  pos: number;
  atBlock: number;
  tx: Hex;
}

export interface TormentEvent {
  watcher: Hex;
  kind: number;
  body: number;
  atBlock: number;
  tx: Hex;
}

export type Vec = { x: number; y: number }; // centimetres

export const unpack = (p: number): Vec => ({ x: p & 0xffff, y: p >>> 16 });
export const pack = (v: Vec): number => ((Math.round(v.y) & 0xffff) << 16 >>> 0) + (Math.round(v.x) & 0xffff);
const dist2 = (a: number, b: number) => {
  const A = unpack(a);
  const B = unpack(b);
  return (A.x - B.x) ** 2 + (A.y - B.y) ** 2;
};

const spawnsWord = BigInt(map.spawns);
const objectivesWord = BigInt(map.objectives);
export const spawnOf = (body: number) => Number((spawnsWord >> BigInt(32 * body)) & 0xffffffffn);
export const objective = (i: number) => Number((objectivesWord >> BigInt(32 * i)) & 0xffffffffn);

const TAIL = 16;
const ZERO32 = ('0x' + '0'.repeat(64)) as Hex;

function parseEpoch(index: number, word: bigint): Epoch {
  const assign: number[] = [];
  for (let b = 0; b < 8; b++) assign.push(Number((word >> BigInt(4 * b)) & 0xfn));
  return {
    index,
    assign,
    start: Number((word >> 32n) & 0xffffffffffffffffn),
    mask: Number((word >> 96n) & 0xffn),
    nextShift: 0,
    predicted: false,
  };
}

const tormentEvent = parseAbiItem(
  'event Torment(uint256 indexed night, address indexed watcher, uint8 kind, uint8 body, uint64 atBlock, uint256 paid)',
);
const usedEvent = parseAbiItem('event Used(uint256 indexed night, uint8 body, uint8 soul, uint8 item, uint32 pos, uint64 atBlock)');

/**
 * Mirrors one night of Hollow.sol in the browser: polls a snapshot every block, predicts
 * shifts locally from block hashes (so everyone swaps on the exact block), keeps a sample
 * cache per body, and detects touches/fuses/escapes to prove onchain.
 */
export class NightState {
  readonly id: bigint;
  header: NightHeader | null = null;
  souls: SoulInfo[] = [];
  bodies: BodyInfo[] = [];
  epochs: Epoch[] = [];
  private predicted: Epoch[] = [];
  private samples: Map<number, number>[] = [];
  chainBlock = 0;
  private chainBlockAt = 0;
  msPerBlock = NET.blockMs;
  private lastBlockSeen = 0;
  private lastBlockSeenAt = 0;
  private blockHashes = new Map<number, Hex>();
  private polling = false;
  private soulsAt = 0;
  private logsFrom = 0;
  torments: TormentEvent[] = [];
  watcherAddrs = new Set<string>();
  /** item counts per body: pockets[body][item] */
  pockets: number[][] = [];
  private pocketsAt = 0;
  private usedSeen = new Set<string>();

  onTorment?: (t: TormentEvent) => void;
  onUsed?: (u: UsedEvent) => void;

  constructor(id: bigint) {
    this.id = id;
  }

  // ------------------------------------------------------------- time
  estBlock(now = performance.now()): number {
    if (!this.chainBlockAt) return this.chainBlock;
    return this.chainBlock + (now - this.chainBlockAt) / this.msPerBlock;
  }

  get start(): number {
    return this.header?.startBlock ?? 0;
  }

  blockOfIndex(i: number) {
    return this.start + i * SAMPLE_BLOCKS;
  }

  indexAtBlock(b: number) {
    return (b - this.start) / SAMPLE_BLOCKS;
  }

  // ------------------------------------------------------------- polling
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const res = (await publicClient.readContract({
        address: NET.hollow,
        abi: hollowAbi,
        functionName: 'snapshot',
        args: [this.id, BigInt(TAIL)],
      })) as unknown as [Record<string, unknown>, bigint, bigint, Record<string, unknown>[], bigint[]];
      const [n, , blockNumber, bodyList, tails] = res;
      const now = performance.now();
      this.header = {
        host: n.host as Hex,
        lobbyEnd: Number(n.lobbyEnd),
        nSouls: Number(n.nSouls),
        living: Number(n.living),
        fuses: Number(n.fuses),
        goneMask: Number(n.goneMask),
        startBlock: Number(n.startBlock),
        nextShift: Number(n.nextShift),
        exitOpenBlock: Number(n.exitOpenBlock),
        endBlock: Number(n.endBlock),
        epoch: Number(n.epoch),
        escapedCount: Number(n.escapedCount),
        lastForcedShift: Number(n.lastForcedShift),
      };
      this.observeBlock(Number(blockNumber), now);
      this.bodies = bodyList.map((b) => ({
        nSamples: Number(b.nSamples),
        lastPos: Number(b.lastPos),
        goneRel: Number(b.goneRel),
        voice: Number(b.voice),
        voiceIndex: Number(b.voiceIndex),
      }));
      while (this.samples.length < this.bodies.length) this.samples.push(new Map());
      for (let i = 0; i < this.bodies.length; i++) {
        for (let t = 0; t < TAIL; t++) {
          const v = tails[i * TAIL + t];
          if (!v) continue;
          const pos = Number(v & 0xffffffffn);
          if (pos) this.samples[i].set(Number(v >> 32n), pos);
        }
      }
      if (this.header.startBlock && this.epochs.length <= this.header.epoch) {
        const words = (await publicClient.readContract({
          address: NET.hollow,
          abi: hollowAbi,
          functionName: 'getEpochs',
          args: [this.id, BigInt(this.epochs.length)],
        })) as readonly bigint[];
        words.forEach((w, k) => this.epochs.push(parseEpoch(this.epochs.length + k * 0, w)));
        this.epochs.forEach((e, k) => (e.index = k));
        this.predicted = this.predicted.filter((p) => p.index > this.header!.epoch);
      }
      const last = this.epochs[this.epochs.length - 1];
      if (last) last.nextShift = this.header.nextShift;
      if (now - this.soulsAt > 1200 || this.souls.length !== this.header.nSouls) {
        this.soulsAt = now;
        await this.pollSouls();
      }
      if (this.header.startBlock) await this.pollTorments();
      if (this.header.startBlock && now - this.pocketsAt > 1500) {
        this.pocketsAt = now;
        await this.pollPockets();
      }
      await this.predictShifts();
    } finally {
      this.polling = false;
    }
  }

  private observeBlock(b: number, now: number) {
    if (b > this.lastBlockSeen) {
      if (this.lastBlockSeen) {
        const per = (now - this.lastBlockSeenAt) / (b - this.lastBlockSeen);
        if (per > 50 && per < 3000) this.msPerBlock = this.msPerBlock * 0.85 + per * 0.15;
      }
      this.lastBlockSeen = b;
      this.lastBlockSeenAt = now;
    }
    // never let the estimate run backwards
    const est = this.estBlock(now);
    if (b >= est - 0.5 || !this.chainBlockAt) {
      this.chainBlock = b;
      this.chainBlockAt = now;
    }
  }

  async pollSouls() {
    const [addrs, names, hollowSince, escapedRel] = (await publicClient.readContract({
      address: NET.hollow,
      abi: hollowAbi,
      functionName: 'getSouls',
      args: [this.id],
    })) as unknown as [Hex[], Hex[], bigint[], number[]];
    this.souls = addrs.map((addr, i) => ({
      addr,
      name: decodeName(names[i]) || short(addr),
      hollowSince: Number(hollowSince[i]),
      escapedRel: Number(escapedRel[i]),
    }));
  }

  async pollPockets() {
    const words = (await publicClient.readContract({ address: NET.hollow, abi: hollowAbi, functionName: 'getPockets', args: [this.id] })) as readonly bigint[];
    this.pockets = words.map((w) => Array.from({ length: 6 }, (_, i) => Number((w >> BigInt(16 * i)) & 0xffffn)));
  }

  private async pollTorments() {
    const tip = this.chainBlock;
    const from = Math.max(this.logsFrom, this.start - 5, tip - 90);
    if (tip <= from) return;
    try {
      const logs = (await publicClient.getLogs({
        address: NET.hollow,
        event: tormentEvent,
        args: { night: this.id },
        fromBlock: BigInt(from),
        toBlock: BigInt(tip),
      })) as (Log & { args: { watcher: Hex; kind: number; body: number; atBlock: bigint } })[];
      for (const l of logs) {
        if (this.torments.some((t) => t.tx === l.transactionHash && t.kind === Number(l.args.kind))) continue;
        const t: TormentEvent = {
          watcher: l.args.watcher,
          kind: Number(l.args.kind),
          body: Number(l.args.body),
          atBlock: Number(l.args.atBlock),
          tx: l.transactionHash as Hex,
        };
        this.torments.push(t);
        this.watcherAddrs.add(t.watcher.toLowerCase());
        this.onTorment?.(t);
      }
      const used = (await publicClient.getLogs({
        address: NET.hollow,
        event: usedEvent,
        args: { night: this.id },
        fromBlock: BigInt(from),
        toBlock: BigInt(tip),
      })) as (Log & { args: { body: number; soul: number; item: number; pos: number; atBlock: bigint } })[];
      for (const l of used) {
        const key = `${l.transactionHash}:${l.logIndex}`;
        if (this.usedSeen.has(key)) continue;
        this.usedSeen.add(key);
        this.onUsed?.({ body: Number(l.args.body), soul: Number(l.args.soul), item: Number(l.args.item), pos: Number(l.args.pos), atBlock: Number(l.args.atBlock), tx: l.transactionHash as Hex });
      }
      this.logsFrom = tip + 1;
    } catch {
      /* RPC log limits: try again next poll */
    }
  }

  // ------------------------------------------------------------- epochs & shifts
  allEpochs(): Epoch[] {
    return [...this.epochs, ...this.predicted];
  }

  epochAt(block: number): Epoch | undefined {
    const all = this.allEpochs();
    for (let k = all.length - 1; k >= 0; k--) if (all[k].start <= block) return all[k];
    return undefined;
  }

  /** the shift after the latest known epoch (chain or predicted) */
  nextShiftBlock(): number {
    const all = this.allEpochs();
    return all.length ? all[all.length - 1].nextShift : 0;
  }

  private async blockHash(b: number): Promise<Hex | null> {
    const c = this.blockHashes.get(b);
    if (c) return c;
    try {
      const blk = await publicClient.getBlock({ blockNumber: BigInt(b) });
      if (blk?.hash) {
        this.blockHashes.set(b, blk.hash);
        return blk.hash;
      }
    } catch {
      /* not produced yet */
    }
    return null;
  }

  /** Re-implements Hollow._sync so swaps happen locally on the exact shift block. */
  private async predictShifts() {
    const h = this.header;
    if (!h || !h.startBlock || h.endBlock) return;
    const nightEnd = h.startBlock + NIGHT_BLOCKS;
    for (let guard = 0; guard < 4; guard++) {
      const all = this.allEpochs();
      const prev = all[all.length - 1];
      if (!prev) return;
      const S = prev.nextShift;
      if (!S || S >= nightEnd || this.chainBlock < S) return;
      const bh = await this.blockHash(S - 1);
      if (!bh) return;
      const e = BigInt(prev.index);
      const inner = bh === ZERO32 ? keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [this.id, e])) : bh;
      let seed = hexToBigInt(
        keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }], [inner, this.id, e])),
      );
      const list: number[] = [];
      for (let i = 0; i < h.nSouls; i++) if (((h.goneMask >> i) & 1) === 0) list.push(i);
      const soulOf = list.map((b) => prev.assign[b]);
      for (let k = list.length; k > 1; k--) {
        const j = Number(seed % BigInt(k - 1));
        [soulOf[k - 1], soulOf[j]] = [soulOf[j], soulOf[k - 1]];
        seed = hexToBigInt(keccak256(encodeAbiParameters([{ type: 'uint256' }], [seed])));
      }
      const assign = [...prev.assign];
      list.forEach((b, k) => (assign[b] = soulOf[k]));
      const nextShift =
        S + SHIFT_MIN + Number(hexToBigInt(keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'string' }], [seed, 'next']))) % BigInt(SHIFT_RANGE));
      let mask = 0;
      list.forEach((b) => (mask |= 1 << b));
      this.predicted.push({ index: prev.index + 1, assign, start: S, mask, nextShift, predicted: true });
    }
  }

  // ------------------------------------------------------------- souls & bodies
  soulIndexOf(addr: Hex): number {
    return this.souls.findIndex((s) => s.addr.toLowerCase() === addr.toLowerCase());
  }

  bodyOfSoul(soul: number, block: number): number {
    const e = this.epochAt(block);
    if (!e) return soul;
    return e.assign.findIndex((s, b) => s === soul && b < (this.header?.nSouls ?? 8));
  }

  soulInBody(body: number, block: number): number {
    const e = this.epochAt(block);
    return e ? e.assign[body] : body;
  }

  isHollowAt(soul: number, block: number): boolean {
    const s = this.souls[soul];
    return !!s && s.hollowSince !== 0 && s.hollowSince < block;
  }

  isLivingAt(soul: number, block: number): boolean {
    const s = this.souls[soul];
    return !!s && (s.hollowSince === 0 || s.hollowSince > block) && s.escapedRel === 0;
  }

  bodyGone(body: number): boolean {
    return ((this.header?.goneMask ?? 0) >> body) & 1 ? true : false;
  }

  /** last known position of a body at or before sample index i (cm, packed) */
  positionAt(body: number, i: number): number {
    const cache = this.samples[body];
    const floor = Math.floor(i);
    if (cache) {
      for (let k = floor; k >= Math.max(0, floor - 400); k--) {
        const v = cache.get(k);
        if (v) return v;
      }
    }
    const b = this.bodies[body];
    if (b && b.nSamples > 0 && b.lastPos) return b.lastPos;
    return spawnOf(body);
  }

  latestIndex(body: number): number {
    const b = this.bodies[body];
    return b ? b.nSamples - 1 : -1;
  }

  /** smooth render position (cm) at fractional sample index, with short extrapolation */
  renderPosition(body: number, fi: number): { x: number; y: number; vx: number; vy: number } {
    const latest = this.latestIndex(body);
    const i0 = Math.floor(fi);
    if (latest >= 0 && i0 >= latest) {
      const a = unpack(this.positionAt(body, latest - 1));
      const b = unpack(this.positionAt(body, latest));
      const ahead = Math.min(fi - latest, 2.5); // extrapolate at most ~1.5s
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      return { x: b.x + vx * ahead, y: b.y + vy * ahead, vx, vy };
    }
    const a = unpack(this.positionAt(body, i0));
    const b = unpack(this.positionAt(body, i0 + 1));
    const t = fi - i0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, vx: b.x - a.x, vy: b.y - a.y };
  }

  addLocalSample(body: number, index: number, pos: number) {
    while (this.samples.length <= body) this.samples.push(new Map());
    this.samples[body].set(index, pos);
  }

  // ------------------------------------------------------------- proofs
  private proven = new Set<string>();
  private checkedTo = 0;

  /** Finds Hollow touches in recorded samples. Returns proofs not yet submitted. */
  findTurns(): { epoch: number; victim: number; hollow: number; index: number; victimSoul: number; hollowSoul: number }[] {
    const h = this.header;
    if (!h || !h.startBlock) return [];
    const out: ReturnType<NightState['findTurns']> = [];
    const maxCommon = Math.min(...this.bodies.map((b, i) => (this.bodyGone(i) ? Infinity : b.nSamples - 1)));
    const finalIdx = Math.floor(this.indexAtBlock(this.chainBlock - LATE_BLOCKS - 1));
    const upTo = Math.max(Number.isFinite(maxCommon) ? maxCommon : 0, finalIdx);
    for (let i = Math.max(this.checkedTo, 0); i <= upTo; i++) {
      const blk = this.blockOfIndex(i);
      const e = this.epochAt(blk);
      if (!e) continue;
      if (blk < e.start + SHIFT_GRACE_BLOCKS || blk < h.startBlock + START_GRACE_BLOCKS) continue;
      for (let hb = 0; hb < h.nSouls; hb++) {
        const hs = e.assign[hb];
        if (!this.isHollowAt(hs, blk)) continue;
        if (i > this.latestIndex(hb) && i > finalIdx) continue;
        for (let vb = 0; vb < h.nSouls; vb++) {
          if (vb === hb || this.bodyGone(vb)) continue;
          const vs = e.assign[vb];
          const s = this.souls[vs];
          if (!s || s.hollowSince !== 0 || s.escapedRel !== 0) continue;
          if (i > this.latestIndex(vb) && i > finalIdx) continue;
          if (dist2(this.positionAt(vb, i), this.positionAt(hb, i)) <= TURN_RADIUS_CM * TURN_RADIUS_CM) {
            const key = `${vs}`;
            if (this.proven.has(key)) continue;
            out.push({ epoch: e.index, victim: vb, hollow: hb, index: i, victimSoul: vs, hollowSoul: hs });
          }
        }
      }
    }
    this.checkedTo = Math.max(0, Math.min(upTo, Number.isFinite(maxCommon) ? maxCommon : upTo) - 2);
    return out;
  }

  markProven(victimSoul: number) {
    this.proven.add(`${victimSoul}`);
  }

  /** a recorded sample of `body` inside an objective radius, for fuse/escape proofs */
  findObjective(body: number, objectiveIdx: number, minBlock = 0): number | null {
    const target = objective(objectiveIdx);
    const latest = this.latestIndex(body);
    for (let i = latest; i >= Math.max(0, latest - 12); i--) {
      if (this.blockOfIndex(i) < minBlock) break;
      const v = this.samples[body]?.get(i);
      if (v && dist2(v, target) <= (OBJECTIVE_RADIUS_CM - 10) ** 2) return i;
    }
    return null;
  }

  /** a recorded (onchain) sample of `body` within the shop radius of a counter */
  findAtCounter(body: number, shop: number, radiusCm: number): number | null {
    const target = objective(4 + shop);
    const nS = this.bodies[body]?.nSamples ?? 0;
    for (let i = nS - 1; i >= Math.max(0, nS - 16); i--) {
      const v = this.samples[body]?.get(i);
      if (v && dist2(v, target) <= (radiusCm - 15) ** 2) return i;
    }
    return null;
  }

  phase(now = performance.now()): 'none' | 'lobby' | 'countdown' | 'night' | 'over' {
    const h = this.header;
    if (!h || h.host === '0x0000000000000000000000000000000000000000') return 'none';
    const b = this.estBlock(now);
    if (!h.startBlock) return 'lobby';
    if (b < h.startBlock) return 'countdown';
    if (h.endBlock || b >= h.startBlock + NIGHT_BLOCKS) return 'over';
    return 'night';
  }
}

export function decodeName(hex: Hex): string {
  const bytes = hex.slice(2).match(/../g) ?? [];
  let s = '';
  for (const b of bytes) {
    const c = parseInt(b, 16);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

export function encodeName(name: string): Hex {
  const clean = name.replace(/[^\x20-\x7e]/g, '').slice(0, 16);
  let hex = '';
  for (let i = 0; i < 16; i++) hex += (i < clean.length ? clean.charCodeAt(i) : 0).toString(16).padStart(2, '0');
  return ('0x' + hex) as Hex;
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Batches my own body's samples and submits them on time, switching bodies on shifts. */
export class Pilot {
  private pending: { index: number; pos: number; voice: number; body: number }[] = [];
  private nextIndex = -1;
  body = -1;
  epochIndex = -1;
  private lastSend = 0;
  sentSamples = 0;
  lastConfirmLatencyMs = 0;
  private sendTimes = new Map<number, number>();

  constructor(private night: NightState, private wallet: Burner, readonly soul: number) {}

  /** called each frame with my current position (cm); returns true if the body changed */
  tick(now: number, pos: Vec, voice: number): boolean {
    const n = this.night;
    const h = n.header;
    if (!h || !h.startBlock) return false;
    const est = n.estBlock(now);
    if (est < h.startBlock) return false;
    const e = n.epochAt(Math.floor(est));
    let changed = false;
    if (e && e.index !== this.epochIndex) {
      const nb = e.assign.findIndex((s, b) => s === this.soul && b < h.nSouls);
      // drop samples that now belong to a body I no longer drive
      this.pending = this.pending.filter((p) => n.blockOfIndex(p.index) < e.start);
      changed = nb !== this.body;
      this.epochIndex = e.index;
      this.body = nb;
      this.nextIndex = Math.ceil(n.indexAtBlock(est));
    }
    if (this.body < 0 || n.bodyGone(this.body)) return changed;
    if (this.nextIndex < 0) this.nextIndex = Math.ceil(n.indexAtBlock(est));
    while (n.blockOfIndex(this.nextIndex) <= est) {
      const p = pack(pos);
      this.pending.push({ index: this.nextIndex, pos: p, voice: 0, body: this.body });
      n.addLocalSample(this.body, this.nextIndex, p);
      this.nextIndex++;
    }
    if (voice && this.pending.length) this.pending[this.pending.length - 1].voice = voice;
    this.flush(false, voice !== 0);
    // confirmation latency: when the chain shows a sample we sent
    const b = n.bodies[this.body];
    if (b) {
      for (const [idx, t] of this.sendTimes) {
        if (idx < b.nSamples) {
          this.lastConfirmLatencyMs = now - t;
          this.sendTimes.delete(idx);
        }
      }
    }
    return changed;
  }

  private flush(force: boolean, urgent = false) {
    const n = this.night;
    if (!this.pending.length) return;
    const now = performance.now();
    const body = this.pending[0].body;
    // only samples whose block the chain has reached can be accepted
    // samples the contract would reject as too late are dropped (a gap just means "stood still")
    this.pending = this.pending.filter((p) => n.blockOfIndex(p.index) + LATE_BLOCKS > n.chainBlock + 3);
    const ready = this.pending.filter((p) => n.blockOfIndex(p.index) <= n.chainBlock + 1);
    if (!ready.length) return;
    if (!force && !urgent && ready.length < 3 && now - this.lastSend < 1500) return;
    const nS = n.bodies[body]?.nSamples ?? 0;
    const batch = ready.filter((p) => p.body === body && p.index >= nS).slice(0, 8);
    // keep only a contiguous-in-time run inside one epoch
    if (!batch.length) {
      this.pending = this.pending.filter((p) => !(p.body === body && p.index < nS));
      return;
    }
    const epoch = n.epochAt(n.blockOfIndex(batch[0].index));
    const run = batch.filter((p) => n.epochAt(n.blockOfIndex(p.index)) === epoch);
    const first = run[0].index;
    let packed = 0n;
    let voice = 0;
    // indices must be consecutive within one call
    const consecutive: typeof run = [];
    for (const p of run) {
      if (p.index !== first + consecutive.length) break;
      consecutive.push(p);
      packed |= BigInt(p.pos) << BigInt(32 * (consecutive.length - 1));
      if (p.voice) voice = p.voice;
    }
    this.pending = this.pending.filter((p) => !consecutive.includes(p) && !(p.body === body && p.index < first));
    this.lastSend = now;
    this.sentSamples += consecutive.length;
    this.sendTimes.set(consecutive[consecutive.length - 1].index, now);
    // Monad charges the gas limit, so size it to what this call will actually do
    const newSlot = consecutive.some((p) => p.index % 8 === 0) || (consecutive[0].index >> 3) !== ((n.bodies[body]?.nSamples ?? 0) >> 3);
    const shiftDue = !!n.header && n.header.nextShift > 0 && n.chainBlock + 1 >= n.header.nextShift;
    const gas = 78_000n + (newSlot ? 24_000n : 0n) + (shiftDue ? 85_000n : 0n) + (voice ? 6_000n : 0n);
    void this.wallet.call('record', [n.id, this.soul, body, first, packed, consecutive.length, voice], { gas });
  }
}

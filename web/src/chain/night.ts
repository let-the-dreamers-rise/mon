import { encodeAbiParameters, hexToBigInt, keccak256, parseAbiItem, type Log } from 'viem';
import {
  CELL_CM,
  GRID,
  LATE_BLOCKS,
  MAX_GAP_STEPS,
  MAX_STEP_CM,
  NET,
  NIGHT_BLOCKS,
  OBJECTIVE_RADIUS_CM,
  SAMPLE_BLOCKS,
  SHOP_RADIUS_CM,
  SPAWN_RADIUS_CM,
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

// the contract's wall rules, mirrored exactly, so the client never sends a move the chain would reject
const wallWords = (map.walls as string[]).map((w) => BigInt(w));
const WORLD_CM = GRID * CELL_CM;
export function solidCm(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= WORLD_CM || y >= WORLD_CM) return true;
  const bit = Math.floor(y / CELL_CM) * GRID + Math.floor(x / CELL_CM);
  return ((wallWords[bit >> 8] >> BigInt(bit & 255)) & 1n) === 1n;
}
/** Hollow._clear: the hop a -> b is probed every <= 1.4 m (same integer maths as the contract) */
export function clearHop(a: number, b: number): boolean {
  const d2v = dist2(a, b);
  let k = 1;
  while (k * k * 19600 < d2v) k++;
  if (k === 1) return true;
  const A = unpack(a);
  const B = unpack(b);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  // Solidity's signed division truncates toward zero
  const div = (n: number) => Math.trunc(n / k);
  for (let i = 1; i < k; i++) if (solidCm(A.x + div(dx * i), A.y + div(dy * i))) return false;
  return true;
}

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

export const tormentEvent = parseAbiItem(
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
  protected predicted: Epoch[] = [];
  /** a locally predicted swap was confirmed (or contradicted) by the chain */
  onShiftVerified?: (epoch: number, ok: boolean, atBlock: number) => void;
  protected samples: Map<number, number>[] = [];
  chainBlock = 0;
  protected chainBlockAt = 0;
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
        // every swap this browser computed from a block hash is checked against what the chain stored
        for (const p of this.predicted) {
          const c = this.epochs[p.index];
          if (!c || p.index > this.header.epoch) continue;
          const ok = c.start === p.start && c.assign.slice(0, this.header.nSouls).join() === p.assign.slice(0, this.header.nSouls).join();
          this.onShiftVerified?.(p.index, ok, p.start);
        }
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

/** samples to skip after waking up in a new body: the previous wearer's last moves may still be landing */
const SWAP_SETTLE = 3;
/** below this a sample counts as standing still, and standing still is free (a gap means "stood still") */
const IDLE_CM = 6;

/**
 * Batches my own body's samples and submits them on time, switching bodies on shifts.
 *
 * It only ever produces samples the contract will accept: each one is clamped to the reach the
 * contract allows from the body's last sample (including the gap cap) and must pass the same wall
 * probes. If the player outran what the chain can accept (a lost transaction, a stale body after a
 * shift), `pull` holds the position the chain agrees with and the game drags the player back to it.
 */
export class Pilot {
  private pending: { index: number; pos: number; voice: number; body: number }[] = [];
  private nextIndex = -1;
  body = -1;
  epochIndex = -1;
  private lastSend = 0;
  sentSamples = 0;
  skippedSamples = 0;
  lastConfirmLatencyMs = 0;
  /** smoothed send-to-onchain latency in blocks: slow machines and links send earlier */
  private latBlocks = 3;
  private sendTimes = new Map<number, number>();
  /** the last sample queued for my body (index -1 = its spawn) */
  private tail: { index: number; pos: number } | null = null;
  private sentTo = -1;
  /** where the chain says I am, when I got ahead of it */
  pull: Vec | null = null;
  onDesync?: () => void;
  /** previous frame, to place each sample where the player was at its block (smooth at low fps) */
  private prev: { est: number; pos: Vec } | null = null;

  constructor(private night: NightState, private wallet: Burner, readonly soul: number) {}

  private chainTail(body: number) {
    const b = this.night.bodies[body];
    return b && b.nSamples > 0 ? { index: b.nSamples - 1, pos: b.lastPos } : { index: -1, pos: spawnOf(body) };
  }

  private nearObjective(p: number) {
    for (let i = 0; i < 4; i++) if (dist2(p, objective(i)) <= (OBJECTIVE_RADIUS_CM + 250) ** 2) return true;
    for (let i = 4; i < 7; i++) if (dist2(p, objective(i)) <= (SHOP_RADIUS_CM + 250) ** 2) return true;
    return false;
  }

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
      // drop samples that now belong to a body I no longer drive, and send my last moves in the old
      // one right away: its new wearer waits SWAP_SETTLE samples before writing over them
      this.pending = this.pending.filter((p) => n.blockOfIndex(p.index) < e.start);
      if (this.pending.length) this.flush(true);
      changed = nb !== this.body;
      this.epochIndex = e.index;
      this.body = nb;
      this.nextIndex = Math.ceil(n.indexAtBlock(est)) + (changed && e.index > 0 ? SWAP_SETTLE : 0);
      this.tail = null;
      this.sentTo = -1;
    }
    if (this.body < 0 || n.bodyGone(this.body)) return changed;
    if (this.nextIndex < 0) this.nextIndex = Math.ceil(n.indexAtBlock(est));

    // a batch that never landed (and now never can): the body is wherever the chain last saw it
    const cb = n.bodies[this.body];
    if (this.sentTo >= 0 && cb && cb.nSamples <= this.sentTo && n.chainBlock > n.blockOfIndex(this.sentTo) + LATE_BLOCKS + 8) {
      this.sentTo = -1;
      this.pending = this.pending.filter((p) => p.body !== this.body);
      this.tail = this.chainTail(this.body);
      this.pull = unpack(this.tail.pos);
      this.onDesync?.();
    }

    const prev = this.prev && this.prev.est < est && !changed ? this.prev : { est, pos };
    this.prev = { est, pos: { ...pos } };
    // never record past a shift whose new assignment isn't known yet (it needs the hash of the block
    // before it): those samples may belong to someone else's body by then
    const fence = n.nextShiftBlock();
    while (n.blockOfIndex(this.nextIndex) <= est && !(fence > 0 && n.blockOfIndex(this.nextIndex) >= fence)) {
      const idx = this.nextIndex++;
      if (!this.tail) this.tail = this.chainTail(this.body);
      const t = this.tail;
      const f = Math.min(1, Math.max(0, (n.blockOfIndex(idx) - prev.est) / (est - prev.est || 1)));
      let p = pack({ x: prev.pos.x + (pos.x - prev.pos.x) * f, y: prev.pos.y + (pos.y - prev.pos.y) * f });
      // the contract's reach from the last sample, with a margin for rounding and timing
      const steps = Math.min(idx - t.index, MAX_GAP_STEPS);
      const reach = ((t.index < 0 ? SPAWN_RADIUS_CM : 0) + MAX_STEP_CM * steps) * 0.9;
      if (dist2(p, t.pos) > reach * reach || !clearHop(t.pos, p) || solidCm(unpack(p).x, unpack(p).y)) {
        const a = unpack(t.pos);
        const b = unpack(p);
        const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const k = Math.min(1, reach / d);
        p = pack({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
        if (!clearHop(t.pos, p) || solidCm(unpack(p).x, unpack(p).y)) p = t.pos;
        this.pull = unpack(p);
      }
      const v = voice;
      if (!v && dist2(p, t.pos) < IDLE_CM * IDLE_CM && t.index >= 0 && !this.nearObjective(p)) {
        this.skippedSamples++;
        continue;
      }
      this.pending.push({ index: idx, pos: p, voice: v, body: this.body });
      voice = 0;
      n.addLocalSample(this.body, idx, p);
      this.tail = { index: idx, pos: p };
    }
    if (voice && this.pending.length) this.pending[this.pending.length - 1].voice = voice;
    // the game moves the player after a swap or a pull: don't interpolate across that jump
    if (changed || this.pull) this.prev = null;
    this.flush(false, voice !== 0);
    // confirmation latency: when the chain shows a sample we sent
    const b = n.bodies[this.body];
    if (b) {
      for (const [idx, t] of this.sendTimes) {
        if (idx < b.nSamples) {
          this.lastConfirmLatencyMs = now - t;
          const blocks = this.lastConfirmLatencyMs / Math.max(100, n.msPerBlock);
          this.latBlocks = Math.min(12, Math.max(2, this.latBlocks * 0.7 + blocks * 0.3));
          this.sendTimes.delete(idx);
        }
      }
    }
    return changed;
  }

  /** sends what is due even when frames are slow (called from a timer as well as every frame) */
  pump() {
    this.flush(false);
  }

  private flush(force: boolean, urgent = false) {
    const n = this.night;
    if (!this.pending.length) return;
    const now = performance.now();
    // judge age by the time-estimated block, not the last poll: a slow frame or poll must not
    // make us sit on samples until the contract rejects them
    const cur = Math.max(n.chainBlock, Math.floor(n.estBlock(now)));
    const body = this.pending[0].body;
    // samples that would land after the contract's window are dropped (a gap just means "stood still")
    const lat = Math.ceil(this.latBlocks);
    this.pending = this.pending.filter((p) => n.blockOfIndex(p.index) + LATE_BLOCKS > cur + lat + 1);
    // only samples whose block the chain has reached can be accepted
    const ready = this.pending.filter((p) => n.blockOfIndex(p.index) <= cur);
    if (!ready.length) return;
    // fewer, fuller transactions: wait for 6 samples or until the oldest has to go (the contract
    // accepts 16 blocks; keep this client's measured latency plus 4 blocks spare), unless a voice
    // line needs it now
    const oldest = n.blockOfIndex(ready[0].index);
    const sendAge = Math.max(0, LATE_BLOCKS - 4 - lat);
    if (!force && !urgent && ready.length < 6 && cur - oldest < sendAge) return;
    if (!force && !urgent && now - this.lastSend < 300) return;
    const nS = n.bodies[body]?.nSamples ?? 0;
    const batch = ready.filter((p) => p.body === body && p.index >= nS).slice(0, 8);
    if (!batch.length) {
      this.pending = this.pending.filter((p) => !(p.body === body && p.index < nS));
      return;
    }
    // keep a run inside one epoch
    const epoch = n.epochAt(n.blockOfIndex(batch[0].index));
    const run = batch.filter((p) => n.epochAt(n.blockOfIndex(p.index)) === epoch);
    const first = run[0].index;
    let packed = 0n;
    let voice = 0;
    // one call writes consecutive indices; an idle gap ends the call (the next one starts after it)
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
    const lastIdx = consecutive[consecutive.length - 1].index;
    this.sendTimes.set(lastIdx, now);
    this.sentTo = Math.max(this.sentTo, lastIdx);
    // the tx lands 1-3 blocks after this; if a shift is due by then this call applies it
    const shiftDue = !!n.header && n.header.nextShift > 0 && cur + 4 >= n.header.nextShift;
    const gas = recordGas(consecutive.length, first, nS, shiftDue, voice !== 0, n.header?.nSouls ?? 8);
    void this.wallet.call('record', [n.id, this.soul, body, first, packed, consecutive.length, voice], { gas });
  }
}

/**
 * Gas limit for a record() call. Monad charges the limit, not what was used, so it is sized to what
 * this call will actually do (calibrated with eth_estimateGas on Monad testnet; see RECORD_GAS).
 */
export function recordGas(count: number, first: number, nSamples: number, shiftDue: boolean, voice: boolean, nSouls: number): bigint {
  // storage slots this call writes for the first time (8 samples per slot)
  const last = first + count - 1;
  const lastWritten = nSamples > 0 ? (nSamples - 1) >> 3 : -1;
  const fresh = Math.max(0, (last >> 3) - Math.max(lastWritten, (first >> 3) - 1));
  let g = RECORD_GAS.base + RECORD_GAS.perSample * count + RECORD_GAS.newSlot * fresh + (nSamples === 0 ? RECORD_GAS.first : 0);
  if (shiftDue) g += RECORD_GAS.shiftBase + RECORD_GAS.shiftPerSoul * nSouls;
  if (voice) g += RECORD_GAS.voice;
  return BigInt(Math.ceil(g * 1.08));
}

/** measured with eth_estimateGas on Monad testnet (243 calls): 4 samples 65.4k p50, a new slot +17.6k,
 *  a body's first batch ~120k, a shift +~40k with 3 souls */
export const RECORD_GAS = { base: 57_000, perSample: 2_500, newSlot: 22_500, first: 40_000, shiftBase: 30_000, shiftPerSoul: 4_000, voice: 4_000 };

import { parseEventLogs, type Hex } from 'viem';
import { NET, NIGHT_BLOCKS, SAMPLE_BLOCKS } from '../config';
import { hollowAbi } from './abi';
import { NightState, decodeName, short, type BodyInfo, type NightHeader, type SoulInfo } from './night';
import { publicClient } from './wallet';

const SAMPLE_SLOTS = 128;
const LOG_CHUNK = 100; // Monad RPCs cap eth_getLogs ranges

type Timed<T> = T & { at: number };

/**
 * A finished night, rebuilt from nothing but the chain: the header, the epoch history, every
 * body's samples and the night's events. It plays back on a virtual clock, revealing touches,
 * fuses, escapes, voices and torments as their blocks come around. Nothing is ever sent.
 */
export class ReplayNight extends NightState {
  private final!: NightHeader;
  private finalSouls: SoulInfo[] = [];
  private finalBodies: BodyInfo[] = [];
  private fuseAt: Timed<{ fuse: number }>[] = [];
  private voices: Timed<{ body: number; voice: number; index: number }>[] = [];
  private tormentLog: Timed<{ watcher: Hex; kind: number; body: number; tx: Hex }>[] = [];
  private usedLog: Timed<{ body: number; soul: number; item: number; pos: number; tx: Hex }>[] = [];
  private fired = new Set<string>();
  private t0 = 0;
  /** first and last block of the footage */
  from = 0;
  to = 0;
  speed = 1;

  static async load(id: bigint, onProgress?: (msg: string) => void): Promise<ReplayNight> {
    const r = new ReplayNight(id);
    await r.fetch(onProgress);
    return r;
  }

  private read<T>(functionName: string, args: unknown[]): Promise<T> {
    return publicClient.readContract({ address: NET.hollow, abi: hollowAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
  }

  private async fetch(onProgress?: (msg: string) => void) {
    const id = this.id;
    onProgress?.('reading the night header');
    const n = await this.read<Record<string, bigint | number | string>>('nights', [id]);
    const h: NightHeader = {
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
    if (!h.startBlock) throw new Error(`night ${id} never started`);
    const tip = Number(await publicClient.getBlockNumber());
    const end = h.endBlock || h.startBlock + NIGHT_BLOCKS;
    if (tip < end) throw new Error(`night ${id} is still running — watch it live instead`);
    this.final = h;
    this.from = h.startBlock - 24;
    this.to = end + 8;

    onProgress?.('reading souls and epochs');
    const [addrs, names, hollowSince, escapedRel] = await this.read<[Hex[], Hex[], bigint[], number[]]>('getSouls', [id]);
    this.finalSouls = addrs.map((addr, i) => ({
      addr,
      name: decodeName(names[i]) || short(addr),
      hollowSince: Number(hollowSince[i]),
      escapedRel: Number(escapedRel[i]),
    }));
    const words = await this.read<readonly bigint[]>('getEpochs', [id, 0n]);
    this.epochs = words.map((w, k) => ({
      index: k,
      assign: Array.from({ length: 8 }, (_, b) => Number((w >> BigInt(4 * b)) & 0xfn)),
      start: Number((w >> 32n) & 0xffffffffffffffffn),
      mask: Number((w >> 96n) & 0xffn),
      nextShift: 0,
      predicted: false,
    }));
    this.epochs.forEach((e, k) => (e.nextShift = this.epochs[k + 1]?.start ?? end + 1));

    onProgress?.('reading every recorded step');
    const snap = (await this.read<unknown[]>('snapshot', [id, 0n])) as [unknown, bigint, bigint, Record<string, unknown>[], bigint[]];
    this.finalBodies = snap[3].map((b) => ({
      nSamples: Number(b.nSamples),
      lastPos: Number(b.lastPos),
      goneRel: Number(b.goneRel),
      voice: 0,
      voiceIndex: 0,
    }));
    this.samples = [];
    for (let b = 0; b < h.nSouls; b++) {
      const nS = this.finalBodies[b].nSamples;
      const slots = Math.min(SAMPLE_SLOTS, Math.ceil(nS / 8));
      const m = new Map<number, number>();
      if (slots > 0) {
        const raw = await this.read<readonly bigint[]>('getSampleSlots', [id, b, 0n, BigInt(slots)]);
        raw.forEach((w, s) => {
          for (let k = 0; k < 8; k++) {
            const v = Number((w >> BigInt(32 * k)) & 0xffffffffn);
            if (v) m.set(s * 8 + k, v);
          }
        });
      }
      this.samples.push(m);
    }

    onProgress?.('reading the night’s events');
    for (let a = this.from; a <= this.to; a += LOG_CHUNK) {
      const raw = await publicClient.getLogs({ address: NET.hollow, fromBlock: BigInt(a), toBlock: BigInt(Math.min(this.to, a + LOG_CHUNK - 1)) });
      const logs = parseEventLogs({ abi: hollowAbi, logs: raw }) as unknown as {
        eventName: string;
        args: Record<string, bigint | number | string>;
        blockNumber: bigint;
        transactionHash: Hex;
      }[];
      for (const l of logs) {
        if (BigInt(l.args.night ?? -1n) !== id) continue;
        const at = Number(l.blockNumber);
        if (l.eventName === 'FuseCollected') this.fuseAt.push({ fuse: Number(l.args.fuse), at });
        if (l.eventName === 'Voice') {
          const index = Number(l.args.sampleIndex);
          this.voices.push({ body: Number(l.args.body), voice: Number(l.args.voice), index, at: h.startBlock + index * SAMPLE_BLOCKS });
        }
        if (l.eventName === 'Torment')
          this.tormentLog.push({ watcher: l.args.watcher as Hex, kind: Number(l.args.kind), body: Number(l.args.body), tx: l.transactionHash, at });
        if (l.eventName === 'Used')
          this.usedLog.push({ body: Number(l.args.body), soul: Number(l.args.soul), item: Number(l.args.item), pos: Number(l.args.pos), tx: l.transactionHash, at });
      }
    }
    this.msPerBlock = NET.blockMs;
    try {
      const [b0, b1] = await Promise.all([publicClient.getBlock({ blockNumber: BigInt(h.startBlock) }), publicClient.getBlock({ blockNumber: BigInt(end) })]);
      const ms = (Number(b1.timestamp - b0.timestamp) * 1000) / Math.max(1, end - h.startBlock);
      // Monad timestamps are whole seconds: only trust the measurement over a long night
      if (end - h.startBlock > 300 && ms > 150 && ms < 2000) this.msPerBlock = ms;
    } catch {
      /* keep the configured block time */
    }
    this.pockets = Array.from({ length: h.nSouls }, () => [0, 0, 0, 0, 0, 0]);
    this.applyAt(this.from);
  }

  /** start (or restart) the footage now */
  play(now = performance.now(), fromBlock = this.from) {
    this.t0 = now - ((fromBlock - this.from) * this.msPerBlock) / this.speed;
    this.fired.clear();
  }

  override estBlock(now = performance.now()): number {
    if (!this.t0) return this.from;
    return Math.min(this.to, this.from + ((now - this.t0) * this.speed) / this.msPerBlock);
  }

  /** the night as it stood at block `vb` */
  override async poll(): Promise<void> {
    const vb = this.estBlock();
    this.applyAt(vb);
    for (const t of this.tormentLog) {
      const key = `t${t.tx}${t.kind}`;
      if (t.at <= vb && !this.fired.has(key)) {
        this.fired.add(key);
        this.torments.push({ ...t, atBlock: t.at });
        this.watcherAddrs.add(t.watcher.toLowerCase());
        this.onTorment?.({ ...t, atBlock: t.at });
      }
    }
    for (const u of this.usedLog) {
      const key = `u${u.tx}${u.item}`;
      if (u.at <= vb && !this.fired.has(key)) {
        this.fired.add(key);
        this.onUsed?.({ ...u, atBlock: u.at });
      }
    }
  }

  private applyAt(vb: number) {
    const f = this.final;
    const start = f.startBlock;
    this.chainBlock = Math.floor(vb);
    this.chainBlockAt = performance.now();
    this.souls = this.finalSouls.map((s) => ({
      ...s,
      hollowSince: s.hollowSince && s.hollowSince <= vb ? s.hollowSince : 0,
      escapedRel: s.escapedRel && start + s.escapedRel <= vb ? s.escapedRel : 0,
    }));
    let goneMask = 0;
    this.bodies = this.finalBodies.map((b, i) => {
      const gone = b.goneRel && start + b.goneRel <= vb;
      if (gone) goneMask |= 1 << i;
      const said = this.voices.filter((v) => v.body === i && v.at <= vb).pop();
      return { ...b, goneRel: gone ? b.goneRel : 0, voice: said?.voice ?? 0, voiceIndex: said?.index ?? 0 };
    });
    let fuses = 0;
    for (const x of this.fuseAt) if (x.at <= vb) fuses |= 1 << x.fuse;
    let epoch = 0;
    for (const e of this.epochs) if (e.start <= vb) epoch = e.index;
    const escapedCount = this.souls.filter((s) => s.escapedRel).length;
    const living = this.souls.filter((s) => !s.escapedRel && !(s.hollowSince && s.hollowSince <= vb)).length;
    this.header = {
      ...f,
      living: vb < start ? f.nSouls : living,
      fuses,
      goneMask,
      exitOpenBlock: f.exitOpenBlock && f.exitOpenBlock <= vb ? f.exitOpenBlock : 0,
      endBlock: f.endBlock && f.endBlock <= vb ? f.endBlock : 0,
      epoch,
      escapedCount,
      nextShift: this.epochs[epoch + 1]?.start ?? 0,
    };
  }
}

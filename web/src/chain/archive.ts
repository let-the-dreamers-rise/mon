import { formatEther, type Hex } from 'viem';
import { NET, NIGHT_BLOCKS } from '../config';
import { hollowAbi } from './abi';
import { decodeName, short } from './night';
import { publicClient } from './wallet';

export interface ArchiveSoul {
  addr: Hex;
  name: string;
  /** Hollow from the first block: the one who started it */
  origin: boolean;
  turned: boolean;
  escaped: boolean;
}

export interface NightOutcome {
  id: bigint;
  souls: ArchiveSoul[];
  pot: bigint;
  /** who the contract pays: escapees, else everyone who ended Hollow, else the lone soul */
  winners: number[];
  kind: 'escaped' | 'hollow' | 'alone';
  fuses: number;
}

export interface HauntedRow {
  addr: Hex;
  name: string;
  nights: number;
  escapes: number;
  hollow: number;
  wins: number;
  won: bigint;
}

const read = <T>(functionName: string, args: unknown[]) =>
  publicClient.readContract({ address: NET.hollow, abi: hollowAbi, functionName: functionName as never, args: args as never }) as Promise<T>;

/**
 * The competitive feed: every finished night's outcome and a leaderboard of souls, read straight
 * from the contract's views (no indexer, no server). Mirrors Hollow.claimPot's winner rule.
 */
export async function loadArchive(maxNights = 40): Promise<{ nights: NightOutcome[]; board: HauntedRow[] }> {
  const count = await read<bigint>('nightCount', []);
  const tip = await publicClient.getBlockNumber();
  const ids: bigint[] = [];
  for (let i = count; i > 0n && ids.length < maxNights; i--) ids.push(i);
  const nights = (
    await Promise.all(
      ids.map(async (id): Promise<NightOutcome | null> => {
        const n = await read<{ startBlock: bigint; endBlock: bigint; fuses: number; escapedCount: number }>('nights', [id]);
        if (!n.startBlock) return null;
        const over = n.endBlock > 0n || tip >= n.startBlock + BigInt(NIGHT_BLOCKS);
        if (!over) return null;
        const [[addrs, names, hollowSince, escapedRel], pot] = await Promise.all([
          read<[Hex[], Hex[], bigint[], number[]]>('getSouls', [id]),
          read<bigint>('pot', [id]),
        ]);
        const souls = addrs.map((addr, i) => ({
          addr,
          name: decodeName(names[i]) || short(addr),
          origin: hollowSince[i] === n.startBlock,
          turned: hollowSince[i] > n.startBlock,
          escaped: Number(escapedRel[i]) > 0,
        }));
        let winners = souls.flatMap((s, i) => (s.escaped ? [i] : []));
        let kind: NightOutcome['kind'] = 'escaped';
        if (!winners.length) {
          winners = souls.flatMap((s, i) => (s.origin || s.turned ? [i] : []));
          kind = 'hollow';
        }
        if (!winners.length) {
          winners = souls.map((_, i) => i);
          kind = 'alone';
        }
        return { id, souls, pot, winners, kind, fuses: Number(n.fuses) };
      }),
    )
  ).filter((x): x is NightOutcome => !!x);

  const rows = new Map<string, HauntedRow>();
  for (const n of [...nights].reverse()) {
    const share = n.winners.length ? n.pot / BigInt(n.winners.length) : 0n;
    n.souls.forEach((s, i) => {
      const k = s.addr.toLowerCase();
      const r = rows.get(k) ?? { addr: s.addr, name: s.name, nights: 0, escapes: 0, hollow: 0, wins: 0, won: 0n };
      r.name = s.name;
      r.nights++;
      if (s.escaped) r.escapes++;
      if (s.origin || s.turned) r.hollow++;
      if (n.winners.includes(i)) {
        r.wins++;
        r.won += share;
      }
      rows.set(k, r);
    });
  }
  const board = [...rows.values()].sort((a, b) => (a.won === b.won ? b.wins - a.wins || b.escapes - a.escapes : a.won > b.won ? -1 : 1));
  return { nights, board };
}

/** one line of the feed, e.g. "NADIA was the Hollow · MARA, TOBIAS turned · nobody got out" */
export function describe(n: NightOutcome): string {
  const names = (f: (s: ArchiveSoul) => boolean) => n.souls.filter(f).map((s) => s.name);
  const parts: string[] = [];
  const origin = names((s) => s.origin);
  if (origin.length) parts.push(`${origin.join(' & ')} ${origin.length > 1 ? 'were' : 'was'} the Hollow`);
  const turned = names((s) => s.turned);
  if (turned.length) parts.push(`${turned.join(', ')} turned`);
  const out = names((s) => s.escaped);
  parts.push(out.length ? `${out.join(', ')} got out` : 'nobody got out');
  const pot = Number(formatEther(n.pot));
  if (pot > 0) parts.push(n.kind === 'escaped' ? `${pot.toFixed(3)} MON to the survivors` : n.kind === 'hollow' ? `the Hollow kept ${pot.toFixed(3)} MON` : `${pot.toFixed(3)} MON returned`);
  return parts.join(' · ');
}

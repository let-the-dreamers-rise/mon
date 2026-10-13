// Real gas use of Hollow calls on a live chain (Monad charges the gas LIMIT, so size limits from this).
//   node scripts/gas-report.mjs --rpc https://testnet-rpc.monad.xyz --hollow 0x... --from <block> --to <block>
import { readFileSync } from 'node:fs';
import { createPublicClient, http, toFunctionSelector } from 'viem';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const abi = JSON.parse(readFileSync(new URL('../../contracts/out/Hollow.sol/Hollow.json', import.meta.url))).abi;
const names = new Map(abi.filter((f) => f.type === 'function').map((f) => [toFunctionSelector(f), f.name]));
const client = createPublicClient({ transport: http(args.rpc ?? 'http://127.0.0.1:8545') });
const target = args.hollow.toLowerCase();
const to = args.to ? BigInt(args.to) : await client.getBlockNumber();
const from = args.from ? BigInt(args.from) : to - 400n;

const stats = new Map();
for (let b = from; b <= to; b++) {
  const blk = await client.getBlock({ blockNumber: b, includeTransactions: true });
  for (const tx of blk.transactions) {
    if (tx.to?.toLowerCase() !== target) continue;
    const r = await client.getTransactionReceipt({ hash: tx.hash });
    const name = names.get(tx.input.slice(0, 10)) ?? '?';
    const s = stats.get(name) ?? { used: [], limits: [], fails: 0 };
    s.used.push(Number(r.gasUsed));
    s.limits.push(Number(tx.gas));
    if (r.status !== 'success') s.fails++;
    stats.set(name, s);
  }
}
for (const [name, s] of stats) {
  const u = [...s.used].sort((a, b) => a - b);
  const pct = (p) => u[Math.min(u.length - 1, Math.floor(p * u.length))];
  console.log(`${name.padEnd(12)} n=${String(u.length).padStart(4)}  used p50 ${pct(0.5)}  p95 ${pct(0.95)}  max ${u[u.length - 1]}  failed ${s.fails}`);
}

// Recomputes every body swap of a night from public block hashes, exactly the way the browser
// predicts them, and checks the result against what Hollow.sol stored. Anyone can audit a night.
//   node scripts/verify-shifts.mjs --rpc https://testnet-rpc.monad.xyz --hollow 0x... --night 3
import { readFileSync } from 'node:fs';
import { createPublicClient, encodeAbiParameters, hexToBigInt, http, keccak256 } from 'viem';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const abi = JSON.parse(readFileSync(new URL('../../contracts/out/Hollow.sol/Hollow.json', import.meta.url))).abi;
const client = createPublicClient({ transport: http(args.rpc ?? 'http://127.0.0.1:8545') });
const read = (functionName, a) => client.readContract({ address: args.hollow, abi, functionName, args: a });
const id = BigInt(args.night ?? 1);

const night = await read('nights', [id]);
const nSouls = Number(night[2]);
const goneMask = Number(night[5]);
const words = await read('getEpochs', [id, 0n]);
const parse = (w) => ({
  assign: Array.from({ length: 8 }, (_, b) => Number((w >> BigInt(4 * b)) & 0xfn)),
  start: Number((w >> 32n) & 0xffffffffffffffffn),
});
const epochs = words.map(parse);
console.log(`night ${id}: ${nSouls} souls, ${epochs.length} epochs on chain`);
let ok = true;
for (let e = 1; e < epochs.length; e++) {
  const prev = epochs[e - 1];
  const S = epochs[e].start;
  const blk = await client.getBlock({ blockNumber: BigInt(S - 1) });
  const ei = BigInt(e - 1);
  let seed = hexToBigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }], [blk.hash, id, ei])));
  const list = [];
  for (let i = 0; i < nSouls; i++) if (((goneMask >> i) & 1) === 0) list.push(i);
  const soulOf = list.map((b) => prev.assign[b]);
  for (let k = list.length; k > 1; k--) {
    const j = Number(seed % BigInt(k - 1));
    [soulOf[k - 1], soulOf[j]] = [soulOf[j], soulOf[k - 1]];
    seed = hexToBigInt(keccak256(encodeAbiParameters([{ type: 'uint256' }], [seed])));
  }
  const predicted = [...prev.assign];
  list.forEach((b, k) => (predicted[b] = soulOf[k]));
  const chain = epochs[e].assign.slice(0, nSouls).join(',');
  const mine = predicted.slice(0, nSouls).join(',');
  const match = chain === mine;
  ok &&= match;
  console.log(`epoch ${e} @ block ${S}: chain [${chain}] predicted [${mine}] ${match ? 'MATCH' : 'MISMATCH'}`);
}
console.log(ok ? 'all shifts verified from block hashes' : 'mismatch found');
process.exit(ok ? 0 : 1);

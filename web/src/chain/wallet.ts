import {
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  fallback,
  formatEther,
  http,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { GAS, MAX_FEE, NET, PRIORITY_FEE, type Hex } from '../config';
import { hollowAbi } from './abi';

const KEY = `hollow.burner.${NET.chainId}`;

function loadKey(): Hex {
  try {
    const k = localStorage.getItem(KEY);
    if (k && /^0x[0-9a-fA-F]{64}$/.test(k)) return k as Hex;
  } catch {
    /* storage blocked: fall through to an ephemeral key */
  }
  const k = generatePrivateKey();
  try {
    localStorage.setItem(KEY, k);
  } catch {
    /* ephemeral session */
  }
  return k;
}

export const chain = {
  id: NET.chainId,
  name: NET.name,
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: NET.rpcs } },
} as const;

export const publicClient: PublicClient = createPublicClient({
  chain,
  transport: fallback(NET.rpcs.map((u) => http(u, { batch: false, retryCount: 1, timeout: 8_000 }))),
  pollingInterval: 300,
});

type FnName = keyof typeof GAS;

export interface SentTx {
  hash: Hex;
  fn: string;
  at: number;
}

/** A burner "session wallet": signs locally, tracks its own nonce, never waits on receipts. */
export class Burner {
  readonly account: PrivateKeyAccount;
  private nonce: number | null = null;
  private sending: Promise<unknown> = Promise.resolve();
  private lastSentAt = 0;
  readonly sent: SentTx[] = [];
  onSent?: (tx: SentTx) => void;
  onError?: (fn: string, err: unknown) => void;

  constructor(key: Hex = loadKey()) {
    this.account = privateKeyToAccount(key);
  }

  get address(): Hex {
    return this.account.address;
  }

  async balance(): Promise<bigint> {
    return publicClient.getBalance({ address: this.address });
  }

  async balanceText(): Promise<string> {
    const b = await this.balance();
    return Number(formatEther(b)).toFixed(3);
  }

  private async nextNonce(): Promise<number> {
    if (this.nonce === null) {
      this.nonce = await publicClient.getTransactionCount({ address: this.address, blockTag: 'pending' });
    }
    return this.nonce++;
  }

  resyncNonce() {
    this.nonce = null;
  }

  /**
   * Encode, sign and broadcast a Hollow call. Calls are serialized so nonces stay ordered.
   *
   * Every call except record() is simulated first: a call that would revert is not sent at all
   * (on Monad a revert still pays the whole gas limit), and the limit is the estimate plus a margin
   * instead of a guess. record() is hot and sizes its own limit (see recordGas).
   */
  async call(fn: FnName | string, args: readonly unknown[], opts: { value?: bigint; gas?: bigint } = {}): Promise<Hex | null> {
    const data = encodeFunctionData({ abi: hollowAbi, functionName: fn as never, args: args as never });
    let gas = opts.gas;
    if (gas === undefined) {
      try {
        const est = await publicClient.estimateGas({ account: this.address, to: NET.hollow, data, value: opts.value ?? 0n });
        // margin: a shift may become due between the estimate and inclusion (_sync then does more)
        gas = (est * 125n) / 100n + 15_000n;
      } catch (err) {
        if (isRevert(err)) {
          this.onError?.(String(fn), err);
          return null;
        }
        gas = GAS[fn as FnName] ?? 200_000n;
      }
    }
    return this.send(String(fn), data, gas, opts.value ?? 0n);
  }

  private send(fn: string, data: Hex, gas: bigint, value: bigint): Promise<Hex | null> {
    const run = async (): Promise<Hex | null> => {
      // Monad reserve balance: an account under 10 MON may only send value if it sent nothing in
      // the previous 3 blocks, so open a quiet window first (movement txs queue up behind this).
      if (value > 0n) {
        const wait = 2300 - (performance.now() - this.lastSentAt);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      try {
        const nonce = await this.nextNonce();
        const raw = await this.account.signTransaction({
          chainId: NET.chainId,
          type: 'eip1559',
          to: NET.hollow,
          data,
          gas,
          nonce,
          value,
          maxFeePerGas: MAX_FEE,
          maxPriorityFeePerGas: PRIORITY_FEE,
        });
        const hash = await publicClient.request({ method: 'eth_sendRawTransaction', params: [raw] });
        // the RPC is not trusted: whatever it returns ends up in links and the DOM
        if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('RPC returned a malformed transaction hash');
        this.lastSentAt = performance.now();
        const tx = { hash: hash as Hex, fn, at: performance.now() };
        this.sent.push(tx);
        if (this.sent.length > 400) this.sent.splice(0, 100);
        this.onSent?.(tx);
        return hash as Hex;
      } catch (err) {
        this.resyncNonce(); // the failed tx may have consumed our local nonce
        this.onError?.(fn, err);
        return null;
      }
    };
    const p = this.sending.then(run, run);
    this.sending = p;
    return p;
  }

  /** Send everything this session wallet holds (minus the transfer's own cost) back to `to`. */
  async sweep(to: Hex): Promise<Hex | null> {
    const run = async (): Promise<Hex | null> => {
      const bal = await this.balance();
      const fee = 21_000n * MAX_FEE;
      if (bal <= fee) return null;
      const wait = 2300 - (performance.now() - this.lastSentAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        const nonce = await this.nextNonce();
        const raw = await this.account.signTransaction({
          chainId: NET.chainId,
          type: 'eip1559',
          to,
          gas: 21_000n,
          nonce,
          value: bal - fee,
          maxFeePerGas: MAX_FEE,
          maxPriorityFeePerGas: PRIORITY_FEE,
        });
        const hash = await publicClient.request({ method: 'eth_sendRawTransaction', params: [raw] });
        if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('RPC returned a malformed transaction hash');
        this.lastSentAt = performance.now();
        return hash as Hex;
      } catch (err) {
        this.resyncNonce();
        this.onError?.('sweep', err);
        return null;
      }
    };
    const p = this.sending.then(run, run);
    this.sending = p;
    return p;
  }

  async callAndWait(fn: FnName | string, args: readonly unknown[], opts: { value?: bigint; gas?: bigint } = {}) {
    let reason = '';
    const prev = this.onError;
    this.onError = (f, err) => {
      reason = explainError(err);
      prev?.(f, err);
    };
    const hash = await this.call(fn, args, opts).finally(() => (this.onError = prev));
    if (!hash) throw new Error(`${fn}: ${reason || 'could not be sent'}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 30_000 });
    if (receipt.status !== 'success') throw new Error(`${fn} reverted`);
    return receipt;
  }
}

/** The player's injected wallet address (one popup the first time). */
export async function connectInjected(): Promise<Hex> {
  const eth = (window as unknown as { ethereum?: { request: (a: { method: string }) => Promise<unknown> } }).ethereum;
  if (!eth) throw new Error('No browser wallet found.');
  const [a] = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error('No account selected.');
  return a as Hex;
}

/** A readable reason for a failed call: the contract's custom error name when there is one. */
/** what to tell a player whose session wallet can't pay for gas */
export const NO_GAS = 'your session wallet has no MON for gas. Top it up: "top up 1 MON from my wallet", or send testnet MON from faucet.monad.xyz to the session address.';

export function explainError(err: unknown): string {
  // Monad answers an unfunded sender with -32000 "Signer had insufficient balance", which viem
  // labels "Missing or invalid parameters"; say what actually happened
  for (let e: unknown = err, depth = 0; e && depth < 6; depth++, e = (e as { cause?: unknown }).cause) {
    const x = e as { details?: unknown; message?: unknown };
    if (/insufficient (balance|funds)/i.test(`${x.details ?? ''} ${x.message ?? ''}`)) return NO_GAS;
  }
  let e: unknown = err;
  for (let depth = 0; e && depth < 6; depth++) {
    const data = (e as { data?: unknown }).data;
    const hex = typeof data === 'string' ? data : (data as { data?: unknown })?.data;
    if (typeof hex === 'string' && /^0x[0-9a-fA-F]{8}/.test(hex)) {
      try {
        return decodeErrorResult({ abi: hollowAbi, data: hex as Hex }).errorName;
      } catch {
        /* not one of ours */
      }
    }
    e = (e as { cause?: unknown }).cause;
  }
  const m = err as { shortMessage?: string; message?: string };
  return String(m?.shortMessage ?? m?.message ?? err);
}

/** true if a call failed because the contract would revert (not because the RPC is down) */
function isRevert(err: unknown): boolean {
  const e = err as { name?: string; shortMessage?: string; message?: string; cause?: unknown };
  const text = `${e?.name ?? ''} ${e?.shortMessage ?? ''} ${e?.message ?? ''}`;
  return /revert|execution reverted|ContractFunctionRevertedError|CallExecutionError/i.test(text);
}

/** Ask an injected wallet (MetaMask etc.) to top up the burner. One popup, then none. */
export async function fundFromInjected(to: Hex, amountWei: bigint): Promise<string> {
  const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
  if (!eth) throw new Error('No browser wallet found. Send MON to the session address instead.');
  const [from] = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  const hexChain = '0x' + NET.chainId.toString(16);
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChain }] });
  } catch {
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: hexChain, chainName: NET.name, nativeCurrency: chain.nativeCurrency, rpcUrls: NET.rpcs, blockExplorerUrls: NET.explorer ? [NET.explorer] : [] }],
    });
  }
  return (await eth.request({ method: 'eth_sendTransaction', params: [{ from, to, value: '0x' + amountWei.toString(16) }] })) as string;
}

/** The connected injected wallet address, if the player already granted it (no popup). */
export async function injectedAddress(): Promise<Hex | null> {
  const eth = (window as unknown as { ethereum?: { request: (a: { method: string }) => Promise<unknown> } }).ethereum;
  if (!eth) return null;
  try {
    const accts = (await eth.request({ method: 'eth_accounts' })) as string[];
    return (accts[0] as Hex) ?? null;
  } catch {
    return null;
  }
}

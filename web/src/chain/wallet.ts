import {
  createPublicClient,
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

  /** Encode, sign and broadcast a Hollow call. Calls are serialized so nonces stay ordered. */
  call(fn: FnName | string, args: readonly unknown[], opts: { value?: bigint; gas?: bigint } = {}): Promise<Hex | null> {
    const run = async (): Promise<Hex | null> => {
      const data = encodeFunctionData({ abi: hollowAbi, functionName: fn as never, args: args as never });
      const gas = opts.gas ?? GAS[fn as FnName] ?? 200_000n;
      try {
        const nonce = await this.nextNonce();
        const raw = await this.account.signTransaction({
          chainId: NET.chainId,
          type: 'eip1559',
          to: NET.hollow,
          data,
          gas,
          nonce,
          value: opts.value ?? 0n,
          maxFeePerGas: MAX_FEE,
          maxPriorityFeePerGas: PRIORITY_FEE,
        });
        const hash = (await publicClient.request({ method: 'eth_sendRawTransaction', params: [raw] })) as Hex;
        const tx = { hash, fn: String(fn), at: performance.now() };
        this.sent.push(tx);
        if (this.sent.length > 400) this.sent.splice(0, 100);
        this.onSent?.(tx);
        return hash;
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (/nonce/i.test(msg)) this.resyncNonce();
        this.onError?.(String(fn), err);
        return null;
      }
    };
    const p = this.sending.then(run, run);
    this.sending = p;
    return p;
  }

  async callAndWait(fn: FnName | string, args: readonly unknown[], opts: { value?: bigint; gas?: bigint } = {}) {
    const hash = await this.call(fn, args, opts);
    if (!hash) throw new Error(`${fn} could not be sent`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 30_000 });
    if (receipt.status !== 'success') throw new Error(`${fn} reverted`);
    return receipt;
  }
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

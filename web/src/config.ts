import deployments from './deployments.json';

export type Hex = `0x${string}`;

export interface Network {
  chainId: number;
  name: string;
  rpcs: string[];
  explorer: string;
  hollow: Hex;
  /** expected block time; refined at runtime from observed blocks */
  blockMs: number;
  /** Monad mainnet RPC used only to read a player's public history for the intro whisper */
  historyRpc?: string;
}

const params = new URLSearchParams(location.search);
export const IS_LOCAL = params.has('local');

const deployed = deployments as Record<string, { hollow?: string }>;

const testnet: Network = {
  chainId: 10143,
  name: 'Monad Testnet',
  rpcs: ['https://testnet-rpc.monad.xyz', 'https://rpc-testnet.monadinfra.com', 'https://rpc.ankr.com/monad_testnet'],
  explorer: 'https://testnet.monadvision.com',
  hollow: (import.meta.env.VITE_HOLLOW_ADDRESS ?? deployed['10143']?.hollow ?? '0x0000000000000000000000000000000000000000') as Hex,
  blockMs: 300,
  historyRpc: 'https://rpc.monad.xyz',
};

const local: Network = {
  chainId: 31337,
  name: 'Local Anvil',
  rpcs: [params.get('rpc') ?? 'http://127.0.0.1:8545'],
  explorer: '',
  hollow: (params.get('hollow') ?? deployed['31337']?.hollow ?? '0x5FbDB2315678afecb367f032d93F642f64180aa3') as Hex,
  blockMs: 1000,
};

export const NET: Network = IS_LOCAL ? local : testnet;

/**
 * Fallback gas limits per call, keyed by contract function. Monad charges the full limit, so every
 * call except record() is simulated first (eth_estimateGas) and sent with a small margin; these are
 * only used if the estimate fails for a reason other than a revert. record() sizes its own limit.
 */
export const GAS = {
  record: 120_000n,
  sync: 140_000n,
  turn: 160_000n,
  collectFuse: 160_000n,
  escape: 160_000n,
  claimPot: 120_000n,
  join: 140_000n,
  createNight: 120_000n,
  start: 260_000n,
  torment: 160_000n,
  setName: 60_000n,
  buy: 170_000n,
  use: 110_000n,
} as const;

export const MAX_FEE = 130_000_000_000n; // 130 gwei (Monad testnet base fee floor is 100)
export const PRIORITY_FEE = 1_000_000_000n; // 1 gwei
export const TORMENT_FEE = 10_000_000_000_000_000n; // 0.01 MON

// ---------------------------------------------------------------- contract constants (mirrors Hollow.sol)
export const GRID = 64;
export const CELL_CM = 300;
export const SAMPLE_BLOCKS = 2;
export const LATE_BLOCKS = 16;
export const START_GRACE_BLOCKS = 30;
export const SHIFT_GRACE_BLOCKS = 10;
export const SHIFT_MIN = 100;
export const SHIFT_RANGE = 150;
export const NIGHT_BLOCKS = 2000;
export const TURN_RADIUS_CM = 120;
export const OBJECTIVE_RADIUS_CM = 160;
export const MAX_STEP_CM = 420;
export const MAX_GAP_STEPS = LATE_BLOCKS / SAMPLE_BLOCKS;
export const SPAWN_RADIUS_CM = 200;
export const SHOP_RADIUS_CM = 250;

export const ITEMS = [
  { id: 0, key: 'battery', name: 'Battery', shop: 0, price: 4_000_000_000_000_000n, desc: 'Torch back to 100%' },
  { id: 1, key: 'flare', name: 'Flare', shop: 0, price: 8_000_000_000_000_000n, desc: 'Red light for 25s. Everyone sees it.' },
  { id: 2, key: 'musicbox', name: 'Music box', shop: 0, price: 6_000_000_000_000_000n, desc: 'A lullaby lure everyone hears' },
  { id: 3, key: 'pills', name: 'Pills', shop: 1, price: 4_000_000_000_000_000n, desc: '+40% sanity, no visions for 30s' },
  { id: 4, key: 'adrenaline', name: 'Adrenaline', shop: 1, price: 10_000_000_000_000_000n, desc: '12s sprint, no stamina cost' },
  { id: 5, key: 'polaroid', name: 'Polaroid', shop: 2, price: 20_000_000_000_000_000n, desc: 'Photograph a figure. See who is inside.' },
] as const;

export const VOICES = ['', 'help', 'here', 'itsme', 'donttrust', 'fuse', 'run'] as const;
export const VOICE_LABELS = ['', 'Help me', 'Over here', "It's me", "Don't trust them", 'I found a fuse', 'Run'];

export const TORMENTS = [
  { kind: 1, label: 'Kill the lights', icon: '◐', price: TORMENT_FEE },
  { kind: 2, label: 'Whisper', icon: '∿', price: TORMENT_FEE },
  { kind: 3, label: 'Scream', icon: '!', price: TORMENT_FEE },
  { kind: 4, label: 'Force a shift', icon: '⇄', price: TORMENT_FEE * 5n },
] as const;

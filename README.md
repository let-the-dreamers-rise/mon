# HOLLOW — *something is wearing you*

**An open-world, body-swap psychological horror game where every footstep is a Monad transaction.**

Up to eight souls wake up in Halden, an abandoned company town at night. Every 30–75 seconds the Monad chain reshuffles who is wearing whom: you wake up in someone else's body, with someone else's name on your chest and someone else's things in your pockets, while a stranger walks around in yours. One of you is **Hollow**. It turns whoever it touches, and they become Hollow too. Find three fuses, power the bridge gate, get out.

Spectators ("watchers") can open any running night, switch between everyone's bodycams, and pay MON to torment the players: kill the lights, whisper, scream, force an early swap. Every fee — and every shop purchase — goes to the souls who escape.

> Metropolis Hackathon · Track 03 — Social, Attention & Culture

- **Play:** _GitHub Pages link — see [Deployment](#deployment)_
- **Demo video:** _link added at submission_
- **Contract (Monad testnet, chain 10143):** [`0xA30C47499589116b14A0F14f3Fcf2884aeA9D33c`](https://testnet.monadvision.com/address/0xA30C47499589116b14A0F14f3Fcf2884aeA9D33c)

---

## Why this only works on Monad

| What HOLLOW does | Why it needs Monad |
| --- | --- |
| Every body's position is recorded onchain every 2 blocks (0.6 s), batched up to 8 samples per transaction | ~1–2 transactions per second per player. Needs 300 ms blocks and very cheap gas. |
| Body swaps happen on the exact block for every player | Each shift is seeded by the previous block's hash; with 300 ms blocks the swap is effectively instant and simultaneous. |
| Touches, fuses, escapes and shop purchases are **proven** against the recorded positions | Anyone can submit a proof; the contract checks both bodies' samples at the same block. No server decides who died. |
| Watchers pay to torment live players | A 0.01 MON torment lands in ~0.3 s, while the victim is still standing in that corridor. |
| Players' moves never touch each other's storage | Each body's samples live in their own slots, so different players' transactions can execute in parallel on Monad. |

The bodycam HUD shows the block number as its timestamp, blinks `● REC` on every Monad block, and lists your own transactions with their confirmation latency. The streetlights dip with every new block, so the town breathes with the chain.

## How it plays

- **Shifts.** Every 30–75 s all souls are reshuffled into different bodies (a random single-cycle permutation, so nobody stays put). The camera cuts to static, you wake up somewhere else, and you don't know whose body you're in until you look down at your wrist ID band. Your original body's heartbeat is on your wrist; if whoever wears it gets turned, it reads **SIGNAL LOST**.
- **The Hollow.** One soul (two with 6+ souls) starts Hollow. A Hollow-controlled body turns any living-controlled body within 1.2 m. The turned soul becomes Hollow in place and keeps playing as a hunter. Every body looks the same; nothing gives the Hollow away.
- **Halden.** A 192 m × 192 m town with rain, fog and dead streetlights. The three fuses are inside the Archive (a backrooms office maze), St. Agnes Hospital, and Halden Station. The exit is the bridge gate.
- **Shops.** The 24/7 Mart, the pharmacy and Koda Photo sell batteries, flares, a music-box lure, pills, adrenaline and a Polaroid that shows who is really inside a body. Purchases are transactions, and items go into the **body's** pockets, so after a swap someone else gets your things.
- **Your own mind.** Sanity drains in the dark. Then you see figures that aren't there, hear footsteps that stop when you stop, sit through swaps that never happened, and hear the browser's own voice say other players' names.
- **Permanence.** The intro reads your real public Monad history. The end screen lists every transaction hash of your night: *your fear is now permanent.*

Full rules and numbers: [`docs/GDD.md`](docs/GDD.md).

Controls: `WASD` move · `Shift` run · mouse look · `F` torch · `E` shop terminal · `Tab` select item · `Q` use item · `M` map · `1–6` voice lines · look down for your wrist · `H` help.

## Architecture

```
contracts/          Foundry project
  src/Hollow.sol    the whole game: nights, souls, bodies, samples, shifts, proofs, shops, watchers, pot
  test/             16 tests (lobby, recording rules, wall/teleport checks, shifts, turns, fuses,
                    escape, shops & pockets, watchers & pot)
  script/           deployment (reads the generated town)
tools/map/          Halden generator → walls bitmap, spawns, objectives, render description
web/                Vite + TypeScript + three.js client
  src/chain/        burner session wallet & tx engine, NightState (mirrors the contract,
                    predicts shifts from block hashes, finds proofs), Pilot (records your samples)
  src/game/         world (town renderer), player (FPS controller), figures, fx (bodycam
                    post-processing), audio (HRTF voices, synthesized rain/thunder), psych
                    (sanity & hallucinations), town (shops, items, map), game (the loop)
  scripts/bots.mjs  bots that play by the contract rules (demos, playtests, filling seats)
docs/GDD.md         game design document
```

**Data flow.** Each client polls one `snapshot()` view per block (night header, current epoch, every body's latest samples), reads `getSouls`/`getEpochs`/`getPockets`, and fetches `Torment`/`Used` logs. Your own body's samples are signed locally by a burner session wallet and sent with `eth_sendRawTransaction` (no popups, local nonce, fixed gas limits, since Monad charges the gas limit). Swaps are computed locally from block hashes with the same algorithm as the contract, so they land on the exact block. Proofs are found client-side and submitted by whoever sees them first.

**Monad's reserve-balance rule.** An account holding less than 10 MON may only send *value* if it sent no other transaction in the previous 3 blocks. Players stream movement transactions every ~2 s, so the session wallet opens a short quiet window before any value-carrying call (shop purchases, watcher torments), and the bots space their funding transfers. Fresh funds are also given a few seconds to settle, because Monad validates balances against slightly lagged state.

**Audit any night.** `node web/scripts/verify-shifts.mjs --rpc https://testnet-rpc.monad.xyz --hollow <address> --night <id>` recomputes every body swap from public block hashes and checks it against the contract.

**Contract rules worth knowing.**
- Samples: `x | y << 16` in cm, one per body every 2 blocks, append-only. Speed cap 4.2 m per sample, the midpoint of every hop must not be inside a wall, and samples must be submitted within 40 blocks. A gap means the body stood still.
- Shifts: seed = `keccak(blockhash(S−1), night, epoch)`, Sattolo's algorithm over bodies still in play; next shift = `S + 100 + seed % 150`.
- Proofs: `turn`, `collectFuse`, `escape` and `buy` all take an epoch and a sample index and are checked against the stored samples and that epoch's body→soul assignment.

## Tech stack

Solidity 0.8.33 + Foundry · TypeScript + Vite · three.js r169 + postprocessing (pmndrs) · viem · WebAudio · Kokoro-82M TTS (offline, for the voice pack) · Blender 4.2 (character model) · Poly Haven CC0 assets · Node bots.

## Setup

Requirements: Node 20+, Foundry.

```bash
# contracts
cd contracts
forge test                     # 16 tests

# local chain with Monad-like 300 ms blocks
anvil --block-time 0.3
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# web client
cd ../web
npm install
node scripts/sync-contract.mjs          # copies ABI + map into the client
# put the local address under "31337" in src/deployments.json, then:
npm run dev                             # open http://localhost:5173/?local=1

# fill a night with bots (they wait until 6 souls have joined, then start)
node scripts/bots.mjs --hollow <address> --create --start-when 6 --count 5
```

`?quality=low|high` forces a graphics level (default adapts to your frame rate).

### Monad testnet

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url https://testnet-rpc.monad.xyz --broadcast --private-key $PRIVATE_KEY
# put the address under "10143" in web/src/deployments.json (or set VITE_HOLLOW_ADDRESS)
cd ../web && npm run build
```

Players need a little testnet MON in their session wallet (shown on the title screen; [faucet](https://faucet.monad.xyz)). One move costs about 0.01 MON at the current base fee, because Monad charges the full gas limit.

Bots on testnet: `BOT_MNEMONIC="..." FUNDER_KEY=0x... node scripts/bots.mjs --rpc https://testnet-rpc.monad.xyz --hollow <address> --fund 0.6 --create --start-when 4 --count 3`.

### Deployment

`.github/workflows/pages.yml` builds `web/` and publishes it to GitHub Pages on every push to the main branch. Enable it under **Settings → Pages → Source: GitHub Actions**.

## Known limitations

- **Hidden roles are hidden in the UI, not cryptographically.** All game state is onchain and public, so a determined player could read who is Hollow from the chain. Commit-reveal or ZK shuffles would fix this; out of scope for the hackathon.
- Positions are self-reported within the contract's rules (speed cap, wall checks, submission window). A modified client could play optimally within those rules.
- Items' effects (battery, pills, adrenaline) are applied client-side; their purchase and use are onchain.

## Built during the hackathon

Everything in this repository was created during the Metropolis hackathon window. No pre-existing project code is used. Third-party code is limited to the open-source libraries listed in `web/package.json` and `forge-std` (vendored in `contracts/lib/forge-std`, MIT/Apache-2.0).

## AI disclosure

This project was built with heavy use of AI coding tools, as the rules require us to disclose. **Claude Code (Anthropic)** wrote most of the code, contracts, tests, map generator, bots and docs under the direction of the team. AI subagents generated the voice/SFX pack (with the open-source Kokoro-82M TTS model and ffmpeg), sourced and optimized the CC0 Poly Haven assets, and scripted the character model in Blender. Game direction, concept decisions and playtesting were done by the team.

## Credits

- 3D assets, textures and HDRI: [Poly Haven](https://polyhaven.com) (CC0). See `web/public/assets/CREDITS.md`.
- Voices: [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0) via kokoro-onnx (MIT). Sound effects synthesized for this project. See `web/public/audio/CREDITS.md`.
- Fonts: VT323, Special Elite, Inter via Google Fonts (OFL).
- Libraries: three.js (MIT), postprocessing (Zlib), viem (MIT), Foundry/forge-std (MIT/Apache-2.0).

## License

[MIT](LICENSE)

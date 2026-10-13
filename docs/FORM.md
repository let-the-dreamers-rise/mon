# Submission form: paste-ready text

Field by field, in the order of the Metropolis submission form.

## Primary track

Social, Attention & Culture

## Project name (≤120)

HOLLOW — something is wearing you

## One-line description (≤200)

Onchain body-swap horror on Monad: every footstep is a transaction, the chain decides who wears whom, and every touch, fuse and escape is proven onchain.

## Logo

`docs/media/logo.png` (1024 × 1024 PNG)

## Description (long field 1)

HOLLOW is a first-person horror game where your fear lives on Monad.

Up to eight strangers wake up in Halden, an abandoned company town, at night, each seen through their own bodycam. One of them is Hollow. Every 30–75 seconds the chain reshuffles who is wearing whom: the screen tears into static, you come to on your knees somewhere else, in someone else's body, with their name on your wrist and their things in your pockets. Every body feels different: taller, shorter, a bad knee that drops you every other step, hands that won't stop shaking. Anyone you meet could be the Hollow, and if it touches you, you turn and start hunting too.

To survive, follow your bodycam's tracker to three fuse boxes (in the Archive, St. Agnes Hospital and Halden Station), power the bridge gate, and walk out. When you're alone, it gets worse: something stands at the end of the street, and every time you look away, it is closer.

Why it's built onchain:
- Every footstep is a transaction. Each body's position is written to the contract every 2 blocks (0.6 s) by a session key in the browser, with no wallet popups.
- The chain decides who is wearing whom. Each swap is seeded by a block hash, so every player swaps on the same block and anyone can verify it.
- No server decides who died. Touches, fuses, escapes and shop purchases are proven against the recorded positions of both bodies at the same block. Anyone can submit the proof.
- Attention becomes money. Spectators can watch any bodycam and pay MON to torment the players: kill the lights, whisper, force an early swap. Every fee and every shop sale goes into the night's pot. The survivors split it, and if nobody escapes, the Hollow keeps it.
- Nothing is lost. Every finished night joins the Archive (who was Hollow, who got out, who took the pot) and can be replayed as recovered bodycam footage, rebuilt block by block from nothing but chain data and shared as a link.

Track 03 fit (Social, Attention & Culture): a competitive feed (the Archive, and the Haunted leaderboard ranked by MON won, both read straight from the contract), attention that turns into ownership (watcher fees pay the winners, with no platform in between), cultural artifacts (permanent, replayable, shareable nights), and an open social graph (souls, bodies and outcomes are public contract state anyone can build on).

## How it's built (long field 2)

Contract: Solidity 0.8, Foundry, deployed on Monad testnet (chain 10143) at 0x5C4ef8456A07c61687d72827709Ff65569BB2957. No owner, no admin keys, no upgrades, no pause. MON leaves only through claimPot, to the winners of the night it was paid into.

Built for how Monad works:
- Gas-limit billing. Monad charges the gas limit, not the gas used, so every call is simulated first (a call that would revert is never sent) and movement transactions size their own limit from measured costs.
- 128-slot storage pages. Each body's samples live in their own page-aligned region, so players' moves never touch each other's storage and can execute in parallel. The town's walls are baked into the bytecode as immutables. A 4-step move costs about 65k gas.
- 300 ms blocks. Positions go onchain every 2 blocks. Swaps land on the same block for everyone. A torment lands in ~0.3 s, while the victim is still in that corridor.
- Reserve-balance rule. Value-carrying calls wait out a quiet window so the session wallet is never blocked.

Proofs: the contract checks both bodies' recorded samples at the same block (touch within 1.2 m, fuse within 1.6 m, shop counter within 2.5 m, escape at the powered gate). Movement is validated against a speed cap, walls probed every 1.4 m along each hop, a cap on how much ground a gap may cover, and a 16-block submission window.

Security: we attacked our own contract and fixed 5 issues, each with a regression test (24 Foundry tests): a way to lock the prize pot forever, a way to walk unseen through a recording gap, long hops through buildings, proofs a camper could make revert, and a host who could pick their own role. Roles come from a block hash that doesn't exist when start() is called.

Client: TypeScript, three.js and viem, a static site with no backend; it reads and writes Monad directly. Bodycam post-processing, a 192 m town with Poly Haven CC0 assets, a rigged character, solid props with a reachability check, a street-following tracker, a stalker with simple horror rules (closer when you look away, hunts with the lights dying, afraid of your torch), per-body physique, and a synthetic soundtrack and voices (Kokoro-82M, generated offline). Replays rebuild any finished night from chain data alone.

AI disclosure: built with heavy use of Claude Code (Anthropic) under the team's direction. Details are in the README.

## Live product

https://hollow-monad.vercel.app

## Repository

https://github.com/let-the-dreamers-rise/mon (public, MIT)

## Demo video (≤3 min)

Upload `hollow-demo-v3` (2:41, product footage only) to YouTube (unlisted is fine) and paste the link.

## Pitch video (≤2 min)

Upload `hollow-pitch` (1:52) and paste the link.

## Promo clip (optional, ≤30 s)

Upload `hollow-promo` (0:28) and paste the link.

## Private notes for judges (long field 3)

How to try it in 2 minutes, no wallet needed:
1. Open https://hollow-monad.vercel.app.
2. RECOVERED FOOTAGE replays testnet night 3, rebuilt from Monad blocks: real swaps, a real touch, real watchers.
3. "or walk around Halden first" opens the town alone. Follow the tracker to a fuse box, and keep an eye on the end of the street. Headphones, dark room.

To play a real night: the title screen creates a session wallet in your browser. Send it testnet MON (faucet.monad.xyz, or "top up 1 MON from my wallet"; 1 MON ≈ 6 minutes of walking), then PLAY A NIGHT → OPEN A NEW NIGHT → START NOW. Alone, you are the only soul. With friends, share the night number and have them JOIN before you start.

Contract: 0x5C4ef8456A07c61687d72827709Ff65569BB2957 (Monad testnet). Verify a night's swaps yourself: `node web/scripts/verify-shifts.mjs`. Contract tests: `cd contracts && forge test`.

Known limitations: hidden roles are hidden in the UI but readable from public chain state (commit-reveal or ZK shuffles are the fix). Positions are self-reported within the contract's movement rules.

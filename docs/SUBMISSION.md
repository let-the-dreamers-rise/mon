# Metropolis submission checklist

Deadline: **Oct 13, 2026, 11:59 PM ET** (Oct 14, 03:59 UTC · 9:29 AM IST).

| Requirement | Status |
| --- | --- |
| Public GitHub repository | ✅ `let-the-dreamers-rise/mon` |
| MIT license | ✅ `LICENSE` |
| README with setup instructions | ✅ `README.md` (setup, Monad testnet, bots, replays, security) |
| AI-use disclosure | ✅ README → *AI disclosure* |
| Demo video ≤ 3 min | ✅ `hollow-demo.mp4` (2:51), rendered from the game itself (see `tools/film`). Upload it (YouTube unlisted or similar) and paste the link |
| Deployed on Monad testnet, contract address | ✅ `0x5C4ef8456A07c61687d72827709Ff65569BB2957` (chain 10143) |
| Playable link | ✅ https://hollow-monad.vercel.app |

## Playable link

**https://hollow-monad.vercel.app** (Vercel, static build of `web/`). The title screen's
**RECOVERED FOOTAGE** replays testnet night 3 without a wallet, and *or just walk around Halden
first* opens the town with no wallet at all. Playing a night needs testnet MON in the session wallet
([faucet](https://faucet.monad.xyz)).

The Vercel project builds the repository at a pinned commit, so a push does not redeploy it on its
own. To have every push deploy, install the Vercel GitHub app on this repository and connect the
project to it (root directory `web`).

`.github/workflows/pages.yml` can also publish a mirror to GitHub Pages
(**Settings → Pages → Source: GitHub Actions**).

## Form text (paste and edit)

**Name:** HOLLOW — *something is wearing you*

**Track:** 03 — Social, Attention & Culture

**One-liner:** An open-world body-swap horror game where every footstep is a Monad transaction, and
the chain decides who is wearing whom.

**Description:**
Up to eight souls wake up in Halden, an abandoned company town at night. Every 30–75 seconds Monad
reshuffles who is wearing whom: you wake up in someone else's body, with their name on your wrist
and their things in your pockets. One of you is Hollow, and whatever it touches turns. Collect
three fuses (the bodycam's tracker leads the way), power the bridge gate, get out. Every body
feels different: height, a bad knee, shaking hands. When you're alone, something stands at the end of
the street, and it is closer every time you look away.

Every body's position is written onchain every 2 blocks (0.6 s) by a session key in the browser.
Swaps are seeded by block hashes, so every client swaps on the same block and anyone can verify it.
Touches, fuses, escapes and shop purchases are proven against the recorded positions: no server
decides who died. Watchers pay MON to torment the players. Every fee goes to the night's pot: the
escapees split it, and if nobody escapes, the Hollow keeps it. Every finished night can be replayed,
rebuilt from nothing but chain data.

Built for Monad specifically:
- Moves are sized to Monad's gas-limit billing.
- Storage is laid out in Monad's 128-slot pages (about 65k gas per 4-step move).
- Value calls respect the reserve-balance rule.
- The contract was reviewed adversarially: 5 issues found and fixed, each with a regression test. It has no owner and no admin keys, and 24 tests pass.

**Links:** repository, playable link, demo video, contract on
[MonadVision](https://testnet.monadvision.com/address/0x5C4ef8456A07c61687d72827709Ff65569BB2957).

## If you want to run bots for a live demo

The deployer and bot keys are in `.env` (never committed). One bot spends about 0.6 MON in
2.5 minutes of constant movement. Send testnet MON from the [faucet](https://faucet.monad.xyz) to
the deployer address `0xC218F64533fBE17549cbFcdb5d3E0C09b28C35a6`, then run:

```bash
cd web && set -a && . ../.env && set +a
FUNDER_KEY=$PRIVATE_KEY node scripts/bots.mjs --rpc https://testnet-rpc.monad.xyz \
  --hollow 0x5C4ef8456A07c61687d72827709Ff65569BB2957 --fund 0.6 --create --start-when 4 --count 3 --speed 1.4
```

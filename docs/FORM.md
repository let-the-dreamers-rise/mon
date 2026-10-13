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

Also in `docs/form/description.txt`.

HOLLOW is a first-person horror game where your fear lives on Monad. Every footstep is a transaction, the chain decides whose body you are wearing, and no server decides who died.

A NIGHT IN HALDEN
Up to eight strangers wake up in Halden, an abandoned company town, at night: rain, fog, dead streetlights, an office maze called the Archive, St. Agnes Hospital, Halden Station. Each player sees the night through their own bodycam. One of them (two, with six or more) is Hollow, and nothing about them gives it away.

Every 30–75 seconds, Monad reshuffles who is wearing whom. The camera tears into static and you come to on your knees somewhere else, in someone else's body. You don't know whose until you look down at the ID band on your wrist. Every body feels different: taller or shorter (the camera height changes), a bad knee that drops you on every other step, hands that won't stop shaking, lungs that can't run for long. Your own body's heartbeat stays on your wrist while someone else wears it. If whoever is wearing it gets turned, it reads SIGNAL LOST.

If a Hollow body gets within arm's reach of a living one, the living soul turns. They stay in play as a hunter, still wearing the same face. Survivors have to find three fuse boxes (one each in the Archive, the hospital and the station), power the bridge gate, and walk out before dawn. The bodycam's tracker points the way along the streets, not through walls, and it lies when you're scared. Players can call out "help me", "over here", "it's me", "don't trust them", "I found a fuse" and "run", and every call is spoken from the body you're wearing. So a voice you trust may be the Hollow's.

Three shops (the 24/7 Mart, the pharmacy and Koda Photo) sell batteries, flares, a music-box lure, pills, adrenaline, and a Polaroid that shows who is really inside a body. Purchases are transactions, and items go into the body's pockets, not yours. After the next swap, someone else is carrying what you bought.

And when you're alone, it gets worse. Something stands at the end of the street, facing you, and every time you look away it is closer. When it's close enough it hunts: the lamps around you die, your heart gets loud, and it runs at you through the streets. Hold your torch on it, or sprint and break its line of sight. Sanity drains in the dark, and then you see figures that aren't there, hear footsteps that stop when you stop, sit through swaps that never happened, and hear the other players' names whispered.

WATCHERS, THE POT, AND THE ARCHIVE
Anyone can open a running night as a watcher, switch between every bodycam, and pay to torment the players: kill the lights, whisper or scream (0.01 MON each), or force an early swap (0.05 MON). A torment lands in about 0.3 seconds, while the victim is still standing in that corridor. Every fee and every shop sale goes into the night's pot. The souls who escape split it, and if nobody escapes, the Hollow keeps it. Watchers' attention becomes the players' money, with no platform in between.

Nothing is lost. Every finished night joins the Archive: who was Hollow, who turned, who got out, who took the pot. The Haunted ranks every soul by MON won, wins, escapes and nights spent Hollow. Both are read straight from the contract. Any night can be replayed as recovered bodycam footage, rebuilt block by block from nothing but chain data (positions, swaps, touches, fuses, voices, torments), and shared as a link.

WHAT IS ONCHAIN, AND WHY IT MATTERS
- Movement: each body's position is recorded every 2 blocks (0.6 s) by a session key that lives in the browser. No wallet popups while you play.
- Swaps: each swap is seeded by the previous block's hash, so every player swaps on the same block and anyone can recompute it.
- Death and victory: touches, fuses, escapes and shop purchases are proofs, checked against both bodies' recorded positions at the same block. Anyone can submit them, and the contract settles them.
- Money: there is no owner and no admin key. MON leaves the contract only through claimPot, to the winners of the night it was paid into.
- Memory: the intro reads your real public history on Monad, and the end screen lists every transaction of your night.

WHY ONLY MONAD
A night means one to two transactions per second per player, swaps that must land on the same block for everyone, and torments that matter only if they arrive within a second. That needs 300 ms blocks and gas cheap enough to move every second. HOLLOW is also built for how Monad executes:
- Each body writes its own 128-slot storage page, so players never touch each other's state and their moves can run in parallel.
- Every call is sized for Monad's gas-limit billing.
- A step costs about 65k gas.

TRACK 03: SOCIAL, ATTENTION & CULTURE
- Competitive feeds: the Archive and the Haunted.
- Attention that turns into ownership: watcher fees pay the survivors.
- Cultural participation: every night is a permanent, replayable, shareable artifact.
- An open social graph: souls, bodies and outcomes are public contract state that anyone can build on.

LIVE TODAY
The game is live at hollow-monad.vercel.app on Monad testnet (contract 0x5C4ef8456A07c61687d72827709Ff65569BB2957). Recovered footage and a free walk through Halden need no wallet. A real night needs a little testnet MON in the session wallet, and that's it.

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

## Go-to-market and user acquisition (required, ≤8000)

Also in `docs/form/go-to-market.txt`.

WHO OUR FIRST USERS ARE
1. Horror streamers and their chats. Horror games are a staple of Twitch and YouTube, and their audiences already pay to interact with the streamer through tips, bits and sound alerts. HOLLOW is built for this: the streamer plays, and the chat becomes watchers who can kill the streamer's lights, whisper in their ear, or force an early swap. They pay MON to do it, the money goes into the pot, and the pot goes to whoever survives. A streamer who gets out takes home what their chat paid to scare them.
2. The Monad community. Testnet users, Discord regulars and builders who want something to do on Monad that shows off what it can do: real-time, every step onchain, a swap on the same block for everyone. They are our first nights, our first bug reports and our first leaderboard.
3. Social-deduction and co-op horror players: people who play Among Us, Lethal Company, Phasmophobia or Dead by Daylight with friends. HOLLOW gives them what those games can't: a night nobody can fake, a pot that really pays, and footage that can be rebuilt from the chain forever.

HOW WE REACH THEM
Streamers first (weeks 1–6 after the hackathon)
- Hand-pick 10–20 small and mid-size horror streamers (roughly 1k–20k followers). For them, a new format is the difference between a normal stream and a clip that travels.
- Host their first night: we pre-fund their session wallet, open the night, and give their chat a one-click watcher link.
- One stream turns hundreds of viewers into watchers at once, and the most engaged become players the next night. The streamer's chat is the funnel.

Every night is a clip (always on)
- Every finished night can be replayed as recovered bodycam footage, rebuilt from chain data and shared with one link (COPY FOOTAGE LINK).
- The best moments are short and made for X, TikTok and YouTube Shorts: the swap, the touch, IT at the end of the street, the jump scare. Each clip links straight back into the game.
- Next we'll add one-click clip export, so the replay becomes the marketing.

Community nights on Monad (weekly)
- Scheduled "Nights in Halden" with the Monad community on Discord and X, at fixed times so there are always enough souls.
- Monad ecosystem projects can host private nights for their own communities: a haunted house for a Discord server.
- The Haunted leaderboard (ranked by MON won, read from the contract) is the season ladder.

Launch season: Halloween
The hackathon ends about two weeks before October 31. We'll launch a public season, "The Night of the Hollow", with nightly events, a streamer night, and a leaderboard season that closes on Halloween.

Creators and builders
- Everything is public contract state: souls, bodies, outcomes, replays.
- We'll publish the "how a horror game runs onchain" story (300 ms blocks, every footstep a transaction, proofs instead of servers) for the Monad developer audience.
- We'll invite people to build on the data: clip bots, stats sites, alternative clients.

THE ONBOARDING FUNNEL
1. Zero-wallet entry: recovered footage and the free walk need no wallet, so a link from a clip shows the game instantly.
2. Watch: open a live night, switch bodycams, torment the players for 0.01 MON.
3. Play: the session key is created in the browser and signs every step without popups. One top-up (1 MON is about 6 minutes of play on testnet) and you're in.
4. Next: passkey wallets so a new player never sees a seed phrase, and sponsored first nights so a streamer's chat can try it for free.

WHY PEOPLE COME BACK
- Identity: your soul's record (nights, escapes, nights spent Hollow, MON won) is permanent and ranked.
- Every night is different: different roles, different bodies, different swaps, a different pot.
- Social stakes: friends, rivals and streamers you want to beat or betray.
- Your own footage: you can rewatch the moment you were turned, from the Hollow's bodycam.
- Seasons and community nights give a reason to show up at a fixed time.

WHAT WE'LL MEASURE (TARGETS FOR THE FIRST 60 DAYS)
- 1,000 nights played and 5,000 unique wallets (players and watchers combined).
- 20 streamers hosted, with a median of 15 or more watchers per streamed night.
- The share of watchers who become players within 7 days.
- MON paid in torments per night, and replay links opened per night.

HOW IT SUSTAINS ITSELF
For the hackathon, there is no platform fee: every MON paid goes to the players. After launch, the options are:
- a small, transparent rake on pots, set in the contract;
- sponsored nights and seasons by Monad ecosystem projects;
- cosmetic bodies.
Gameplay stays the same for everyone.

RISKS AND HOW WE HANDLE THEM
- Gas for players: Monad makes per-step transactions cheap, and sponsored nights cover first-timers.
- Not enough players at once: scheduled nights, streamer-hosted nights, and solo play (alone, IT hunts you).
- Hidden roles readable from chain state: commit-reveal roles before mainnet.
- Mainnet launch follows a public testnet season and an external review of the contract.

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

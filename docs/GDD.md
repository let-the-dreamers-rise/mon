# HOLLOW — Game Design Document

> *Something is wearing you.*
> An open-world, body-swap psychological horror game where every footstep is a Monad transaction.

## 1. Pillars

1. **You are not safe in your own body.** The chain reshuffles who wears whom. Your hands, your pockets, your name tag can all belong to someone else at any moment.
2. **Nobody can be trusted, including you.** The Hollow is a real person wearing faces. Your eyes lie when your sanity goes. Voices are shared and anonymous.
3. **Everything is permanent.** Every step, purchase, touch and escape is recorded onchain forever. The game says so, and it is literally true.
4. **People are watching, and paying to hurt you.** Spectators spend MON to torment you; their money funds whoever survives.

## 2. Inspirations (what we take from each)

| Game | What we take |
| --- | --- |
| Lethal Company (2023) | Terminal shop, scarce gear, co-op paranoia, mimics that sound like friends |
| R.E.P.O. (2025) | Spending between threats, physical shops in the world |
| Silent Hill 2 Remake (2024) | A whole town as the antagonist: fog, empty streets, landmarks you dread entering |
| Alan Wake 2 (2023) | Darkness as a mechanic, light as a resource, night-town atmosphere |
| Content Warning (2024) | Horror as content: an audience that watches and reacts |
| Mouthwashing (2024) | Unreliable perception, psychological dread over gore |
| The Exit 8 (2023) | Paranoia about whether something is *wrong* with what you see |
| Among Us / The Thing | One of you is not human, and it spreads |
| Unrecord / Bodycam (2024) | Body-worn camera found-footage realism |

## 3. The Night (match structure)

| Phase | Duration | What happens |
| --- | --- | --- |
| Lobby | until host starts (max ~3 min) | 1–8 souls join a night. Bots can fill seats. |
| Countdown | 20 blocks (~6 s) | "The lights go out." Intro narration. |
| Night | up to 2,400 blocks (~12 min) | Explore Halden, collect 3 fuses, power the bridge gate, escape. |
| Dawn | — | Night ends when no living souls remain in play or time runs out. Survivors split the pot. |

**Roles.** At start, 1 random soul is Hollow (2 if ≥ 6 souls). Everyone else is living. Nobody is told who the Hollow is, except the Hollow.

**Win conditions.**
- Living: reach the powered bridge gate in any body. Each soul that escapes wins and claims an equal share of the pot.
- Hollow: turn every living soul before dawn.

## 4. Shifts (the core mechanic)

- Every **30–75 s** (100 + 0..149 blocks, decided by the previous block hash), all souls in play are reshuffled into **different** bodies (a random single-cycle permutation; nobody stays put).
- The shift happens on the exact block for everyone (clients compute it from the block hash locally).
- **What you feel:** bodycam static, a tape-stop glitch, a chorus whispering "not yours", camera label scrambles (`CAM ▓▒`), you wake up somewhere else facing a random direction.
- **What you don't know:** whose body you're in. Look down at your wrist ID band to find out. Your original body's heartbeat is on your wrist, with distance and direction. If whoever wears it gets turned, the wrist reads **SIGNAL LOST**.
- **Pockets belong to bodies.** Items stay in the body. After a shift you have someone else's items, and someone else has yours.
- **Grace:** for 10 blocks (~3 s) after a shift nobody can be turned.
- Watchers can pay to **force a shift** within 10 blocks (cooldown 200 blocks).

## 5. The Hollow

- A Hollow-controlled body turns a living-controlled body if they are within **1.2 m** at the same recorded sample.
- The turned soul becomes Hollow **in place**: the body doesn't fall. It just stops being on your side.
- The Hollow hears living heartbeats through walls (positional, 14 m), never needs stamina, and sees the world bleed red.
- Hollow souls keep playing as hunters. The infection grows.
- **Proof:** anyone can submit a touch to the contract, which checks both bodies' recorded positions at that sample. Clients submit automatically.

## 6. Halden (the open world)

192 m × 192 m grid of 3 m cells (64 × 64). Night, rain, fog density 0.06. No ceiling outdoors.

| District | Contents | Mood |
| --- | --- | --- |
| **Main Street** (centre) | 3 shops, abandoned cars, bus stop, flickering sodium lamps | The only light in town; where people meet; where the Hollow waits |
| **The Archive** (NW building) | Backrooms office maze, fluorescent panels, **Fuse A** | Claustrophobic, yellow, humming |
| **St. Agnes Hospital** (NE building) | Wards, long corridors, gurneys, **Fuse B** | Cold, green-white, dripping |
| **Halden Station** (SW building) | Ticket hall, pillars, platform edge, **Fuse C** | Echoing, dark, trains that never come |
| **The Park & Cemetery** (SE) | Trees, headstones, fog | Open, exposed, you are seen |
| **The Bridge Gate** (east edge) | Electrified gate, red siren light → green when powered | The way out |

Streets are wide (6–9 m); alleys 3 m. Buildings render as tall dark blocks with mostly dead windows; a few lit windows flicker.

## 7. Shops & items (onchain)

Shops are unmanned. Each has a counter terminal. You can buy only while your body's **recorded** position is within 2.5 m of the counter. Purchases are Monad transactions; prices go to the survivors' pot. Items go into the **body's** pockets (max 9 of each).

| Item | Shop | Price (MON) | Effect |
| --- | --- | --- | --- |
| Battery | 24/7 Mart | 0.004 | Torch back to 100 % |
| Flare | 24/7 Mart | 0.008 | Red light, 14 m radius, 25 s, seen by everyone (onchain event) |
| Music box | 24/7 Mart | 0.006 | Plays a lullaby at your position for 12 s, a lure everyone hears |
| Pills | Pharmacy | 0.004 | +40 % sanity, no hallucinations for 30 s |
| Adrenaline | Pharmacy | 0.010 | 12 s sprint with no stamina cost, +15 % speed |
| Polaroid | Koda Photo | 0.020 | Photograph the figure in front of you; after 5 s it develops and shows **who is really inside** |

Using an item is also a transaction (`use`), so every flare, pill and photo is recorded.

## 8. Psychology systems

- **Sanity** (0–1): drains in darkness (−3.5 %/s without light), near figures (up to −2.5 %/s), on shifts (−12 %), and from torments (−10..15 %). Recovers +1.2 %/s in light. Pills restore it.
- **Phantoms** (insanity > 35 %): figures identical to real ones appear at the end of corridors or cross streets. They vanish when lit for 0.45 s or approached within 3.5 m.
- **Following footsteps** (insanity > 50 %): 5 steps behind you that stop when you stop.
- **False shifts** (insanity > 72 %): full shift glitch, nothing changed. Or did it?
- **Named whispers** (insanity > 45 %): the browser's own voice says real player names: "Mara is behind you."
- **The tab talks** (insanity > 60 %): the page title changes to "it's behind you".
- **Fourth wall:** the intro reads your real Monad mainnet history ("we've watched all 1,204 of your transactions"). The end screen lists every transaction hash of your night: *your fear is now permanent.*

## 9. Watchers

Spectators open any running night, switch between bodycams (CAM 01–08), and pay to torment the body they're watching:

| Torment | Price | Effect |
| --- | --- | --- |
| Kill the lights | 0.01 | Lamps within 22 m die for 9 s |
| Whisper | 0.01 | An entity whisper right behind the victim, −10 % sanity |
| Scream | 0.01 | A scream sting next to the victim, camera shake, −15 % sanity |
| Force a shift | 0.05 | The next shift happens in 10 blocks (cooldown 200) |

The victim sees who paid: "0x8a…f3 paid 0.01 MON to blind you." All fees go to the pot.

## 10. Bodycam presentation

Fisheye lens, scanlines, rolling bar, film grain, desaturated colour with a green cast, chromatic aberration rising with insanity. HUD in VT323: `● REC` blinking on every Monad block, `CAM 03`, `BLOCK #70,512,331`, torch battery, stamina, living count, watchers, and a live feed of your own transactions with confirmation latency.

## 11. Controls

`WASD` move · `Shift` run · `F` torch · mouse look · look down for wrist ID · `1–6` voice lines (help me / over here / it's me / don't trust them / I found a fuse / run) · `E` interact with a shop counter or fuse box · `Q` use the selected item · `Tab` / scroll to select an item.

## 12. Onchain spec (Monad)

- Positions: one sample per body every 2 blocks (0.6 s), packed `x | y << 16` in cm, batched up to 8 per tx. Speed cap 4.2 m per sample, midpoint wall check, 40-block submission window.
- Shifts: `keccak(blockhash(S−1), night, epoch)` seeds Sattolo's algorithm; next shift = S + 100 + seed % 150.
- Proofs: `turn`, `collectFuse`, `escape`, `buy` are verified against recorded samples and the epoch's body→soul assignment.
- Parallel-friendly storage: each body's samples live in their own slots, so different players' moves never touch the same storage and Monad can execute them in parallel.
- Economy: watcher torments and shop purchases → `pot[night]`; escaped souls claim equal shares; if nobody escapes, the pot rolls over to a later night.

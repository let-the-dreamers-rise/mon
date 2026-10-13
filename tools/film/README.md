# Demo video tooling

The demo video is rendered by the game itself, deterministically: time inside the page only moves
when the harness steps it, one rendered frame per film frame. Slow software rendering still yields
smooth 24 fps footage.

```bash
npm install                       # playwright
# footage of a finished night, rebuilt from Monad testnet (cam 1 pinned), and the town tour
node film.mjs --url 'http://localhost:5173/?quality=low&replay=3&cam=1' --out work/clips/A --seconds 50 --skip 4
node film.mjs --url 'http://localhost:5173/?local=1&quality=low&roam=1' --ready roam --tour tour.js --out work/clips/tour --seconds 34
node slides.mjs work/slides                              # slides.html → PNGs
python3 narration.py --models <kokoro dir> --out work/vo  # offline voice-over (Kokoro-82M)
python3 edit.py --work work --audio ../../web/public/audio --out hollow-demo.mp4 --cut cut.json
```

- `film.mjs` virtualizes `performance.now`, `Date.now`, timers and `requestAnimationFrame`, and
  logs every sound the game plays with its film time (`audio.json`), so the soundtrack is mixed
  offline from the game's own audio files.
- `edit.py` cuts picture segments, overlays, bodycam static between segments, the ambience, the
  game's sounds and the narration (ducking the game under the voice).
- Set `CHROME=/path/to/chrome` to use a specific browser build.

"""
Voice-over for the HOLLOW demo video, generated offline with Kokoro-82M (same as the game's voices).

  python3 tools/film/narration.py --models <dir with kokoro-v1.0.onnx and voices-v1.0.bin> --out <dir>

Writes one WAV per section plus narration.json with each section's length, so the edit can be cut
to the voice.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "audio"))
import dsp  # noqa: E402
from dsp import SR  # noqa: E402

SECTIONS = {
    "title": [
        "HOLLOW is a body-swap horror game,",
        "where every footstep is a Monad transaction.",
    ],
    "town": [
        "Up to eight souls wake up in Halden, a company town, at night.",
        "Every thirty to seventy-five seconds, the chain reshuffles who is wearing whom.",
        "You wake up somewhere else. In someone else's body. With their name on your wrist, and their things in your pockets.",
        "One of you is Hollow. Whatever it touches... turns.",
    ],
    "footage": [
        "This footage was never recorded.",
        "It is rebuilt, block by block, from Monad testnet.",
        "Every body's position goes onchain every two blocks, signed by a session key in the browser. No popups.",
        "Each swap is seeded by the previous block's hash, so every player swaps on the same block, and anyone can verify it.",
        "When a Hollow body touches a living one, anyone can submit the proof. The contract checks both bodies' recorded positions, at the same block.",
        "No server decides who died.",
    ],
    "monad": [
        "This only works on Monad. Three hundred millisecond blocks, and gas cheap enough to move every second.",
        "We built for how Monad charges: the gas limit, not the gas used. So every move is sized to what it will really cost, and storage is laid out in Monad's pages.",
        "A step costs about sixty-five thousand gas.",
    ],
    "security": [
        "The contract has no owner, no admin keys, and no upgrades.",
        "We attacked it ourselves. We found a way to lock the prize pot forever, a way to walk unseen, and a way to become untouchable.",
        "All fixed, and every fix has a test.",
    ],
    "watchers": [
        "Spectators can watch any bodycam, and pay MON to torment the players. Kill the lights. Whisper. Force an early swap.",
        "Every fee goes into the night's pot. The survivors split it.",
        "And if nobody escapes... the Hollow keeps it.",
    ],
    "end": [
        "Your fear is onchain. Forever.",
    ],
}

GAP = 0.45  # silence between sentences


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default="bm_george")
    ap.add_argument("--speed", type=float, default=0.92)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(os.path.join(args.models, "kokoro-v1.0.onnx"), os.path.join(args.models, "voices-v1.0.bin"))
    info = {}
    lines_info = {}
    for name, lines in SECTIONS.items():
        parts, t = [], 0.0
        lines_info[name] = []
        for k, line in enumerate(lines):
            audio, sr = kokoro.create(line, voice=args.voice, speed=args.speed, lang="en-gb" if args.voice.startswith("b") else "en-us")
            x = dsp.trim_silence(dsp.resample(np.asarray(audio, dtype=np.float64), sr, SR), -45, 0.03)
            parts.append((x, t))
            # each line on its own too, so the edit can place it against the picture
            y = dsp.normalize(dsp.eq(x, "lowshelf", 160, 2.5), -16, ceiling_db=-1.5)
            lp = os.path.join(args.out, f"{name}_{k}.wav")
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-", lp],
                           input=np.clip(y, -1, 1).astype(np.float32).tobytes(), check=True)
            lines_info[name].append({"file": f"{name}_{k}.wav", "text": line, "seconds": round(len(x) / SR, 2)})
            t += len(x) / SR + GAP
        x = dsp.mix(t, *parts)
        # a little low end and a small room, so it sits under found footage
        x = dsp.eq(x, "lowshelf", 160, 2.5)
        x = dsp.normalize(x, -16, ceiling_db=-1.5)
        path = os.path.join(args.out, f"{name}.wav")
        raw = np.clip(x, -1, 1).astype(np.float32).tobytes()
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-", path], input=raw, check=True)
        info[name] = round(len(x) / SR, 2)
        print(f"{name:10s} {info[name]:6.2f}s")
    with open(os.path.join(args.out, "narration.json"), "w") as f:
        json.dump({"sections": info, "lines": lines_info}, f, indent=2)
    print(f"total {sum(info.values()):.1f}s")


if __name__ == "__main__":
    main()

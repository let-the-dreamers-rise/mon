"""
Re-cut a finished video: keep ranges of it, drop in other finished pieces, and cover jump cuts with a
blip of bodycam static. Picture is re-encoded piece by piece and joined; sound is cut in numpy with
short fades at every edge, so nothing clicks.

  python3 tools/film/splice.py --plan splice-v2.json --out hollow-demo-v2.mp4

A plan is a list of steps, in order:
  ["keep", "master.mp4", from_s, to_s]   a range of a finished video
  ["insert", "piece.mp4"]                 a whole finished video
  ["blip", seconds]                       bodycam static
and "fadeout": seconds at the end.
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

FPS = 24
SR = 48000
ENC = ["-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p"]


def run(cmd):
    subprocess.run(cmd, check=True)


def audio_of(path, start=None, dur=None):
    cmd = ["ffmpeg", "-v", "error"]
    if start is not None:
        cmd += ["-ss", f"{start:.4f}"]
    cmd += ["-i", path]
    if dur is not None:
        cmd += ["-t", f"{dur:.4f}"]
    cmd += ["-vn", "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def edge_fade(x, ms=25):
    n = min(len(x) // 2, int(SR * ms / 1000))
    if n > 0:
        ramp = np.linspace(0, 1, n)[:, None]
        x[:n] *= ramp
        x[-n:] *= ramp[::-1]
    return x


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tmp", default="splice-tmp")
    args = ap.parse_args()
    with open(args.plan) as f:
        plan = json.load(f)
    os.makedirs(args.tmp, exist_ok=True)
    parts, sound = [], []
    rng = np.random.default_rng(3)
    for k, step in enumerate(plan["steps"]):
        p = os.path.join(args.tmp, f"part{k:02d}.mp4")
        if step[0] == "keep":
            _, src, a, b = step
            # on frame boundaries, so pieces join without a dropped or doubled frame
            a, b = round(a * FPS) / FPS, round(b * FPS) / FPS
            run(["ffmpeg", "-v", "error", "-y", "-ss", f"{a:.4f}", "-i", src, "-t", f"{b - a:.4f}", "-an", *ENC, p])
            sound.append(edge_fade(audio_of(src, a, b - a)))
        elif step[0] == "insert":
            src = step[1]
            run(["ffmpeg", "-v", "error", "-y", "-i", src, "-an", *ENC, p])
            sound.append(edge_fade(audio_of(src)))
        elif step[0] == "blip":
            d = round(step[1] * FPS) / FPS
            run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=gray:s=1280x720:r={FPS}", "-t", f"{d:.4f}",
                 "-vf", "noise=alls=100:allf=t+u,hue=s=0,eq=contrast=1.6:brightness=-0.05", *ENC, p])
            hiss = dsp.highpass(rng.standard_normal(int(d * SR)) * 0.06, 400, sr=SR)
            sound.append(edge_fade(np.stack([hiss, hiss], axis=1), 10))
        else:
            raise SystemExit(f"unknown step {step}")
        # keep sound exactly as long as the picture it belongs to
        n = int(round(duration(p) * SR))
        s = sound[-1]
        sound[-1] = s[:n] if len(s) >= n else np.concatenate([s, np.zeros((n - len(s), 2))])
        parts.append(p)
    lst = os.path.join(args.tmp, "concat.txt")
    with open(lst, "w") as f:
        for p in parts:
            f.write(f"file '{os.path.abspath(p)}'\n")
    picture = os.path.join(args.tmp, "picture.mp4")
    run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", picture])
    mix = np.concatenate(sound)
    fade = plan.get("fadeout", 0)
    total = duration(picture)
    if fade:
        n = int(fade * SR)
        mix[-n:] *= np.linspace(1, 0, n)[:, None]
    wav = os.path.join(args.tmp, "mix.wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-", wav],
                   input=np.clip(mix, -1, 1).astype(np.float32).tobytes(), check=True)
    vf = ["-vf", f"fade=t=out:st={total - fade:.3f}:d={fade}"] if fade else []
    run(["ffmpeg", "-v", "error", "-y", "-i", picture, "-i", wav, *vf, *ENC, "-c:a", "aac", "-b:a", "192k", "-shortest",
         "-movflags", "+faststart", args.out])
    print(f"wrote {args.out}: {duration(args.out):.2f}s")


if __name__ == "__main__":
    main()

"""
Assemble the HOLLOW demo video from captured clips (tools/film film.mjs), slides (slides.html)
and the narration (narration.py).

  python3 tools/film/edit.py --work <dir> --audio web/public/audio --out hollow-demo.mp4

<work> holds: clips/<name>/f00000.jpg + audio.json, slides/slide-*.png, vo/*.wav + narration.json.
The cut is described in CUT below: picture segments in order, overlays, and narration cues.
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

SR = 48000
FPS = 24

# picture: (kind, source, in-seconds, duration)
CUT = {
    "segments": [
        ("clip", "tour", 0.0, 33.0),
        ("static", None, 0, 0.35),
        ("clip", "A", 0.0, 49.0),
        ("static", None, 0, 0.35),
        ("slide", "monad", 0, 24.0),
        ("slide", "security", 0, 19.0),
        ("static", None, 0, 0.35),
        ("clip", "B", 0.0, 24.0),
        ("static", None, 0, 0.35),
        ("slide", "end", 0, 8.0),
    ],
    # overlays: (slide, segment index, from, to) in segment time
    "overlays": [
        ("title", 0, 0.5, 7.0),
        ("footage", 2, 1.0, 9.0),
        ("watchers", 7, 1.5, 21.5),
    ],
    # narration: (line file, segment index, start in segment time)
    "voice": [],
}


def run(cmd):
    subprocess.run(cmd, check=True)


def decode(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def segment_starts():
    t, out = 0.0, []
    for seg in CUT["segments"]:
        out.append(t)
        t += seg[3]
    return out, t


def build_video(work, tmp):
    parts = []
    for i, (kind, src, tin, dur) in enumerate(CUT["segments"]):
        p = os.path.join(tmp, f"seg{i:02d}.mp4")
        ov = [(o, a, b) for (o, si, a, b) in CUT["overlays"] if si == i]
        if kind == "clip":
            base = ["-framerate", str(FPS), "-start_number", str(int(round(tin * FPS))), "-i", os.path.join(work, "clips", src, "f%05d.jpg")]
        elif kind == "slide":
            base = ["-loop", "1", "-framerate", str(FPS), "-i", os.path.join(work, "slides", f"slide-{src}.png")]
        else:
            base = ["-f", "lavfi", "-i", f"color=c=gray:s=1280x720:r={FPS}"]
        inputs = list(base)
        for (o, a, b) in ov:
            inputs += ["-loop", "1", "-framerate", str(FPS), "-i", os.path.join(work, "slides", f"slide-{o}.png")]
        if kind == "static":
            chain = "[0:v]noise=alls=100:allf=t+u,hue=s=0,eq=contrast=1.6:brightness=-0.05,format=yuv420p[v0]"
        elif kind == "slide":
            # a slow push-in so stills breathe
            chain = (f"[0:v]scale=1408:792,zoompan=z='min(1.0+on/({FPS}*{dur})*0.05,1.05)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
                     f"s=1280x720:fps={FPS},fade=t=in:st=0:d=0.5,fade=t=out:st={dur - 0.5}:d=0.5,format=yuv420p[v0]")
        else:
            chain = "[0:v]scale=1280:720,format=yuv420p[v0]"
        last = "v0"
        for k, (o, a, b) in enumerate(ov):
            chain += (f";[{k + 1}:v]format=rgba,fade=t=in:st={a}:d=0.6:alpha=1,fade=t=out:st={b - 0.6}:d=0.6:alpha=1[o{k}]"
                      f";[{last}][o{k}]overlay=0:0:enable='between(t,{a},{b})'[v{k + 1}]")
            last = f"v{k + 1}"
        run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", chain, "-map", f"[{last}]", "-t", str(dur),
             "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", p])
        parts.append(p)
    lst = os.path.join(tmp, "concat.txt")
    with open(lst, "w") as f:
        for p in parts:
            f.write(f"file '{p}'\n")
    out = os.path.join(tmp, "picture.mp4")
    run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out])
    return out


def build_audio(work, audio_dir, total):
    n = int(total * SR) + SR
    game = np.zeros(n)
    voice = np.zeros(n)
    starts, _ = segment_starts()
    cache = {}

    def load(name):
        if name not in cache:
            path = os.path.join(audio_dir, name)
            cache[name] = decode(path) if os.path.exists(path) else np.zeros(1)
        return cache[name]

    def add(buf, x, t, gain=1.0):
        i = int(t * SR)
        if i >= len(buf) or i + len(x) <= 0:
            return
        x = x[max(0, -i):]
        i = max(0, i)
        m = min(len(x), len(buf) - i)
        buf[i:i + m] += x[:m] * gain

    # ambience: the game's drone + buzz, and rain, under the in-world segments
    drone = load("amb_drone_loop.mp3")
    buzz = load("amb_buzz_loop.mp3")
    rng = np.random.default_rng(7)
    for i, (kind, src, tin, dur) in enumerate(CUT["segments"]):
        t0 = starts[i]
        length = int(dur * SR)
        if kind == "static":
            add(game, load("static_burst.mp3"), t0, 0.5)
            continue
        if kind == "clip":
            bed = np.resize(drone, length) * 0.45 + np.resize(buzz, length) * 0.08
            rain = dsp.lowpass(dsp.highpass(rng.standard_normal(length) * 0.05, 300, sr=SR), 5000, sr=SR)
            bed = bed + rain * (0.5 if src != "A" else 0.35)
            bed = dsp.fade(bed, 0.4, 0.4, sr=SR)
            add(game, bed, t0)
            log_path = os.path.join(work, "clips", src, "audio.json")
            if os.path.exists(log_path):
                with open(log_path) as f:
                    log = json.load(f)
                for s in log["sounds"]:
                    st = s["t"] - tin
                    if st < 0 or st > dur:
                        continue
                    x = load(s["file"])
                    if abs(s.get("rate", 1) - 1) > 0.02:
                        x = dsp.varispeed(x, s["rate"])
                    tail = int((dur - st) * SR)
                    add(game, x[:tail], t0 + st, min(1.5, s["volume"]))
        else:
            bed = np.resize(drone, length) * 0.22
            add(game, dsp.fade(bed, 0.5, 0.5, sr=SR), t0)

    # beds: the game's looping layers (heartbeat, breathing) that the film log doesn't capture
    for (file, si, a, b, gain) in CUT.get("beds", []):
        length = int((b - a) * SR)
        x = dsp.fade(np.resize(load(file), length), 0.5, 0.6, sr=SR)
        add(game, x, starts[si] + a, gain)

    # narration, with the game ducked under it
    with open(os.path.join(work, "vo", "narration.json")) as f:
        lines = {l["file"]: l for sec in json.load(f)["lines"].values() for l in sec}
    duck = np.ones(n)
    for (file, si, at) in CUT["voice"]:
        x = decode(os.path.join(work, "vo", file))
        t = starts[si] + at
        add(voice, x, t)
        a, b = int(t * SR), int((t + lines[file]["seconds"]) * SR)
        duck[max(0, a - SR // 4):b + SR // 3] = dsp.db(-9)
    duck = np.convolve(duck, np.ones(SR // 8) / (SR // 8), mode="same")
    mix = game * duck * 0.8 + voice
    mix = dsp.limiter(mix, -1.0, sr=SR)
    mix = dsp.normalize(mix, -16, ceiling_db=-1.0, sr=SR)
    return mix[: int(total * SR)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cut", help="json file overriding CUT")
    args = ap.parse_args()
    if args.cut:
        with open(args.cut) as f:
            CUT.update(json.load(f))
    tmp = os.path.join(args.work, "tmp")
    os.makedirs(tmp, exist_ok=True)
    _, total = segment_starts()
    print(f"cut: {total:.1f}s")
    picture = build_video(args.work, tmp)
    mix = build_audio(args.work, args.audio, total)
    wav = os.path.join(tmp, "mix.wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-", wav],
                   input=np.clip(mix, -1, 1).astype(np.float32).tobytes(), check=True)
    run(["ffmpeg", "-v", "error", "-y", "-i", picture, "-i", wav, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
         "-ac", "2", "-shortest", "-movflags", "+faststart", args.out])
    print("wrote", args.out)


if __name__ == "__main__":
    main()

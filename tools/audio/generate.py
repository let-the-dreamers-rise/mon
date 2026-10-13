"""
HOLLOW audio pack: horror voices (Kokoro-82M TTS, offline) + synthesized SFX.

  python3 tools/audio/generate.py --models <dir with kokoro-v1.0.onnx and voices-v1.0.bin>

Writes MP3s into web/public/audio/ with the names the game loads (see web/src/game/audio.ts).
Model files: https://github.com/thewh1teagle/kokoro-onnx/releases (model-files-v1.0).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import dsp  # noqa: E402
from dsp import SR  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "web", "public", "audio")

ap = argparse.ArgumentParser()
ap.add_argument("--models", required=True)
ap.add_argument("--only", default="")
args = ap.parse_args()
os.makedirs(OUT, exist_ok=True)

_kokoro = None


def tts(text, voice="am_michael", speed=0.85):
    global _kokoro
    if _kokoro is None:
        from kokoro_onnx import Kokoro
        _kokoro = Kokoro(os.path.join(args.models, "kokoro-v1.0.onnx"), os.path.join(args.models, "voices-v1.0.bin"))
    audio, sr = _kokoro.create(text, voice=voice, speed=speed, lang="en-us")
    x = dsp.resample(np.asarray(audio, dtype=np.float64), sr, SR)
    return dsp.trim_silence(x, -45, 0.03)


def write(name, x, lufs=None, peak_db=-1.0, stereo=False, kbps=112):
    if lufs is not None:
        x = dsp.normalize(x, lufs, ceiling_db=peak_db)
    else:
        x = dsp.normalize_peak(x, peak_db)
    if stereo:
        x = dsp.to_stereo(x)
    elif x.ndim == 2:
        x = dsp.to_mono(x)
    ch = 2 if x.ndim == 2 else 1
    raw = np.clip(x, -1, 1).astype(np.float32).tobytes()
    path = os.path.join(OUT, name)
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", str(ch), "-i", "-",
         "-codec:a", "libmp3lame", "-b:a", f"{kbps}k", path],
        input=raw, check=True)
    print(f"  {name:28s} {len(x) / SR:5.1f}s  {os.path.getsize(path) // 1024:4d} KB")


def want(key):
    return not args.only or any(k in key for k in args.only.split(","))


# ============================================================================ voices

def survivor(text):
    """one shared, slightly broken voice for every lure line: nobody can tell who is talking"""
    x = tts(text, "am_michael", 0.92)
    x = dsp.detune_double(x, cents=18, delay_ms=11, gain_db=-7)
    x = dsp.radio(x, 260, 4200, drive=1.6)
    x = dsp.reverb(x, rt60=1.1, wet_db=-11, predelay=0.012, damp=0.6)
    return x


def whisper(text, i):
    voices = ["af_nicole", "bm_george", "af_sky", "am_adam"]
    a = dsp.lpc_whisper(dsp.resample(tts(text, voices[i % 4], 0.78), SR, 24000), sr=24000, seed=i)
    a = dsp.resample(a, 24000, SR)
    b = dsp.lpc_whisper(dsp.resample(tts(text, voices[(i + 1) % 4], 0.8), SR, 24000), sr=24000, seed=i + 9)
    b = dsp.resample(b, 24000, SR)
    b = dsp.pitch(b, -3, formant="preserved")
    swell, lead = dsp.reverse_reverb(a, rt60=1.6, wet_db=-4, seed=i)
    body = dsp.mix(lead + max(len(a), len(b)) / SR + 0.6, (swell, 0, -2), (a, lead, 0), (b, lead + 0.035, -6))
    body = dsp.eq(body, "peak", 3800, 5, 1.2)  # close, breathy presence
    body = dsp.highpass(body, 140)
    return body


def chorus(text, n=7, semis=(-4, -7, -5, -9, -3, -6, -12)):
    voices = ["am_adam", "bm_george", "af_bella", "am_michael", "bf_emma", "af_nicole", "bm_lewis"]
    parts = []
    for k in range(n):
        v = tts(text, voices[k % len(voices)], 0.72 + 0.03 * k)
        v = dsp.pitch(v, semis[k % len(semis)], formant="shifted")
        parts.append((v, 0.02 + 0.045 * k, -2 - k * 0.6))
    length = max(len(p[0]) for p in parts) / SR + 0.5
    x = dsp.mix(length, *parts)
    x = dsp.reverb(x, rt60=3.8, wet_db=-3, predelay=0.03, damp=0.35, stereo=True, size=1.4)
    return x


LURES = {
    "help": "help me... please. help me.",
    "here": "over here!",
    "itsme": "it's me. it's really me.",
    "donttrust": "don't trust them.",
    "fuse": "I found a fuse!",
    "run": "run. RUN.",
}
WHISPERS = [
    "you are not you.", "whose hands are those?", "it's wearing you.", "give it back.",
    "we remember every step.", "turn around.", "they are not who they say they are.",
    "it's already inside.", "let me in.", "your body misses you.", "nobody leaves the archive.",
    "shhh... it can hear you.",
]

if want("lure"):
    print("lure voices")
    for k, line in LURES.items():
        write(f"voice_lure_{k}.mp3", survivor(line), lufs=-16)

if want("whisper"):
    print("whispers")
    for i, line in enumerate(WHISPERS):
        write(f"voice_whisper_{i + 1:02d}.mp3", whisper(line, i), lufs=-24)

if want("shift"):
    print("shift chorus")
    for i, word in enumerate(["not yours.", "switch.", "wake up."]):
        write(f"voice_shift_{i + 1:02d}.mp3", chorus(word), lufs=-15, stereo=True)

if want("turned"):
    print("turned")
    x = tts("now... you're hollow.", "am_adam", 0.7)
    x = dsp.pitch(x, -6, formant="shifted")
    x = dsp.detune_double(x, cents=-35, delay_ms=22, gain_db=-4)
    swell, lead = dsp.reverse_reverb(x, rt60=2.2, wet_db=-2)
    x = dsp.mix(lead + len(x) / SR + 2.0, (swell, 0), (dsp.reverb(x, rt60=2.6, wet_db=-6), lead))
    write("voice_turned.mp3", x, lufs=-15)

if want("intro"):
    print("intro")
    lines = [
        ("Welcome to the Archive.", 1.0), ("Find the three fuses.", 0.6), ("Power the door.", 1.1),
        ("And when you wake up...", 0.9), ("check your hands.", 1.2), ("The body you are in...", 0.9),
        ("may not be yours.", 0.0),
    ]
    parts, t = [], 0.4
    for text, gap in lines:
        v = tts(text, "bm_george", 0.8)
        parts.append((v, t))
        t += len(v) / SR + gap
    x = dsp.mix(t + 1.5, *parts)
    x = dsp.radio(x, 120, 6500, drive=1.15)
    x = dsp.reverb(x, rt60=1.4, wet_db=-12, damp=0.6)
    write("voice_intro.mp3", x, lufs=-18)

# ============================================================================ sfx


def drone():
    T = 48
    sub = dsp.lowpass(dsp.noise(T + 4, 1, "brown"), 55) * 0.9
    hum = sum(dsp.osc(60 * h, T + 4) * (0.35 / h) for h in (1, 2, 3, 4, 6))
    hum = hum * (0.85 + 0.15 * dsp.osc(0.07, T + 4))
    groans = np.zeros(dsp.samples(T + 4))
    rng = np.random.default_rng(3)
    for k in range(7):
        start = rng.uniform(1, T)
        g = dsp.noise(3.5, 40 + k, "pink") * dsp.exp_env(3.5, 1.2, attack=0.6)
        f0 = rng.uniform(70, 160)
        g = dsp.modal(g, [f0, f0 * 2.31, f0 * 3.7], [2.5, 1.8, 1.1], [1, 0.5, 0.25])
        g = dsp.tape(g, rng.uniform(0.6, 0.9))
        dsp.wrap_add(groans, g * 0.08, dsp.samples(start))
    x = dsp.mix(T + 4, (sub, 0, -6), (hum, 0, -14), (groans, 0, -8), stereo=True)
    x = dsp.reverb(x, rt60=3.5, wet_db=-8, stereo=True, size=1.5)
    return dsp.loop_crossfade(x, T, 3.0)


def buzz():
    T = 4
    s = dsp.additive_saw(120, T + 1, 30)
    s = dsp.bandpass(s, 400, 6000)
    crackle = (np.random.default_rng(7).random(dsp.samples(T + 1)) > 0.9993) * dsp.noise(T + 1, 8)
    x = s * (0.8 + 0.2 * dsp.osc(7.3, T + 1)) + dsp.highpass(crackle, 2000) * 0.6
    return dsp.loop_crossfade(x, T, 0.4)


def whisper_bed():
    T = 30
    bed = np.zeros((dsp.samples(T + 2), 2))
    rng = np.random.default_rng(11)
    for k in range(18):
        line = WHISPERS[k % len(WHISPERS)]
        w = dsp.lpc_whisper(dsp.resample(tts(line, ["af_nicole", "bm_george", "af_sky"][k % 3], 0.75), SR, 24000), sr=24000, seed=k)
        w = dsp.resample(w, 24000, SR)
        if k % 2:
            w = w[::-1]
        w = dsp.pan(w * dsp.db(rng.uniform(-14, -6)), rng.uniform(-0.9, 0.9), 6)
        start = dsp.samples(rng.uniform(0, T))
        for ch in range(2):
            dsp.wrap_add(bed[:, ch], w[:, ch], start)
    bed = dsp.lowpass(bed, 5000)
    bed = dsp.reverb(bed, rt60=2.5, wet_db=-4, stereo=True, circular=True)
    return dsp.loop_crossfade(bed, T, 1.5)


def heartbeat(bpm, T):
    beat = 60 / bpm
    out = np.zeros(dsp.samples(T + 1))
    t = 0.0
    while t < T:
        for dt, f, g in ((0, 52, 1.0), (0.16, 44, 0.7)):
            thump = dsp.osc(f, 0.25) * dsp.exp_env(0.25, 0.05, attack=0.004) * g
            dsp.wrap_add(out, dsp.lowpass(thump, 120), dsp.samples(t + dt))
        t += beat
    out = dsp.softclip(out * 1.6, 1.2)
    return out[: dsp.samples(T)]


def breath():
    T = 6
    out = np.zeros(dsp.samples(T + 1))
    t, k = 0.1, 0
    rng = np.random.default_rng(5)
    while t < T - 0.8:
        dur = rng.uniform(0.45, 0.8)
        n = dsp.bandpass(dsp.noise(dur, 20 + k, "pink"), 450 if k % 2 == 0 else 700, 2600)
        env = np.sin(np.linspace(0, np.pi, len(n))) ** 1.5 * (1 + 0.3 * np.sin(np.linspace(0, 40, len(n))))
        dsp.wrap_add(out, n * env * (0.6 if k % 2 == 0 else 0.9), dsp.samples(t))
        t += dur + rng.uniform(0.05, 0.25)
        k += 1
    return dsp.loop_crossfade(out, T - 0.5, 0.4)


def step(i):
    rng = np.random.default_rng(100 + i)
    thump = dsp.lowpass(dsp.noise(0.18, 60 + i), 380) * dsp.exp_env(0.18, 0.035, attack=0.003)
    scuff = dsp.bandpass(dsp.noise(0.22, 70 + i), 900, 3200) * dsp.exp_env(0.22, 0.06, attack=0.01) * 0.25
    x = dsp.mix(0.3, (thump, 0), (scuff, rng.uniform(0.0, 0.03)))
    return x


def static_burst():
    n = dsp.noise(0.6, 31)
    crackle = (np.random.default_rng(32).random(len(n)) > 0.995) * 3.0
    x = (dsp.highpass(n, 600) + crackle) * dsp.env_adsr(0.6, 0.005, 0.1, 0.8, 0.15)
    return dsp.bitcrush(x, 6, 2)


def scream(seed=0):
    x = tts("aaaaaaaaah!", "af_bella", 1.05)
    x = dsp.pitch(x, 5, formant="shifted")
    x = dsp.detune_double(x, cents=45, delay_ms=7, gain_db=-2)
    x = dsp.softclip(x * 3, 1.5)
    return x


def glitch_shift():
    T = 2.6
    chord = sum(dsp.additive_saw(f, T, 20) for f in (55, 58.3, 82.4, 110))
    chord = dsp.lowpass(chord, 1800) * 0.4
    rate = np.linspace(1.0, 0.15, dsp.samples(T)) ** 2
    stopped = dsp.varispeed(chord + dsp.noise(T, 41) * 0.1, rate)
    rev = scream()[::-1]
    rev = rev[: dsp.samples(1.6)] * np.linspace(0, 1, min(len(rev), dsp.samples(1.6))) ** 2
    stut = np.zeros(dsp.samples(T))
    seg = dsp.noise(0.06, 42)
    for k in range(9):
        dsp.wrap_add(stut, seg * (1 - k / 9), dsp.samples(0.9 + k * 0.09))
    x = dsp.mix(T, (stopped, 0, -3), (rev, 0.7, -2), (dsp.bitcrush(stut, 5, 3), 0, -8))
    x[-dsp.samples(0.03):] = 0
    return x


def jumpscare():
    T = 1.8
    cluster = sum(dsp.additive_saw(f, T, 40) for f in (233, 246.9, 261.6, 277.2, 466, 494))
    noise = dsp.highpass(dsp.noise(T, 51), 1500) * 0.5
    sc = scream()
    x = dsp.mix(T, (cluster * dsp.exp_env(T, 0.9, attack=0.002), 0, -4), (noise * dsp.exp_env(T, 0.4, attack=0.001), 0, -6), (sc, 0.02, 0))
    return dsp.softclip(x * 2.2, 1.6)


def fuse_pickup():
    T = 1.3
    crackle = dsp.highpass(dsp.noise(0.4, 61), 2500) * ((np.random.default_rng(62).random(dsp.samples(0.4)) > 0.97) * 2 + 0.1)
    clunk = dsp.modal(dsp.noise(0.02, 63), [180, 410, 960], [0.25, 0.15, 0.08])
    rise = dsp.osc(np.linspace(80, 240, dsp.samples(1.0)), 1.0, "saw")
    rise = dsp.lowpass(rise, 900) * np.linspace(0, 0.5, len(rise))
    return dsp.mix(T, (crackle, 0, -4), (clunk, 0.15, 0), (rise, 0.25, -6))


def exit_power():
    T = 3.2
    thunk = dsp.modal(dsp.noise(0.03, 71) * 3, [48, 96, 210], [0.9, 0.5, 0.2])
    spin = dsp.osc(np.linspace(20, 180, dsp.samples(2.6)) ** 1.0, 2.6, "saw")
    spin = dsp.lowpass(spin, 1200) * np.linspace(0, 0.6, len(spin))
    alarm = dsp.osc(np.where((np.arange(dsp.samples(2.0)) // dsp.samples(0.25)) % 2 == 0, 880, 660), 2.0, "square")
    alarm = dsp.bandpass(alarm, 500, 2500) * 0.15
    x = dsp.mix(T, (thunk, 0, 0), (spin, 0.3, -6), (alarm, 1.1, -12))
    return dsp.reverb(x, rt60=2.2, wet_db=-8)


def door_open():
    T = 2.6
    scrape = dsp.bandpass(dsp.noise(2.0, 81, "pink"), 120, 1400)
    scrape = dsp.modal(scrape * 0.3, [92, 231, 377, 610], [0.8, 0.6, 0.4, 0.3]) * np.linspace(0.3, 1, dsp.samples(2.0))
    clang = dsp.modal(dsp.noise(0.02, 82) * 3, [140, 330, 720], [1.2, 0.8, 0.4])
    x = dsp.mix(T, (scrape, 0, -4), (clang, 2.0, 0))
    return dsp.reverb(x, rt60=2.4, wet_db=-6)


def click(f=2200, t=0.05):
    return dsp.bandpass(dsp.noise(t, int(f)), f * 0.6, f * 1.4) * dsp.exp_env(t, 0.006, attack=0.0005)


def flicker():
    T = 0.8
    b = dsp.bandpass(dsp.additive_saw(120, T, 30), 300, 5000)
    gate = (np.random.default_rng(91).random(dsp.samples(T) // 400 + 1) > 0.45).repeat(400)[: dsp.samples(T)]
    return b * gate * 0.7


SFX = {
    "amb_drone_loop.mp3": (drone, -22, True),
    "amb_buzz_loop.mp3": (buzz, -24, False),
    "whisper_bed_loop.mp3": (whisper_bed, -28, True),
    "heartbeat_slow_loop.mp3": (lambda: heartbeat(60, 4.0), -18, False),
    "heartbeat_fast_loop.mp3": (lambda: heartbeat(140, 60 / 140 * 5), -16, False),
    "breath_scared_loop.mp3": (breath, -22, False),
    "static_burst.mp3": (static_burst, -14, False),
    "glitch_shift.mp3": (glitch_shift, -12, False),
    "jumpscare_sting.mp3": (jumpscare, -9, False),
    "scream_turned.mp3": (scream, -12, False),
    "fuse_pickup.mp3": (fuse_pickup, -14, False),
    "exit_power.mp3": (exit_power, -13, False),
    "door_open.mp3": (door_open, -15, False),
    "ui_hover.mp3": (lambda: click(3200, 0.03), -26, False),
    "ui_click.mp3": (lambda: click(1800, 0.06), -20, False),
    "flashlight_click.mp3": (lambda: click(2600, 0.04), -20, False),
    "flashlight_flicker.mp3": (flicker, -20, False),
}
for i in range(4):
    SFX[f"step_carpet_{i + 1}.mp3"] = ((lambda i=i: step(i)), -22, False)

print("sfx")
for name, (fn, lufs, stereo) in SFX.items():
    if want(name):
        write(name, fn(), lufs=lufs, stereo=stereo, kbps=128 if stereo else 96)

manifest = {
    "voices": {
        "lure": {k: f"voice_lure_{k}.mp3" for k in LURES},
        "whispers": [f"voice_whisper_{i + 1:02d}.mp3" for i in range(len(WHISPERS))],
        "shift": [f"voice_shift_{i + 1:02d}.mp3" for i in range(3)],
        "turned": "voice_turned.mp3",
        "intro": "voice_intro.mp3",
    },
    "sfx": sorted(SFX.keys()),
}
with open(os.path.join(OUT, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
with open(os.path.join(OUT, "CREDITS.md"), "w") as f:
    f.write(
        "# Audio credits\n\n"
        "- Voices: generated offline with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0) "
        "via [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) (MIT), then processed for this project.\n"
        "- All sound effects were synthesized for this project (numpy/scipy + ffmpeg); no third-party samples.\n"
        "- Regenerate: `python3 tools/audio/generate.py --models <dir>` (see tools/audio/README.md).\n"
    )
print("done")

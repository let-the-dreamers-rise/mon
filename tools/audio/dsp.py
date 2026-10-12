"""
Small DSP toolkit for the HOLLOW audio pack.

Everything works on float32/float64 numpy arrays at SR (44.1 kHz).
Mono signals are 1-D arrays, stereo signals are (N, 2) arrays.
ffmpeg (on PATH or $FFMPEG) is used for rubberband pitch/time shifting
and MP3 encoding; everything else is numpy/scipy.
"""

from __future__ import annotations

import os
import subprocess

import numpy as np
from scipy import signal
from scipy.ndimage import minimum_filter1d, uniform_filter1d

SR = 44100
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")


# --------------------------------------------------------------------------
# basic helpers
# --------------------------------------------------------------------------

def db(x):
    return 10.0 ** (x / 20.0)


def secs(n, sr=SR):
    return n / sr


def samples(t, sr=SR):
    return int(round(t * sr))


def silence(t, sr=SR):
    return np.zeros(samples(t, sr))


def is_stereo(x):
    return x.ndim == 2


def to_stereo(x):
    return x if x.ndim == 2 else np.stack([x, x], axis=1)


def to_mono(x):
    return x.mean(axis=1) if x.ndim == 2 else x


def peak(x):
    return float(np.max(np.abs(x))) if len(x) else 0.0


def rms(x):
    return float(np.sqrt(np.mean(np.square(x)))) if len(x) else 0.0


def pad(x, pre=0.0, post=0.0, sr=SR):
    a, b = samples(pre, sr), samples(post, sr)
    width = ((a, b), (0, 0)) if x.ndim == 2 else (a, b)
    return np.pad(x, width)


def fit(x, n):
    """Zero-pad or cut x to exactly n samples."""
    if len(x) >= n:
        return x[:n]
    width = ((0, n - len(x)), (0, 0)) if x.ndim == 2 else (0, n - len(x))
    return np.pad(x, width)


def fade(x, fin=0.0, fout=0.0, sr=SR, shape="cos"):
    y = x.copy()
    n_in, n_out = samples(fin, sr), samples(fout, sr)

    def curve(n):
        t = np.linspace(0, 1, n)
        return np.sin(t * np.pi / 2) ** 2 if shape == "cos" else t

    if n_in:
        c = curve(n_in)
        y[:n_in] *= c[:, None] if y.ndim == 2 else c
    if n_out:
        c = curve(n_out)[::-1]
        y[-n_out:] *= c[:, None] if y.ndim == 2 else c
    return y


def mix(length, *parts, sr=SR, stereo=False):
    """mix(length_seconds, (signal, offset_seconds, gain_db), ...).

    Signals that run past the end are cut. Negative offsets cut the head."""
    n = samples(length, sr)
    out = np.zeros((n, 2)) if stereo else np.zeros(n)
    for part in parts:
        sig, off = part[0], part[1]
        g = db(part[2]) if len(part) > 2 else 1.0
        if stereo:
            sig = to_stereo(sig)
        elif sig.ndim == 2:
            sig = to_mono(sig)
        o = samples(off, sr)
        if o < 0:
            sig, o = sig[-o:], 0
        if o >= n:
            continue
        m = min(len(sig), n - o)
        out[o:o + m] += sig[:m] * g
    return out


def concat(*parts):
    return np.concatenate([p for p in parts if len(p)])


def trim_silence(x, thresh_db=-50, pad_s=0.02, sr=SR):
    a = np.abs(to_mono(x))
    thr = peak(a) * db(thresh_db)
    idx = np.where(a > thr)[0]
    if not len(idx):
        return x
    s = max(0, idx[0] - samples(pad_s, sr))
    e = min(len(x), idx[-1] + samples(pad_s, sr))
    return x[s:e]


# --------------------------------------------------------------------------
# filters
# --------------------------------------------------------------------------

def _sos_apply(sos, x, zero_phase=False):
    f = signal.sosfiltfilt if zero_phase else signal.sosfilt
    return f(sos, x, axis=0)


def lowpass(x, fc, order=4, sr=SR, zero_phase=False):
    fc = min(fc, sr * 0.49)
    return _sos_apply(signal.butter(order, fc, "low", fs=sr, output="sos"), x, zero_phase)


def highpass(x, fc, order=4, sr=SR, zero_phase=False):
    return _sos_apply(signal.butter(order, fc, "high", fs=sr, output="sos"), x, zero_phase)


def bandpass(x, lo, hi, order=4, sr=SR, zero_phase=False):
    hi = min(hi, sr * 0.49)
    return _sos_apply(signal.butter(order, [lo, hi], "band", fs=sr, output="sos"), x, zero_phase)


def _biquad(kind, f0, gain_db=0.0, q=0.707, sr=SR):
    """RBJ cookbook biquads -> (b, a)."""
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / sr
    al = np.sin(w0) / (2 * q)
    c = np.cos(w0)
    if kind == "peak":
        b = [1 + al * A, -2 * c, 1 - al * A]
        a = [1 + al / A, -2 * c, 1 - al / A]
    elif kind == "lowshelf":
        sA = 2 * np.sqrt(A) * al
        b = [A * ((A + 1) - (A - 1) * c + sA), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sA)]
        a = [(A + 1) + (A - 1) * c + sA, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sA]
    elif kind == "highshelf":
        sA = 2 * np.sqrt(A) * al
        b = [A * ((A + 1) + (A - 1) * c + sA), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sA)]
        a = [(A + 1) - (A - 1) * c + sA, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sA]
    elif kind == "bandpass":  # constant 0 dB peak gain
        b = [al, 0, -al]
        a = [1 + al, -2 * c, 1 - al]
    else:
        raise ValueError(kind)
    return np.array(b) / a[0], np.array(a) / a[0]


def eq(x, kind, f0, gain_db=0.0, q=0.707, sr=SR):
    b, a = _biquad(kind, f0, gain_db, q, sr)
    return signal.lfilter(b, a, x, axis=0)


def resonator(x, f0, q, sr=SR):
    return eq(x, "bandpass", f0, 0, q, sr)


def tv_lowpass(x, fc_curve, sr=SR):
    """Time-varying one-pole-pair lowpass; fc_curve has len(x) values (Hz)."""
    fc = np.clip(np.asarray(fc_curve, float), 20, sr * 0.45)
    a = np.exp(-2 * np.pi * fc / sr)
    y = np.empty_like(x, dtype=float)
    z1 = np.zeros(x.shape[1:]) if x.ndim == 2 else 0.0
    z2 = z1 * 0 if x.ndim == 2 else 0.0
    # two cascaded one-pole filters, vectorised per block for speed
    blk = 64
    for i in range(0, len(x), blk):
        aa = a[i:i + blk]
        xx = x[i:i + blk]
        for j in range(len(xx)):
            z1 = (1 - aa[j]) * xx[j] + aa[j] * z1
            z2 = (1 - aa[j]) * z1 + aa[j] * z2
            y[i + j] = z2
    return y


# --------------------------------------------------------------------------
# resampling / pitch
# --------------------------------------------------------------------------

def resample(x, sr_in, sr_out):
    if sr_in == sr_out:
        return x.astype(float)
    g = np.gcd(int(sr_in), int(sr_out))
    return signal.resample_poly(x, sr_out // g, sr_in // g, axis=0)


def tape(x, factor):
    """Varispeed: factor>1 = faster & higher, <1 = slower & lower."""
    n_out = int(len(x) / factor)
    pos = np.arange(n_out) * factor
    if x.ndim == 2:
        return np.stack([np.interp(pos, np.arange(len(x)), x[:, c]) for c in range(2)], 1)
    # band-limit when speeding up to avoid aliasing
    if factor > 1:
        x = lowpass(x, SR * 0.45 / factor, order=8)
    return np.interp(pos, np.arange(len(x)), x)


def varispeed(x, rate):
    """Play x with a per-output-sample rate curve (callable t->rate or array).

    Negative rates play backwards. Returns as many samples as `rate` has."""
    rate = np.asarray(rate, float)
    pos = np.cumsum(rate)
    pos = np.clip(pos, 0, len(x) - 1)
    return np.interp(pos, np.arange(len(x)), x)


def run_ffmpeg_filter(x, filt, sr=SR):
    """Pipe a float signal through an ffmpeg audio filter graph."""
    ch = 2 if x.ndim == 2 else 1
    raw = np.ascontiguousarray(x, dtype=np.float32).tobytes()
    cmd = [FFMPEG, "-v", "error", "-f", "f32le", "-ar", str(sr), "-ac", str(ch), "-i", "-",
           "-af", filt, "-f", "f32le", "-ar", str(sr), "-ac", str(ch), "-"]
    out = subprocess.run(cmd, input=raw, capture_output=True, check=True).stdout
    y = np.frombuffer(out, dtype=np.float32).astype(float)
    return y.reshape(-1, 2) if ch == 2 else y


def pitch(x, semitones=0.0, tempo=1.0, formant="shifted", sr=SR, quality=True):
    """Rubberband pitch/tempo shift. formant='preserved' keeps vocal tract size."""
    if semitones == 0 and tempo == 1.0:
        return x.copy()
    ratio = 2 ** (semitones / 12)
    opts = [f"pitch={ratio:.6f}", f"tempo={tempo:.6f}", f"formant={formant}",
            "transients=mixed", "detector=soft", "window=standard", "smoothing=on"]
    if quality:
        opts.append("pitchq=quality")
    # pad so the filter's latency compensation never eats the tail
    xp = pad(x, 0, 0.3, sr)
    y = run_ffmpeg_filter(xp, "rubberband=" + ":".join(opts), sr)
    return y


def stretch_to(x, n, formant="preserved"):
    """Time-stretch x to n samples without changing pitch."""
    tempo = len(x) / max(1, n)
    y = pitch(x, 0.0001, tempo=tempo, formant=formant)
    return fit(y, n)


# --------------------------------------------------------------------------
# dynamics / distortion
# --------------------------------------------------------------------------

def env_follow(x, attack=0.005, release=0.05, sr=SR):
    a = np.abs(to_mono(x))
    # vectorised: smooth with asymmetric approach approximated by two passes
    up = uniform_filter1d(a, max(1, samples(attack, sr)))
    env = signal.lfilter([1 - np.exp(-1 / (release * sr))], [1, -np.exp(-1 / (release * sr))], up)
    return np.maximum(env, up * 0.0)


def softclip(x, drive=1.0):
    return np.tanh(x * drive) / np.tanh(drive)


def bitcrush(x, bits=8, hold=1):
    y = x.copy()
    if hold > 1:
        idx = (np.arange(len(y)) // hold) * hold
        y = y[idx]
    q = 2 ** (bits - 1)
    return np.round(y * q) / q


def limiter(x, ceiling_db=-1.0, lookahead=0.004, release=0.06, sr=SR):
    c = db(ceiling_db)
    a = np.abs(x).max(axis=1) if x.ndim == 2 else np.abs(x)
    g = np.minimum(1.0, c / np.maximum(a, 1e-12))
    la = max(1, samples(lookahead, sr))
    rl = max(1, samples(release, sr))
    g = minimum_filter1d(g, size=2 * la + 1)
    g = uniform_filter1d(g, size=la)
    g = minimum_filter1d(g, size=2 * rl + 1)
    g = uniform_filter1d(g, size=rl)
    g = np.minimum(g, 1.0)
    y = x * (g[:, None] if x.ndim == 2 else g)
    return np.clip(y, -c, c)


def compress(x, thresh_db=-20, ratio=4, attack=0.005, release=0.1, makeup_db=0, sr=SR):
    env = env_follow(x, attack, release, sr)
    lvl = 20 * np.log10(np.maximum(env, 1e-9))
    over = np.maximum(0, lvl - thresh_db)
    gdb = -over * (1 - 1 / ratio) + makeup_db
    g = db(gdb)
    return x * (g[:, None] if x.ndim == 2 else g)


# --------------------------------------------------------------------------
# loudness (ITU-R BS.1770-4 / EBU R128 integrated)
# --------------------------------------------------------------------------

def _k_weight(x, sr=SR):
    # stage 1: high shelf, stage 2: RLB high-pass (coeffs as in BS.1770 / pyloudnorm)
    b1, a1 = _kw_shelf(sr)
    b2, a2 = _kw_hp(sr)
    return signal.lfilter(b2, a2, signal.lfilter(b1, a1, x, axis=0), axis=0)


def _kw_shelf(sr):
    G, Q, fc = 3.999843853973347, 0.7071752369554193, 1681.974450955533
    A = 10 ** (G / 40)
    w0 = 2 * np.pi * fc / sr
    al = np.sin(w0) / (2 * Q)
    c = np.cos(w0)
    b = [A * ((A + 1) + (A - 1) * c + 2 * np.sqrt(A) * al),
         -2 * A * ((A - 1) + (A + 1) * c),
         A * ((A + 1) + (A - 1) * c - 2 * np.sqrt(A) * al)]
    a = [(A + 1) - (A - 1) * c + 2 * np.sqrt(A) * al,
         2 * ((A - 1) - (A + 1) * c),
         (A + 1) - (A - 1) * c - 2 * np.sqrt(A) * al]
    return np.array(b) / a[0], np.array(a) / a[0]


def _kw_hp(sr):
    Q, fc = 0.5003270373253953, 38.13547087613982
    w0 = 2 * np.pi * fc / sr
    al = np.sin(w0) / (2 * Q)
    c = np.cos(w0)
    b = [(1 + c) / 2, -(1 + c), (1 + c) / 2]
    a = [1 + al, -2 * c, 1 - al]
    return np.array(b) / a[0], np.array(a) / a[0]


def lufs(x, sr=SR):
    y = _k_weight(x if x.ndim == 2 else x[:, None], sr)
    n = len(y)
    blk, hop = samples(0.4, sr), samples(0.1, sr)
    if n < blk:
        y = np.pad(y, ((0, blk - n), (0, 0)))
        n = blk
    starts = np.arange(0, n - blk + 1, hop)
    cs = np.concatenate([np.zeros((1, y.shape[1])), np.cumsum(y ** 2, axis=0)])
    z = (cs[starts + blk] - cs[starts]) / blk  # (blocks, ch)
    zs = z.sum(axis=1)
    lk = -0.691 + 10 * np.log10(np.maximum(zs, 1e-20))
    g1 = lk > -70
    if not g1.any():
        return -120.0
    rel = -0.691 + 10 * np.log10(zs[g1].mean()) - 10
    g2 = g1 & (lk > rel)
    return float(-0.691 + 10 * np.log10(zs[g2].mean()))


def normalize(x, target_lufs, ceiling_db=-1.0, sr=SR):
    """Gain to target integrated loudness, limiting peaks to the ceiling."""
    y = x.copy()
    for _ in range(4):
        cur = lufs(y, sr)
        y = y * db(target_lufs - cur)
        if peak(y) > db(ceiling_db):
            y = limiter(y, ceiling_db, sr=sr)
        if abs(lufs(y, sr) - target_lufs) < 0.15:
            break
    return y


def normalize_peak(x, peak_db=-1.0):
    p = peak(x)
    return x * (db(peak_db) / p) if p > 0 else x


# --------------------------------------------------------------------------
# reverb
# --------------------------------------------------------------------------

def make_ir(rt60=2.0, predelay=0.01, damp=0.5, stereo=False, seed=0, early=6,
            size=1.0, sr=SR, lo_cut=60.0):
    """Synthetic room impulse response: early taps + band-dependent decaying noise.

    damp: 0..1, how much faster high frequencies die (1 = very dark tail)."""
    rng = np.random.default_rng(seed)
    n = samples(rt60 * 1.15 + predelay + 0.05, sr)
    t = np.arange(n) / sr
    chans = 2 if stereo else 1
    out = np.zeros((n, chans))
    bands = [(None, 400, 1.15), (400, 3000, 1.0), (3000, None, max(0.12, 1 - damp))]
    for c in range(chans):
        noise = rng.standard_normal(n)
        ir = np.zeros(n)
        for lo, hi, mult in bands:
            if lo is None:
                b = lowpass(noise, hi, 2, sr)
            elif hi is None:
                b = highpass(noise, lo, 2, sr)
            else:
                b = bandpass(noise, lo, hi, 2, sr)
            ir += b * 10 ** (-3 * t / (rt60 * mult))
        # soft onset (diffuse field builds up)
        build = 1 - np.exp(-t / (0.012 * size + 1e-4))
        ir *= build
        # early reflections
        for _ in range(early):
            d = samples(rng.uniform(0.004, 0.06) * size, sr)
            if d < n:
                ir[d] += rng.uniform(0.3, 0.9) * rng.choice([-1, 1]) * np.sqrt(np.mean(ir ** 2)) * 25
        ir = np.concatenate([np.zeros(samples(predelay, sr)), ir])[:n]
        out[:, c] = ir
    if lo_cut:
        out = highpass(out, lo_cut, 2, sr)
    out /= np.sqrt(np.sum(out ** 2) / chans)
    return out if stereo else out[:, 0]


def convolve(x, ir, circular=False):
    """Convolve (mono or stereo) x with (mono or stereo) ir."""
    xs, irs = x.ndim == 2, ir.ndim == 2
    if not xs and not irs:
        return _conv1(x, ir, circular)
    xx, ii = to_stereo(x), to_stereo(ir)
    return np.stack([_conv1(xx[:, c], ii[:, c], circular) for c in range(2)], 1)


def _conv1(x, h, circular):
    if not circular:
        return signal.fftconvolve(x, h)
    n = len(x)
    hf = np.zeros(n)
    for i in range(0, len(h), n):  # fold long IR into loop length
        seg = h[i:i + n]
        hf[:len(seg)] += seg
    return np.fft.irfft(np.fft.rfft(x) * np.fft.rfft(hf), n)


def reverb(x, rt60=2.0, wet_db=-6, dry_db=0, predelay=0.01, damp=0.5, stereo=False,
           seed=0, circular=False, size=1.0, tail=True, lo_cut=60.0):
    ir = make_ir(rt60, predelay, damp, stereo, seed, size=size, lo_cut=lo_cut)
    w = convolve(x, ir, circular)
    # scale wet so it sits relative to the dry signal's level
    w = w * (rms(x) / max(rms(w), 1e-12)) * db(wet_db)
    d = x * db(dry_db)
    if stereo and x.ndim == 1:
        d = to_stereo(d)
    if circular:
        return d + w
    if not tail:
        return d + w[:len(d)]
    return fit(d, len(w)) + w


def reverse_reverb(x, rt60=1.5, wet_db=-6, predelay=0.0, damp=0.4, seed=1, stereo=False):
    """reverse -> reverb (wet only) -> reverse. Returns (swell, lead_seconds):
    the swell array starts `lead` seconds before x starts."""
    ir = make_ir(rt60, predelay, damp, stereo, seed)
    w = convolve(x[::-1], ir)[::-1]
    w = w * (rms(x) / max(rms(w), 1e-12)) * db(wet_db)
    lead = (len(w) - len(x)) / SR
    return w, lead


# --------------------------------------------------------------------------
# voice effects
# --------------------------------------------------------------------------

def lpc_whisper(x, sr=24000, order=None, frame=0.025, hop=0.0125, seed=0, keep_voiced=0.0):
    """Turn voiced speech into a whisper: per-frame LPC envelope excited with noise."""
    from scipy.linalg import solve_toeplitz
    rng = np.random.default_rng(seed)
    order = order or int(sr / 1000) + 4
    pre = signal.lfilter([1, -0.95], [1], x)
    N, H = samples(frame, sr), samples(hop, sr)
    win = np.hanning(N)
    nfr = max(1, (len(pre) - N) // H + 1)
    out = np.zeros(len(pre) + N)
    norm = np.zeros(len(pre) + N)
    for i in range(nfr):
        s = i * H
        fr = pre[s:s + N]
        if len(fr) < N:
            fr = np.pad(fr, (0, N - len(fr)))
        fw = fr * win
        e = np.sqrt(np.mean(fw ** 2))
        if e < 1e-6:
            norm[s:s + N] += win ** 2
            continue
        r = np.correlate(fw, fw, "full")[N - 1:N + order]
        r[0] *= 1.0001
        r = r * np.exp(-0.5 * (2 * np.pi * 60 * np.arange(order + 1) / sr) ** 2)  # lag window
        try:
            a = solve_toeplitz(r[:order], -r[1:order + 1])
        except Exception:
            norm[s:s + N] += win ** 2
            continue
        A = np.concatenate([[1.0], a])
        if np.any(np.abs(np.roots(A)) >= 1):
            norm[s:s + N] += win ** 2
            continue
        ex = rng.standard_normal(N + 256)
        y = signal.lfilter([1.0], A, ex)[256:] * win
        y *= e / max(np.sqrt(np.mean(y ** 2)), 1e-12)
        out[s:s + N] += y * win
        norm[s:s + N] += win ** 2
    out = out[:len(pre)] / np.maximum(norm[:len(pre)], 1e-3)
    out = signal.lfilter([1], [1, -0.95], out)
    out = highpass(out, 80, 2, sr)
    if keep_voiced:
        out = out + x * keep_voiced
    return out


def detune_double(x, cents=12, delay_ms=15, gain_db=-3, formant="preserved"):
    """Add a slightly detuned, delayed copy (unsettling 'two of you' doubling)."""
    a = pitch(x, cents / 100, formant=formant)
    a = pad(a, delay_ms / 1000, 0)
    out = fit(x, max(len(x), len(a))) + fit(a, max(len(x), len(a))) * db(gain_db)
    return out


def ring(x, freq, depth=1.0, sr=SR):
    t = np.arange(len(x)) / sr
    m = (1 - depth) + depth * np.sin(2 * np.pi * freq * t)
    return x * (m[:, None] if x.ndim == 2 else m)


def tremolo(x, freq, depth=0.5, sr=SR, jitter=0.0, seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(len(x)) / sr
    ph = 2 * np.pi * freq * t
    if jitter:
        ph += jitter * np.cumsum(rng.standard_normal(len(x))) / np.sqrt(sr) * 2 * np.pi
    m = 1 - depth * (0.5 + 0.5 * np.sin(ph))
    return x * (m[:, None] if x.ndim == 2 else m)


def vibrato(x, freq=5.0, depth_ms=0.6, sr=SR):
    n = np.arange(len(x))
    d = depth_ms / 1000 * sr * (1 + np.sin(2 * np.pi * freq * n / sr)) / 2
    return np.interp(n - d, n, x)


def radio(x, lo=350, hi=3200, drive=2.5, sr=SR):
    y = bandpass(x, lo, hi, 2, sr)
    y = softclip(y / max(peak(y), 1e-9), drive) * peak(y)
    return y


def pan(x, pos=0.0, width_ms=0.0, sr=SR):
    """Constant-power pan of a mono signal; pos -1..1. Optional tiny ITD."""
    th = (pos + 1) * np.pi / 4
    l, r = x * np.cos(th), x * np.sin(th)
    d = samples(abs(width_ms) / 1000 * abs(pos), sr)
    if d:
        if pos > 0:
            l = np.concatenate([np.zeros(d), l[:-d]])
        else:
            r = np.concatenate([np.zeros(d), r[:-d]])
    return np.stack([l, r], 1)


# --------------------------------------------------------------------------
# noise / oscillators
# --------------------------------------------------------------------------

def noise(t, seed=0, color="white", sr=SR):
    rng = np.random.default_rng(seed)
    n = samples(t, sr)
    w = rng.standard_normal(n)
    if color == "white":
        return w
    if color == "pink":
        f = np.fft.rfft(w)
        k = np.arange(len(f))
        k[0] = 1
        y = np.fft.irfft(f / np.sqrt(k), n)
    elif color == "brown":
        f = np.fft.rfft(w)
        k = np.arange(len(f)).astype(float)
        k[0] = 1
        y = np.fft.irfft(f / k, n)
    else:
        raise ValueError(color)
    return y / max(np.std(y), 1e-12)


def osc(freq, t, shape="sine", phase=0.0, sr=SR):
    """freq may be scalar or per-sample array."""
    n = samples(t, sr)
    f = np.broadcast_to(np.asarray(freq, float), (n,)) if np.ndim(freq) == 0 else np.asarray(freq, float)[:n]
    ph = 2 * np.pi * np.cumsum(f) / sr + phase
    if shape == "sine":
        return np.sin(ph)
    if shape == "saw":  # polyblep-free, band-limit afterwards if needed
        return 2 * ((ph / (2 * np.pi)) % 1.0) - 1
    if shape == "square":
        return np.sign(np.sin(ph))
    if shape == "tri":
        return 2 * np.abs(2 * ((ph / (2 * np.pi)) % 1.0) - 1) - 1
    raise ValueError(shape)


def additive_saw(freq, t, nharm=40, sr=SR, phase_seed=None):
    """Band-limited saw by additive synthesis (freq scalar or array)."""
    n = samples(t, sr)
    f = np.broadcast_to(np.asarray(freq, float), (n,)) if np.ndim(freq) == 0 else np.asarray(freq, float)[:n]
    ph = 2 * np.pi * np.cumsum(f) / sr
    out = np.zeros(n)
    rng = np.random.default_rng(phase_seed) if phase_seed is not None else None
    for k in range(1, nharm + 1):
        mask = (f * k) < sr * 0.45
        off = rng.uniform(0, 2 * np.pi) if rng is not None else 0.0
        out += mask * np.sin(k * ph + off) / k
    return out * (2 / np.pi)


def env_adsr(t, a, d, s, r, sr=SR, total=None):
    n = samples(total if total else t, sr)
    e = np.zeros(n)
    na, nd, nr = samples(a, sr), samples(d, sr), samples(r, sr)
    hold_end = samples(t, sr)
    i = 0
    seg = np.linspace(0, 1, max(1, na))
    e[i:i + len(seg)] = seg[:n - i]
    i += len(seg)
    seg = np.linspace(1, s, max(1, nd))
    e[i:i + len(seg)] = seg[:max(0, n - i)]
    i += len(seg)
    if hold_end > i:
        e[i:hold_end] = s
        i = hold_end
    seg = np.linspace(s, 0, max(1, nr))
    e[i:i + len(seg)] = seg[:max(0, n - i)]
    return e


def exp_env(t, tau, sr=SR, attack=0.001):
    n = samples(t, sr)
    tt = np.arange(n) / sr
    e = np.exp(-tt / tau)
    na = samples(attack, sr)
    if na > 1:
        e[:na] *= np.linspace(0, 1, na)
    return e


def modal(excite, freqs, decays, gains=None, sr=SR):
    """Bank of decaying resonators (metallic objects). decays = T60 seconds."""
    out = np.zeros(len(excite))
    gains = gains if gains is not None else [1.0] * len(freqs)
    for f, t60, g in zip(freqs, decays, gains):
        if f >= sr * 0.45:
            continue
        r = 10 ** (-3 / (t60 * sr))
        w = 2 * np.pi * f / sr
        b = [1 - r]
        a = [1, -2 * r * np.cos(w), r * r]
        out += g * signal.lfilter(b, a, excite)
    return out


# --------------------------------------------------------------------------
# loops
# --------------------------------------------------------------------------

def loop_crossfade(x, length, xfade):
    """x must be at least length+xfade long. Returns a seamless loop of `length`
    seconds: the material after the loop point is cross-faded into the head."""
    L, C = samples(length), samples(xfade)
    assert len(x) >= L + C, (len(x), L + C)
    y = x[:L].copy()
    t = np.linspace(0, 1, C)
    fin, fout = np.sin(t * np.pi / 2), np.cos(t * np.pi / 2)
    if x.ndim == 2:
        fin, fout = fin[:, None], fout[:, None]
    y[:C] = x[:C] * fin + x[L:L + C] * fout
    return y


def wrap_add(buf, sig, offset):
    """Add sig into circular buffer buf starting at sample offset (wraps around)."""
    n = len(buf)
    o = offset % n
    sig = sig[:n]
    first = min(len(sig), n - o)
    buf[o:o + first] += sig[:first]
    if first < len(sig):
        buf[:len(sig) - first] += sig[first:]
    return buf


# --------------------------------------------------------------------------
# io
# --------------------------------------------------------------------------

def write_mp3(path, x, bitrate="96k", sr=SR, title=None):
    ch = 2 if x.ndim == 2 else 1
    raw = np.ascontiguousarray(np.clip(x, -1, 1), dtype=np.float32).tobytes()
    cmd = [FFMPEG, "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", str(ch), "-i", "-",
           "-map_metadata", "-1", "-c:a", "libmp3lame", "-b:a", bitrate, "-ar", str(sr), "-ac", str(ch)]
    if title:
        cmd += ["-metadata", f"title={title}"]
    cmd.append(path)
    subprocess.run(cmd, input=raw, check=True)


def write_wav(path, x, sr=SR):
    import soundfile as sf
    sf.write(path, np.clip(x, -1, 1).astype(np.float32), sr, subtype="FLOAT")


def read_audio(path, sr=SR, mono=True):
    cmd = [FFMPEG, "-v", "error", "-i", path, "-ac", "1" if mono else "2", "-ar", str(sr), "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    y = np.frombuffer(out, dtype=np.float32).astype(float)
    return y if mono else y.reshape(-1, 2)

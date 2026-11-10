"""Original music bed and UI sounds for the product films.

Everything here is synthesized from sine, saw and noise in this script, so the audio is
original work with no third-party samples or licences. Deterministic: same args, same files.

  uv run --with numpy --with scipy python scripts/make_audio.py bed --out public/audio/film-bed.wav \
      --seconds 24 --drop 3.6 --outro 20.4 --key D

Tempo is fixed at 100 BPM, so one beat is 0.6 s = 18 frames at 30 fps. Scene cuts land on beats.
"""

import argparse
import wave
from pathlib import Path

import numpy as np
from scipy import signal

SR = 44100
BPM = 100
BEAT = 60 / BPM
BAR = 4 * BEAT
RNG = np.random.default_rng(7)

NOTE = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def env_adsr(n: int, a: float, d: float, s: float, r: float) -> np.ndarray:
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    sus_n = max(n - a_n - d_n - r_n, 0)
    e = np.concatenate([
        np.linspace(0, 1, a_n, endpoint=False),
        np.linspace(1, s, d_n, endpoint=False),
        np.full(sus_n, s),
        np.linspace(s, 0, r_n),
    ])
    return np.pad(e, (0, max(n - len(e), 0)))[:n]


def lowpass(x: np.ndarray, cutoff: float, order: int = 2) -> np.ndarray:
    b, a = signal.butter(order, cutoff / (SR / 2), "low")
    return signal.lfilter(b, a, x)


def highpass(x: np.ndarray, cutoff: float, order: int = 2) -> np.ndarray:
    b, a = signal.butter(order, cutoff / (SR / 2), "high")
    return signal.lfilter(b, a, x)


def saw(f: float, t: np.ndarray) -> np.ndarray:
    return 2 * ((f * t) % 1.0) - 1


def place(buf: np.ndarray, clip: np.ndarray, at: float, gain: float = 1.0) -> None:
    i = int(at * SR)
    if i >= buf.shape[-1]:
        return
    j = min(i + clip.shape[-1], buf.shape[-1])
    buf[..., i:j] += gain * clip[..., : j - i]


def stereo(mono: np.ndarray, pan: float = 0.0) -> np.ndarray:
    left = np.cos((pan + 1) * np.pi / 4)
    right = np.sin((pan + 1) * np.pi / 4)
    return np.stack([mono * left, mono * right])


# ---------------------------------------------------------------- instruments
def pad_chord(notes: list[int], dur: float) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros((2, n))
    for k, m in enumerate(notes):
        for det, pan in ((-0.07, -0.6), (0.0, 0.0), (0.07, 0.6)):
            f = hz(m + det)
            phase = RNG.uniform(0, 1)
            v = saw(f, t + phase / f) * 0.5 + np.sin(2 * np.pi * f * t) * 0.5
            out += stereo(v, pan) / (len(notes) * 3)
    # slow filter swell inside the chord
    lfo = 900 + 700 * (0.5 - 0.5 * np.cos(2 * np.pi * t / dur))
    out = np.stack([lowpass(ch, 1400) for ch in out]) * 0.6 + np.stack([lowpass(ch, 700) for ch in out]) * 0.4
    out *= 0.85 + 0.15 * (lfo / lfo.max())
    return out * env_adsr(n, 0.35, 0.4, 0.8, 0.5)


def pluck(m: int, dur: float = 0.5) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(m)
    v = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 18) + 0.15 * saw(f, t)
    v = lowpass(v, 3200)
    return v * np.exp(-t * 7.5) * env_adsr(n, 0.004, 0.05, 1.0, 0.05)


def bass(m: int, dur: float) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(m)
    v = np.sin(2 * np.pi * f * t) + 0.2 * np.sin(2 * np.pi * 2 * f * t)
    return v * env_adsr(n, 0.01, 0.15, 0.7, 0.12)


def kick() -> np.ndarray:
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 45 + 85 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    v = np.sin(ph) * np.exp(-t * 7) + 0.25 * RNG.standard_normal(n) * np.exp(-t * 300)
    return lowpass(v, 2500)


def hat(open_: bool = False) -> np.ndarray:
    n = int((0.18 if open_ else 0.05) * SR)
    t = np.arange(n) / SR
    v = highpass(RNG.standard_normal(n), 7000)
    return v * np.exp(-t * (18 if open_ else 70))


def shaker() -> np.ndarray:
    n = int(0.09 * SR)
    t = np.arange(n) / SR
    v = signal.lfilter(*signal.butter(2, [4000 / (SR / 2), 9000 / (SR / 2)], "band"), RNG.standard_normal(n))
    return v * (t / 0.02).clip(0, 1) * np.exp(-t * 40)


# ---------------------------------------------------------------- the bed
def chords_for(key: str) -> list[tuple[list[int], int]]:
    r = 50 + NOTE[key]  # D3 = 50
    # I maj9 - vi m9 - IV maj7(#11 color) - V sus: calm, bright, unresolved
    return [
        ([r, r + 4, r + 7, r + 11, r + 14], r - 12),
        ([r - 3, r + 0, r + 4, r + 7, r + 11], r - 15),
        ([r - 5, r - 1, r + 2, r + 6, r + 9], r - 17),
        ([r - 3 + 0, r + 2, r + 4, r + 9, r + 11], r - 10),
    ]


def make_bed(seconds: float, drop: float, outro: float, key: str) -> np.ndarray:
    n = int((seconds + 2.5) * SR)
    pad = np.zeros((2, n))
    lead = np.zeros((2, n))
    low = np.zeros((2, n))
    drums = np.zeros((2, n))
    prog = chords_for(key)
    bars = int(np.ceil((seconds + 2.5) / BAR))
    arp = [0, 2, 4, 3, 1, 3, 2, 4]  # index into chord tones
    for b in range(bars):
        t0 = b * BAR
        notes, root = prog[b % 4]
        place(pad, pad_chord(notes, BAR + 0.6), t0)
        in_body = drop <= t0 + 1e-6 < outro
        if t0 + BAR > drop and t0 < outro:
            for s in range(8):
                ts = t0 + s * BEAT / 2
                if ts < drop or ts >= outro:
                    continue
                m = notes[arp[s]] + 12
                p = pluck(m)
                pan = -0.35 if s % 2 else 0.35
                place(lead, stereo(p, pan), ts, 0.33)
                place(lead, stereo(p, -pan), ts + 0.75 * BEAT, 0.12)  # dotted-8th echo
            for q in range(4):
                tq = t0 + q * BEAT
                if drop <= tq < outro:
                    place(low, stereo(bass(root, BEAT * 0.9)), tq, 0.42)
                    if q in (0, 2):
                        place(drums, stereo(kick()), tq, 0.55)
                    place(drums, stereo(lowpass(hat(q == 3), 9000) if q == 3 else hat(), 0.25), tq + BEAT / 2, 0.065 if q == 3 else 0.11)  # open hat softer
                    place(drums, stereo(shaker(), -0.3), tq + BEAT / 4, 0.05)
                    place(drums, stereo(shaker(), -0.3), tq + 3 * BEAT / 4, 0.04)
        _ = in_body
    # sidechain pump from the kick grid, body only
    t = np.arange(n) / SR
    beat_pos = (t % (2 * BEAT)) / (2 * BEAT)
    pump = 1 - 0.35 * np.exp(-beat_pos * 9)
    body = ((t >= drop) & (t < outro)).astype(float)
    pump = 1 - body * (1 - pump)
    mix = pad * 0.55 * pump + lead * pump + low * pump + drums
    # intro swell, outro ring out
    fade_in = np.clip(t / 1.2, 0, 1) ** 2
    tail = np.clip(1 - (t - seconds + 1.4) / 1.4, 0, 1)
    mix *= fade_in * tail
    mix = np.tanh(mix * 1.4) / np.tanh(1.4)
    peak = np.abs(mix).max()
    return (mix / peak * 0.85)[:, : int(seconds * SR)]


# ---------------------------------------------------------------- UI sounds
def sfx_whoosh() -> np.ndarray:
    dur = 0.7
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = RNG.standard_normal(n)
    out = np.zeros(n)
    centers = 400 + 3200 * np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 2
    for i in range(0, n, 512):  # block-wise swept band-pass
        c = centers[i]
        b, a = signal.butter(2, [max(c * 0.6, 60) / (SR / 2), min(c * 1.4, SR / 2 - 100) / (SR / 2)], "band")
        out[i:i + 512] = signal.lfilter(b, a, noise[i:i + 512])
    e = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 1.6
    pan = np.linspace(-0.6, 0.6, n)
    return np.stack([out * e * np.cos((pan + 1) * np.pi / 4), out * e * np.sin((pan + 1) * np.pi / 4)])


def sfx_tick() -> np.ndarray:
    n = int(0.08 * SR)
    t = np.arange(n) / SR
    v = np.sin(2 * np.pi * 2600 * t) * np.exp(-t * 90) + 0.4 * highpass(RNG.standard_normal(n), 3000) * np.exp(-t * 400)
    return stereo(v)


def sfx_hit() -> np.ndarray:
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    f = 520 + 260 * np.exp(-t * 40)
    v = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 14)
    v += 0.35 * np.sin(2 * np.pi * 1560 * t) * np.exp(-t * 30)
    v += 0.3 * lowpass(RNG.standard_normal(n), 4000) * np.exp(-t * 250)
    return stereo(v)


def sfx_chime() -> np.ndarray:
    n = int(1.6 * SR)
    t = np.arange(n) / SR
    v = np.zeros(n)
    for f, g, d in ((1174.7, 1.0, 3.2), (1760.0, 0.6, 4.0), (2349.3, 0.25, 6.0), (587.3, 0.4, 2.5)):
        v += g * np.sin(2 * np.pi * f * t) * np.exp(-t * d)
    v *= np.clip(t / 0.004, 0, 1)
    return np.stack([v, np.roll(v, int(0.012 * SR))])


def write(path: Path, data: np.ndarray, peak: float = 0.85) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = data / max(np.abs(data).max(), 1e-9) * peak
    pcm = (np.clip(data.T, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print(f"wrote {path} ({data.shape[-1] / SR:.2f} s)")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bed")
    b.add_argument("--out", required=True)
    b.add_argument("--seconds", type=float, required=True)
    b.add_argument("--drop", type=float, default=BAR)
    b.add_argument("--outro", type=float)
    b.add_argument("--key", default="D")
    s = sub.add_parser("sfx")
    s.add_argument("--dir", required=True)
    args = ap.parse_args()
    if args.cmd == "bed":
        outro = args.outro if args.outro is not None else args.seconds - BAR
        write(Path(args.out), make_bed(args.seconds, args.drop, outro, args.key))
    else:
        d = Path(args.dir)
        write(d / "whoosh.wav", sfx_whoosh(), 0.7)
        write(d / "tick.wav", sfx_tick(), 0.6)
        write(d / "hit.wav", sfx_hit(), 0.7)
        write(d / "chime.wav", sfx_chime(), 0.6)


if __name__ == "__main__":
    main()

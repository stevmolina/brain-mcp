"""Voiceover for the voiced cuts, made on this machine: Kokoro-82M (Apache 2.0) speaks each
line and local Whisper listens back, so a mispronounced line shows up before it reaches the film.
Writes one WAV per line to public/audio/vo/<lang>/ and the durations the film timing reads
(src/products/brain/vo-<lang>.json). Nothing leaves the machine. Needs espeak-ng (brew).

  uv run --python 3.11 --with "kokoro>=0.9" --with "misaki[es]" --with soundfile \
    --with mlx-whisper python scripts/make_vo.py es [line ids]

`say` in vo/<lang>.json respells brand names so the voice pronounces them (ChatGPT -> Chat G P T).
The voice is AI-generated, and the end card says so."""
import json, subprocess, sys
from pathlib import Path

import mlx_whisper
import numpy as np
import soundfile as sf
from kokoro import KPipeline

lang = sys.argv[1]
only = set(sys.argv[2:])
root = Path(__file__).resolve().parent.parent
spec = json.loads((root / "vo" / f"{lang}.json").read_text())
out = root / "public" / "audio" / "vo" / lang
out.mkdir(parents=True, exist_ok=True)
dur_path = root / "src" / "products" / "brain" / f"vo-{lang}.json"
durations = json.loads(dur_path.read_text()) if dur_path.exists() else {}
pipe = KPipeline(lang_code={"es": "e", "en": "a"}[lang])
for name, text in spec["lines"].items():
    if only and name not in only:
        continue
    spoken = text
    for a, b in spec["say"].items():
        spoken = spoken.replace(a, b)
    audio = np.concatenate([r.audio.numpy() for r in pipe(spoken, voice=spec["voice"])])
    raw = out / f"{name}.raw.wav"
    sf.write(raw, audio, 24000)
    final = out / f"{name}.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw),
                    "-af", "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse",
                    "-ar", "48000", "-ac", "1", str(final)], check=True)
    raw.unlink()
    heard = mlx_whisper.transcribe(str(final), path_or_hf_repo="mlx-community/whisper-large-v3-turbo", language=lang)["text"].strip()
    secs = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(final)], capture_output=True, text=True, check=True).stdout)
    durations[name] = {"text": text, "frames": int(secs * 30 + 0.999)}
    print(f"{name}: {secs:.2f}s | heard: {heard}", flush=True)
dur_path.write_text(json.dumps(durations, ensure_ascii=False, indent=1) + "\n")

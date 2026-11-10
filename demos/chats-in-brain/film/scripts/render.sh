#!/usr/bin/env bash
# Renders the "your chats" film and checks it (kit recipe, one product, bash 3 safe):
# Remotion render, one fixed gain to -16 LUFS plus a -2 dBFS limiter (keeps the caption
# ducking), a full decode check, a loudness and ducking report, a contact sheet, and a
# square 1080x1080 cut (the 16:9 film on the brand frame).
set -euo pipefail
cd "$(dirname "$0")/.."
ID=Brain-Chats-Main-16x9
OUT=out; mkdir -p "$OUT/qa"
raw="$OUT/.raw.mp4"; final="$OUT/your-chats-in-agent-brain-1080p.mp4"
if pgrep -f "remotion studio" >/dev/null; then echo "Stop Remotion Studio first." >&2; exit 1; fi
nice -n 10 pnpm exec remotion render "$ID" "$raw" --codec=h264 --crf=18 --concurrency="${CONCURRENCY:-6}" --log=error
i_raw="$(ffmpeg -hide_banner -nostats -i "$raw" -filter_complex ebur128 -f null - 2>&1 | sed -n '/Summary:/,$p' | awk '/ I:/{print $2; exit}')"
gain="$(python3 -c "print(round(-16 - float('$i_raw'), 2))")"
ffmpeg -v error -y -i "$raw" -c:v copy -af "volume=${gain}dB,alimiter=limit=0.79:attack=2:release=80:level=disabled" -ar 48000 -c:a aac -b:a 192k -movflags +faststart "$final"
rm -f "$raw"
err="$(ffmpeg -v error -i "$final" -f null - 2>&1 || true)"
if [ -n "$err" ]; then echo "decode errors in $final:" >&2; echo "$err" >&2; exit 1; fi
ffmpeg -hide_banner -nostats -i "$final" -filter_complex ebur128=peak=true -f null - 2>&1 | sed -n '/Summary:/,$p' > "$OUT/qa/loudness.txt"
python3 scripts/duck-check.py "$final" "$ID" >> "$OUT/qa/loudness.txt"
d="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$final")"
ffmpeg -v error -y -i "$final" -vf "fps=$(python3 -c "print(24/float('$d'))"),scale=480:-2,tile=6x4:padding=6:color=black" -frames:v 1 "$OUT/qa/contact.png"
# Square: the film scaled into the brand frame (wordmark above, link below).
pnpm exec remotion still Square-Frame "$OUT/.square-frame.png" --log=error
ffmpeg -v error -y -loop 1 -i "$OUT/.square-frame.png" -i "$final" -filter_complex "[1:v]scale=1080:-2[v];[0:v][v]overlay=0:(1080-608)/2:shortest=1,format=yuv420p" -map 1:a -c:v libx264 -crf 18 -c:a copy -movflags +faststart "$OUT/your-chats-in-agent-brain-square.mp4"
echo "${d}s, mix ${i_raw} LUFS, gain ${gain} dB, $(grep -E '^\s+I:' "$OUT/qa/loudness.txt" | tr -s ' ')"

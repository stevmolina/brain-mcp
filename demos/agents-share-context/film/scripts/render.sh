#!/usr/bin/env bash
# Renders both cuts of "agents share context" and checks each (kit recipe, bash 3 safe):
# Remotion render, one fixed gain to -16 LUFS plus a -2 dBFS limiter (keeps the caption
# ducking), a full decode check, a loudness and ducking report, a contact sheet, and a
# square 1080x1080 version (the 16:9 cut on the brand frame).
#   bash scripts/render.sh            both cuts
#   bash scripts/render.sh main       one cut (main | howto | main-es | howto-es)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=out; mkdir -p "$OUT/qa"
if pgrep -f "remotion studio" >/dev/null; then echo "Stop Remotion Studio first." >&2; exit 1; fi

render_cut() {
  local id="$1" name="$2" link="$3" es="${4:-false}"
  local raw="$OUT/.raw-$name.mp4" final="$OUT/$name-1080p.mp4"
  nice -n 10 pnpm exec remotion render "$id" "$raw" --codec=h264 --crf=18 --concurrency="${CONCURRENCY:-6}" --log=error
  local i_raw gain err d
  i_raw="$(ffmpeg -hide_banner -nostats -i "$raw" -filter_complex ebur128 -f null - 2>&1 | sed -n '/Summary:/,$p' | awk '/ I:/{print $2; exit}')"
  gain="$(python3 -c "print(round(-16 - float('$i_raw'), 2))")"
  ffmpeg -v error -y -i "$raw" -c:v copy -af "volume=${gain}dB,alimiter=limit=0.79:attack=2:release=80:level=disabled" -ar 48000 -c:a aac -b:a 192k -movflags +faststart "$final"
  rm -f "$raw"
  err="$(ffmpeg -v error -i "$final" -f null - 2>&1 || true)"
  if [ -n "$err" ]; then echo "decode errors in $final:" >&2; echo "$err" >&2; exit 1; fi
  ffmpeg -hide_banner -nostats -i "$final" -filter_complex ebur128=peak=true -f null - 2>&1 | sed -n '/Summary:/,$p' > "$OUT/qa/$name-loudness.txt"
  python3 scripts/duck-check.py "$final" "$id" >> "$OUT/qa/$name-loudness.txt" || true
  d="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$final")"
  # dense sheet: one frame every half second
  ffmpeg -v error -y -i "$final" -vf "fps=2,scale=384:-2,tile=8x$(python3 -c "import math; print(math.ceil(float('$d')*2/8))"):padding=4:color=black" -frames:v 1 "$OUT/qa/$name-contact.png"
  pnpm exec remotion still Square-Frame "$OUT/.square-frame.png" --props="{\"link\":\"$link\",\"es\":$es}" --log=error
  ffmpeg -v error -y -loop 1 -i "$OUT/.square-frame.png" -i "$final" -filter_complex "[1:v]scale=1080:-2[v];[0:v][v]overlay=0:(1080-608)/2:shortest=1,format=yuv420p" -map 1:a -c:v libx264 -crf 18 -c:a copy -movflags +faststart "$OUT/$name-square.mp4"
  rm -f "$OUT/.square-frame.png"
  echo "$name: ${d}s, mix ${i_raw} LUFS, gain ${gain} dB, $(grep -E '^\s+I:' "$OUT/qa/$name-loudness.txt" | tr -s ' ')"
}

want="${1:-all}"
if [ "$want" = all ] || [ "$want" = main ]; then render_cut Brain-Agents-Main-16x9 agents-share-context brain.mcpbox.dev; fi
if [ "$want" = all ] || [ "$want" = howto ]; then render_cut Brain-Agents-HowTo-16x9 agent-brain-how-to-start brain.mcpbox.dev/mcp; fi
if [ "$want" = all ] || [ "$want" = main-es ]; then render_cut Brain-Agents-Main-ES-16x9 agentes-comparten-contexto-es brain.mcpbox.dev true; fi
if [ "$want" = all ] || [ "$want" = howto-es ]; then render_cut Brain-Agents-HowTo-ES-16x9 agent-brain-como-empezar-es brain.mcpbox.dev/mcp true; fi

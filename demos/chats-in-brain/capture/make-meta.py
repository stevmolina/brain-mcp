"""Turn the capture logs into the film kit's footage meta (cursor moves, clicks, named marks).

    python3 capture/make-meta.py <dir with <clip>-30.mp4 files> film/public/footage/chats

Copies each normalized clip (30 fps, 1600x900) next to its meta JSON. Times become source
frames: (epoch ms - recorder start - frame offset) / 1000 * 30.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

FPS = 30
here = Path(__file__).parent
src_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)
logs = json.loads((here / "logs.json").read_text())
offset = logs["frameOffsetMs"]


def frames_of(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True).stdout
    return int(out.strip())


def target(e):
    # Wide things (cards, the search box) are pointed at near their start, like a person would.
    x = e["x"] + (min(170, e["w"] / 2) if e["w"] > 400 else e["w"] / 2)
    y = e["y"] + (min(30, e["h"] / 2) if e["h"] > 80 else e["h"] / 2)
    return round(x), round(y)


for name, clip in logs["clips"].items():
    video = src_dir / f"{name}-30.mp4"
    frames = frames_of(video)
    shutil.copyfile(video, out_dir / f"{name}.mp4")
    cursor, marks, pending = [], {}, {}
    for e in clip["events"]:
        at = clip["t0"] + e["t"] if clip.get("relative") else e["at"]
        frame = e["frame"] if "frame" in e else round((at - clip["recStart"] - offset) / 1000 * FPS)
        if e["kind"] == "move":
            pending[e["name"]] = frame
        elif e["kind"] == "click":
            x, y = target(e)
            start = pending.pop(e["name"], frame - 18)
            cursor.append({"frame": start, "x": x, "y": y, "travel": max(6, frame - start)})
            cursor.append({"frame": frame, "x": x, "y": y, "click": True})
        else:
            marks[e["name"]] = {"frame": frame, "x": e["x"], "y": e["y"], "width": e["w"], "height": e["h"]}
    meta = {"width": 1600, "height": 900, "fps": FPS, "frames": frames, "cursor": cursor, "marks": marks}
    (out_dir / f"{name}.json").write_text(json.dumps(meta, indent=1) + "\n")
    print(name, frames, "frames,", len(cursor) // 2, "clicks,", ", ".join(f"{k}@{v['frame']}" for k, v in marks.items()))

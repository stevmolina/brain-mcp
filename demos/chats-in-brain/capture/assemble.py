"""Turn the screencast captures into the film kit's footage: a 30 fps video and its meta.

    python3 capture/assemble.py <capture dir> film/public/footage/chats

For each clip folder (frames/ plus clip.json from film/scripts/capture.mjs): every 1/30 s
shows the last frame Chrome had painted by then, so still screens stay still and nothing is
sped up. The log becomes cursor moves, clicks and named marks in source frames, in the page's
CSS pixels (1600x900). The clip.json logs are kept next to this script as the record.
"""

import json
import shutil
import subprocess
import sys
import tempfile
from bisect import bisect_right
from pathlib import Path

FPS = 30
src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
logs = Path(__file__).parent / "logs"
logs.mkdir(exist_ok=True)


def target(e):
    # Where the pointer rests on an element: near the start of wide things, the middle of small ones.
    return round(e["x"] + (min(170, e["w"] / 2))), round(e["y"] + (min(30, e["h"] / 2)))


for clip_dir in sorted(p for p in src.iterdir() if (p / "clip.json").exists()):
    clip = json.loads((clip_dir / "clip.json").read_text())
    name, start, end = clip["name"], clip["start"], clip["end"]
    times = [f["t"] for f in clip["frames"]]
    count = int((end - start) / 1000 * FPS)
    with tempfile.TemporaryDirectory() as tmp:
        for k in range(count):
            i = max(0, bisect_right(times, start + k * 1000 / FPS) - 1)
            (Path(tmp) / f"{k:05d}.jpg").symlink_to((clip_dir / "frames" / clip["frames"][i]["file"]).resolve())
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(FPS), "-i", f"{tmp}/%05d.jpg",
                        "-vf", "scale=3200:1800:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "16",
                        "-preset", "slow", "-tune", "stillimage", "-movflags", "+faststart", str(out / f"{name}.mp4")], check=True)
    frame = lambda at: round((at - start) / 1000 * FPS)
    cursor, marks, pending = [], {}, {}
    for e in clip["events"]:
        if e["kind"] == "move":
            pending[e["name"]] = (frame(e["at"]), e)
        elif e["kind"] == "click":
            began, moved = pending.pop(e["name"], (frame(e["at"]) - 14, e))
            x, y = target(moved)
            cursor.append({"frame": began, "x": x, "y": y, "travel": max(6, frame(e["at"]) - began)})
            cursor.append({"frame": frame(e["at"]), "x": x, "y": y, "click": True})
        elif "x" in e:
            marks[e["name"]] = {"frame": frame(e["at"]), "x": e["x"], "y": e["y"], "width": e["w"], "height": e["h"]}
    # A move with no click (resting the pointer on something) still travels there.
    for began, e in pending.values():
        x, y = target(e)
        cursor.append({"frame": began, "x": x, "y": y, "travel": 14})
    cursor.sort(key=lambda c: c["frame"])
    meta = {"width": 1600, "height": 900, "fps": FPS, "frames": count, "cursor": cursor, "marks": marks}
    (out / f"{name}.json").write_text(json.dumps(meta, indent=1) + "\n")
    shutil.copyfile(clip_dir / "clip.json", logs / f"{name}.json")
    print(name, count, "frames,", sum(1 for c in cursor if c.get("click")), "clicks,", ", ".join(f"{k}@{v['frame']}" for k, v in marks.items()))

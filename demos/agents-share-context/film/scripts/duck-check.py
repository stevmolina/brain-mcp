"""Listen-check by numbers: how far the music sits under the captions in a rendered film.
Compares the film's momentary loudness (ebur128, 400 ms) with its own music bed at the mix level,
inside and outside the caption/callout windows of the same plan the film uses. The difference
between the two is the ducking depth heard in the final file (the master gain cancels out).
  python3 scripts/duck-check.py <video.mp4> <plan-id>     (plan ids as printed by film-plan.mjs)"""
import json, re, subprocess, sys

video, cut = sys.argv[1], sys.argv[2]
plans = json.loads(subprocess.run(["node", "scripts/film-plan.mjs"], capture_output=True, text=True, check=True).stdout)
plan = next(p for p in plans if p["id"] == cut)

def momentary(path, pre=None):
    graph = (pre + "," if pre else "") + "ebur128"
    log = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-filter_complex", graph, "-f", "null", "-"], capture_output=True, text=True).stderr
    return {round(float(t), 1): float(m) for t, m in re.findall(r"t:\s*([\d.]+).*?M:\s*(-?[\d.]+)", log)}

film = momentary(video)
bed = momentary(f"public/{plan['bed']}", "volume=0.5")  # Sound.tsx level
inside = lambda t: any(d["from"] / 30 + 0.4 <= t <= d["to"] / 30 - 0.2 for d in plan["ducks"])
# Reference: the title card, where nothing is ducked (film minus bed there = master gain only).
ref = [film[t] - bed[t] for t in film if t in bed and 1.2 <= t <= plan["drop"] - 0.1 and bed[t] > -60]
body = [t for t in film if t in bed and plan["drop"] + 0.5 < t < plan["outro"] and bed[t] > -60]
under = [film[t] - bed[t] for t in body if inside(t)]
mean = lambda xs: sum(xs) / len(xs) if xs else float("nan")
covered = sum(d["to"] - d["from"] for d in plan["ducks"]) / 30
print(f"Ducking: while a caption or callout is on screen the music sits {mean(ref) - mean(under):.1f} dB under its own level "
      f"(design 5.7 dB; reference = title card). Captions and callouts cover about {min(covered, plan['seconds']):.0f} of {plan['seconds']:.0f} s.")

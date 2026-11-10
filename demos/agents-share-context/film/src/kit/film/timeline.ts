import type { Mark, ShotMeta, ZoomKey } from "../shot-meta";

// The film timeline, as plain data. No React or Remotion imports, so `scripts/film-plan.mjs` can
// read the same numbers in Node to size each music bed (length, drop, outro) to its cut.

// The music runs at 100 BPM: one beat is 18 frames at 30 fps. Every scene lasts a whole number of
// beats and every transition lasts one beat, so each cut lands on a beat.
export const BEAT = 18;
export const FILM_FPS = 30;

export type Sfx = "whoosh" | "tick" | "hit" | "chime";
export type Cue = { at: number; sfx: Sfx; volume?: number };
export type Duck = { from: number; to: number };

// A recorded clip and where the camera looks in it (footage px, keyed on source frames).
export type FilmClip = { src: string; meta: ShotMeta; wide: ZoomKey[]; tall?: ZoomKey[] };
// Source frames [from, to) of one clip. `rate` > 1 plays faster and always gets an on-screen tag;
// `tag` labels a segment that is condensed in the recording itself (a time-lapse).
// `note` names what a segment is when it is not a recording (a held screenshot).
export type FilmSeg = { clip: string; from: number; to: number; rate?: number; tag?: string; note?: string };
// Scene-local frames.
export type FilmCap = { from: number; to: number; text: string; highlight?: string[] };
// A callout lifts one real on-screen value into a card. `value` must be the exact string shown.
export type FilmCallout = {
  label: string; value: string; note: string; source: string;
  side?: "right" | "left" | "below" | "above"; tallSide?: "below" | "above"; cardWidth?: number; quote?: boolean;
};
// Source frames of `clip`: dim everything but `mark`, optionally with a callout.
export type FilmFocus = { clip: string; mark: Mark; from: number; to: number; pad?: number; callout?: FilmCallout };

export type FilmScene =
  | { kind: "title"; name: string; beats: number; headline: string; sub?: string; highlight?: string[] }
  | { kind: "end"; name: string; beats: number; line1?: string; line2?: string }
  | { kind: "shot"; name: string; chapter: string; window: string; segs: FilmSeg[]; caps: FilmCap[]; focus?: FilmFocus[]; note?: string; overlay?: string }
  | { kind: "panel"; name: string; chapter: string; beats: number; panel: string; caps: FilmCap[]; cues?: Cue[]; note?: string };

export type FilmCut = { id: string; bed: string; key: string; clips: Record<string, FilmClip>; scenes: FilmScene[] };

export type Placed = { scene: FilmScene; start: number; frames: number; segs: FilmSeg[]; index: string };
export type Plan = {
  placed: Placed[]; total: number; ducks: Duck[]; cues: Cue[];
  music: { bed: string; key: string; seconds: number; drop: number; outro: number };
};

// Captions end a few frames before their scene does, even when beat-fitting trimmed the scene.
export const capEnd = (sceneFrames: number) => sceneFrames - 4;

export const segFrames = (s: FilmSeg) => Math.max(1, Math.round((s.to - s.from) / (s.rate ?? 1)));
const sum = (segs: FilmSeg[]) => segs.reduce((n, s) => n + segFrames(s), 0);

// Rounds a footage scene to whole beats by lengthening or trimming its last segment; never past
// the end of the recording.
export const fitSegs = (segs: FilmSeg[], clips: Record<string, FilmClip>) => {
  const natural = sum(segs);
  const last = segs[segs.length - 1];
  const rate = last.rate ?? 1;
  const meta = clips[last.clip].meta;
  let target = Math.max(2 * BEAT, Math.round(natural / BEAT) * BEAT);
  for (;;) {
    const lastFrames = segFrames(last) + (target - natural);
    const to = last.from + lastFrames * rate;
    if (lastFrames >= 1 && to <= meta.frames) return { segs: [...segs.slice(0, -1), { ...last, to }], frames: target };
    target -= BEAT;
  }
};

// Where a source frame of `clip` plays inside the scene, or null if it is cut out.
export const sourceToScene = (segs: FilmSeg[], clip: string, source: number) => {
  let at = 0;
  for (const s of segs) {
    if (s.clip === clip && source >= s.from && source < s.to) return at + (source - s.from) / (s.rate ?? 1);
    at += segFrames(s);
  }
  return null;
};

export const planCut = (cut: FilmCut): Plan => {
  let at = 0;
  let n = 0;
  const placed: Placed[] = cut.scenes.map((scene) => {
    const fit = scene.kind === "shot" ? fitSegs(scene.segs, cut.clips) : { segs: [], frames: scene.beats * BEAT };
    const index = scene.kind === "shot" || scene.kind === "panel" ? String(++n).padStart(2, "0") : "";
    const p = { scene, start: at, frames: fit.frames, segs: fit.segs, index };
    at += fit.frames - BEAT;
    return p;
  });
  const total = at + BEAT;

  const ducks: Duck[] = [];
  const cues: Cue[] = [];
  for (const [i, p] of placed.entries()) {
    const { scene, start } = p;
    if (scene.kind === "title") {
      cues.push({ at: start + 4, sfx: "tick" }, { at: start + 14, sfx: "hit", volume: 0.2 });
      continue;
    }
    if (scene.kind === "end") {
      cues.push({ at: start - 10, sfx: "whoosh" }, { at: start + 6, sfx: "hit", volume: 0.22 });
      continue;
    }
    if (i > 0) cues.push({ at: start - 8, sfx: "whoosh", volume: 0.2 });
    for (const c of scene.caps) ducks.push({ from: start + c.from, to: start + Math.min(c.to, capEnd(p.frames)) });
    if (scene.kind === "panel") {
      for (const c of scene.cues ?? []) cues.push({ ...c, at: start + c.at });
      continue;
    }
    // A tick on every real click the capture recorded inside the segments shown.
    let segAt = 0;
    for (const s of p.segs) {
      for (const e of cut.clips[s.clip].meta.cursor) {
        if (e.click && e.frame >= s.from && e.frame < s.to) cues.push({ at: start + segAt + (e.frame - s.from) / (s.rate ?? 1), sfx: "tick" });
      }
      segAt += segFrames(s);
    }
    for (const f of scene.focus ?? []) {
      const a = sourceToScene(p.segs, f.clip, f.from);
      const b = sourceToScene(p.segs, f.clip, f.to) ?? sourceToScene(p.segs, f.clip, f.to - 1);
      if (a == null) continue;
      if (f.callout) {
        cues.push({ at: start + a, sfx: "hit" }, { at: start + a + 18, sfx: "chime" });
        ducks.push({ from: start + a, to: start + (b ?? a + 60) });
      } else {
        cues.push({ at: start + a, sfx: "tick", volume: 0.14 });
      }
    }
  }
  cues.sort((x, y) => x.at - y.at);
  // Two sounds closer than 4 frames read as one; keep the first.
  const clean = cues.filter((c, i) => i === 0 || c.at - cues[i - 1].at >= 4 || c.sfx !== cues[i - 1].sfx).map((c) => ({ ...c, at: Math.max(0, Math.round(c.at)) }));

  const firstScene = placed.find((p) => p.scene.kind !== "title") ?? placed[0];
  const end = placed.find((p) => p.scene.kind === "end") ?? placed[placed.length - 1];
  return {
    placed, total, ducks, cues: clean,
    music: { bed: cut.bed, key: cut.key, seconds: total / FILM_FPS, drop: firstScene.start / FILM_FPS, outro: end.start / FILM_FPS },
  };
};

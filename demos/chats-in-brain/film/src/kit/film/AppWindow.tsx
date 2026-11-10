import { AbsoluteFill, Series, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Shot, shotGeometry, type Box } from "../Shot";
import type { Mark, Ring, ShotMeta, ZoomKey } from "../shot-meta";
import { KineticWords } from "./pieces";
import { cardOf, chromeOf, clamp, EASE_OUT, type FilmTheme } from "./theme";

export type Geo = ReturnType<typeof shotGeometry> & { sourceFrame: number; box: Box };

// One run of real footage inside the window: source frames [from, to) at `rate`.
export type WindowShot = { id: string; src: string; meta: ShotMeta; from: number; to: number; rate?: number; zoom: ZoomKey[]; rings?: Ring[] };
const shotFrames = (s: WindowShot) => Math.max(1, Math.round((s.to - s.from) / (s.rate ?? 1)));

// Which shot plays at a window frame, and the source frame it shows.
export const activeShot = (shots: WindowShot[], frame: number) => {
  let at = 0;
  for (const s of shots) {
    const n = shotFrames(s);
    if (frame < at + n) return { shot: s, sourceFrame: s.from + Math.max(0, frame - at) * (s.rate ?? 1) };
    at += n;
  }
  const last = shots[shots.length - 1];
  return { shot: last, sourceFrame: last.from + (shotFrames(last) - 1) * (last.rate ?? 1) };
};

// Real footage floated in a designed window: a slim frame bar, soft shadow, and a camera that
// tilts in on entry and drifts a little while it plays. The captured UI itself is untouched.
// Pass `shots` for several segments in one window, or the single-clip props.
export const AppWindow: React.FC<{
  theme: FilmTheme;
  shots?: WindowShot[];
  src?: string;
  meta?: ShotMeta;
  trimBefore?: number;
  rate?: number;
  zoom?: ZoomKey[];
  rings?: Ring[];
  rect: Box; // where the footage sits on the stage
  label: string; // text in the frame bar
  enterFrom?: number; // frames of entrance (0 = already in)
  overlay?: (geo: Geo, shot: WindowShot) => React.ReactNode;
}> = ({ theme, shots: given, src, meta, trimBefore = 0, rate = 1, zoom, rings, rect, label, enterFrom = 24, overlay }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const shots: WindowShot[] = given ?? [{ id: "main", src: src!, meta: meta!, from: trimBefore, to: meta!.frames, rate, zoom: zoom!, rings }];
  const enter = enterFrom ? spring({ frame, fps, config: { damping: 22, stiffness: 90 }, durationInFrames: enterFrom }) : 1;
  const bar = 40;
  const tiltX = (1 - enter) * 16 + Math.sin(frame / 90) * 0.6;
  const tiltY = (1 - enter) * -6 + Math.cos(frame / 110) * 0.8;
  const lift = (1 - enter) * 260;
  const { shot, sourceFrame } = activeShot(shots, frame);
  const geo: Geo = { ...shotGeometry(shot.meta, shot.zoom, rect, sourceFrame), sourceFrame, box: rect };
  const shotEls = shots.map((s) => (
    <Shot src={s.src} meta={s.meta} trimBefore={s.from} playbackRate={s.rate ?? 1} zoom={s.zoom} rings={s.rings} box={rect} accent={theme.pointer ?? theme.ink} ringColor={theme.accent} background="transparent" radius={0} />
  ));
  return (
    <AbsoluteFill style={{ perspective: 2600, perspectiveOrigin: `${width / 2}px ${height * 0.3}px` }}>
      <AbsoluteFill style={{ transformStyle: "preserve-3d", transformOrigin: `${rect.left + rect.width / 2}px ${rect.top + rect.height}px`, rotate: `x ${tiltX}deg`, translate: `0 ${lift}px`, opacity: interpolate(enter, [0, 0.4], [0, 1], clamp) }}>
        <AbsoluteFill style={{ rotate: `y ${tiltY}deg`, transformOrigin: `${rect.left + rect.width / 2}px ${rect.top + rect.height / 2}px` }}>
          {/* shadow + frame */}
          <div style={{ position: "absolute", left: rect.left - 1, top: rect.top - bar - 1, width: rect.width + 2, height: rect.height + bar + 2, borderRadius: 18, background: chromeOf(theme), border: `1px solid ${theme.rule}`, boxShadow: theme.dark ? "0 50px 120px -30px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.04)" : "0 50px 120px -30px rgba(10,10,10,0.35), 0 18px 40px -20px rgba(10,10,10,0.25)" }} />
          <div style={{ position: "absolute", left: rect.left, top: rect.top - bar, width: rect.width, height: bar, display: "flex", alignItems: "center", gap: 9, padding: "0 18px", fontFamily: theme.fontSans, fontSize: 16, fontWeight: 600, color: theme.muted, borderBottom: `1px solid ${theme.rule}`, overflow: "hidden", whiteSpace: "nowrap" }}>
            {[0, 1, 2].map((i) => <span key={i} style={{ width: 11, height: 11, borderRadius: 6, background: theme.rule, flexShrink: 0 }} />)}
            <span style={{ marginLeft: 14, letterSpacing: "0.04em" }}>{label}</span>
          </div>
          {shots.length === 1 ? shotEls[0] : (
            <Series>
              {shots.map((s, i) => <Series.Sequence key={s.id} name={s.id} durationInFrames={shotFrames(s)} premountFor={fps}>{shotEls[i]}</Series.Sequence>)}
            </Series>
          )}
          <div style={{ position: "absolute", left: rect.left, top: rect.top, width: rect.width, height: rect.height, overflow: "hidden", borderRadius: "0 0 17px 17px", pointerEvents: "none" }}>
            <div style={{ position: "absolute", left: -rect.left, top: -rect.top, width, height }}>{overlay ? overlay(geo, shot) : null}</div>
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const markRect = (geo: Geo, mark: Mark, pad = 10) => {
  const a = geo.toScreen(mark.x ?? 0, mark.y ?? 0);
  return { left: a.x - pad, top: a.y - pad, width: (mark.width ?? 0) * geo.k + 2 * pad, height: (mark.height ?? 0) * geo.k + 2 * pad };
};

// Dims the footage except one captured element, so the eye goes to the real result.
export const Spotlight: React.FC<{ geo: Geo; mark: Mark; from: number; to: number; theme: FilmTheme; pad?: number }> = ({ geo, mark, from, to, pad = 12 }) => {
  const f = geo.sourceFrame;
  if (f < from - 1 || f > to + 12) return null;
  const o = Math.min(interpolate(f, [from, from + 10], [0, 1], clamp), interpolate(f, [to, to + 12], [1, 0], clamp));
  const r = markRect(geo, mark, pad);
  return (
    <div style={{ position: "absolute", ...r, borderRadius: 14, boxShadow: `0 0 0 4000px rgba(12,12,14,${0.62 * o})`, outline: `3px solid rgba(255,255,255,${o})`, outlineOffset: 2 }} />
  );
};

// A real figure (or line) from the captured screen, lifted into a card beside it with a leader line.
// `value` must be the exact string shown in the footage. Times are source frames.
export const NumberCallout: React.FC<{
  geo: Geo; mark: Mark; from: number; to: number; theme: FilmTheme;
  label: string; value: string; note: string; source: string; side?: "right" | "left" | "below" | "above"; cardWidth?: number; quote?: boolean;
}> = ({ geo, mark, from, to, theme, label, value, note, source, side = "right", cardWidth = 520, quote = false }) => {
  const now = useCurrentFrame();
  const f = geo.sourceFrame;
  if (f < from - 1 || f > to + 14) return null;
  const t = f - from;
  const r = markRect(geo, mark, 12);
  const line = interpolate(t, [4, 16], [0, 1], { ...clamp, easing: EASE_OUT });
  const card = interpolate(t, [10, 26], [0, 1], { ...clamp, easing: EASE_OUT });
  const out = interpolate(f, [to, to + 12], [1, 0], clamp);
  const b = geo.box;
  const valueSize = quote ? 40 : Math.min(92, (cardWidth - 68) / (value.length * 0.6));
  const cardH = quote ? 150 + Math.ceil((value.length * valueSize * 0.5) / (cardWidth - 68)) * valueSize * 1.15 : 300;
  const vertical = side === "below" || side === "above";
  let cardLeft: number, cardTop: number, x1: number, y1: number, x2: number, y2: number;
  if (vertical) {
    cardLeft = Math.max(b.left + 30, Math.min(r.left + r.width / 2 - cardWidth / 2, b.left + b.width - cardWidth - 30));
    cardTop = side === "below" ? Math.min(r.top + r.height + 70, b.top + b.height - cardH - 24) : Math.max(r.top - 70 - cardH, b.top + 24);
    x1 = r.left + r.width / 2; y1 = side === "below" ? r.top + r.height : r.top;
    x2 = cardLeft + cardWidth / 2; y2 = side === "below" ? cardTop : cardTop + cardH;
  } else {
    cardLeft = side === "right" ? Math.min(r.left + r.width + 90, b.left + b.width - cardWidth - 40) : Math.max(r.left - 90 - cardWidth, b.left + 40);
    y1 = r.top + r.height / 2;
    cardTop = Math.max(b.top + 30, Math.min(y1 - cardH / 2, b.top + b.height - cardH - 30));
    x1 = side === "right" ? r.left + r.width : r.left;
    x2 = side === "right" ? cardLeft : cardLeft + cardWidth;
    y2 = cardTop + 60;
  }
  const slide = vertical ? `0 ${(1 - card) * (side === "below" ? 30 : -30)}px` : `${(1 - card) * (side === "right" ? 40 : -40)}px 0`;
  return (
    <div style={{ position: "absolute", inset: 0, opacity: out }}>
      <svg style={{ position: "absolute", inset: 0, overflow: "visible" }} width="100%" height="100%">
        <circle cx={x1} cy={y1} r={7 * line} fill="#fff" />
        <line x1={x1} y1={y1} x2={x1 + (x2 - x1) * line} y2={y1 + (y2 - y1) * line} stroke="#fff" strokeWidth={3} strokeLinecap="round" />
      </svg>
      <div style={{ position: "absolute", left: cardLeft, top: cardTop, width: cardWidth, background: cardOf(theme), border: theme.dark ? `1px solid ${theme.accent}` : "none", borderRadius: 22, padding: "28px 34px 26px", boxShadow: "0 40px 90px -20px rgba(0,0,0,0.45)", opacity: card, translate: slide, scale: String(0.94 + 0.06 * card), fontFamily: theme.fontSans, color: theme.ink }}>
        <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: theme.muted }}>{label}</div>
        {quote ? (
          <div style={{ marginTop: 12, fontWeight: 700, fontSize: valueSize, lineHeight: 1.15, letterSpacing: -0.6 }}>
            <KineticWords text={value} delay={now - t + 14} stagger={1.4} />
          </div>
        ) : (
          <div style={{ display: "flex", marginTop: 10, fontFamily: theme.fontMono, fontWeight: 600, fontSize: valueSize, letterSpacing: -2, lineHeight: 1 }}>
            {value.split("").map((ch, i) => {
              const c = interpolate(t, [16 + i * 1.6, 28 + i * 1.6], [0, 1], { ...clamp, easing: EASE_OUT });
              return <span key={i} style={{ display: "inline-block", overflow: "hidden" }}><span style={{ display: "inline-block", translate: `0 ${(1 - c) * 100}%`, opacity: c }}>{ch}</span></span>;
            })}
          </div>
        )}
        <div style={{ marginTop: 14, fontSize: quote ? 24 : 28, fontWeight: 600, lineHeight: 1.25 }}>{note}</div>
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${theme.rule}`, fontSize: 18, fontWeight: 500, color: theme.muted }}>{source}</div>
      </div>
    </div>
  );
};

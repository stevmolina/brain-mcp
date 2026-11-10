import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { chromeOf, clamp, EASE_OUT, nightInkOf, nightOf, type FilmTheme } from "./theme";

// ------------------------------------------------------------------ stage
// The designed space the app floats in: product paper, a slow dot grid, one soft light.
export const Stage: React.FC<{ theme: FilmTheme; dark?: boolean; children?: React.ReactNode }> = ({ theme, dark = false, children }) => {
  const frame = useCurrentFrame();
  const bg = dark ? nightOf(theme) : theme.stage;
  const lightDots = dark || theme.dark;
  const dot = lightDots ? "rgba(255,255,255,0.07)" : "rgba(10,10,10,0.07)";
  const glow = dark ? "radial-gradient(70% 60% at 70% 30%, rgba(255,255,255,0.08), transparent 70%)"
    : theme.dark ? `radial-gradient(60% 55% at 50% 38%, ${theme.halo[1]}22, transparent 75%)`
    : "radial-gradient(60% 55% at 50% 38%, rgba(255,255,255,0.95), transparent 75%)";
  return (
    <AbsoluteFill style={{ background: bg, overflow: "hidden" }}>
      <AbsoluteFill style={{ backgroundImage: `radial-gradient(${dot} 1.4px, transparent 1.6px)`, backgroundSize: "28px 28px", backgroundPosition: `${frame * 0.25}px ${frame * 0.12}px` }} />
      <AbsoluteFill style={{ background: glow }} />
      {children}
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ brand
export const Wordmark: React.FC<{ theme: FilmTheme; size: number; color?: string; sub?: string; delay?: number }> = ({ theme, size, color, sub, delay = 0 }) => {
  const frame = useCurrentFrame() - delay;
  const track = interpolate(frame, [0, 22], [0.9, 0.42], { ...clamp, easing: EASE_OUT });
  const o = interpolate(frame, [0, 10], [0, 1], clamp);
  const subO = interpolate(frame, [8, 20], [0, 1], clamp);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: size * 0.22, color: color ?? theme.ink }}>
      {theme.brand?.hand ? (
        <span style={{ alignSelf: "flex-start", fontFamily: theme.fontWord, fontWeight: 700, fontSize: size * 1.35, lineHeight: 1.15, padding: `0 ${size * 0.22}px`, background: theme.brand.bg, color: theme.ink, opacity: o, translate: `${(1 - o) * -12}px 0`, whiteSpace: "nowrap" }}>{theme.brand.text}</span>
      ) : (
        <span style={{ fontFamily: theme.fontWord, fontWeight: 500, fontSize: size, letterSpacing: `${track}em`, lineHeight: 1, opacity: o, whiteSpace: "nowrap" }}>{theme.brand?.text ?? theme.product.toUpperCase()}</span>
      )}
      {sub ? <span style={{ fontFamily: theme.fontSans, fontWeight: 600, fontSize: size * 0.36, letterSpacing: "0.18em", textTransform: "uppercase", color: color ? color : theme.muted, opacity: subO * (color ? 0.7 : 1) }}>{sub}</span> : null}
    </div>
  );
};

export const SyntheticChip: React.FC<{ theme: FilmTheme; size?: number; delay?: number; dark?: boolean }> = ({ theme, size = 24, delay = 0, dark = theme.dark ?? false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 14, stiffness: 180 } });
  const pulse = 0.55 + 0.45 * Math.abs(Math.sin(frame / 14));
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: size * 0.45, fontFamily: theme.fontSans, fontWeight: 600, fontSize: size, color: dark ? "#fff" : theme.ink, border: `2px solid ${dark ? "rgba(255,255,255,0.25)" : theme.rule}`, background: dark ? "rgba(255,255,255,0.06)" : "#fff", borderRadius: 999, padding: `${size * 0.3}px ${size * 0.75}px`, scale: String(0.6 + 0.4 * s), opacity: s, transformOrigin: "left center", whiteSpace: "nowrap" }}>
      <span style={{ width: size * 0.36, height: size * 0.36, borderRadius: "50%", background: theme.flag, opacity: pulse }} />
      Synthetic demo data
    </div>
  );
};

export const rateText = (rate: number) => `${Number(rate.toFixed(2))}x`;

// Small honest note when footage runs faster than real time, or a time-lapse is condensed.
export const SpeedTag: React.FC<{ theme: FilmTheme; rate: number; label?: string; size?: number }> = ({ theme, rate, label, size = 20 }) => (
  <div style={{ display: "inline-flex", alignItems: "center", gap: 10, fontFamily: theme.fontMono, fontWeight: 500, fontSize: size, color: theme.dark ? theme.ink : theme.muted, background: chromeOf(theme), border: `2px solid ${theme.dark ? theme.accent : theme.rule}`, borderRadius: 999, padding: "6px 16px", whiteSpace: "nowrap" }}>
    <svg width={size * 0.9} height={size * 0.9} viewBox="0 0 24 24"><path d="M4 5l8 7-8 7zM12 5l8 7-8 7z" fill={theme.dark ? theme.accent : theme.muted} /></svg>
    {label ?? `Shown at ${rateText(rate)} speed`}
  </div>
);

// Names what the viewer is looking at ("Local fixture web · fictional outlet"), so nothing reads as more than it is.
export const NoteTag: React.FC<{ theme: FilmTheme; text: string; size?: number }> = ({ theme, text, size = 20 }) => (
  <div style={{ display: "inline-flex", alignItems: "center", gap: 10, fontFamily: theme.fontSans, fontWeight: 600, fontSize: size, color: nightInkOf(theme), background: nightOf(theme), border: theme.dark ? `1px solid ${theme.rule}` : "none", borderRadius: 999, padding: "7px 18px", whiteSpace: "nowrap" }}>
    <span style={{ width: size * 0.4, height: size * 0.4, borderRadius: "50%", background: theme.accent }} />
    {text}
  </div>
);

// ------------------------------------------------------------------ the halo: the ring every film shares
export const HaloRing: React.FC<{ theme: FilmTheme; size: number; delay?: number; stroke?: number; spin?: number }> = ({ theme, size, delay = 0, stroke = 14, spin = 0.35 }) => {
  const frame = useCurrentFrame() - delay;
  const r = size / 2 - stroke;
  const c = 2 * Math.PI * r;
  const draw = interpolate(frame, [0, 40], [0, 1], { ...clamp, easing: EASE_OUT });
  const id = `halo-${theme.product.replace(/\W/g, "")}`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block", overflow: "visible", rotate: `${-90 + frame * spin}deg` }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={theme.halo[0]} />
          <stop offset="50%" stopColor={theme.halo[1]} />
          <stop offset="100%" stopColor={theme.halo[2]} />
        </linearGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${id})`} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - draw)} />
      <circle cx={size / 2} cy={size / 2} r={r - stroke * 2.2} fill="none" stroke={theme.halo[1]} strokeOpacity={0.35} strokeWidth={2} strokeDasharray={`2 ${stroke}`} strokeDashoffset={-frame} opacity={draw} />
    </svg>
  );
};

// ------------------------------------------------------------------ kinetic type
// Words rise out of a mask one after another. `highlight` words take the flag color.
export const KineticWords: React.FC<{
  text: string; delay?: number; stagger?: number; style?: React.CSSProperties; highlight?: string[]; highlightColor?: string; exitAt?: number;
}> = ({ text, delay = 0, stagger = 3, style, highlight = [], highlightColor, exitAt }) => {
  const frame = useCurrentFrame();
  const words = text.split(" ");
  const exit = exitAt == null ? 0 : interpolate(frame, [exitAt, exitAt + 10], [0, 1], { ...clamp, easing: EASE_OUT });
  return (
    <div style={{ display: "flex", flexWrap: "wrap", columnGap: "0.26em", ...style }}>
      {words.map((w, i) => {
        const t = interpolate(frame - delay - i * stagger, [0, 16], [0, 1], { ...clamp, easing: EASE_OUT });
        const hl = highlight.includes(w.replace(/[.,:]/g, ""));
        return (
          <span key={i} style={{ display: "inline-block", overflow: "hidden", paddingBottom: "0.08em", marginBottom: "-0.08em" }}>
            <span style={{ display: "inline-block", translate: `0 ${(1 - t) * 110 - exit * 110}%`, color: hl ? highlightColor : undefined }}>{w}</span>
          </span>
        );
      })}
    </div>
  );
};

// ------------------------------------------------------------------ captions
// A floating card in the margin under the app window. Words arrive in a quick stagger; the
// card itself never covers the captured UI.
export const FilmCaption: React.FC<{
  theme: FilmTheme; text: string; duration: number; highlight?: string[]; fontSize?: number; bottom?: number; maxWidth?: number;
}> = ({ theme, text, duration, highlight, fontSize = 38, bottom = 40, maxWidth = 1400 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 18, stiffness: 160 } });
  const out = interpolate(frame, [duration - 8, duration], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-end", paddingBottom: bottom, pointerEvents: "none" }}>
      <div style={{ display: "flex", alignItems: "stretch", maxWidth, background: nightOf(theme), color: nightInkOf(theme), border: theme.dark ? `1px solid ${theme.rule}` : "none", borderRadius: 18, overflow: "hidden", boxShadow: "0 18px 50px rgba(10,10,10,0.28)", opacity: Math.min(s, out), translate: `0 ${(1 - s) * 30 + (1 - out) * 12}px`, scale: String(0.96 + 0.04 * s) }}>
        <div style={{ width: 10, background: theme.accent, flexShrink: 0 }} />
        <div style={{ padding: "20px 34px 22px 28px", fontFamily: theme.fontSans, fontWeight: 600, fontSize, lineHeight: 1.22, letterSpacing: -0.3 }}>
          <KineticWords text={text} delay={3} stagger={1.6} highlight={highlight} highlightColor={theme.flag === theme.accent ? nightInkOf(theme) : theme.dark ? theme.flag : lighten(theme.flag)} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

const lighten = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.45);
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
};

// Chapter label in the top margin: "02  Find it" with a line that grows.
export const ChapterTag: React.FC<{ theme: FilmTheme; index: string; label: string; delay?: number }> = ({ theme, index, label, delay = 0 }) => {
  const frame = useCurrentFrame() - delay;
  const line = interpolate(frame, [0, 18], [0, 56], { ...clamp, easing: EASE_OUT });
  const o = interpolate(frame, [4, 14], [0, 1], clamp);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, fontFamily: theme.fontSans, fontWeight: 600, fontSize: 22, letterSpacing: "0.14em", textTransform: "uppercase", color: theme.ink }}>
      <span style={{ fontFamily: theme.fontMono, color: theme.muted, opacity: o }}>{index}</span>
      <span style={{ width: line, height: 2, background: theme.accent }} />
      <span style={{ opacity: o, translate: `${(1 - o) * -10}px 0` }}>{label}</span>
    </div>
  );
};

import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { HaloRing, KineticWords, Stage, SyntheticChip, Wordmark } from "./pieces";
import { clamp, EASE_IN_OUT, EASE_OUT, nightInkOf, type FilmTheme, type Layout } from "./theme";

// Opening card: the halo draws on, the wordmark tracks in, the headline rises word by word.
export const TitleCard: React.FC<{ theme: FilmTheme; layout: Layout; headline: string; sub?: string; highlight?: string[] }> = ({ theme, layout, headline, sub, highlight }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const tall = layout === "tall";
  const exitAt = durationInFrames - 14;
  const ringSize = tall ? 980 : 920;
  const ringIn = interpolate(frame, [0, 50], [0.86, 1], { ...clamp, easing: EASE_OUT });
  const ringOut = interpolate(frame, [exitAt - 4, durationInFrames], [1, 1.6], { ...clamp, easing: EASE_IN_OUT });
  const subO = interpolate(frame, [26, 40], [0, 1], clamp) * interpolate(frame, [exitAt, exitAt + 10], [1, 0], clamp);
  return (
    <Stage theme={theme}>
      <div style={{ position: "absolute", ...(tall ? { left: 1080 - ringSize * 0.62, top: 1920 - ringSize * 0.78 } : { left: 1920 - ringSize * 0.72, top: (1080 - ringSize) / 2 }), scale: String(ringIn * ringOut) }}>
        <HaloRing theme={theme} size={ringSize} stroke={tall ? 26 : 24} delay={2} />
      </div>
      <AbsoluteFill style={{ padding: tall ? "200px 84px" : "0 150px", justifyContent: tall ? "flex-start" : "center" }}>
        <div style={{ opacity: interpolate(frame, [exitAt, exitAt + 10], [1, 0], clamp) }}>
          <Wordmark theme={theme} size={tall ? 50 : 44} sub={theme.product} delay={4} />
        </div>
        <div style={{ marginTop: tall ? 90 : 60, fontFamily: theme.fontSans, fontWeight: 700, fontSize: tall ? 112 : 104, lineHeight: 1.02, letterSpacing: -3.2, color: theme.ink, maxWidth: tall ? 920 : 1180 }}>
          <KineticWords text={headline} delay={12} stagger={3} highlight={highlight} highlightColor={theme.flag} exitAt={exitAt} />
        </div>
        {sub ? <div style={{ marginTop: 36, fontFamily: theme.fontSans, fontWeight: 500, fontSize: tall ? 42 : 34, color: theme.muted, maxWidth: tall ? 900 : 980, lineHeight: 1.3, opacity: subO, translate: `0 ${(1 - subO) * 14}px` }}>{sub}</div> : null}
        <div style={{ marginTop: 44, opacity: interpolate(frame, [exitAt, exitAt + 8], [1, 0], clamp) }}><SyntheticChip theme={theme} size={tall ? 30 : 24} delay={30} /></div>
      </AbsoluteFill>
    </Stage>
  );
};

// Closing card on ink: the halo frames the wordmark, an optional tagline, and a small "Not real data" note.
export const EndCard: React.FC<{ theme: FilmTheme; layout: Layout; line1?: string; line2?: string }> = ({ theme, layout, line1, line2 }) => {
  const frame = useCurrentFrame();
  const tall = layout === "tall";
  const ring = tall ? 520 : 440;
  const pop = interpolate(frame, [0, 26], [0.7, 1], { ...clamp, easing: EASE_OUT });
  const note = interpolate(frame, [30, 44], [0, 1], { ...clamp, easing: EASE_OUT });
  return (
    <Stage theme={theme} dark>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
        <div style={{ position: "relative", width: ring, height: ring, display: "flex", alignItems: "center", justifyContent: "center", scale: String(pop) }}>
          <div style={{ position: "absolute", inset: 0 }}><HaloRing theme={theme} size={ring} stroke={12} spin={0.6} /></div>
          <Wordmark theme={theme} size={tall ? 46 : 40} color={nightInkOf(theme)} sub={theme.product} delay={8} />
        </div>
        {line1 || line2 ? (
          <div style={{ marginTop: tall ? 80 : 56, padding: tall ? "0 70px" : "0 120px", fontFamily: theme.fontSans, fontWeight: 700, fontSize: tall ? 84 : 72, letterSpacing: -2, color: nightInkOf(theme), lineHeight: 1.06, textAlign: "center" }}>
            {line1 ? <KineticWords text={line1} delay={18} stagger={3} style={{ justifyContent: "center" }} /> : null}
            {line2 ? <KineticWords text={line2} delay={26} stagger={3} style={{ justifyContent: "center", color: theme.halo[1] }} /> : null}
          </div>
        ) : null}
        <div style={{ marginTop: line1 || line2 ? 40 : 56, fontFamily: theme.fontSans, fontWeight: 500, fontSize: tall ? 26 : 22, letterSpacing: "0.08em", color: nightInkOf(theme), opacity: 0.55 * note, translate: `0 ${(1 - note) * 8}px` }}>Not real data</div>
      </AbsoluteFill>
    </Stage>
  );
};

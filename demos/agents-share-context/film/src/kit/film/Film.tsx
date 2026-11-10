import { TransitionSeries, springTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { useMemo } from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { Box } from "../Shot";
import { AppWindow, NumberCallout, Spotlight, activeShot, type WindowShot } from "./AppWindow";
import { EndCard, TitleCard } from "./Cards";
import { ChapterTag, FilmCaption, NoteTag, SpeedTag, Stage, SyntheticChip, Wordmark } from "./pieces";
import { Sound } from "./Sound";
import type { FilmTheme, Layout } from "./theme";
import { BEAT, capEnd, planCut, type FilmCap, type FilmCut, type FilmScene, type FilmSeg, type Placed } from "./timeline";

// Where the app window sits. Wide: 86% of a 1600x900 capture, captions in the margin below.
// Tall: a near-square window on the action, chapter above, captions below.
export const WINDOW: Record<Layout, Box> = {
  wide: { left: 272, top: 124, width: 1376, height: 774 },
  tall: { left: 48, top: 420, width: 984, height: 1040 },
};

export type PanelProps = { layout: Layout; theme: FilmTheme; frames: number };
export type Panels = Record<string, React.FC<PanelProps>>;

const toShots = (segs: FilmSeg[], cut: FilmCut, layout: Layout): WindowShot[] =>
  segs.map((s, i) => {
    const c = cut.clips[s.clip];
    return { id: `${s.clip} ${i + 1}`, src: c.src, meta: c.meta, from: s.from, to: s.to, rate: s.rate, zoom: layout === "tall" ? c.tall ?? c.wide : c.wide };
  });

const Captions: React.FC<{ caps: FilmCap[]; theme: FilmTheme; layout: Layout; frames: number }> = ({ caps, theme, layout, frames }) => {
  const { fps } = useVideoConfig();
  const tall = layout === "tall";
  return (
    <>
      {caps.map((c) => ({ ...c, to: Math.min(c.to, capEnd(frames)) })).map((c, i) => (
        <Sequence key={i} name={`Caption: ${c.text.slice(0, 28)}`} from={c.from} durationInFrames={c.to - c.from} premountFor={fps}>
          <FilmCaption theme={theme} text={c.text} duration={c.to - c.from} highlight={c.highlight} fontSize={tall ? 46 : 38} bottom={tall ? 200 : 40} maxWidth={tall ? 984 : 1400} />
        </Sequence>
      ))}
    </>
  );
};

// Furniture around the window: chapter, chip, and honesty tags (speed, what this is).
const Margins: React.FC<{ theme: FilmTheme; layout: Layout; index: string; chapter: string; tags: React.ReactNode[] }> = ({ theme, layout, index, chapter, tags }) => {
  const r = WINDOW[layout];
  if (layout === "tall") {
    return (
      <>
        <div style={{ position: "absolute", left: 48, top: 80 }}><Wordmark theme={theme} size={30} sub={theme.product} /></div>
        <div style={{ position: "absolute", right: 48, top: 84 }}><SyntheticChip theme={theme} size={20} delay={10} /></div>
        <div style={{ position: "absolute", left: 48, top: 236 }}><ChapterTag theme={theme} index={index} label={chapter} delay={8} /></div>
        <div style={{ position: "absolute", left: 48, right: 48, top: 296, display: "flex", gap: 12, flexWrap: "wrap" }}>{tags}</div>
      </>
    );
  }
  return (
    <>
      <div style={{ position: "absolute", left: r.left, top: 40 }}><ChapterTag theme={theme} index={index} label={chapter} delay={10} /></div>
      <div style={{ position: "absolute", right: r.left, top: 30, display: "flex", alignItems: "center", gap: 12 }}>{tags}<SyntheticChip theme={theme} size={20} delay={16} /></div>
    </>
  );
};

const ShotScene: React.FC<{ p: Placed; cut: FilmCut; theme: FilmTheme; layout: Layout; panels: Panels }> = ({ p, cut, theme, layout, panels }) => {
  const frame = useCurrentFrame();
  const scene = p.scene as Extract<FilmScene, { kind: "shot" }>;
  const shots = useMemo(() => toShots(p.segs, cut, layout), [p.segs, cut, layout]);
  const { shot } = activeShot(shots, frame);
  const seg = p.segs[shots.indexOf(shot)];
  const rate = seg?.rate ?? 1;
  const tags: React.ReactNode[] = [];
  if (scene.note) tags.push(<NoteTag key="note" theme={theme} text={scene.note} />);
  if (seg && (rate > 1.001 || seg.tag)) tags.push(<SpeedTag key="speed" theme={theme} rate={rate} label={seg.tag} />);
  if (seg?.note) tags.push(<NoteTag key="segnote" theme={theme} text={seg.note} />);
  const rect = WINDOW[layout];
  const Over = scene.overlay ? panels[scene.overlay] : null;
  return (
    <Stage theme={theme}>
      <AppWindow theme={theme} shots={shots} rect={rect} label={scene.window}
        overlay={(geo, active) => (scene.focus ?? []).filter((f) => active.id.startsWith(`${f.clip} `)).map((f, i) => (
          <div key={i} style={{ position: "absolute", inset: 0 }}>
            <Spotlight geo={geo} mark={f.mark} from={f.from} to={f.to} theme={theme} pad={f.pad} />
            {f.callout ? (
              <NumberCallout geo={geo} mark={f.mark} from={f.from} to={f.to} theme={theme} label={f.callout.label} value={f.callout.value} note={f.callout.note} source={f.callout.source}
                side={layout === "tall" ? f.callout.tallSide ?? "below" : f.callout.side} cardWidth={layout === "tall" ? Math.min(f.callout.cardWidth ?? 640, 860) : f.callout.cardWidth} quote={f.callout.quote} />
            ) : null}
          </div>
        ))} />
      {Over ? <Over layout={layout} theme={theme} frames={p.frames} /> : null}
      <Margins theme={theme} layout={layout} index={p.index} chapter={scene.chapter} tags={tags} />
      <Captions caps={scene.caps} theme={theme} layout={layout} frames={p.frames} />
    </Stage>
  );
};

const PanelScene: React.FC<{ p: Placed; theme: FilmTheme; layout: Layout; panels: Panels }> = ({ p, theme, layout, panels }) => {
  const scene = p.scene as Extract<FilmScene, { kind: "panel" }>;
  const Body = panels[scene.panel];
  return (
    <Stage theme={theme}>
      <Body layout={layout} theme={theme} frames={p.frames} />
      <Margins theme={theme} layout={layout} index={p.index} chapter={scene.chapter} tags={scene.note ? [<NoteTag key="note" theme={theme} text={scene.note} />] : []} />
      <Captions caps={scene.caps} theme={theme} layout={layout} frames={p.frames} />
    </Stage>
  );
};

// A product film: title, chapters of real footage (or drawn panels), end card, music and sound.
export const Film: React.FC<{ cut: FilmCut; theme: FilmTheme; layout: Layout; panels?: Panels }> = ({ cut, theme, layout, panels = {} }) => {
  const { fps } = useVideoConfig();
  const plan = useMemo(() => planCut(cut), [cut]);
  return (
    <AbsoluteFill style={{ background: theme.stage }}>
      <TransitionSeries>
        {plan.placed.flatMap((p, i) => {
          const s = p.scene;
          const body = s.kind === "title" ? <TitleCard theme={theme} layout={layout} headline={s.headline} sub={s.sub} highlight={s.highlight} />
            : s.kind === "end" ? <EndCard theme={theme} layout={layout} line1={s.line1} line2={s.line2} />
            : s.kind === "shot" ? <ShotScene p={p} cut={cut} theme={theme} layout={layout} panels={panels} />
            : <PanelScene p={p} theme={theme} layout={layout} panels={panels} />;
          const seq = <TransitionSeries.Sequence key={`s${i}`} name={s.name} durationInFrames={p.frames} premountFor={fps}>{body}</TransitionSeries.Sequence>;
          if (i === 0) return [seq];
          const t = s.kind === "end"
            ? <TransitionSeries.Transition key={`t${i}`} presentation={slide({ direction: "from-bottom" })} timing={springTiming({ config: { damping: 200 }, durationInFrames: BEAT })} />
            : <TransitionSeries.Transition key={`t${i}`} presentation={s.kind === "shot" && plan.placed[i - 1].scene.kind === "shot" ? slide({ direction: "from-right" }) : fade()} timing={springTiming({ config: { damping: 200 }, durationInFrames: BEAT })} />;
          return [t, seq];
        })}
      </TransitionSeries>
      <Sound bed={plan.music.bed} ducks={plan.ducks} cues={plan.cues} />
    </AbsoluteFill>
  );
};

export const filmFrames = (cut: FilmCut) => planCut(cut).total;

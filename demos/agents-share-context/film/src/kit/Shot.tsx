import { Video } from "@remotion/media";
import { AbsoluteFill, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { cursorAt, zoomAt, type Ring, type ShotMeta, type ZoomKey } from "./shot-meta";

export type Box = { left: number; top: number; width: number; height: number };

const Pointer: React.FC<{ fill: string }> = ({ fill }) => (
  <svg width="34" height="34" viewBox="0 0 24 24" style={{ display: "block" }}>
    <path d="M5.2 2.2 L5.2 18.2 L9.4 14.4 L12.6 20.4 L15.2 19.1 L12 13.2 L17.6 12.6 Z" fill={fill} stroke="#ffffff" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);

// Plays real footage with a camera: zoom keys say where it looks. `box` is the window the
// footage lives in (default: the whole frame). In a 9:16 cut use a box such as
// {left:0, top:260, width:1080, height:1100} and zoom keys that follow the action; the camera
// is "cover" scaled into the box and never leaves the footage edge.
// Where the camera looks at a source frame, and how footage pixels map to screen pixels.
// Overlays (callouts, spotlights) use the same mapping so they stay pinned to the UI.
export const shotGeometry = (meta: ShotMeta, zoom: ZoomKey[], b: Box, sourceFrame: number) => {
  const base = Math.max(b.width / meta.width, b.height / meta.height); // cover
  const raw = zoomAt(sourceFrame, zoom);
  const k = base * raw.scale; // footage px -> screen px
  const halfW = b.width / (2 * k);
  const halfH = b.height / (2 * k);
  const view = {
    ...raw,
    cx: Math.min(Math.max(raw.cx, halfW), meta.width - halfW),
    cy: Math.min(Math.max(raw.cy, halfH), meta.height - halfH),
  };
  const toScreen = (vx: number, vy: number) => ({
    x: b.left + b.width / 2 + (vx - view.cx) * k,
    y: b.top + b.height / 2 + (vy - view.cy) * k,
  });
  return { k, view, toScreen };
};

export const Shot: React.FC<{
  src: string;
  meta: ShotMeta;
  trimBefore: number;
  playbackRate?: number;
  zoom: ZoomKey[];
  rings?: Ring[];
  showCursor?: boolean;
  box?: Box;
  accent?: string; // pointer + click ring color
  ringColor?: string;
  background?: string;
  radius?: number;
}> = ({ src, meta, trimBefore, playbackRate = 1, zoom, rings = [], showCursor = true, box, accent = "#2563eb", ringColor = "#ffc800", background = "#e8eaee", radius = 0 }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const b: Box = box ?? { left: 0, top: 0, width, height };
  const sourceFrame = trimBefore + frame * playbackRate;
  const { k, view, toScreen } = shotGeometry(meta, zoom, b, sourceFrame);
  const cursor = showCursor ? cursorAt(meta, sourceFrame) : null;
  return (
    <AbsoluteFill style={{ background }}>
      <div style={{ position: "absolute", left: b.left, top: b.top, width: b.width, height: b.height, overflow: "hidden", borderRadius: radius }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: meta.width, height: meta.height, transformOrigin: "0 0",
          transform: `translate(${b.width / 2 - view.cx * k}px, ${b.height / 2 - view.cy * k}px) scale(${k})` }}>
          <Video src={staticFile(src)} trimBefore={trimBefore} playbackRate={playbackRate} muted objectFit="cover" premountFor={fps} style={{ width: meta.width, height: meta.height }} />
        </div>
      </div>
      {rings.map((ring) => {
        const mark = meta.marks[ring.mark];
        if (mark?.x == null || mark.y == null || !mark.width || !mark.height) return null;
        if (sourceFrame < ring.from || sourceFrame > ring.to) return null;
        const o = toScreen(mark.x, mark.y);
        const pad = 10;
        const opacity = Math.min(1, (sourceFrame - ring.from) / 6);
        return <div key={ring.mark} style={{ position: "absolute", left: o.x - pad, top: o.y - pad, width: mark.width * k + pad * 2, height: mark.height * k + pad * 2, border: `4px solid ${ringColor}`, borderRadius: 12, boxShadow: "0 0 0 6px rgba(255,200,0,0.28)", opacity, pointerEvents: "none" }} />;
      })}
      {cursor ? (
        <div style={{ position: "absolute", left: toScreen(cursor.x, cursor.y).x, top: toScreen(cursor.x, cursor.y).y, pointerEvents: "none" }}>
          {cursor.clickAge >= 0 && cursor.clickAge < 14 ? (
            <div style={{ position: "absolute", left: -18, top: -18, width: 36, height: 36, borderRadius: 18, border: `3px solid ${ringColor}`, opacity: 1 - cursor.clickAge / 14, transform: `scale(${0.6 + cursor.clickAge / 10})` }} />
          ) : null}
          <div style={{ marginLeft: -4, marginTop: -2 }}><Pointer fill={accent} /></div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

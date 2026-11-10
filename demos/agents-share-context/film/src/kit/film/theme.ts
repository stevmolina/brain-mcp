import { Easing } from "remotion";
import { BEAT } from "./timeline";

// One motion system for every product film. Each product passes its own colors and type
// (taken from its app), the motion, layout and sound stay the same.
export type FilmTheme = {
  product: string; // "Your chats"
  stage: string; // background around the floating app window
  paper: string; // light card surface
  ink: string; // text on the stage, and the dark caption / end cards unless `night` is set
  muted: string;
  rule: string;
  accent: string; // ring, leader lines, caption bar
  accentInk: string; // text on the accent
  halo: [string, string, string]; // ring gradient stops
  flag: string; // the "attention" color for one highlighted word
  fontSans: string;
  fontWord: string;
  fontMono: string;
  // Dark apps float on a dark stage. These default to the light look.
  dark?: boolean;
  night?: string; // caption card and end card surface (default: ink)
  nightInk?: string; // text on night (default: white)
  chrome?: string; // window frame bar (default: white)
  pointer?: string; // cursor fill (default: ink)
  // The wordmark. Default: the product name in fontWord, tracked out. `hand` sets it like a highlighter
  // label (Agent Brain: Caveat on a pink block).
  brand?: { text: string; hand?: boolean; bg?: string };
  chip?: string; // the honesty chip's words (default "Synthetic demo data")
};

export const nightOf = (t: FilmTheme) => t.night ?? t.ink;
export const nightInkOf = (t: FilmTheme) => t.nightInk ?? "#fff";
export const chromeOf = (t: FilmTheme) => t.chrome ?? "#fff";
export const cardOf = (t: FilmTheme) => (t.dark ? t.paper : "#fff");

export const FPS = 30;
export { BEAT };
export const beats = (n: number) => Math.round(n * BEAT);

export const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
export const EASE_IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);
export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export type Layout = "wide" | "tall";

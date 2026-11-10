import { loadFont as loadSans } from "@remotion/google-fonts/Inter";
import { loadFont as loadHand } from "@remotion/google-fonts/Caveat";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import type { FilmTheme } from "../../kit/film/theme";

// Agent Brain's own tokens (site/app/app.css :root): white notebook paper with a dot grid,
// ink #111, pink / yellow / blue highlighters, Inter + Caveat + JetBrains Mono.
export const pk = "#ffc6ec";
export const yl = "#ffe58f";
export const bl = "#a6dcff";
export const pkd = "#f06bc4";
export const yld = "#e9c24a";
export const bld = "#4fa8e8";
export const ink = "#111111";
export const muted = "#5b6470";
export const line = "#cfe3f5";

const sans = loadSans("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] });
const hand = loadHand("normal", { weights: ["700"], subsets: ["latin"] });
const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] });

export const brainFilm: FilmTheme = {
  product: "Shared memory",
  stage: "#ffffff",
  paper: "#ffffff",
  ink,
  muted,
  rule: "#e3e7ec",
  accent: pkd,
  accentInk: "#ffffff",
  halo: [pkd, yld, bld],
  flag: pkd,
  fontSans: `${sans.fontFamily}, Helvetica, Arial, sans-serif`,
  fontWord: `${hand.fontFamily}, "Segoe Script", cursive`,
  fontMono: `${mono.fontFamily}, Menlo, monospace`,
  pointer: ink,
  brand: { text: "Agent Brain", hand: true, bg: pk },
};

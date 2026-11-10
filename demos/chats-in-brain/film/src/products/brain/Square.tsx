import { AbsoluteFill } from "remotion";
import { Stage, Wordmark } from "../../kit/film/pieces";
import { brainFilm, muted } from "./theme";

// The frame around the 16:9 film in the square cut: brand above, the live link below.
export const SquareFrame: React.FC = () => (
  <Stage theme={brainFilm}>
    <AbsoluteFill style={{ padding: "0 60px" }}>
      <div style={{ position: "absolute", top: 92, left: 60 }}><Wordmark theme={brainFilm} size={44} sub={brainFilm.product} delay={-60} /></div>
      <div style={{ position: "absolute", bottom: 104, left: 60, right: 60, fontFamily: brainFilm.fontMono, fontSize: 34, color: muted }}>brain.mcpbox.dev/sessions</div>
    </AbsoluteFill>
  </Stage>
);

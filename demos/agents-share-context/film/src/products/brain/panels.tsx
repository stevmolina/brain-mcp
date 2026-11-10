import { createContext, useContext } from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Panels, PanelProps } from "../../kit/film/Film";
import { clamp, EASE_OUT } from "../../kit/film/theme";
import { APPLE_PATH, BRAIN_PATH, CLAUDE_ORANGE, CLAUDE_PATH, GITHUB_PATH, GOOGLE_PATH, Mark, OPENAI_PATH } from "./icons";
import { BRAIN_NAME, CHATGPT_RUN, CLAUDE_RUN, NOTE } from "./run";
import { T as T_EN, type Timing } from "./filmCuts";
import { bl, brainFilm, ink, muted, pk, yl } from "./theme";
import { AgentBadge, BrainBadge, Camera, ChatGPTChat, ClaudeChat, HandArrow, NotePage, SERIF, ramp, typed, type Box } from "./ui";

const SANS = brainFilm.fontSans;
const HAND = brainFilm.fontWord;
const MONO = brainFilm.fontMono;
const WIN: Box = { left: 232, top: 100, width: 1456, height: 806 };

// Which cut is playing: its words on screen and its pace. The app screens stay in English
// in every cut, because the real run was in English.
export type Lang = "en" | "es";
export const FilmLang = createContext<{ lang: Lang; T: Timing }>({ lang: "en", T: T_EN });
const COPY = {
  en: {
    savedBy: "saved by Claude · just now", sticky: ["Saved by Claude.", "Read by ChatGPT."],
    s1: ["Copy the link.", "This is the address of your team's brain."], copy: "Copy", copied: "Copied ✓",
    s2: ["Add it to your agent.", "Paste it as a connector in Claude, or as a custom server in ChatGPT."],
    s3: ["Sign in once.", "Your agent asks the first time. After that it just works."], connected: "Connected",
    s4: ["Tell one agent. Ask another.", `Say "remember this" in one app. Any other app can find it.`],
  },
  es: {
    savedBy: "guardado por Claude · recién", sticky: ["Lo guardó Claude.", "Lo leyó ChatGPT."],
    s1: ["Copiá el link.", "Es la dirección del brain de tu equipo."], copy: "Copiar", copied: "Copiado ✓",
    s2: ["Agregalo a tu agente.", "En Claude, como conector. En ChatGPT, como servidor propio."],
    s3: ["Iniciá sesión una vez.", "Tu agente lo pide la primera vez. Después funciona solo."], connected: "Conectado",
    s4: ["Contale a uno. Preguntale a otro.", `Decile "acordate de esto" en una app. Cualquier otra lo encuentra.`],
  },
};
const useFilm = () => {
  const ctx = useContext(FilmLang);
  return { T: ctx.T, c: COPY[ctx.lang] };
};

// ------------------------------------------------------------------ the film
const ClaudePanel: React.FC<PanelProps> = () => {
  const { T } = useFilm();
  const t = { ...T.claude, cpf: T.cpf };
  return (
    <Camera keys={[
      { f: 0, s: 1, x: 960, y: 540 }, { f: 24, s: 1.05, x: 960, y: 860 }, { f: t.send - 2, s: 1.05, x: 960, y: 860 },
      { f: t.send + 12, s: 1.06, x: 960, y: 240 }, { f: t.toolDone, s: 1.12, x: 700, y: 300 }, { f: t.reply + 14, s: 1.06, x: 960, y: 380 }, { f: 400, s: 1.08, x: 960, y: 400 },
    ]}>
      <ClaudeChat rect={WIN} t={t} title={`${BRAIN_NAME} launch`} prompt={CLAUDE_RUN.prompt} tool={CLAUDE_RUN.tool} toolResult={CLAUDE_RUN.toolResult} reply={CLAUDE_RUN.reply} />
    </Camera>
  );
};

const BrainPanel: React.FC<PanelProps> = () => {
  const f = useCurrentFrame();
  const { T, c } = useFilm();
  const page: Box = { left: 470, top: 230, width: 980, height: 400 };
  const by = (
    <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", border: `3px solid ${ink}`, borderRadius: 99, padding: "8px 18px 8px 12px", fontFamily: SANS, fontWeight: 600, fontSize: 22, boxShadow: "4px 5px 0 rgba(17,17,17,0.9)" }}>
      <Mark d={CLAUDE_PATH} size={26} color={CLAUDE_ORANGE} />{c.savedBy}
    </div>
  );
  return (
    <AbsoluteFill>
      <NotePage rect={page} page={NOTE.page} before={NOTE.before} heading={NOTE.heading} added={NOTE.added} addAt={T.brain.add} cpf={T.brain.cpf} by={by} />
      <div style={{ position: "absolute", left: 150, top: 330, opacity: ramp(f, 2, 10), translate: `${(1 - ramp(f, 2, 14)) * -40}px 0` }}><AgentBadge who="claude" label="Claude" /></div>
      <HandArrow x1={290} y1={360} x2={455} y2={420} bend={-70} p={ramp(f, 6, 18)} />
      <div style={{ position: "absolute", left: 1640, top: 330, opacity: ramp(f, T.brain.read, 10), translate: `${(1 - ramp(f, T.brain.read, 14)) * 40}px 0` }}><AgentBadge who="chatgpt" label="ChatGPT" /></div>
      <HandArrow x1={1466} y1={430} x2={1630} y2={380} bend={-70} p={ramp(f, T.brain.read + 4, 16)} dashed />
    </AbsoluteFill>
  );
};

const ChatGPTPanel: React.FC<PanelProps> = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { T, c } = useFilm();
  const t = { ...T.chatgpt, cpf: T.cpf, wpf: T.wpf };
  const s = spring({ frame: f - t.hl - 6, fps, config: { damping: 14, stiffness: 160 } });
  return (
    <AbsoluteFill>
      <Camera keys={[
        { f: 0, s: 1, x: 960, y: 540 }, { f: 22, s: 1.05, x: 960, y: 870 }, { f: t.send - 2, s: 1.05, x: 960, y: 870 },
        { f: t.send + 12, s: 1.06, x: 960, y: 240 }, { f: t.toolDone + 4, s: 1.1, x: 760, y: 300 }, { f: t.card + 10, s: 1.04, x: 960, y: 520 }, { f: t.hl, s: 1.06, x: 960, y: 600 }, { f: 400, s: 1.07, x: 960, y: 600 },
      ]}>
        <ChatGPTChat rect={WIN} t={t} prompt={CHATGPT_RUN.prompt} tool={CHATGPT_RUN.tool} toolResult={CHATGPT_RUN.toolResult} subject={CHATGPT_RUN.subject} body={CHATGPT_RUN.body} facts={CHATGPT_RUN.facts} />
      </Camera>
      {/* the sticky that says where the facts came from */}
      <div style={{ position: "absolute", right: 70, top: 560, rotate: `${3 - 3 * s}deg`, scale: String(0.7 + 0.3 * s), opacity: s, background: yl, border: `3px solid ${brainFilm.halo[1]}`, borderRadius: 6, padding: "18px 24px", boxShadow: "6px 8px 0 rgba(17,17,17,0.85)", fontFamily: SANS, width: 360 }}>
        <div style={{ fontFamily: MONO, fontSize: 18, color: muted }}>{NOTE.page}</div>
        <div style={{ marginTop: 6, fontSize: 27, fontWeight: 700, lineHeight: 1.25, color: ink }}>{c.sticky[0]}<br />{c.sticky[1]}</div>
      </div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ the tutorial
const Pointer: React.FC<{ x: number; y: number; press?: number }> = ({ x, y, press = 0 }) => (
  <svg width="44" height="44" viewBox="0 0 24 24" style={{ position: "absolute", left: x, top: y, scale: String(1 - 0.12 * press), transformOrigin: "0 0", filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.3))" }}>
    <path d="M3 2l7.5 19 2.6-7.4L20.5 11z" fill={ink} stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);

const Ripple: React.FC<{ x: number; y: number; at: number }> = ({ x, y, at }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [at, at + 16], [0, 1], clamp);
  if (f < at || p >= 1) return null;
  return <div style={{ position: "absolute", left: x - 40 * p, top: y - 40 * p, width: 80 * p, height: 80 * p, borderRadius: "50%", border: `3px solid ${brainFilm.accent}`, opacity: 1 - p }} />;
};

const move = (f: number, keys: [number, number, number][]) => ({
  x: interpolate(f, keys.map((k) => k[0]), keys.map((k) => k[1]), { ...clamp, easing: EASE_OUT }),
  y: interpolate(f, keys.map((k) => k[0]), keys.map((k) => k[2]), { ...clamp, easing: EASE_OUT }),
});

// Left: the step number on a highlighter block and the instruction. Right: the thing you do.
const Step: React.FC<{ n: number; title: string; sub?: string; color: string; children: React.ReactNode }> = ({ n, title, sub, color, children }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: f - 2, fps, config: { damping: 14, stiffness: 170 } });
  const t = ramp(f, 6, 14);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 150, top: 300, width: 640 }}>
        <div style={{ display: "inline-block", fontFamily: HAND, fontWeight: 700, fontSize: 120, lineHeight: 1, background: color, padding: "0 26px", border: `3px solid ${ink}`, borderRadius: 10, rotate: `${-4 + 4 * pop}deg`, scale: String(0.6 + 0.4 * pop), opacity: pop }}>{n}</div>
        <div style={{ marginTop: 40, fontFamily: SANS, fontWeight: 700, fontSize: 70, lineHeight: 1.05, letterSpacing: -2, color: ink, opacity: t, translate: `0 ${(1 - t) * 24}px` }}>{title}</div>
        {sub ? <div style={{ marginTop: 22, fontFamily: SANS, fontWeight: 500, fontSize: 30, lineHeight: 1.35, color: muted, opacity: ramp(f, 14, 12) }}>{sub}</div> : null}
      </div>
      <div style={{ position: "absolute", left: 860, top: 150, width: 920, height: 760 }}>{children}</div>
    </AbsoluteFill>
  );
};

const card = (extra: React.CSSProperties = {}): React.CSSProperties => ({ position: "absolute", background: "#fff", border: `3px solid ${ink}`, borderRadius: 14, boxShadow: "10px 12px 0 rgba(17,17,17,0.9)", ...extra });

const StepLink: React.FC<PanelProps> = () => {
  const f = useCurrentFrame();
  const click = 46;
  const c = move(f, [[10, 760, 640], [40, 742, 352]]);
  const copied = f >= click;
  const { c: t } = useFilm();
  return (
    <Step n={1} title={t.s1[0]} sub={t.s1[1]} color={pk}>
      <div style={card({ left: 20, top: 250, width: 860, height: 190, display: "flex", alignItems: "center", padding: "0 30px 0 40px", gap: 24, opacity: ramp(f, 4, 10) })}>
        <Mark d={BRAIN_PATH} size={44} color={ink} />
        <span style={{ flex: 1, fontFamily: MONO, fontSize: 44, fontWeight: 500, color: ink }}>brain.mcpbox.dev/mcp</span>
        <div style={{ minWidth: 150, height: 74, borderRadius: 12, border: `3px solid ${ink}`, background: copied ? yl : "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontFamily: SANS, fontWeight: 700, fontSize: 26, scale: String(f >= click - 2 && f < click + 3 ? 0.93 : 1) }}>
          {copied ? t.copied : t.copy}
        </div>
      </div>
      <Ripple x={c.x + 4} y={c.y + 4} at={click} />
      <Pointer x={c.x} y={c.y} press={f >= click - 2 && f < click + 3 ? 1 : 0} />
    </Step>
  );
};

const Dialog: React.FC<{ who: "claude" | "chatgpt"; at: number; box: Box }> = ({ who, at, box }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: f - at, fps, config: { damping: 16, stiffness: 150 } });
  const claude = who === "claude";
  const url = typed("https://brain.mcpbox.dev/mcp", f, at + 14, 1.6);
  const bg = claude ? "#FAF9F5" : "#fff";
  const field = (label: string, value: string, caret = false) => (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 17, fontWeight: 600, color: "#6b6b6b", marginBottom: 6 }}>{label}</div>
      <div style={{ height: 50, borderRadius: 10, border: `1.5px solid ${claude ? "#DEDCD1" : "#E2E2E2"}`, background: "#fff", display: "flex", alignItems: "center", padding: "0 14px", fontSize: 20, color: "#141413", fontFamily: label === "URL" ? MONO : SANS }}>
        {value}{caret && Math.floor(f / 8) % 2 === 0 ? <span style={{ width: 2, height: 22, background: "#141413", marginLeft: 2 }} /> : null}
      </div>
    </div>
  );
  return (
    <div style={{ position: "absolute", ...box, opacity: pop, translate: `0 ${(1 - pop) * 40}px`, background: bg, border: `1.5px solid ${claude ? "#E6E3D8" : "#E5E5E5"}`, borderRadius: 20, boxShadow: "0 30px 70px -20px rgba(0,0,0,0.3)", padding: "22px 26px", fontFamily: SANS }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 23, fontWeight: 600, color: "#141413" }}>
        <Mark d={claude ? CLAUDE_PATH : OPENAI_PATH} size={26} color={claude ? CLAUDE_ORANGE : "#0D0D0D"} />
        {claude ? "Add custom connector" : "Add custom server"}
      </div>
      <div style={{ marginTop: 6, fontSize: 17, color: "#8a8a8a" }}>{claude ? "Customize  ›  Connectors  ›  + Add" : "Plugins  ›  +"}</div>
      {field("Name", "Agent Brain")}
      {field("URL", url, url.length < 28)}
      <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
        <div style={{ padding: "10px 22px", borderRadius: claude ? 10 : 99, background: url.length >= 28 ? (claude ? "#141413" : "#0D0D0D") : "#bdbdbd", color: "#fff", fontSize: 19, fontWeight: 600 }}>{claude ? "Add" : "Create"}</div>
      </div>
    </div>
  );
};

const StepConnect: React.FC<PanelProps> = () => {
  const { c } = useFilm();
  return (
  <Step n={2} title={c.s2[0]} sub={c.s2[1]} color={yl}>
    <Dialog who="claude" at={4} box={{ left: 10, top: 40, width: 600, height: 330 }} />
    <Dialog who="chatgpt" at={24} box={{ left: 300, top: 400, width: 600, height: 330 }} />
  </Step>
  );
};

const StepSignIn: React.FC<PanelProps> = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const click = 50;
  const c = move(f, [[8, 820, 700], [42, 522, 388]]);
  const done = spring({ frame: f - click - 6, fps, config: { damping: 14, stiffness: 170 } });
  const prov = (d: string | null, color: string, i: number) => (
    <div key={i} style={{ width: 118, height: 58, borderRadius: 10, border: `1.5px solid ${i === 2 && f >= click - 2 && f < click + 4 ? "#111" : "#D9D9D9"}`, display: "flex", alignItems: "center", justifyContent: "center", background: "#fff" }}>
      {d ? <Mark d={d} size={26} color={color} /> : (
        <div style={{ display: "grid", gridTemplateColumns: "12px 12px", gap: 2 }}>{["#F25022", "#7FBA00", "#00A4EF", "#FFB900"].map((k) => <span key={k} style={{ width: 12, height: 12, background: k }} />)}</div>
      )}
    </div>
  );
  const { c: t } = useFilm();
  return (
    <Step n={3} title={t.s3[0]} sub={t.s3[1]} color={bl}>
      {/* the real sign-in page (brain.mcpbox.dev's AuthKit), redrawn */}
      <div style={{ position: "absolute", left: 140, top: 60, width: 640, opacity: ramp(f, 2, 10), translate: `0 ${(1 - ramp(f, 2, 14)) * 30}px`, fontFamily: SANS, textAlign: "center" }}>
        <div style={{ fontSize: 34, fontWeight: 600, color: "#1c1c1c" }}>Sign in</div>
        <div style={{ marginTop: 26, background: "#fff", border: "1.5px solid #DADADA", borderRadius: 20, padding: "38px 48px 34px", textAlign: "left", boxShadow: "0 30px 70px -30px rgba(0,0,0,0.25)" }}>
          <div style={{ fontSize: 19, fontWeight: 600 }}>Email</div>
          <div style={{ marginTop: 8, height: 54, borderRadius: 8, border: "2px solid #9AA0F0", display: "flex", alignItems: "center", padding: "0 14px", fontSize: 20, color: "#8a8a8a" }}>Your email address</div>
          <div style={{ marginTop: 22, height: 54, borderRadius: 8, background: "#000", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21, fontWeight: 500 }}>Continue with email</div>
          <div style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 14, fontSize: 15, color: "#777" }}><span style={{ flex: 1, height: 1, background: "#DDD" }} />OR<span style={{ flex: 1, height: 1, background: "#DDD" }} /></div>
          <div style={{ marginTop: 20, display: "flex", justifyContent: "space-between" }}>
            {prov(GOOGLE_PATH, "#4285F4", 0)}{prov(null, "", 1)}{prov(GITHUB_PATH, "#181717", 2)}{prov(APPLE_PATH, "#000", 3)}
          </div>
        </div>
      </div>
      <Ripple x={c.x + 4} y={c.y + 4} at={click} />
      <Pointer x={c.x} y={c.y} press={f >= click - 2 && f < click + 3 ? 1 : 0} />
      <div style={{ position: "absolute", left: 300, top: 600, opacity: done, scale: String(0.6 + 0.4 * done), rotate: "-3deg", display: "flex", alignItems: "center", gap: 14, background: pk, border: `3px solid ${ink}`, borderRadius: 99, padding: "12px 26px 12px 14px", boxShadow: "6px 7px 0 rgba(17,17,17,0.9)", fontFamily: SANS, fontWeight: 700, fontSize: 30 }}>
        <BrainBadge size={44} />{t.connected}
      </div>
    </Step>
  );
};

// Step 4 replays two real lines from the run: what Claude was told, what ChatGPT asked.
const Bubble: React.FC<{ who: "claude" | "chatgpt"; ask: string; answer: string; at: number; box: Box }> = ({ who, ask, answer, at, box }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = spring({ frame: f - at, fps, config: { damping: 16, stiffness: 160 } });
  const b = spring({ frame: f - at - 16, fps, config: { damping: 16, stiffness: 160 } });
  const claude = who === "claude";
  return (
    <div style={{ position: "absolute", ...box, background: claude ? "#FAF9F5" : "#fff", border: `1.5px solid ${claude ? "#E6E3D8" : "#E5E5E5"}`, borderRadius: 20, boxShadow: "0 30px 70px -24px rgba(0,0,0,0.3)", padding: "20px 24px", opacity: a, translate: `0 ${(1 - a) * 30}px` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: SANS, fontSize: 20, fontWeight: 600 }}><Mark d={claude ? CLAUDE_PATH : OPENAI_PATH} size={24} color={claude ? CLAUDE_ORANGE : "#0D0D0D"} />{claude ? "Claude" : "ChatGPT"}</div>
      <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
        <div style={{ maxWidth: 520, background: claude ? "#F0EEE6" : "#EEF2FC", color: claude ? "#141413" : "#2E4FB8", borderRadius: claude ? 16 : 22, padding: "12px 18px", fontFamily: SANS, fontSize: 21, lineHeight: 1.4 }}>{ask}</div>
      </div>
      <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, fontFamily: SANS, fontSize: 20, color: "#6b6b6b", opacity: b }}>
        <BrainBadge size={28} /><span style={{ color: "#141413", fontWeight: 500 }}>{answer}</span>
      </div>
    </div>
  );
};

const StepUse: React.FC<PanelProps> = () => {
  const { c } = useFilm();
  return (
  <Step n={4} title={c.s4[0]} sub={c.s4[1]} color={pk}>
    <Bubble who="claude" ask="…launches March 3. Remember that in the brain." answer={CLAUDE_RUN.toolResult} at={4} box={{ left: 20, top: 70, width: 680, height: 230 }} />
    <Bubble who="chatgpt" ask="Write a short launch email… Use what's in our brain." answer={CHATGPT_RUN.toolResult} at={30} box={{ left: 220, top: 380, width: 680, height: 230 }} />
  </Step>
  );
};

export const PANELS: Panels = { claude: ClaudePanel, brain: BrainPanel, chatgpt: ChatGPTPanel, stepLink: StepLink, stepConnect: StepConnect, stepSignIn: StepSignIn, stepUse: StepUse };
export { SERIF };

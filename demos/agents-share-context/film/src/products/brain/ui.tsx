import { loadFont as loadSerif } from "@remotion/google-fonts/SourceSerif4";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { clamp, EASE_IN_OUT, EASE_OUT } from "../../kit/film/theme";
import { BRAIN_PATH, CLAUDE_ORANGE, CLAUDE_PATH, Mark, OPENAI_PATH } from "./icons";
import { bl, brainFilm, ink, pk, pkd, yl } from "./theme";

// Motion-design recreations of the Claude and ChatGPT desktop apps, drawn from screenshots of
// the real apps (November 2026), plus the Agent Brain note. Type is set large so a phone can read it.

const serif = loadSerif("normal", { weights: ["400", "500"], subsets: ["latin"] });
export const SERIF = `${serif.fontFamily}, Georgia, serif`;
const SANS = brainFilm.fontSans;

export type Box = { left: number; top: number; width: number; height: number };

// ------------------------------------------------------------------ timing helpers
export const ramp = (f: number, at: number, dur = 12) => interpolate(f, [at, at + dur], [0, 1], { ...clamp, easing: EASE_OUT });
export const typed = (text: string, f: number, start: number, cpf = 2.4) => text.slice(0, Math.max(0, Math.floor((f - start) * cpf)));
export const wordsShown = (text: string, f: number, start: number, wpf = 0.7) => Math.max(0, Math.min(text.split(" ").length, Math.floor((f - start) * wpf)));

// Text that streams in word by word; listed words get a highlighter sweep from `hlAt`.
export const Stream: React.FC<{ text: string; f: number; start: number; wpf?: number; facts?: string[]; hlAt?: number; hlColor?: string }> = ({ text, f, start, wpf = 0.7, facts = [], hlAt = 1e9, hlColor = pk }) => {
  const words = text.split(" ");
  const n = wordsShown(text, f, start, wpf);
  let k = 0;
  return (
    <>
      {words.slice(0, n).map((w, i) => {
        const fact = facts.includes(w.replace(/[.,:!;]$/g, ""));
        const sweep = fact ? ramp(f, hlAt + k++ * 2, 12) : 0;
        return (
          <span key={i}>
            <span style={fact ? { backgroundImage: `linear-gradient(${hlColor}, ${hlColor})`, backgroundRepeat: "no-repeat", backgroundPosition: "0 88%", backgroundSize: `${sweep * 100}% 62%`, padding: "0 2px", margin: "0 -2px" } : undefined}>{w}</span>
            {i < words.length - 1 ? " " : ""}
          </span>
        );
      })}
    </>
  );
};

export const Caret: React.FC<{ f: number; color: string; h: number }> = ({ f, color, h }) => (
  <span style={{ display: "inline-block", width: 2.5, height: h, background: color, marginLeft: 2, verticalAlign: "-0.18em", opacity: Math.floor(f / 8) % 2 ? 0 : 1 }} />
);

const Spinner: React.FC<{ f: number; size: number; color: string }> = ({ f, size, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ rotate: `${f * 14}deg`, flexShrink: 0 }}>
    <circle cx="12" cy="12" r="9" fill="none" stroke={color} strokeOpacity={0.22} strokeWidth="3" />
    <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" />
  </svg>
);

const Check: React.FC<{ size: number; color: string; p: number }> = ({ size, color, p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0, scale: String(0.6 + 0.4 * p), opacity: p }}>
    <circle cx="12" cy="12" r="11" fill={color} />
    <path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="16" strokeDashoffset={16 * (1 - p)} />
  </svg>
);

const UpArrow: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

const Plus: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke={color} strokeWidth="2" strokeLinecap="round" /></svg>
);

const Chevron: React.FC<{ size: number; color: string; dir?: "down" | "right" }> = ({ size, color, dir = "down" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ rotate: dir === "right" ? "-90deg" : "0deg" }}><path d="M6 9l6 6 6-6" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

// Agent Brain's star on its pink highlighter square: how the connector shows up inside both apps.
export const BrainBadge: React.FC<{ size: number }> = ({ size }) => (
  <div style={{ width: size, height: size, borderRadius: size * 0.26, background: pk, border: `2px solid ${ink}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
    <Mark d={BRAIN_PATH} size={size * 0.58} color={ink} />
  </div>
);

// ------------------------------------------------------------------ the desktop window
// A macOS app window that tilts in like the film kit's AppWindow and drifts a little.
export const DesktopWindow: React.FC<{
  rect: Box; bg: string; bar: string; border: string; title: React.ReactNode; enter?: number; children: React.ReactNode;
}> = ({ rect, bg, bar, border, title, enter: enterFrames = 22, children }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const e = enterFrames ? spring({ frame, fps, config: { damping: 22, stiffness: 90 }, durationInFrames: enterFrames }) : 1;
  const tiltX = (1 - e) * 16 + Math.sin(frame / 90) * 0.5;
  const tiltY = (1 - e) * -6 + Math.cos(frame / 110) * 0.6;
  const barH = 52;
  return (
    <AbsoluteFill style={{ perspective: 2600, perspectiveOrigin: `${width / 2}px ${height * 0.3}px` }}>
      <div style={{ position: "absolute", ...rect, transformOrigin: "50% 100%", rotate: `x ${tiltX}deg`, translate: `0 ${(1 - e) * 240}px`, opacity: interpolate(e, [0, 0.4], [0, 1], clamp) }}>
        <div style={{ position: "absolute", inset: 0, rotate: `y ${tiltY}deg`, borderRadius: 16, overflow: "hidden", background: bg, border: `1px solid ${border}`, boxShadow: "0 50px 120px -30px rgba(10,10,10,0.35), 0 18px 40px -20px rgba(10,10,10,0.25)" }}>
          <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: barH, background: bar, borderBottom: `1px solid ${border}`, display: "flex", alignItems: "center", padding: "0 22px", gap: 10 }}>
            {["#ff5f57", "#febc2e", "#28c840"].map((c) => <span key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />)}
            <div style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>{title}</div>
          </div>
          <div style={{ position: "absolute", left: 0, right: 0, top: barH, bottom: 0 }}>{children}</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// A gentle camera on the whole stage: keys of { f, s, x, y } (scale and focus point in stage px).
export type CamKey = { f: number; s: number; x: number; y: number };
export const Camera: React.FC<{ keys: CamKey[]; children: React.ReactNode }> = ({ keys, children }) => {
  const f = useCurrentFrame();
  const fs = keys.map((k) => k.f);
  const opt = { ...clamp, easing: EASE_IN_OUT };
  const s = interpolate(f, fs, keys.map((k) => k.s), opt);
  const x = interpolate(f, fs, keys.map((k) => k.x), opt);
  const y = interpolate(f, fs, keys.map((k) => k.y), opt);
  // scale around (x, y) and keep that point where it was
  return <AbsoluteFill style={{ transformOrigin: `${x}px ${y}px`, scale: String(s) }}>{children}</AbsoluteFill>;
};

// ------------------------------------------------------------------ Claude
export type ChatTimes = { type: number; send: number; tool: number; toolDone: number; reply: number; cpf?: number; wpf?: number };

const C = { bg: "#FAF9F5", bar: "#F5F4EE", line: "#E6E3D8", bubble: "#F0EEE6", text: "#141413", muted: "#83817A" };

export const ClaudeChat: React.FC<{ rect: Box; t: ChatTimes; prompt: string; tool: string; toolResult: string; reply: string; title: string }> = ({ rect, t, prompt, tool, toolResult, reply, title }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sent = f >= t.send;
  const draft = sent ? "" : typed(prompt, f, t.type, t.cpf);
  const col = 940;
  const colLeft = (rect.width - col) / 2;
  const bubble = spring({ frame: f - t.send, fps, config: { damping: 18, stiffness: 170 } });
  const toolIn = spring({ frame: f - t.tool, fps, config: { damping: 18, stiffness: 170 } });
  const done = ramp(f, t.toolDone, 10);
  const replyN = wordsShown(reply, f, t.reply, 0.75);
  const replyDone = replyN >= reply.split(" ").length;
  return (
    <DesktopWindow rect={rect} bg={C.bg} bar={C.bar} border={C.line}
      title={<div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: SANS, fontSize: 20, fontWeight: 500, color: C.text }}><Mark d={CLAUDE_PATH} size={22} color={CLAUDE_ORANGE} />{title}<Chevron size={18} color={C.muted} /></div>}>
      {/* empty new chat: the greeting */}
      <div style={{ position: "absolute", left: 0, right: 0, top: 210, display: "flex", justifyContent: "center", alignItems: "center", gap: 18, opacity: 1 - ramp(f, t.send - 4, 8), fontFamily: SERIF, fontSize: 48, color: C.text }}>
        <Mark d={CLAUDE_PATH} size={46} color={CLAUDE_ORANGE} />What's on your mind?
      </div>
      <div style={{ position: "absolute", left: colLeft, top: 44, width: col }}>
        {sent ? (
          <div style={{ display: "flex", justifyContent: "flex-end", opacity: bubble, translate: `0 ${(1 - bubble) * 30}px` }}>
            <div style={{ maxWidth: 740, background: C.bubble, borderRadius: 20, padding: "18px 24px", fontFamily: SANS, fontSize: 25, lineHeight: 1.45, color: C.text }}>{prompt}</div>
          </div>
        ) : null}
        {f >= t.tool ? (
          <div style={{ marginTop: 30, display: "inline-flex", alignItems: "center", gap: 14, border: `1.5px solid ${C.line}`, borderRadius: 14, padding: "12px 18px", background: "#fff", opacity: toolIn, translate: `0 ${(1 - toolIn) * 20}px`, fontFamily: SANS, fontSize: 22, color: C.text }}>
            <BrainBadge size={34} />
            <span style={{ fontWeight: 600 }}>{tool}</span>
            <span style={{ color: C.muted }}>Agent Brain</span>
            <span style={{ width: 1, height: 26, background: C.line }} />
            {done < 1 && f < t.toolDone ? <Spinner f={f} size={24} color={C.muted} /> : <Check size={26} color="#2F9E5B" p={done} />}
            <span style={{ color: f >= t.toolDone ? C.text : C.muted, fontWeight: f >= t.toolDone ? 500 : 400 }}>{f >= t.toolDone ? toolResult : "Saving…"}</span>
            <Chevron size={18} color={C.muted} dir="right" />
          </div>
        ) : null}
        {f >= t.reply ? (
          <div style={{ marginTop: 28, fontFamily: SERIF, fontSize: 29, lineHeight: 1.5, color: C.text, maxWidth: col }}>
            <Stream text={reply} f={f} start={t.reply} wpf={0.75} />
          </div>
        ) : null}
        {replyDone && f >= t.reply ? <div style={{ marginTop: 22, opacity: ramp(f, t.reply + reply.split(" ").length / 0.75, 8) }}><Mark d={CLAUDE_PATH} size={34} color={CLAUDE_ORANGE} /></div> : null}
      </div>
      {/* composer */}
      <div style={{ position: "absolute", left: colLeft, width: col, bottom: 30, minHeight: 128, background: "#fff", border: `1.5px solid ${C.line}`, borderRadius: 24, boxShadow: "0 6px 24px rgba(20,20,19,0.06)", padding: "20px 22px 16px", fontFamily: SANS, fontSize: 25, lineHeight: 1.4 }}>
        <div style={{ color: draft ? C.text : C.muted, minHeight: 36, paddingRight: 10 }}>{draft || (sent ? "Reply to Claude…" : "How can I help you today?")}{!sent && f >= t.type ? <Caret f={f} color={C.text} h={28} /> : null}</div>
        <div style={{ display: "flex", alignItems: "center", marginTop: 14 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, border: `1.5px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "center" }}><Plus size={22} color={C.muted} /></div>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 19, color: C.muted, marginRight: 16, display: "flex", alignItems: "center", gap: 4 }}>Claude<Chevron size={16} color={C.muted} /></span>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: CLAUDE_ORANGE, opacity: draft ? 1 : 0.45, display: "flex", alignItems: "center", justifyContent: "center", scale: String(f >= t.send - 3 && f < t.send + 3 ? 0.9 : 1) }}><UpArrow size={24} color="#fff" /></div>
        </div>
      </div>
    </DesktopWindow>
  );
};

// ------------------------------------------------------------------ ChatGPT
const G = { bg: "#FCFCFC", bar: "#F9F9F9", line: "#E5E5E5", bubble: "#EEF2FC", bubbleText: "#2E4FB8", text: "#0D0D0D", muted: "#8F8F8F", send: "#2F7CF6" };

export const ChatGPTChat: React.FC<{
  rect: Box; t: ChatTimes & { card: number; hl: number }; prompt: string; tool: string; toolResult: string; subject: string; body: string[]; facts: string[];
}> = ({ rect, t, prompt, tool, toolResult, subject, body, facts }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sent = f >= t.send;
  const draft = sent ? "" : typed(prompt, f, t.type, t.cpf);
  const col = 960;
  const colLeft = (rect.width - col) / 2;
  const bubble = spring({ frame: f - t.send, fps, config: { damping: 18, stiffness: 170 } });
  const toolIn = ramp(f, t.tool, 10);
  const card = spring({ frame: f - t.card, fps, config: { damping: 20, stiffness: 150 } });
  const subjStart = t.card + 6;
  const bodyStarts: number[] = [];
  const wpf = t.wpf ?? 0.9;
  let at = subjStart + subject.split(" ").length / wpf + 4;
  for (const line of body) { bodyStarts.push(at); at += line.split(" ").length / wpf + 3; }
  const shimmer = (f % 40) / 40;
  return (
    <DesktopWindow rect={rect} bg={G.bg} bar={G.bar} border={G.line}
      title={<div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: SANS, fontSize: 21, fontWeight: 600, color: G.text }}><Mark d={OPENAI_PATH} size={22} color={G.text} />ChatGPT<Chevron size={18} color={G.muted} /></div>}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 220, textAlign: "center", opacity: 1 - ramp(f, t.send - 4, 8), fontFamily: SANS, fontSize: 44, fontWeight: 500, color: G.text, letterSpacing: -0.5 }}>Where should we begin?</div>
      <div style={{ position: "absolute", left: colLeft, top: 36, width: col }}>
        {sent ? (
          <div style={{ display: "flex", justifyContent: "flex-end", opacity: bubble, translate: `0 ${(1 - bubble) * 30}px` }}>
            <div style={{ maxWidth: 720, background: G.bubble, color: G.bubbleText, borderRadius: 26, padding: "16px 24px", fontFamily: SANS, fontSize: 25, lineHeight: 1.42 }}>{prompt}</div>
          </div>
        ) : null}
        {f >= t.tool ? (
          <div style={{ marginTop: 26, display: "flex", alignItems: "center", gap: 12, opacity: toolIn, fontFamily: SANS, fontSize: 22, color: G.muted }}>
            <BrainBadge size={30} />
            {f < t.toolDone ? (
              <span style={{ backgroundImage: `linear-gradient(90deg, ${G.muted} ${shimmer * 100 - 30}%, ${G.text} ${shimmer * 100}%, ${G.muted} ${shimmer * 100 + 30}%)`, WebkitBackgroundClip: "text", color: "transparent" }}>Searching Agent Brain…</span>
            ) : (
              <>
                <span>Called <b style={{ color: G.text, fontWeight: 600 }}>{tool}</b> on Agent Brain</span>
                <span style={{ color: G.line }}>·</span>
                <span style={{ color: G.text }}>{toolResult}</span>
                <Chevron size={18} color={G.muted} dir="right" />
              </>
            )}
          </div>
        ) : null}
        {f >= t.card ? (
          <div style={{ marginTop: 18, border: `1.5px solid ${G.line}`, borderRadius: 26, background: "#fff", padding: "20px 28px 24px", opacity: card, translate: `0 ${(1 - card) * 24}px`, fontFamily: SANS, color: G.text }}>
            <div style={{ display: "flex", alignItems: "center", fontSize: 19, color: G.muted, marginBottom: 14 }}>
              Writing<div style={{ flex: 1 }} />
              <svg width="22" height="22" viewBox="0 0 24 24" style={{ marginRight: 18 }}><path d="M4 20h4L19 9l-4-4L4 16z" fill="none" stroke={G.text} strokeWidth="1.8" strokeLinejoin="round" /></svg>
              <svg width="22" height="22" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke={G.text} strokeWidth="1.8" /><path d="M16 5H6a2 2 0 0 0-2 2v9" fill="none" stroke={G.text} strokeWidth="1.8" /></svg>
            </div>
            <div style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.4 }}><Stream text={subject} f={f} start={subjStart} wpf={wpf} facts={facts} hlAt={t.hl} /></div>
            {body.map((line, i) => (
              <div key={i} style={{ marginTop: 12, fontSize: 24, lineHeight: 1.5 }}><Stream text={line} f={f} start={bodyStarts[i]} wpf={wpf} facts={facts} hlAt={t.hl + 4} /></div>
            ))}
          </div>
        ) : null}
      </div>
      <div style={{ position: "absolute", left: colLeft, width: col, bottom: 26, height: 76, background: "#fff", border: `1.5px solid ${G.line}`, borderRadius: 38, boxShadow: "0 4px 18px rgba(0,0,0,0.05)", display: "flex", alignItems: "center", padding: "0 14px 0 24px", gap: 16, fontFamily: SANS, fontSize: 25 }}>
        <Plus size={28} color={G.text} />
        <div style={{ flex: 1, color: draft ? G.text : G.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "clip", direction: "ltr" }}>
          <span style={{ display: "inline-block", translate: `${-Math.max(0, draft.length * 12.6 - 700)}px 0` }}>{draft || "Ask ChatGPT"}{!sent && f >= t.type ? <Caret f={f} color={G.text} h={28} /> : null}</span>
        </div>
        <div style={{ width: 50, height: 50, borderRadius: 25, background: draft ? G.send : "#D6E7FF", display: "flex", alignItems: "center", justifyContent: "center", scale: String(f >= t.send - 3 && f < t.send + 3 ? 0.9 : 1) }}><UpArrow size={26} color="#fff" /></div>
      </div>
    </DesktopWindow>
  );
};

// ------------------------------------------------------------------ the Agent Brain note
// The page the claim landed on, drawn the way Agent Brain draws notes: a ruled notebook card,
// 3px ink border, mono path, the new line under a pink highlighter.
export const NotePage: React.FC<{ rect: Box; page: string; before: { kind: string; text: string }[]; heading: string; added: string; addAt: number; cpf?: number; by: React.ReactNode }> = ({ rect, page, before, heading, added, addAt, cpf = 2.6, by }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: f, fps, config: { damping: 16, stiffness: 120 } });
  const typedAdded = typed(added, f, addAt, cpf);
  const sweep = ramp(f, addAt + added.length / cpf + 2, 12);
  const chip = spring({ frame: f - (addAt + added.length / cpf + 6), fps, config: { damping: 14, stiffness: 180 } });
  const row = (k: string, text: string, i: number) => k === "h"
    ? <div key={i} style={{ fontWeight: 700, fontSize: 30, marginTop: i ? 22 : 0 }}>{text}</div>
    : <div key={i} style={{ fontSize: 26, marginTop: 10, paddingLeft: 26, textIndent: -26 }}>-&nbsp;&nbsp;{text}</div>;
  return (
    <div style={{ position: "absolute", ...rect, scale: String(0.9 + 0.1 * pop), opacity: pop, rotate: `${(1 - pop) * -2}deg` }}>
      <div style={{ position: "absolute", inset: 0, background: "#fff", border: `3px solid ${ink}`, borderRadius: 10, boxShadow: "10px 12px 0 rgba(17,17,17,0.9)", overflow: "hidden" }}>
        <div style={{ height: 64, borderBottom: `3px solid ${ink}`, background: yl, display: "flex", alignItems: "center", padding: "0 26px", gap: 14, fontFamily: brainFilm.fontMono, fontSize: 22, fontWeight: 500 }}>
          <Mark d={BRAIN_PATH} size={24} color={ink} />{page}
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 64, bottom: 0, backgroundImage: `repeating-linear-gradient(transparent 0 43px, ${bl}66 43px 45px)`, backgroundPosition: "0 10px" }} />
        <div style={{ position: "absolute", left: 92, top: 64, bottom: 0, borderLeft: `2px solid ${pkd}55` }} />
        <div style={{ position: "relative", padding: "30px 40px 0 120px", fontFamily: brainFilm.fontMono, color: ink, lineHeight: 1.45 }}>
          {before.map((b, i) => row(b.kind, b.text, i))}
          {f >= addAt - 6 ? row("h", heading, before.length) : null}
          {f >= addAt ? (
            <div style={{ fontSize: 26, marginTop: 10, paddingLeft: 26, textIndent: -26 }}>
              -&nbsp;&nbsp;<span style={{ backgroundImage: `linear-gradient(${pk}, ${pk})`, backgroundRepeat: "no-repeat", backgroundSize: `${sweep * 100}% 100%`, padding: "2px 4px" }}>{typedAdded}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div style={{ position: "absolute", right: -18, top: -24, rotate: "3deg", scale: String(0.6 + 0.4 * chip), opacity: chip }}>{by}</div>
    </div>
  );
};

// Agent badge: the app's real mark in a round chip with its name in the hand font.
export const AgentBadge: React.FC<{ who: "claude" | "chatgpt"; size?: number; label?: string }> = ({ who, size = 120, label }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
    <div style={{ width: size, height: size, borderRadius: size / 2, background: who === "claude" ? "#FAF9F5" : "#fff", border: `3px solid ${ink}`, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "6px 7px 0 rgba(17,17,17,0.9)" }}>
      <Mark d={who === "claude" ? CLAUDE_PATH : OPENAI_PATH} size={size * 0.54} color={who === "claude" ? CLAUDE_ORANGE : "#0D0D0D"} />
    </div>
    {label ? <span style={{ fontFamily: brainFilm.fontWord, fontWeight: 700, fontSize: 40, background: who === "claude" ? pk : bl, padding: "0 10px", lineHeight: 1.2 }}>{label}</span> : null}
  </div>
);

// A hand-drawn arrow that draws itself from (x1,y1) to (x2,y2), bowed by `bend`.
export const HandArrow: React.FC<{ x1: number; y1: number; x2: number; y2: number; bend?: number; p: number; dashed?: boolean }> = ({ x1, y1, x2, y2, bend = -60, p, dashed }) => {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2 + bend;
  const d = `M${x1} ${y1} Q${mx} ${my} ${x2} ${y2}`;
  const ang = Math.atan2(y2 - my, x2 - mx);
  const h = 18;
  const a1 = `M${x2} ${y2} l${-h * Math.cos(ang - 0.5)} ${-h * Math.sin(ang - 0.5)}`;
  const a2 = `M${x2} ${y2} l${-h * Math.cos(ang + 0.5)} ${-h * Math.sin(ang + 0.5)}`;
  return (
    <svg style={{ position: "absolute", inset: 0, overflow: "visible" }} width="100%" height="100%">
      <path d={d} fill="none" stroke={ink} strokeWidth={4} strokeLinecap="round" pathLength={1} strokeDasharray={dashed ? undefined : "1 1"} strokeDashoffset={dashed ? undefined : 1 - p} style={dashed ? { strokeDasharray: "0.02 0.025", opacity: p } : undefined} />
      <path d={`${a1} ${a2}`} fill="none" stroke={ink} strokeWidth={4} strokeLinecap="round" opacity={p > 0.95 ? 1 : 0} />
    </svg>
  );
};

import type { FilmCut, Vo } from "../../kit/film/timeline";
import { CHATGPT_RUN, CLAUDE_RUN, NOTE } from "./run";
import VO_ES from "./vo-es.json";

// "Agents share context": Claude settles something, ChatGPT picks it up, because both read the
// same Agent Brain. Plain data (scene frames), read by Film.tsx, panels.tsx and film-plan.mjs.
// The apps are motion-design recreations of a real run (run/), so every scene that shows one
// carries a note tag, in every cut.
// Two languages: the English cuts are silent (captions only); the Spanish cuts carry an
// AI voiceover (vo/es.json, scripts/make_vo.py) and their timing is built around it.

const words = (s: string) => s.split(" ").length;
const bodyWords = words(CHATGPT_RUN.subject) + CHATGPT_RUN.body.reduce((n, l) => n + words(l), 0);

// How fast the redrawn apps move. The voiced cut types slower so the voice can keep up.
type Pace = { cpf: number; cType: number; gType: number; gToolWait: number; noteCpf: number; noteAdd: number; wpf: number };
const makeT = (p: Pace) => {
  const cSend = p.cType + Math.ceil(CLAUDE_RUN.prompt.length / p.cpf) + 6;
  const cTool = cSend + 10;
  const cDone = cTool + 24;
  const gSend = p.gType + Math.ceil(CHATGPT_RUN.prompt.length / p.cpf) + 6;
  const gTool = gSend + 8;
  const gDone = gTool + p.gToolWait;
  const gCard = gDone + 6;
  const gHl = gCard + 6 + Math.ceil(bodyWords / p.wpf) + 4 * (CHATGPT_RUN.body.length + 1) + 4;
  return {
    cpf: p.cpf, wpf: p.wpf,
    claude: { type: p.cType, send: cSend, tool: cTool, toolDone: cDone, reply: cDone + 8 },
    brain: { add: p.noteAdd, cpf: p.noteCpf, read: p.noteAdd + Math.ceil(NOTE.added.length / p.noteCpf) + 22 },
    chatgpt: { type: p.gType, send: gSend, tool: gTool, toolDone: gDone, reply: gCard, card: gCard, hl: gHl },
  };
};
export type Timing = ReturnType<typeof makeT>;

export const T = makeT({ cpf: 2.4, cType: 12, gType: 14, gToolWait: 22, noteCpf: 2.6, noteAdd: 16, wpf: 0.9 });
export const T_ES = makeT({ cpf: 1.7, cType: 12, gType: 16, gToolWait: 61, noteCpf: 1.8, noteAdd: 20, wpf: 1.1 });

const beatsFor = (frames: number) => Math.ceil(frames / 18);

// ------------------------------------------------------------------ English, silent
const NOTE_TAG = "Recreated from a real run · waits shortened";

export const MAIN: FilmCut = {
  id: "Brain-Agents-Main-16x9", bed: "audio/brain-agents-main-bed.wav", key: "G", clips: {},
  scenes: [
    { kind: "title", name: "Title", beats: 4, headline: "Tell Claude. ChatGPT already knows.", highlight: ["knows"],
      sub: "Agent Brain is one memory every AI app can read." },
    { kind: "panel", name: "Claude", chapter: "In Claude", panel: "claude", note: NOTE_TAG,
      beats: beatsFor(T.claude.reply + Math.ceil(words(CLAUDE_RUN.reply) / 0.75) + 40),
      cues: [{ at: T.claude.send, sfx: "tick" }, { at: T.claude.toolDone, sfx: "hit", volume: 0.24 }, { at: T.claude.toolDone + 14, sfx: "chime", volume: 0.2 }],
      caps: [
        { from: 6, to: T.claude.send + 4, text: "Settle something in Claude." },
        { from: T.claude.toolDone - 4, to: T.claude.toolDone + 70, text: "It saves it to your team's brain.", highlight: ["brain."] },
      ] },
    { kind: "panel", name: "Brain", chapter: "The brain", panel: "brain", note: "The page Claude committed, redrawn",
      beats: 6,
      cues: [{ at: 16, sfx: "tick", volume: 0.16 }, { at: T.brain.read + 2, sfx: "whoosh", volume: 0.14 }],
      caps: [{ from: 6, to: 104, text: "A plain note in a git repo. Any agent can read it.", highlight: ["Any", "agent"] }] },
    { kind: "panel", name: "ChatGPT", chapter: "In ChatGPT", panel: "chatgpt", note: "Real run in Codex, OpenAI's agent · redrawn as ChatGPT",
      beats: beatsFor(T.chatgpt.hl + 66),
      cues: [{ at: T.chatgpt.send, sfx: "tick" }, { at: T.chatgpt.toolDone, sfx: "tick", volume: 0.16 }, { at: T.chatgpt.hl, sfx: "hit" }, { at: T.chatgpt.hl + 18, sfx: "chime" }],
      caps: [
        { from: 6, to: T.chatgpt.send + 4, text: "Later, in ChatGPT." },
        { from: T.chatgpt.toolDone - 4, to: T.chatgpt.card + 20, text: "It checks the brain on its own." },
        { from: T.chatgpt.hl - 6, to: T.chatgpt.hl + 64, text: "Same facts. Nobody pasted anything.", highlight: ["Nobody"] },
      ] },
    { kind: "end", name: "End", beats: 5, line1: "Tell one agent. They all know.", line2: "brain.mcpbox.dev" },
  ],
};

export const HOWTO: FilmCut = {
  id: "Brain-Agents-HowTo-16x9", bed: "audio/brain-agents-howto-bed.wav", key: "D", clips: {},
  scenes: [
    { kind: "title", name: "Title", beats: 4, headline: "How to start.", highlight: ["start"], sub: "Four steps. No code." },
    { kind: "panel", name: "Link", chapter: "Step 1", panel: "stepLink", beats: 5, cues: [{ at: 46, sfx: "tick" }, { at: 50, sfx: "chime", volume: 0.16 }], caps: [] },
    { kind: "panel", name: "Connect", chapter: "Step 2", panel: "stepConnect", beats: 6, note: "Redrawn from the real apps", cues: [{ at: 4, sfx: "tick", volume: 0.14 }, { at: 24, sfx: "tick", volume: 0.14 }], caps: [] },
    { kind: "panel", name: "Sign in", chapter: "Step 3", panel: "stepSignIn", beats: 5, note: "Redrawn from the real sign-in page", cues: [{ at: 50, sfx: "tick" }, { at: 56, sfx: "hit", volume: 0.2 }], caps: [] },
    { kind: "panel", name: "Use", chapter: "Step 4", panel: "stepUse", beats: 6, note: "Lines from the real run",
      cues: [{ at: 20, sfx: "tick", volume: 0.16 }, { at: 46, sfx: "chime", volume: 0.18 }], caps: [] },
    { kind: "end", name: "End", beats: 5, line1: "That's it.", line2: "brain.mcpbox.dev/mcp" },
  ],
};

// ------------------------------------------------------------------ Spanish, voiced
type VoKey = keyof typeof VO_ES;
const vo = (key: VoKey, at: number): Vo => ({ at, src: `audio/vo/es/${key}.wav`, frames: VO_ES[key].frames });
const said = (v: Vo) => v.at + v.frames;
// The caption under a voice line shows the same words, a little longer than the voice.
const cap = (key: VoKey, v: Vo, highlight?: string[]) => ({ from: v.at, to: said(v) + 10, text: VO_ES[key].text, highlight });
const fit = (minFrames: number, ...lines: Vo[]) => beatsFor(Math.max(minFrames, ...lines.map((l) => said(l) + 14)));

const E = T_ES;
const NOTE_ES = "Recreado de una corrida real · esperas acortadas";
const esTitle = vo("m-title", 8);
const esC1 = vo("m-claude-1", 8);
const esC2 = vo("m-claude-2", Math.max(E.claude.toolDone - 6, said(esC1) + 6));
const esBrain = vo("m-brain", 6);
const esG1 = vo("m-gpt-1", 6);
const esG2 = vo("m-gpt-2", Math.max(E.chatgpt.tool + 4, said(esG1) + 4));
const esG3 = vo("m-gpt-3", E.chatgpt.hl);
const esEnd = vo("m-end", 10);

export const MAIN_ES: FilmCut = {
  id: "Brain-Agents-Main-ES-16x9", bed: "audio/brain-agents-main-es-bed.wav", key: "G", clips: {},
  scenes: [
    { kind: "title", name: "Title", beats: fit(0, esTitle) - 1, headline: "Le contás a Claude. ChatGPT ya lo sabe.", highlight: ["sabe"],
      sub: "Agent Brain es una memoria que cualquier app de IA puede leer.", vo: [esTitle] },
    { kind: "panel", name: "Claude", chapter: "En Claude", panel: "claude", note: NOTE_ES,
      beats: fit(E.claude.reply + Math.ceil(words(CLAUDE_RUN.reply) / 0.75) + 40, esC1, esC2), vo: [esC1, esC2],
      cues: [{ at: E.claude.send, sfx: "tick" }, { at: E.claude.toolDone, sfx: "hit", volume: 0.24 }, { at: E.claude.toolDone + 14, sfx: "chime", volume: 0.2 }],
      caps: [cap("m-claude-1", esC1), cap("m-claude-2", esC2, ["brain"])] },
    { kind: "panel", name: "Brain", chapter: "El brain", panel: "brain", note: "La página que guardó Claude, redibujada",
      beats: fit(E.brain.read + 30, esBrain), vo: [esBrain],
      cues: [{ at: E.brain.add, sfx: "tick", volume: 0.16 }, { at: E.brain.read + 2, sfx: "whoosh", volume: 0.14 }],
      caps: [cap("m-brain", esBrain, ["Cualquier", "agente"])] },
    { kind: "panel", name: "ChatGPT", chapter: "En ChatGPT", panel: "chatgpt", note: "Corrida real en Codex, el agente de OpenAI · redibujado como ChatGPT",
      beats: fit(E.chatgpt.hl + 66, esG1, esG2, esG3), vo: [esG1, esG2, esG3],
      cues: [{ at: E.chatgpt.send, sfx: "tick" }, { at: E.chatgpt.toolDone, sfx: "tick", volume: 0.16 }, { at: E.chatgpt.hl, sfx: "hit" }, { at: E.chatgpt.hl + 18, sfx: "chime" }],
      caps: [cap("m-gpt-1", esG1), cap("m-gpt-2", esG2), cap("m-gpt-3", esG3, ["Nadie"])] },
    { kind: "end", name: "End", beats: fit(0, esEnd), line1: "Le contás a uno. Lo saben todos.", line2: "brain.mcpbox.dev",
      note: "Datos inventados · voz generada con IA", vo: [esEnd] },
  ],
};

const hTitle = vo("h-title", 8);
const h1 = vo("h-1", 4);
const h2 = vo("h-2", 4);
const h3 = vo("h-3", 4);
const h4 = vo("h-4", 4);
const hEnd = vo("h-end", 12);

export const HOWTO_ES: FilmCut = {
  id: "Brain-Agents-HowTo-ES-16x9", bed: "audio/brain-agents-howto-es-bed.wav", key: "D", clips: {},
  scenes: [
    { kind: "title", name: "Title", beats: fit(72, hTitle), headline: "Cómo empezar.", highlight: ["empezar"], sub: "Cuatro pasos. Sin código.", vo: [hTitle] },
    { kind: "panel", name: "Link", chapter: "Paso 1", panel: "stepLink", beats: fit(90, h1), vo: [h1], cues: [{ at: 46, sfx: "tick" }, { at: 50, sfx: "chime", volume: 0.16 }], caps: [] },
    { kind: "panel", name: "Connect", chapter: "Paso 2", panel: "stepConnect", beats: fit(108, h2), vo: [h2], note: "Redibujado de las apps reales", cues: [{ at: 4, sfx: "tick", volume: 0.14 }, { at: 24, sfx: "tick", volume: 0.14 }], caps: [] },
    { kind: "panel", name: "Sign in", chapter: "Paso 3", panel: "stepSignIn", beats: fit(90, h3), vo: [h3], note: "Redibujado de la página real de inicio de sesión", cues: [{ at: 50, sfx: "tick" }, { at: 56, sfx: "hit", volume: 0.2 }], caps: [] },
    { kind: "panel", name: "Use", chapter: "Paso 4", panel: "stepUse", beats: fit(108, h4), vo: [h4], note: "Líneas de la corrida real",
      cues: [{ at: 20, sfx: "tick", volume: 0.16 }, { at: 46, sfx: "chime", volume: 0.18 }], caps: [] },
    { kind: "end", name: "End", beats: fit(90, hEnd), line1: "Y listo.", line2: "brain.mcpbox.dev/mcp", note: "Voz generada con IA", vo: [hEnd] },
  ],
};

export const SOCIAL = HOWTO; // film-plan.mjs reads every exported cut

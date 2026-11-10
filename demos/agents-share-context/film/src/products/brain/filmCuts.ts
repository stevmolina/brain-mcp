import type { FilmCut } from "../../kit/film/timeline";
import { CHATGPT_RUN, CLAUDE_RUN, NOTE } from "./run";

// "Agents share context": Claude settles something, ChatGPT picks it up, because both read the
// same Agent Brain. Plain data (scene frames), read by Film.tsx, panels.tsx and film-plan.mjs.
// The apps are motion-design recreations of a real run (run/), so every scene carries a note tag.

const typeFrames = (s: string, cpf = 2.4) => Math.ceil(s.length / cpf);
const words = (s: string) => s.split(" ").length;

const cType = 12;
const cSend = cType + typeFrames(CLAUDE_RUN.prompt) + 6;
const cTool = cSend + 10;
const cDone = cTool + 24;
const cReply = cDone + 8;

const gType = 14;
const gSend = gType + typeFrames(CHATGPT_RUN.prompt) + 6;
const gTool = gSend + 8;
const gDone = gTool + 22;
const gReply = gDone + 6;
const gCard = gReply;
const gWritten = gCard + 6 + Math.ceil((words(CHATGPT_RUN.subject) + CHATGPT_RUN.body.reduce((n, l) => n + words(l), 0)) / 0.9) + 4 * (CHATGPT_RUN.body.length + 1);
const gHl = gWritten + 4;

export const T = {
  claude: { type: cType, send: cSend, tool: cTool, toolDone: cDone, reply: cReply },
  brain: { add: 16, read: 16 + Math.ceil(NOTE.added.length / 2.6) + 22 },
  chatgpt: { type: gType, send: gSend, tool: gTool, toolDone: gDone, reply: gReply, card: gCard, hl: gHl },
};

const beatsFor = (frames: number) => Math.ceil(frames / 18);
const NOTE_TAG = "Recreated from a real run · waits shortened";

export const MAIN: FilmCut = {
  id: "Brain-Agents-Main-16x9", bed: "audio/brain-agents-main-bed.wav", key: "G", clips: {},
  scenes: [
    { kind: "title", name: "Title", beats: 4, headline: "Tell Claude. ChatGPT already knows.", highlight: ["knows"],
      sub: "Agent Brain is one memory every AI app can read." },
    { kind: "panel", name: "Claude", chapter: "In Claude", panel: "claude", note: NOTE_TAG,
      beats: beatsFor(cReply + Math.ceil(words(CLAUDE_RUN.reply) / 0.75) + 40),
      cues: [{ at: cSend, sfx: "tick" }, { at: cDone, sfx: "hit", volume: 0.24 }, { at: cDone + 14, sfx: "chime", volume: 0.2 }],
      caps: [
        { from: 6, to: cSend + 4, text: "Settle something in Claude." },
        { from: cDone - 4, to: cDone + 70, text: "It saves it to your team's brain.", highlight: ["brain."] },
      ] },
    { kind: "panel", name: "Brain", chapter: "The brain", panel: "brain", note: "The page Claude committed, redrawn",
      beats: 6,
      cues: [{ at: 16, sfx: "tick", volume: 0.16 }, { at: T.brain.read + 2, sfx: "whoosh", volume: 0.14 }],
      caps: [{ from: 6, to: 104, text: "A plain note in a git repo. Any agent can read it.", highlight: ["Any", "agent"] }] },
    { kind: "panel", name: "ChatGPT", chapter: "In ChatGPT", panel: "chatgpt", note: "Real run in Codex, OpenAI's agent · redrawn as ChatGPT",
      beats: beatsFor(gHl + 66),
      cues: [{ at: gSend, sfx: "tick" }, { at: gDone, sfx: "tick", volume: 0.16 }, { at: gHl, sfx: "hit" }, { at: gHl + 18, sfx: "chime" }],
      caps: [
        { from: 6, to: gSend + 4, text: "Later, in ChatGPT." },
        { from: gDone - 4, to: gCard + 20, text: "It checks the brain on its own." },
        { from: gHl - 6, to: gHl + 64, text: "Same facts. Nobody pasted anything.", highlight: ["Nobody"] },
      ] },
    { kind: "end", name: "End", beats: 5, line1: "Tell one agent. They all know.", line2: "brain.mcpbox.dev" },
  ],
};

export const HOWTO: FilmCut = {
  id: "Brain-Agents-HowTo-16x9", bed: "audio/brain-agents-howto-bed.wav", key: "D", clips: {},
  scenes: [
    { kind: "title", name: "Title", beats: 4, headline: "How to start.", highlight: ["start"], sub: "Four steps. No code." },
    { kind: "panel", name: "Link", chapter: "Step 1", panel: "stepLink", beats: 5, cues: [{ at: 46, sfx: "tick" }, { at: 50, sfx: "chime", volume: 0.16 }], caps: [] },
    { kind: "panel", name: "Connect", chapter: "Step 2", panel: "stepConnect", beats: 6, cues: [{ at: 4, sfx: "tick", volume: 0.14 }, { at: 24, sfx: "tick", volume: 0.14 }], caps: [] },
    { kind: "panel", name: "Sign in", chapter: "Step 3", panel: "stepSignIn", beats: 5, cues: [{ at: 50, sfx: "tick" }, { at: 56, sfx: "hit", volume: 0.2 }], caps: [] },
    { kind: "panel", name: "Use", chapter: "Step 4", panel: "stepUse", beats: 6, note: "Lines from the real run",
      cues: [{ at: 20, sfx: "tick", volume: 0.16 }, { at: 46, sfx: "chime", volume: 0.18 }], caps: [] },
    { kind: "end", name: "End", beats: 5, line1: "That's it.", line2: "brain.mcpbox.dev/mcp" },
  ],
};

export const SOCIAL = HOWTO; // film-plan.mjs reads MAIN and SOCIAL

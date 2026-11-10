import type { ShotMeta, ZoomKey } from "../../kit/shot-meta";
import type { FilmClip, FilmCut } from "../../kit/film/timeline";
import listMeta from "../../../public/footage/chats/list.json";
import shareMeta from "../../../public/footage/chats/share.json";
import openMeta from "../../../public/footage/chats/open.json";
import revokeMeta from "../../../public/footage/chats/revoke.json";
import goneMeta from "../../../public/footage/chats/gone.json";

// "Your chats in Agent Brain". Plain data: scenes, camera keys (footage px, source frames),
// captions (scene frames) and callouts on exact on-screen text. Read by Film.tsx and
// scripts/film-plan.mjs. Footage: the live site, a demo account, invented chats (seed/).
const LI = listMeta as unknown as ShotMeta;
const SH = shareMeta as unknown as ShotMeta;
const OP = openMeta as unknown as ShotMeta;
const RV = revokeMeta as unknown as ShotMeta;
const GO = goneMeta as unknown as ShotMeta;
const z = (frame: number, cx: number, cy: number, scale: number): ZoomKey => ({ frame, cx, cy, scale });
const FOOT = "footage/chats";

const clips: Record<string, FilmClip> = {
  list: { src: `${FOOT}/list.mp4`, meta: LI,
    wide: [z(0, 800, 450, 1.04), z(100, 800, 420, 1.1), z(240, 800, 470, 1.1)] },
  share: { src: `${FOOT}/share.mp4`, meta: SH,
    wide: [
      z(0, 800, 300, 1.3), z(90, 800, 300, 1.3), z(150, 760, 330, 1.25), z(250, 800, 420, 1.12), z(330, 800, 450, 1),
      z(372, 800, 450, 1), z(398, 540, 360, 1.5), z(560, 540, 380, 1.5), z(640, 540, 450, 1.5), z(700, 540, 500, 1.5), z(839, 540, 500, 1.5),
    ] },
  open: { src: `${FOOT}/open.mp4`, meta: OP,
    wide: [z(0, 800, 330, 1.3), z(100, 800, 330, 1.3), z(214, 800, 330, 1.3), z(300, 800, 360, 1.36)] },
  revoke: { src: `${FOOT}/revoke.mp4`, meta: RV,
    wide: [z(150, 760, 300, 1.35), z(215, 700, 270, 1.5), z(330, 700, 270, 1.5)] },
  gone: { src: `${FOOT}/gone.mp4`, meta: GO,
    wide: [z(0, 800, 300, 1.4), z(273, 800, 300, 1.45)] },
};

const SRC = "From the captured page · invented chats";
const MAYA = "Agent Brain  ·  Maya's chats  ·  demo account, invented chats";
const LEO = "Agent Brain  ·  signed in as Leo  ·  demo account";

export const MAIN: FilmCut = {
  id: "Brain-Chats-Main-16x9", bed: "audio/brain-chats-main-bed.wav", key: "F", clips,
  scenes: [
    { kind: "title", name: "Title", beats: 6, headline: "Every AI chat you ever had, in one private place.", highlight: ["private"],
      sub: "Search them all. Share just the part that matters. Take it back anytime." },
    { kind: "shot", name: "All chats", chapter: "All your chats", window: MAYA,
      segs: [{ clip: "list", from: 40, to: 240 }],
      caps: [
        { from: 6, to: 94, text: "Claude Code, Codex, Cursor, ChatGPT, Grok: one list." },
        { from: 100, to: 194, text: "Each chat is tagged by client, and private to you.", highlight: ["private"] },
      ] },
    { kind: "shot", name: "Search", chapter: "Find it", window: MAYA,
      segs: [{ clip: "share", from: 30, to: 340, rate: 1.25 }],
      focus: [{ clip: "share", mark: SH.marks["safari-card"], from: 206, to: 252, pad: 6 }],
      caps: [
        { from: 4, to: 100, text: "Search every chat at once." },
        { from: 106, to: 170, text: "Filter to one client: Acme.", highlight: ["Acme."] },
        { from: 176, to: 248, text: "Open the one you need." },
      ] },
    { kind: "shot", name: "Share", chapter: "Share a part", window: MAYA,
      segs: [{ clip: "share", from: 345, to: 800, rate: 1.5 }],
      focus: [
        { clip: "share", mark: SH.marks["preview-box"], from: 630, to: 688, pad: 8 },
        { clip: "share", mark: SH.marks["done-box"], from: 728, to: 804, pad: 8,
          callout: { label: "Shared", value: "Send them this link.", note: "Only leo@example.com can open it, after signing in.", source: SRC, quote: true, side: "right", cardWidth: 560 } },
      ],
      caps: [
        { from: 4, to: 100, text: "Share turns 1 to 2 with a teammate, by email." },
        { from: 106, to: 182, text: "Add a note so they know why." },
        { from: 188, to: 248, text: "Preview exactly what they will get.", highlight: ["Preview"] },
        { from: 254, to: 302, text: "Shared. One link, one person." },
      ] },
    { kind: "shot", name: "Teammate", chapter: "Their view", window: LEO,
      segs: [{ clip: "open", from: 0, to: 100 }, { clip: "open", from: 214, to: 330, note: "Loading wait cut" }],
      focus: [{ clip: "open", mark: OP.marks.banner, from: 228, to: 326, pad: 8,
        callout: { label: "What Leo sees", value: "turns 1 to 2 of 8. Read only.", note: "Only the part Maya picked. Nothing else of hers.", source: SRC, quote: true, side: "below", cardWidth: 620 } }],
      caps: [
        { from: 4, to: 94, text: "Leo signs in. It waits under Shared with me." },
        { from: 100, to: 212, text: "He reads two turns, not the whole chat.", highlight: ["two", "turns,"] },
      ] },
    { kind: "shot", name: "Revoke", chapter: "Take it back", window: "Agent Brain  ·  My shares, then Leo's link  ·  demo account",
      segs: [{ clip: "revoke", from: 150, to: 330 }, { clip: "gone", from: 0, to: 60, note: "Leo's view, right after" }],
      focus: [
        { clip: "revoke", mark: RV.marks.revoked, from: 240, to: 326, pad: 8,
          callout: { label: "Status", value: "revoked", note: "The link stops working right away.", source: SRC, side: "right", cardWidth: 460 } },
        { clip: "gone", mark: GO.marks["not-available"], from: 4, to: 56, pad: 8 },
      ],
      caps: [
        { from: 4, to: 72, text: "Changed your mind? Revoke it." },
        { from: 182, to: 230, text: "Gone for Leo, at once.", highlight: ["Gone"] },
      ] },
    { kind: "end", name: "End", beats: 6, line1: "Your chats. Your call.", line2: "brain.mcpbox.dev/sessions" },
  ],
};

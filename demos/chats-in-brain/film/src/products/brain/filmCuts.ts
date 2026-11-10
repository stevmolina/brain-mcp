import type { ShotMeta, ZoomKey } from "../../kit/shot-meta";
import type { FilmClip, FilmCut } from "../../kit/film/timeline";
import shareMeta from "../../../public/footage/chats/share.json";
import openMeta from "../../../public/footage/chats/open.json";
import revokeMeta from "../../../public/footage/chats/revoke.json";
import goneMeta from "../../../public/footage/chats/gone.json";

// "Your chats in Agent Brain". Plain data: scenes, camera keys (footage px, source frames),
// captions (scene frames) and callouts on exact on-screen text. Read by Film.tsx and
// scripts/film-plan.mjs. Footage: the live site, two demo users, invented chats (seed/),
// captured by scripts/capture.mjs. The camera follows the cursor: it punches in on each action.
const SH = shareMeta as unknown as ShotMeta;
const OP = openMeta as unknown as ShotMeta;
const RV = revokeMeta as unknown as ShotMeta;
const GO = goneMeta as unknown as ShotMeta;
const z = (frame: number, cx: number, cy: number, scale: number): ZoomKey => ({ frame, cx, cy, scale });
const FOOT = "footage/chats";

const clips: Record<string, FilmClip> = {
  share: { src: `${FOOT}/share.mp4`, meta: SH,
    wide: [
      // the whole list, then into the search box as the cursor arrives
      z(0, 800, 450, 1), z(40, 800, 420, 1.12), z(62, 560, 250, 1.85), z(88, 560, 250, 1.85),
      // results with their highlights, then the client filter, then the chat opening
      z(102, 760, 330, 1.35), z(128, 600, 260, 1.7), z(160, 640, 320, 1.55), z(196, 800, 420, 1.2), z(222, 820, 400, 1.3),
      // the share dialog: fields, preview, then the link
      z(256, 700, 380, 1.45), z(272, 470, 300, 1.9), z(410, 470, 320, 1.85), z(436, 470, 430, 1.6), z(496, 470, 450, 1.6), z(512, 470, 560, 1.7), z(589, 470, 560, 1.72),
    ] },
  open: { src: `${FOOT}/open.mp4`, meta: OP,
    wide: [z(0, 620, 230, 1.75), z(52, 620, 220, 1.8), z(84, 800, 300, 1.45), z(120, 800, 300, 1.55), z(224, 800, 300, 1.62)] },
  revoke: { src: `${FOOT}/revoke.mp4`, meta: RV,
    wide: [z(0, 640, 250, 1.6), z(40, 520, 245, 1.95), z(80, 560, 245, 1.95), z(163, 580, 245, 2.0)] },
  gone: { src: `${FOOT}/gone.mp4`, meta: GO,
    wide: [z(0, 800, 260, 1.5), z(127, 800, 250, 1.7)] },
};

const SRC = "From the captured page · invented chats";
const MAYA = "Agent Brain  ·  Maya's chats  ·  demo account, invented chats";
const LEO = "Agent Brain  ·  signed in as Leo  ·  demo account";

export const MAIN: FilmCut = {
  id: "Brain-Chats-Main-16x9", bed: "audio/brain-chats-main-bed.wav", key: "F", clips,
  scenes: [
    { kind: "title", name: "Title", beats: 5, headline: "Every AI chat you ever had. One private place.", highlight: ["private"],
      sub: "Search them. Share a part. Take it back." },
    { kind: "shot", name: "Find", chapter: "Find it", window: MAYA,
      segs: [{ clip: "share", from: 0, to: 215, rate: 1.2 }],
      caps: [
        { from: 4, to: 62, text: "Every chat from every AI tool, in one place." },
        { from: 66, to: 112, text: "Search them all at once." },
        { from: 116, to: 176, text: "Filter by client. Open one.", highlight: ["client."] },
      ] },
    { kind: "shot", name: "Share", chapter: "Share a part", window: MAYA,
      segs: [{ clip: "share", from: 215, to: 580, rate: 1.35 }],
      focus: [
        { clip: "share", mark: SH.marks["preview-box"], from: 438, to: 496, pad: 8 },
        { clip: "share", mark: SH.marks["done-box"], from: 516, to: 580, pad: 8,
          callout: { label: "Shared", value: "Send them this link.", note: "Only leo@example.com can open it, after signing in.", source: SRC, quote: true, side: "right", cardWidth: 560 } },
      ],
      caps: [
        { from: 4, to: 100, text: "Share turns 1 to 2 with a teammate." },
        { from: 104, to: 156, text: "Add a note so they know why." },
        { from: 160, to: 208, text: "Preview exactly what they get.", highlight: ["Preview"] },
        { from: 220, to: 266, text: "One link, one person." },
      ] },
    { kind: "shot", name: "Teammate", chapter: "Their view", window: LEO,
      segs: [{ clip: "open", from: 10, to: 224 }],
      focus: [{ clip: "open", mark: OP.marks.banner, from: 98, to: 206, pad: 8,
        callout: { label: "What Leo sees", value: "turns 1 to 2 of 8. Read only.", note: "Only the part Maya picked. Nothing else of hers.", source: SRC, quote: true, side: "below", cardWidth: 620 } }],
      caps: [
        { from: 4, to: 78, text: "Leo signs in. One chat is waiting." },
        { from: 86, to: 194, text: "Two turns. Read only.", highlight: ["Two", "turns."] },
      ] },
    { kind: "shot", name: "Revoke", chapter: "Take it back", window: "Agent Brain  ·  Maya's shares, then Leo's link  ·  demo account",
      segs: [{ clip: "revoke", from: 12, to: 140 }, { clip: "gone", from: 44, to: 114, note: "Leo's view, right after" }],
      focus: [
        { clip: "revoke", mark: RV.marks.revoked, from: 82, to: 138, pad: 8,
          callout: { label: "Status", value: "revoked", note: "The link stops working right away.", source: SRC, side: "right", cardWidth: 460 } },
        { clip: "gone", mark: GO.marks["not-available"], from: 46, to: 108, pad: 8 },
      ],
      caps: [
        { from: 4, to: 62, text: "Changed your mind? Revoke it." },
        { from: 132, to: 194, text: "Gone for Leo. Right away.", highlight: ["Gone"] },
      ] },
    { kind: "end", name: "End", beats: 5, line1: "Your chats. Your call.", line2: "brain.mcpbox.dev/sessions" },
  ],
};

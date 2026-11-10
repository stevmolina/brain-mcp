// Records the live sessions pages for the film, at full quality.
//   node scripts/capture.mjs <cookies.json> <out dir>   (from film/)
// cookies.json: {"maya": "<bm_session value>", "leo": "<bm_session value>"}, signed with the
// server's WEB_SESSION_SECRET for two demo users. The values never reach the footage.
//
// Each clip is a CDP screencast of a 1600x900 page at 2x pixels: Chrome sends a JPEG on every
// repaint, with its wall-clock time. Real mouse moves, clicks and typing drive the page, and
// every action is logged with its time and the element's box, for the film's cursor overlay.
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const [cookieFile, outDir] = process.argv.slice(2);
const cookies = JSON.parse(readFileSync(cookieFile, "utf8"));
const ORIGIN = "https://brain.mcpbox.dev";
const CHROME = process.env.CHROME ?? path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function signedIn(who) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  await context.addCookies([{ name: "bm_session", value: cookies[who], domain: "brain.mcpbox.dev", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  return page;
}

class Clip {
  constructor(page, name) { this.page = page; this.name = name; this.events = []; this.frames = []; this.dir = path.join(outDir, name, "frames"); mkdirSync(this.dir, { recursive: true }); this.mouse = { x: 1500, y: 850 }; }
  async start() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", async (f) => {
      const file = `${String(this.frames.length).padStart(5, "0")}.jpg`;
      writeFileSync(path.join(this.dir, file), Buffer.from(f.data, "base64"));
      this.frames.push({ t: f.metadata.timestamp * 1000, file });
      await this.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 94, maxWidth: 3200, maxHeight: 1800, everyNthFrame: 1 });
    // Keep the compositor producing frames even when nothing moves, so a still screen is still recorded.
    await this.page.evaluate(() => { const k = document.createElement("div"); k.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;pointer-events:none;z-index:9999"; document.body.appendChild(k); let n = 0; const t = () => { k.style.background = ++n % 2 ? "rgba(255,255,255,0.01)" : "rgba(255,255,255,0.02)"; requestAnimationFrame(t); }; requestAnimationFrame(t); });
    this.startAt = Date.now();
    await sleep(150);
  }
  async box(sel) { const b = await this.page.locator(sel).first().boundingBox(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; }
  log(kind, name, box = {}) { this.events.push({ at: Date.now(), kind, name, ...box }); }
  async mark(name, sel) { this.log("mark", name, await this.box(sel)); }
  // A human-paced move: eased, about 450 ms, so hover states change as they would.
  async moveTo(sel, name, { dx, dy } = {}) {
    const b = await this.box(sel);
    const x = b.x + (dx ?? Math.min(b.w / 2, 170)), y = b.y + (dy ?? Math.min(b.h / 2, 30));
    this.log("move", name, b);
    const from = { ...this.mouse }, steps = 18;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      await this.page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      await sleep(24);
    }
    this.mouse = { x, y };
    return b;
  }
  async click(sel, name, opts) { const b = await this.moveTo(sel, name, opts); await sleep(60); this.log("click", name, b); await this.page.mouse.down(); await this.page.mouse.up(); }
  async type(sel, text, name, delay = 40) { await this.click(sel, name); await this.page.keyboard.type(text, { delay }); }
  async stop() {
    await sleep(300);
    await this.cdp.send("Page.stopScreencast");
    await sleep(300);
    const out = { name: this.name, start: this.startAt, end: Date.now(), viewport: { width: 1600, height: 900 }, frames: this.frames, events: this.events };
    writeFileSync(path.join(outDir, this.name, "clip.json"), JSON.stringify(out, null, 1));
    console.log(`${this.name}: ${this.frames.length} frames over ${((out.end - out.start) / 1000).toFixed(1)} s, ${this.events.length} events`);
  }
}

// ---------------------------------------------------------------- Maya: find a chat and share part of it
const maya = await signedIn("maya");
await maya.goto(`${ORIGIN}/sessions`);
await maya.locator("#results .card").nth(9).waitFor();
await maya.locator("#f-brain option").nth(3).waitFor({ state: "attached" });
let c = new Clip(maya, "share");
await c.start();
await c.mark("list", "#results");
await sleep(1400);
await c.type("#q", "checkout", "search", 55);
await maya.waitForFunction(() => document.querySelectorAll("#results .card").length === 6 && document.querySelector("#results .snippet b"));
c.log("mark", "results", await c.box("#results"));
await sleep(900);
await c.click("#f-brain", "client", { dx: 75, dy: 18 });
await maya.selectOption("#f-brain", "acme/acme-knowledge");
await maya.waitForFunction(() => document.querySelectorAll("#results .card").length === 5);
await sleep(800);
await c.click("#results .card:has-text('Safari')", "open");
await maya.locator("#detail h2").waitFor();
await sleep(150);
await c.mark("detail", "#detail");
await sleep(900);
await c.click("#detail [data-act=share]", "share-button", { dx: 70, dy: 21 });
await maya.locator("#share-dialog[open]").waitFor();
await sleep(350);
await c.type("#s-with", "leo@example.com", "email", 38);
await c.type("#s-from", "1", "from");
await c.type("#s-to", "2", "to");
await c.type("#s-note", "The Safari fix, for the release notes", "note", 22);
await sleep(250);
await c.click("#s-preview-btn", "preview", { dx: 45, dy: 21 });
await maya.locator("#s-preview").waitFor({ state: "visible" });
await sleep(100);
await c.mark("preview-box", "#s-preview");
await sleep(1500);
await c.click("#s-confirm", "confirm", { dx: 37, dy: 21 });
await maya.locator("#s-done").waitFor({ state: "visible" });
await sleep(100);
await c.mark("done-box", "#s-done");
await sleep(2000);
await c.stop();
const link = await maya.locator("#s-link").inputValue();

// ---------------------------------------------------------------- Leo: what the teammate sees
const leo = await signedIn("leo");
await leo.goto(`${ORIGIN}/sessions#shared`);
await leo.locator("#shared-list .card").first().waitFor();
c = new Clip(leo, "open");
await c.start();
await c.mark("shared-list", "#view-shared");
await sleep(1100);
await c.click("#shared-list .card", "open-shared");
await leo.locator("#share-detail .banner").waitFor();
await sleep(150);
await c.mark("banner", "#share-detail .banner");
await c.mark("chat", "#share-detail");
await sleep(600);
await c.moveTo("#share-detail .banner", "banner", { dx: 420, dy: 20 });
await sleep(2600);
await c.stop();

// ---------------------------------------------------------------- Maya: take it back
await maya.goto(`${ORIGIN}/sessions#shares`);
await maya.reload(); // a hash change alone keeps the share dialog open
await maya.locator("[data-revoke]").waitFor();
c = new Clip(maya, "revoke");
await c.start();
await c.mark("share-card", "#shares-list .card");
await sleep(900);
await c.click("[data-revoke]", "revoke", { dx: 35, dy: 15 });
await maya.locator("#shares-list .status-revoked").waitFor();
await sleep(100);
await c.mark("revoked", "#shares-list .status-revoked");
await sleep(2200);
await c.stop();

// ---------------------------------------------------------------- Leo: the link now
c = new Clip(leo, "gone");
await c.start();
await sleep(500);
c.log("mark", "reload", {});
await leo.reload();
await leo.getByText("This chat is not available").waitFor();
await sleep(100);
await c.mark("not-available", "#share-detail");
await sleep(2200);
await c.stop();

writeFileSync(path.join(outDir, "share-link.txt"), link + "\n");
await browser.close();

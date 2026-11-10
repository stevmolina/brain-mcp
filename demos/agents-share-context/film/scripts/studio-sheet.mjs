// Contact sheet of a composition, taken from the running Remotion Studio (no render process).
//   node scripts/studio-sheet.mjs <composition-id> <out.png> <frame,frame,...> [port=42600] [cols=4]
// Each frame is seeked in Studio, screenshotted from the preview, labelled and tiled with ffmpeg.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [id, out, framesArg, port = "42600", cols = "4"] = process.argv.slice(2);
if (!id || !out || !framesArg) {
  console.error("usage: node scripts/studio-sheet.mjs <composition-id> <out.png> <f1,f2,...> [port] [cols]");
  process.exit(2);
}
const frames = framesArg.split(",").map(Number);
const dir = mkdtempSync(path.join(tmpdir(), "studio-sheet-"));
// Uses whichever headless shell is on the machine (PLAYWRIGHT_CHROMIUM overrides).
const shell = process.env.PLAYWRIGHT_CHROMIUM ?? (() => { const base = path.join(process.env.HOME, ".cache/ms-playwright"); const d = readdirSync(base).filter((x) => x.startsWith("chromium_headless_shell-")).sort().pop(); return d && path.join(base, d, "chrome-headless-shell-linux64/chrome-headless-shell"); })();
const browser = await chromium.launch({ executablePath: shell || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage({ viewport: { width: 2200, height: 1500 } });
  await page.goto(`http://127.0.0.1:${port}/${id}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => typeof window.remotion_setFrame === "function", null, { timeout: 60000 });
  for (const label of ["Collapse left sidebar", "Collapse right sidebar"]) await page.locator(`[aria-label="${label}"]`).click().catch(() => {});
  await page.waitForTimeout(800);
  const files = [];
  let box = null;
  for (const f of frames) {
    await page.evaluate(([frame, comp]) => window.remotion_setFrame(frame, comp), [f, id]);
    await page.waitForTimeout(Number(process.env.SHEET_WAIT ?? 1500));
    // Measure the preview once (on the first frame) and reuse it: inner layers can share its ratio.
    box ??= await page.evaluate(() => {
      let best = null;
      for (const el of document.querySelectorAll("div")) {
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.top < 40 || r.top > 400) continue;
        const ratio = r.width / r.height;
        if ((Math.abs(ratio - 16 / 9) < 0.01 || Math.abs(ratio - 9 / 16) < 0.01) && (!best || r.width * r.height > best.width * best.height)) best = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
      return best;
    });
    const file = path.join(dir, `${String(f).padStart(5, "0")}.png`);
    await page.screenshot({ path: file, clip: box });
    files.push({ f, file });
  }
  const tall = files.length && execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", files[0].file]).toString().trim().split(",").map(Number);
  const w = tall && tall[1] > tall[0] ? 360 : 640;
  const labelled = files.map(({ f, file }) => {
    const o = file.replace(".png", "-l.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `scale=${w}:-2,drawbox=x=0:y=0:w=110:h=34:color=black@0.7:t=fill,drawtext=text='${f}':x=10:y=7:fontsize=22:fontcolor=white`, o]);
    return o;
  });
  const c = Math.min(Number(cols), labelled.length);
  const rows = Math.ceil(labelled.length / c);
  const inputs = labelled.flatMap((l) => ["-i", l]);
  const pads = Array.from({ length: c * rows - labelled.length }, () => null);
  const layout = Array.from({ length: c * rows }, (_, i) => `${(i % c) === 0 ? "0" : Array.from({ length: i % c }, (_, j) => `w${j}`).join("+")}_${Math.floor(i / c) === 0 ? "0" : Array.from({ length: Math.floor(i / c) }, (_, j) => `h${j * c}`).join("+")}`);
  const n = labelled.length;
  const filter = `${labelled.map((_, i) => `[${i}:v]`).join("")}xstack=inputs=${n}:layout=${layout.slice(0, n).join("|")}:fill=black[v]`;
  void pads;
  if (n === 1) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", labelled[0], out]);
  else execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[v]", out]);
  console.log(`${out} (${n} frames)`);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

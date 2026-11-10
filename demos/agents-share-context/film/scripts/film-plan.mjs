// Prints the timing plan of every product film (frames, seconds, music drop and outro) from the
// same scene data the compositions use, so each music bed is cut to its film.
//   node scripts/film-plan.mjs            -> JSON
//   node scripts/film-plan.mjs --beds     -> one make_audio.py command per bed
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const pnpmDir = path.join(root, "node_modules/.pnpm");
const esbuildDir = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
const esbuild = require(path.join(pnpmDir, esbuildDir, "node_modules/esbuild"));

const products = ["brain"].filter((p) => existsSync(path.join(root, `src/products/${p}/filmCuts.ts`)));
const entry = [
  `import { planCut } from "./src/kit/film/timeline";`,
  ...products.map((p, i) => `import * as c${i} from "./src/products/${p}/filmCuts";`),
  `const all = { ${products.map((p, i) => `${p}: c${i}`).join(", ")} };`,
  `const out = [];`,
  `for (const [product, mod] of Object.entries(all)) for (const cut of [...new Set(Object.values(mod).filter((c) => c && c.id && c.scenes))]) {`,
  `  if (!cut) continue; const p = planCut(cut);`,
  `  out.push({ product, id: cut.id, frames: p.total, ...p.music, ducks: p.ducks, scenes: p.placed.map((s) => ({ name: s.scene.name, start: s.start, frames: s.frames })) });`,
  `}`,
  `console.log(JSON.stringify(out));`,
].join("\n");

const built = await esbuild.build({ stdin: { contents: entry, resolveDir: root, loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs", logLevel: "error" });
const lines = [];
const orig = console.log;
console.log = (s) => lines.push(s);
new Function("require", "module", built.outputFiles[0].text)(require, { exports: {} });
console.log = orig;
const plans = JSON.parse(lines[0]);

if (process.argv.includes("--beds")) {
  for (const p of plans) {
    console.log(`uv run --with numpy --with scipy python scripts/make_audio.py bed --out public/${p.bed} --seconds ${p.seconds.toFixed(3)} --drop ${p.drop.toFixed(3)} --outro ${p.outro.toFixed(3)} --key ${p.key}`);
  }
} else {
  console.log(JSON.stringify(plans, null, 1));
}

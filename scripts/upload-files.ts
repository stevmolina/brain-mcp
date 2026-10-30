/**
 * Uploads a local folder into a brain's private file space in R2.
 *
 *   pnpm upload-files <brain id> <local dir>
 *
 * Add-only, like the add_file tool: a path that already exists in the bucket is
 * skipped, never overwritten. Hidden files (names starting with ".") are left
 * out. Ends with a count of what it added, skipped and refused.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { closeDb } from '../src/db/client.js';
import { getBrain } from '../src/auth/access.js';
import { loadR2Config, R2_ENV } from '../src/config.js';
import { BrainFiles, r2Client } from '../src/files/store.js';
import { validatePath } from '../src/files/paths.js';

const [brainId, localDir] = process.argv.slice(2);
if (!brainId || !localDir) {
  console.error('usage: pnpm upload-files <brain id> <local dir>');
  process.exit(1);
}

const r2 = loadR2Config();
if (!r2) {
  console.error(`R2 is not configured. Set ${R2_ENV.join(', ')}.`);
  process.exit(1);
}

// A typo in the brain id would otherwise leave files no brain can reach.
const brain = await getBrain(brainId);
await closeDb();
if (!brain) {
  console.error(`No brain "${brainId}" is registered.`);
  process.exit(1);
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

const files = new BrainFiles(r2Client(r2), r2.bucket);
const root = path.resolve(localDir);
const counts = { added: 0, skipped: 0, refused: 0 };

for await (const full of walk(root)) {
  const relative = path.relative(root, full).split(path.sep).join('/');
  try {
    validatePath(relative);
    if (await files.stat(brain.id, relative)) {
      counts.skipped += 1;
      console.log(`skip   ${relative} (already there)`);
      continue;
    }
    const outcome = await files.putNew(brain.id, relative, await readFile(full));
    counts[outcome === 'stored' ? 'added' : 'skipped'] += 1;
    console.log(`${outcome === 'stored' ? 'add   ' : 'skip  '} ${relative}`);
  } catch (error) {
    counts.refused += 1;
    console.error(`refuse ${relative}: ${(error as Error).message}`);
  }
}

console.log(
  `\n${brain.id}: ${counts.added} added, ${counts.skipped} skipped (already there), ${counts.refused} refused.`,
);
if (counts.refused) process.exit(1);

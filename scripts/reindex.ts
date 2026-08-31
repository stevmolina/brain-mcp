/** Full rebuild of one brain, or every brain, from the current default branch.
 *   pnpm reindex [<brain id>] */
import { db, closeDb } from '../src/db/client.js';
import { installationOctokit } from '../src/github/app.js';
import { resolveCommit } from '../src/github/repo.js';
import { indexBrainAtCommit } from '../src/indexer/sync.js';
import type { BrainRow } from '../src/types.js';

const brainId = process.argv[2];
const { rows } = brainId
  ? await db().query<BrainRow>('select * from brains where id = $1', [brainId])
  : await db().query<BrainRow>('select * from brains order by id');

if (!rows.length) {
  console.error(brainId ? `no brain ${brainId}` : 'no brains registered');
  await closeDb();
  process.exit(1);
}

for (const brain of rows) {
  const octokit = await installationOctokit(brain.installation_id!);
  const commit = await resolveCommit(octokit, brain.repo_owner, brain.repo_name, brain.default_branch);
  console.log(JSON.stringify(await indexBrainAtCommit(brain, commit)));
}
await closeDb();

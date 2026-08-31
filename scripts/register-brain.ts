/**
 * Registers a git repo as a brain and indexes it once.
 *
 *   pnpm register-brain <owner/repo> --workos-user <id> [--id <brain id>] [--branch <name>]
 *
 * The App must already be installed on the repo; this looks the installation up
 * rather than asking for it.
 */
import { db, closeDb } from '../src/db/client.js';
import { defaultBranch, resolveCommit } from '../src/github/repo.js';
import { findInstallationId, installationOctokit } from '../src/github/app.js';
import { indexBrainAtCommit } from '../src/indexer/sync.js';
import type { BrainRow } from '../src/types.js';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const slug = process.argv[2];
if (!slug || !slug.includes('/')) {
  console.error('usage: pnpm register-brain <owner/repo> --workos-user <id> [--id <brain id>] [--branch <name>]');
  process.exit(1);
}

const [owner, repo] = slug.split('/') as [string, string];
const brainId = arg('id') ?? slug;
const workosUser = arg('workos-user') ?? '';

const installationId = await findInstallationId(owner, repo);
if (!installationId) {
  console.error(`The mcpbox-brain GitHub App is not installed on ${slug}. Install it, then re-run.`);
  await closeDb();
  process.exit(1);
}

const octokit = await installationOctokit(installationId);
const branch = arg('branch') ?? (await defaultBranch(octokit, owner, repo));
const commit = await resolveCommit(octokit, owner, repo, branch);

const { rows } = await db().query<BrainRow>(
  `insert into brains (id, owner_workos_user_id, owner_github_login, repo_owner, repo_name, default_branch, installation_id)
   values ($1, $2, $3, $4, $5, $6, $7)
   on conflict (id) do update set
     owner_workos_user_id = excluded.owner_workos_user_id,
     owner_github_login   = excluded.owner_github_login,
     default_branch       = excluded.default_branch,
     installation_id      = excluded.installation_id
   returning *`,
  [brainId, workosUser, owner, owner, repo, branch, installationId],
);

const brain = rows[0]!;
console.log(`registered ${brain.id} -> ${owner}/${repo}@${branch} (installation ${installationId})`);

const result = await indexBrainAtCommit(brain, commit);
console.log(JSON.stringify(result, null, 2));
await closeDb();

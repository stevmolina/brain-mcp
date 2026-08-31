/**
 * Offboarding, decided before the second tenant rather than after.
 *
 *   pnpm offboard-brain <brain id> [--confirm]
 *
 * Removes the tenant from the index and revokes its access in one step: every
 * derived row goes (they cascade off the brain), the access cache is dropped so
 * revocation is immediate rather than cached-TTL eventual, and the App's
 * installation-repository grant for that repo is removed so the server can no
 * longer read or write it. The git repo itself is the tenant's and is untouched.
 */
import { db, closeDb } from '../src/db/client.js';
import { appOctokit } from '../src/github/app.js';
import { clearAccessCaches } from '../src/auth/access.js';
import type { BrainRow } from '../src/types.js';

const brainId = process.argv[2];
const confirmed = process.argv.includes('--confirm');
if (!brainId) {
  console.error('usage: pnpm offboard-brain <brain id> [--confirm]');
  process.exit(1);
}

const { rows } = await db().query<BrainRow>('select * from brains where id = $1', [brainId]);
const brain = rows[0];
if (!brain) {
  console.error(`no brain ${brainId}`);
  await closeDb();
  process.exit(1);
}

const counts = await db().query<{ claims: string; sources: string; findings: string }>(
  `select (select count(*) from claims where brain_id = $1) as claims,
          (select count(*) from sources where brain_id = $1) as sources,
          (select count(*) from audit_findings where brain_id = $1) as findings`,
  [brainId],
);

console.log(`brain      ${brain.id}`);
console.log(`repo       ${brain.repo_owner}/${brain.repo_name}`);
console.log(`rows       ${counts.rows[0]!.claims} claims, ${counts.rows[0]!.sources} sources, ${counts.rows[0]!.findings} findings`);

if (!confirmed) {
  console.log('\nDry run. Re-run with --confirm to remove the index and revoke access.');
  await closeDb();
  process.exit(0);
}

// Revoke first: if the DB delete fails the tenant is already cut off.
if (brain.installation_id) {
  try {
    const { data: repo } = await appOctokit().request('GET /repos/{owner}/{repo}', {
      owner: brain.repo_owner,
      repo: brain.repo_name,
    });
    await appOctokit().request('DELETE /user/installations/{installation_id}/repositories/{repository_id}', {
      installation_id: Number(brain.installation_id),
      repository_id: Number(repo.id),
    });
    console.log('revoked   installation access to the repo');
  } catch (error) {
    console.warn(
      `could not revoke installation access (${(error as { status?: number }).status ?? 'error'}); ` +
        'remove the repo from the GitHub App installation by hand.',
    );
  }
}

await db().query('delete from brains where id = $1', [brainId]);
clearAccessCaches(brainId);
console.log('deleted   every derived row for this brain');
await closeDb();

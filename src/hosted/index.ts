/**
 * Rebuilds a hosted brain's claims from its pages. Same rule as the git
 * indexer: full replace, no diff. The pages are the truth; the claims are the
 * copy.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { resolveProfile } from '../profiles/index.js';
import { parsePage, type ParsedClaim } from '../indexer/parse.js';
import type { BrainRow } from '../types.js';

interface PageRow {
  path: string;
  content: string;
}

export async function reindexHosted(client: PoolClient, brain: BrainRow): Promise<number> {
  const profile = resolveProfile(brain.profile);
  const { rows } = await client.query<PageRow>(
    'select path, content from pages where brain_id = $1 order by path',
    [brain.id],
  );

  const claims: ParsedClaim[] = [];
  for (const page of rows) {
    if (!page.path.endsWith('.md')) continue;
    if (page.path.startsWith(`${profile.sourcesDir.replace(/\/$/, '')}/`)) continue;
    claims.push(
      ...parsePage({
        brainId: brain.id,
        pagePath: page.path,
        content: page.content,
        sourcesDir: profile.sourcesDir,
      }),
    );
  }

  const byId = new Map<string, ParsedClaim>();
  for (const claim of claims) if (!byId.has(claim.id)) byId.set(claim.id, claim);
  const unique = [...byId.values()];

  const supersessions: { old: string; new: string }[] = [];
  for (const claim of unique) {
    for (const prefix of claim.supersedes) {
      const targets = unique.filter((c) => c.id.startsWith(prefix) && c.id !== claim.id);
      if (targets.length > 1) continue;
      supersessions.push({ old: targets[0]?.id ?? prefix, new: claim.id });
    }
  }

  const commit = hostedCommit(rows);

  await client.query('select pg_advisory_xact_lock(hashtext($1))', [`brain-mcp:index:${brain.id}`]);
  await client.query('delete from supersessions where brain_id = $1', [brain.id]);
  await client.query('delete from claims where brain_id = $1', [brain.id]);
  await client.query('delete from sources where brain_id = $1', [brain.id]);

  if (unique.length) {
    await client.query(
      `insert into claims (id, brain_id, text, page_path, line, heading, authority, verified_at, commit_sha)
       select * from unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::date[], $9::text[]
       )`,
      [
        unique.map((claim) => claim.id),
        unique.map(() => brain.id),
        unique.map((claim) => claim.text),
        unique.map((claim) => claim.pagePath),
        unique.map((claim) => claim.line),
        unique.map((claim) => claim.heading),
        unique.map((claim) => claim.authority),
        unique.map((claim) => claim.verifiedAt),
        unique.map(() => commit),
      ],
    );
  }

  if (supersessions.length) {
    await client.query(
      `insert into supersessions (brain_id, old_claim_id, new_claim_id)
       select $1, * from unnest($2::text[], $3::text[]) on conflict do nothing`,
      [brain.id, supersessions.map((s) => s.old), supersessions.map((s) => s.new)],
    );
    await client.query(
      `update claims c set superseded_by = s.new_claim_id
         from supersessions s
        where s.brain_id = $1 and c.brain_id = $1 and c.id = s.old_claim_id`,
      [brain.id],
    );
  }

  await client.query('update brains set last_indexed_commit = $1, last_indexed_at = now() where id = $2', [
    commit,
    brain.id,
  ]);

  return unique.length;
}

function hostedCommit(pages: PageRow[]): string {
  const hash = createHash('sha256');
  for (const page of pages) {
    hash.update(page.path);
    hash.update('\0');
    hash.update(page.content);
    hash.update('\0');
  }
  return `hosted-${hash.digest('hex').slice(0, 16)}`;
}

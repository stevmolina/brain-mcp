/**
 * Full rebuild of one brain's derived rows at a commit.
 *
 * No incremental diffing. A push replaces every row for that brain inside one
 * transaction: cheaper to reason about than a diff, and it makes the DB's test
 * true by construction -- drop it, rebuild it, lose nothing.
 */
import { createHash } from 'node:crypto';
import picomatch from 'picomatch';
import { installationOctokit } from '../github/app.js';
import { fetchRepoFiles, type RepoFile } from '../github/repo.js';
import { resolveProfile } from '../profiles/index.js';
import { withTransaction } from '../db/client.js';
import { parsePage, type ParsedClaim } from './parse.js';
import type { BrainRow } from '../types.js';

export interface IndexResult {
  brainId: string;
  commit: string;
  pages: number;
  claims: number;
  sources: number;
  edges: number;
  supersessions: number;
  unresolvedSupersedes: string[];
  durationMs: number;
}

function sourceId(brainId: string, path: string): string {
  return createHash('sha256').update(`${brainId}\n${path}`).digest('hex');
}

/** Reads origin and received date out of a sources/README.md provenance manifest.
 * Best effort: a brain without a manifest simply gets nulls. */
export function parseSourceManifest(content: string): Map<string, { origin: string | null; receivedAt: string | null }> {
  const out = new Map<string, { origin: string | null; receivedAt: string | null }>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim()).filter((c, i, a) => !(i === 0 || i === a.length - 1));
    if (cells.length < 2) continue;
    const file = cells[0]!.replace(/^`|`$/g, '').replace(/^\[|\]\(.*\)$/g, '');
    if (!file || /^-+$/.test(file) || file.toLowerCase() === 'file') continue;
    const date = cells.find((c) => /^\d{4}-\d{2}-\d{2}$/.test(c)) ?? null;
    const origin = cells.slice(1).find((c) => c && c !== date && !/^[0-9a-f]{64}$/i.test(c)) ?? null;
    out.set(file, { origin, receivedAt: date });
  }
  return out;
}

export async function indexBrainAtCommit(brain: BrainRow, commit: string): Promise<IndexResult> {
  const startedAt = Date.now();
  if (!brain.installation_id) {
    throw new Error(`Brain ${brain.id} has no GitHub App installation; cannot index.`);
  }

  const profile = resolveProfile(brain.profile);
  const octokit = await installationOctokit(brain.installation_id);
  const files = await fetchRepoFiles(octokit, brain.repo_owner, brain.repo_name, commit);

  const isIncluded = picomatch(profile.include, { dot: false });
  const isExcluded = picomatch(profile.exclude, { dot: true });
  const sourcesPrefix = `${profile.sourcesDir.replace(/\/$/, '')}/`;

  // sources/: immutable received evidence, hashed but never parsed for claims.
  const sourceFiles: RepoFile[] = [];
  const pages: RepoFile[] = [];
  for (const file of files.values()) {
    if (file.path.startsWith(sourcesPrefix)) {
      sourceFiles.push(file);
      continue;
    }
    if (!file.path.endsWith('.md')) continue;
    if (isExcluded(file.path) || !isIncluded(file.path)) continue;
    if (file.text !== undefined) pages.push(file);
  }

  const manifestFile = files.get(`${sourcesPrefix}README.md`);
  const manifest = manifestFile?.text ? parseSourceManifest(manifestFile.text) : new Map();

  const claims: ParsedClaim[] = [];
  for (const page of pages) {
    claims.push(
      ...parsePage({
        brainId: brain.id,
        pagePath: page.path,
        content: page.text!,
        sourcesDir: profile.sourcesDir,
      }),
    );
  }

  // Two claims can normalize identically inside one page (same text, same file):
  // they are the same claim, so the first wins and the id stays deterministic.
  const byId = new Map<string, ParsedClaim>();
  for (const claim of claims) if (!byId.has(claim.id)) byId.set(claim.id, claim);
  const unique = [...byId.values()];

  // supersedes: <id prefix>, resolved within this brain only.
  //
  // The usual case is that the superseded claim is *gone*: update_fact replaces
  // the old wording in place, so the next rebuild never sees it again. The edge
  // is still recorded against the prefix the marker names, because a pointer to
  // something no longer in the repo is the whole point of a supersession. Only
  // an ambiguous prefix, matching two claims that both still exist, is a fault.
  const supersessions: { old: string; new: string }[] = [];
  const unresolved: string[] = [];
  for (const claim of unique) {
    for (const prefix of claim.supersedes) {
      const targets = unique.filter((c) => c.id.startsWith(prefix) && c.id !== claim.id);
      if (targets.length > 1) {
        unresolved.push(prefix);
        continue;
      }
      supersessions.push({ old: targets[0]?.id ?? prefix, new: claim.id });
    }
  }

  let edges = 0;

  await withTransaction(async (client) => {
    // Two pushes in quick succession would otherwise each delete the other's
    // rows and collide on the claim primary key. The lock is per brain and is
    // released with the transaction, so rebuilds of different brains still run
    // side by side.
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`brain-mcp:index:${brain.id}`]);

    // Full rebuild: claim_sources and supersessions cascade off claims/sources.
    await client.query('delete from supersessions where brain_id = $1', [brain.id]);
    await client.query('delete from claims where brain_id = $1', [brain.id]);
    await client.query('delete from sources where brain_id = $1', [brain.id]);

    // Inserted column-wise through unnest rather than row by row: a brain of a
    // few thousand claims is one round trip per table instead of a few thousand,
    // which is the difference between a push webhook finishing in a second and
    // finishing in a minute.
    if (sourceFiles.length) {
      const meta = sourceFiles.map(
        (file) => manifest.get(file.path) ?? manifest.get(file.path.slice(sourcesPrefix.length)) ?? null,
      );
      await client.query(
        `insert into sources (id, brain_id, path, sha256, bytes, origin, received_at, commit_sha)
         select * from unnest(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::date[], $8::text[]
         )`,
        [
          sourceFiles.map((file) => sourceId(brain.id, file.path)),
          sourceFiles.map(() => brain.id),
          sourceFiles.map((file) => file.path),
          sourceFiles.map((file) => file.sha256),
          sourceFiles.map((file) => file.bytes),
          meta.map((m) => m?.origin ?? null),
          meta.map((m) => m?.receivedAt ?? null),
          sourceFiles.map(() => commit),
        ],
      );
    }

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

    const edgeClaims: string[] = [];
    const edgeSources: string[] = [];
    for (const claim of unique) {
      for (const path of claim.sourcePaths) {
        edgeClaims.push(claim.id);
        edgeSources.push(sourceId(brain.id, path));
      }
    }
    if (edgeClaims.length) {
      // The join against sources drops a citation pointing at a file that is not
      // in the repo at this commit, rather than failing the whole rebuild.
      const result = await client.query(
        `insert into claim_sources (brain_id, claim_id, source_id)
         select $1, e.claim_id, e.source_id
           from unnest($2::text[], $3::text[]) as e(claim_id, source_id)
           join sources s on s.id = e.source_id and s.brain_id = $1
         on conflict do nothing`,
        [brain.id, edgeClaims, edgeSources],
      );
      edges = result.rowCount ?? 0;
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

    await client.query(
      'update brains set last_indexed_commit = $1, last_indexed_at = now() where id = $2',
      [commit, brain.id],
    );
  });

  return {
    brainId: brain.id,
    commit,
    pages: pages.length,
    claims: unique.length,
    sources: sourceFiles.length,
    edges,
    supersessions: supersessions.length,
    unresolvedSupersedes: unresolved,
    durationMs: Date.now() - startedAt,
  };
}

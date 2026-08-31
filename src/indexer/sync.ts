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
  const supersessions: { old: string; new: string }[] = [];
  const unresolved: string[] = [];
  for (const claim of unique) {
    for (const prefix of claim.supersedes) {
      const targets = unique.filter((c) => c.id.startsWith(prefix) && c.id !== claim.id);
      if (targets.length === 1) supersessions.push({ old: targets[0]!.id, new: claim.id });
      else unresolved.push(prefix);
    }
  }

  let edges = 0;

  await withTransaction(async (client) => {
    // Full rebuild: claim_sources and supersessions cascade off claims/sources.
    await client.query('delete from supersessions where brain_id = $1', [brain.id]);
    await client.query('delete from claims where brain_id = $1', [brain.id]);
    await client.query('delete from sources where brain_id = $1', [brain.id]);

    for (const file of sourceFiles) {
      const meta = manifest.get(file.path) ?? manifest.get(file.path.slice(sourcesPrefix.length)) ?? null;
      await client.query(
        `insert into sources (id, brain_id, path, sha256, bytes, origin, received_at, commit_sha)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          sourceId(brain.id, file.path),
          brain.id,
          file.path,
          file.sha256,
          file.bytes,
          meta?.origin ?? null,
          meta?.receivedAt ?? null,
          commit,
        ],
      );
    }

    for (const claim of unique) {
      await client.query(
        `insert into claims (id, brain_id, text, page_path, line, heading, authority, verified_at, commit_sha)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          claim.id,
          brain.id,
          claim.text,
          claim.pagePath,
          claim.line,
          claim.heading,
          claim.authority,
          claim.verifiedAt,
          commit,
        ],
      );
    }

    for (const claim of unique) {
      for (const path of claim.sourcePaths) {
        const id = sourceId(brain.id, path);
        const inserted = await client.query(
          `insert into claim_sources (brain_id, claim_id, source_id)
           select $1, $2, $3 where exists (select 1 from sources where id = $3 and brain_id = $1)
           on conflict do nothing`,
          [brain.id, claim.id, id],
        );
        edges += inserted.rowCount ?? 0;
      }
    }

    for (const link of supersessions) {
      await client.query(
        `insert into supersessions (brain_id, old_claim_id, new_claim_id) values ($1, $2, $3)
         on conflict do nothing`,
        [brain.id, link.old, link.new],
      );
      await client.query('update claims set superseded_by = $1 where id = $2 and brain_id = $3', [
        link.new,
        link.old,
        brain.id,
      ]);
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

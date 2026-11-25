/**
 * Whole pages for `context`: a brain's index and an owner's me card.
 *
 * Read from GitHub (the truth) rather than rebuilt from claims, because these
 * pages are prose meant to be read whole. Only called with a brain the caller
 * already resolved through requireBrain or accessibleBrains. Cached for a
 * minute per brain and path, after that check, so a burst of hook calls costs
 * one GitHub read.
 */
import { db } from '../db/client.js';
import { installationOctokit } from '../github/app.js';
import type { BrainRow } from '../types.js';

export interface BrainPage {
  path: string;
  text: string;
  /** ISO day the page last changed in git, or null when unknown. */
  updated_at: string | null;
  url: string;
}

export type PageReader = (brain: BrainRow, path: string) => Promise<BrainPage | null>;

const cache = new Map<string, { value: BrainPage | null; expiresAt: number }>();

export const readBrainPage: PageReader = async (brain, path) => {
  const key = `${brain.id}::${path}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let value: BrainPage | null = null;
  if (brain.installation_id) {
    const github = await installationOctokit(brain.installation_id);
    const repo = { owner: brain.repo_owner, repo: brain.repo_name };
    try {
      const { data } = await github.request('GET /repos/{owner}/{repo}/contents/{path}', {
        ...repo,
        path,
        ref: brain.default_branch,
      });
      if (!Array.isArray(data) && data.type === 'file' && data.encoding === 'base64') {
        value = {
          path,
          text: Buffer.from(data.content, 'base64').toString('utf8'),
          updated_at: await pageDate(brain, path, async () => {
            const { data: commits } = await github.request('GET /repos/{owner}/{repo}/commits', {
              ...repo,
              sha: brain.default_branch,
              path,
              per_page: 1,
            });
            return commits[0]?.commit.committer?.date ?? null;
          }),
          url: data.html_url ?? `https://github.com/${brain.repo_owner}/${brain.repo_name}/blob/${brain.default_branch}/${path}`,
        };
      }
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }
  cache.set(key, { value, expiresAt: Date.now() + 60_000 });
  return value;
};

/** The indexer's date for the page, else one GitHub call. */
async function pageDate(brain: BrainRow, path: string, fromGithub: () => Promise<string | null>): Promise<string | null> {
  const { rows } = await db().query<{ last_commit_at: Date | null }>(
    'select last_commit_at from pages where brain_id = $1 and path = $2',
    [brain.id, path],
  );
  const indexed = rows[0]?.last_commit_at;
  if (indexed) return indexed.toISOString().slice(0, 10);
  const fetched = await fromGithub().catch(() => null);
  return fetched ? fetched.slice(0, 10) : null;
}

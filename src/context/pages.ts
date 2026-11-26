/**
 * Whole pages for `context`: a brain's index and an owner's me card.
 *
 * Read from GitHub (the truth) rather than rebuilt from claims, because these
 * pages are prose meant to be read whole. Only called with a brain the caller
 * already resolved through requireBrain or accessibleBrains.
 *
 * Cached per brain and path, keyed by the commit the indexer last processed
 * (`brains.last_indexed_commit`). A page cannot change without a new commit, and
 * the indexer moves that column after every push to the default branch, so a
 * cached page stays right until the next push and a call costs no GitHub read.
 * Before the first index there is no commit to key on, so the entry lives a
 * minute. An entry also never outlives an hour.
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

interface Entry {
  value: BrainPage | null;
  /** The brain's indexed commit when the page was read; null before the first index. */
  commit: string | null;
  readAt: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<BrainPage | null>>();
/** Entry life when the brain has no indexed commit to key on. */
const UNKEYED_TTL_MS = 60_000;
/** The longest any entry lives, so a missed webhook cannot pin an old page. */
const MAX_AGE_MS = 60 * 60_000;

function fresh(entry: Entry, brain: BrainRow): boolean {
  const age = Date.now() - entry.readAt;
  if (age >= MAX_AGE_MS) return false;
  return brain.last_indexed_commit ? entry.commit === brain.last_indexed_commit : age < UNKEYED_TTL_MS;
}

export const readBrainPage: PageReader = async (brain, path) => {
  const key = `${brain.id}::${path}`;
  const hit = cache.get(key);
  if (hit && fresh(hit, brain)) return hit.value;

  // One GitHub read per page at a time, so a burst of calls shares it.
  const flightKey = `${key}::${brain.last_indexed_commit ?? ''}`;
  const running = inflight.get(flightKey);
  if (running) return running;
  const read = fetchPage(brain, path)
    .then((value) => {
      cache.set(key, { value, commit: brain.last_indexed_commit, readAt: Date.now() });
      return value;
    })
    .finally(() => inflight.delete(flightKey));
  inflight.set(flightKey, read);
  return read;
};

/** Forgets every cached page. For tests. */
export function clearPageCache(): void {
  cache.clear();
  inflight.clear();
}

async function fetchPage(brain: BrainRow, path: string): Promise<BrainPage | null> {
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
  return value;
}

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

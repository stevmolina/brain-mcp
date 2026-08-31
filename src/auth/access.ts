/**
 * Authorization.
 *
 * WorkOS answers *who this is*. The GitHub API answers *which brains they may
 * read*. There is deliberately no second permission list in this database: a
 * brain is a repo, and repo access is GitHub's to state. The answer is cached for
 * a minute and re-checked on refresh, so someone removed from a repo loses access
 * without a deploy.
 */
import { loadConfig } from '../config.js';
import { db } from '../db/client.js';
import { appOctokit, githubLoginForAccountId, installationOctokit } from '../github/app.js';
import { ToolRefusal } from '../tools/shared.js';
import type { BrainRow } from '../types.js';

/** Denied access to a brain. A ToolRefusal, so the caller reads it as a tool
 * error and can correct the call rather than seeing a transport failure. */
export class Forbidden extends ToolRefusal {}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const identityCache = new Map<string, CacheEntry<string | null>>();
const accessCache = new Map<string, CacheEntry<boolean>>();

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): T {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/** The GitHub login behind a WorkOS user, via their linked GitHub identity. */
export async function githubLoginForWorkosUser(workosUserId: string): Promise<string | null> {
  const cached = readCache(identityCache, workosUserId);
  if (cached !== undefined) return cached;

  const config = loadConfig();
  const response = await fetch(
    `https://api.workos.com/user_management/users/${encodeURIComponent(workosUserId)}/identities`,
    { headers: { Authorization: `Bearer ${config.workosApiKey}` } },
  );
  if (!response.ok) return writeCache(identityCache, workosUserId, null, 30_000);

  const body = (await response.json()) as Array<{ idp_id?: string; provider?: string; type?: string }> | {
    data?: Array<{ idp_id?: string; provider?: string }>;
  };
  const identities = Array.isArray(body) ? body : (body.data ?? []);
  const github = identities.find((i) => /github/i.test(i.provider ?? ''));
  if (!github?.idp_id) return writeCache(identityCache, workosUserId, null, 30_000);

  const login = await githubLoginForAccountId(github.idp_id);
  // Identity is stable; cache it longer than repo access, which is not.
  return writeCache(identityCache, workosUserId, login, 15 * 60_000);
}

/** Does this GitHub login have read access to the brain's repo? */
export async function canReadBrain(brain: BrainRow, githubLogin: string | null): Promise<boolean> {
  if (!githubLogin) return false;
  if (githubLogin.toLowerCase() === brain.owner_github_login.toLowerCase()) return true;
  if (!brain.installation_id) return false;

  const key = `${brain.id}::${githubLogin.toLowerCase()}`;
  const cached = readCache(accessCache, key);
  if (cached !== undefined) return cached;

  const ttl = loadConfig().accessCacheTtlMs;
  try {
    const octokit = await installationOctokit(brain.installation_id);
    const response = await octokit.request('GET /repos/{owner}/{repo}/collaborators/{username}', {
      owner: brain.repo_owner,
      repo: brain.repo_name,
      username: githubLogin,
    });
    return writeCache(accessCache, key, response.status === 204, ttl);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) return writeCache(accessCache, key, false, ttl);
    // A 403 means the App cannot answer the question, not that access exists.
    // Fail closed and say so in the log rather than guessing.
    console.error(
      JSON.stringify({
        level: 'warn',
        at: 'access.canReadBrain',
        brain: brain.id,
        status,
        message: 'collaborator check failed; denying',
      }),
    );
    return writeCache(accessCache, key, false, 10_000);
  }
}

export async function getBrain(brainId: string): Promise<BrainRow | null> {
  const { rows } = await db().query<BrainRow>('select * from brains where id = $1', [brainId]);
  return rows[0] ?? null;
}

/** Every brain this WorkOS user may read, checked against GitHub each time. */
export async function accessibleBrains(workosUserId: string): Promise<BrainRow[]> {
  const login = await githubLoginForWorkosUser(workosUserId);
  const { rows } = await db().query<BrainRow>('select * from brains order by id');
  const allowed: BrainRow[] = [];
  for (const brain of rows) {
    if (brain.owner_workos_user_id === workosUserId || (await canReadBrain(brain, login))) {
      allowed.push(brain);
    }
  }
  return allowed;
}

/**
 * Resolves the brain a call is scoped to and proves the caller may read it.
 * Every tool goes through here; nothing else loads a brain row for a request.
 */
export async function requireBrain(workosUserId: string, requested?: string): Promise<BrainRow> {
  if (requested) {
    const brain = await getBrain(requested);
    // Same message whether the brain is missing or merely forbidden: a caller
    // must not be able to enumerate other tenants' brain ids.
    const denied = new Forbidden(`No brain "${requested}" is available to you.`);
    if (!brain) throw denied;
    if (brain.owner_workos_user_id === workosUserId) return brain;
    const login = await githubLoginForWorkosUser(workosUserId);
    if (await canReadBrain(brain, login)) return brain;
    throw denied;
  }

  const brains = await accessibleBrains(workosUserId);
  if (brains.length === 1) return brains[0]!;
  if (brains.length === 0) {
    throw new Forbidden(
      'You have no brains yet. Install the GitHub App on a markdown repo and register it as a brain.',
    );
  }
  throw new Forbidden(
    `Name a brain. Yours: ${brains.map((b) => b.id).join(', ')}.`,
  );
}

/** Clears the caches. Used by offboarding, so revocation is immediate. */
export function clearAccessCaches(brainId?: string): void {
  if (!brainId) {
    accessCache.clear();
    identityCache.clear();
    return;
  }
  for (const key of accessCache.keys()) if (key.startsWith(`${brainId}::`)) accessCache.delete(key);
}

export { appOctokit };

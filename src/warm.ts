/**
 * Keeps the first call of a chat as fast as the tenth.
 *
 * `context` is called at the start of a chat, often after a quiet spell. Every
 * time-limited cache and every idle connection it touches used to expire in the
 * gaps, so the first call rebuilt all of them in a row: two database
 * connections (one an ocean away), a WorkOS lookup, a GitHub login lookup, a
 * GitHub install token and two GitHub page reads. About 2.7 s cold against 0.7 s
 * warm, measured from a server in 2026-11.
 *
 * This loop runs the same work ahead of time, from inside the server:
 *
 *  - every cycle (20 s): one light query on each database pool, the page
 *    reads (a no-op until a push changes the commit), and the GitHub install
 *    token (renewed before it expires);
 *  - every 5 minutes: the owner's WorkOS profile and GitHub login, the token
 *    signing keys, and the sessions column check. Each keeps its last good
 *    answer when the refresh fails.
 *
 * It only runs while someone is using the server. The brain database is on
 * Neon, which bills compute while it is awake, and a light query every 20 s
 * would keep it awake all month (about 182 compute-hours against 17 used in
 * November). So the loop queries Neon only for `WARM_DB_MINUTES` (default 30)
 * after the last MCP or REST request, enough to cover a working burst of chats;
 * after that Neon scales to zero as before, and the first call of the next
 * burst pays its wake-up (about 1.6 s). Everything that does not touch Neon
 * (the other database, GitHub, WorkOS) stays warm for `WARM_ACTIVE_MINUTES`
 * (default 720). Nothing here widens access: it reads the same caches, with the
 * same keys, that a request reads.
 */
import { githubLoginForWorkosUser } from './auth/access.js';
import { workosProfile } from './auth/identity.js';
import { refreshJwks } from './auth/workos.js';
import { readBrainPage } from './context/pages.js';
import { db } from './db/client.js';
import { installationOctokit } from './github/app.js';
import { resolveProfile } from './profiles/index.js';
import { sessionsDb, sessionsEnabled } from './sessions/db.js';
import { refreshSessionColumns } from './sessions/store.js';
import type { BrainRow } from './types.js';

export interface WarmOptions {
  /** Time between cycles. 0 turns the warmer off. */
  intervalMs: number;
  /** How long after the last request the loop keeps going. */
  activeMs: number;
  /** How long after the last request the loop queries the Neon brain database. */
  dbActiveMs: number;
  /** Time between the slower refreshes (identity, signing keys, columns). */
  slowEveryMs: number;
}

export function warmOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): WarmOptions {
  return {
    intervalMs: Number(env.WARM_INTERVAL_MS ?? 20_000),
    activeMs: Number(env.WARM_ACTIVE_MINUTES ?? 720) * 60_000,
    dbActiveMs: Number(env.WARM_DB_MINUTES ?? 30) * 60_000,
    slowEveryMs: 5 * 60_000,
  };
}

let lastActivity = Date.now();

/** Called for every MCP and REST request: someone is using the server. */
export function markActivity(): void {
  lastActivity = Date.now();
}

export interface Warmer {
  stop(): void;
  /** One cycle, now. For tests and for the first run at boot. */
  cycle(): Promise<void>;
}

export function startWarmer(options: WarmOptions = warmOptionsFromEnv()): Warmer | null {
  if (!(options.intervalMs > 0)) return null;
  let running = false;
  let lastSlow = 0;
  // The brains seen on the last database read, so the steps that do not touch
  // Neon can keep running while Neon is left to sleep.
  let brains: BrainRow[] = [];

  const step = async (name: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      console.error(JSON.stringify({ level: 'warn', at: 'warm', step: name, message: String((error as Error)?.message ?? error) }));
    }
  };

  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      const started = Date.now();
      if (started - lastActivity <= options.dbActiveMs) {
        await step('database', async () => {
          brains = (await db().query<BrainRow>('select * from brains order by id')).rows;
        });
      }
      const work: Promise<unknown>[] = [];
      if (sessionsEnabled()) work.push(step('sessions-database', () => sessionsDb().query('select 1')));
      for (const brain of brains) {
        if (brain.installation_id) work.push(step('install-token', () => installationOctokit(brain.installation_id!)));
        const profile = resolveProfile(brain.profile);
        for (const path of [profile.indexPage, profile.meCard]) {
          if (path) work.push(step('page', () => readBrainPage(brain, path)));
        }
      }
      if (started - lastSlow >= options.slowEveryMs) {
        lastSlow = started;
        for (const owner of new Set(brains.map((b) => b.owner_workos_user_id))) {
          work.push(step('profile', () => workosProfile(owner, { fresh: true, keepOnFailure: true })));
          work.push(step('github-login', () => githubLoginForWorkosUser(owner, { refresh: true })));
        }
        work.push(step('signing-keys', refreshJwks));
        if (sessionsEnabled()) work.push(step('session-columns', refreshSessionColumns));
      }
      await Promise.all(work);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    if (Date.now() - lastActivity > options.activeMs) return;
    void cycle();
  }, options.intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), cycle };
}

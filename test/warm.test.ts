/**
 * The page cache is keyed by the brain's indexed commit, and the warmer keeps
 * connections and caches hot. Fakes only: no network, no database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainRow } from '../src/types.js';

process.env.DATABASE_URL ??= 'postgres://unused';

const request = vi.fn();
const dbQuery = vi.fn();
const sessionsQuery = vi.fn();
const installationOctokit = vi.fn();

vi.mock('../src/github/app.js', () => ({
  installationOctokit: (id: string) => {
    installationOctokit(id);
    return Promise.resolve({ request });
  },
}));
vi.mock('../src/db/client.js', () => ({ db: () => ({ query: dbQuery }) }));
vi.mock('../src/sessions/db.js', () => ({ sessionsEnabled: () => true, sessionsDb: () => ({ query: sessionsQuery }) }));
vi.mock('../src/sessions/store.js', () => ({ refreshSessionColumns: vi.fn(async () => {}) }));
vi.mock('../src/auth/access.js', () => ({ githubLoginForWorkosUser: vi.fn(async () => 'login') }));
vi.mock('../src/auth/identity.js', () => ({ workosProfile: vi.fn(async () => ({ id: 'user_a' })) }));
vi.mock('../src/auth/workos.js', () => ({ refreshJwks: vi.fn(async () => {}) }));

const { readBrainPage, clearPageCache } = await import('../src/context/pages.js');
const { startWarmer } = await import('../src/warm.js');

function brain(commit: string | null): BrainRow {
  return {
    id: 'warm-test/notes',
    owner_workos_user_id: 'user_a',
    owner_github_login: 'a',
    repo_owner: 'warm-test',
    repo_name: 'notes',
    default_branch: 'main',
    installation_id: '7',
    profile: { indexPage: 'wiki/index.md', meCard: 'wiki/me.md' },
    last_indexed_commit: commit,
    last_indexed_at: null,
  };
}

function githubServesPage() {
  request.mockImplementation(async (route: string) => {
    if (route.includes('/contents/')) {
      return { data: { type: 'file', encoding: 'base64', content: Buffer.from('# Page').toString('base64'), html_url: 'https://example.invalid/p' } };
    }
    return { data: [{ commit: { committer: { date: '2026-11-20T00:00:00Z' } } }] };
  });
  dbQuery.mockImplementation(async (sql: string) =>
    sql.includes('from pages') ? { rows: [{ last_commit_at: new Date('2026-11-20T00:00:00Z') }] } : { rows: [brain('c1')] },
  );
}

const opts = { intervalMs: 20_000, activeMs: 12 * 3_600_000, dbActiveMs: 30 * 60_000, slowEveryMs: 300_000 };
const contentReads = () => request.mock.calls.filter(([route]) => String(route).includes('/contents/')).length;

beforeEach(() => {
  vi.useRealTimers();
  clearPageCache();
  request.mockReset();
  dbQuery.mockReset();
  sessionsQuery.mockReset();
  installationOctokit.mockReset();
  githubServesPage();
});

describe('page cache keyed by commit', () => {
  it('reads GitHub once while the indexed commit stays the same, however long it takes', async () => {
    vi.useFakeTimers();
    await readBrainPage(brain('c1'), 'wiki/index.md');
    vi.advanceTimersByTime(30 * 60_000);
    const again = await readBrainPage(brain('c1'), 'wiki/index.md');
    expect(again?.text).toBe('# Page');
    expect(contentReads()).toBe(1);
  });

  it('reads again as soon as the indexer moves to a new commit', async () => {
    await readBrainPage(brain('c1'), 'wiki/index.md');
    await readBrainPage(brain('c2'), 'wiki/index.md');
    expect(contentReads()).toBe(2);
  });

  it('keeps no page longer than an hour', async () => {
    vi.useFakeTimers();
    await readBrainPage(brain('c1'), 'wiki/index.md');
    vi.advanceTimersByTime(61 * 60_000);
    await readBrainPage(brain('c1'), 'wiki/index.md');
    expect(contentReads()).toBe(2);
  });

  it('keeps the one-minute life when the brain has no indexed commit yet', async () => {
    vi.useFakeTimers();
    await readBrainPage(brain(null), 'wiki/index.md');
    vi.advanceTimersByTime(30_000);
    await readBrainPage(brain(null), 'wiki/index.md');
    expect(contentReads()).toBe(1);
    vi.advanceTimersByTime(31_000);
    await readBrainPage(brain(null), 'wiki/index.md');
    expect(contentReads()).toBe(2);
  });

  it('shares one GitHub read between calls that arrive together', async () => {
    await Promise.all([1, 2, 3].map(() => readBrainPage(brain('c1'), 'wiki/index.md')));
    expect(contentReads()).toBe(1);
  });

  it('does not cache a failed read', async () => {
    request.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 502 }));
    await expect(readBrainPage(brain('c1'), 'wiki/index.md')).rejects.toThrow('boom');
    expect((await readBrainPage(brain('c1'), 'wiki/index.md'))?.text).toBe('# Page');
  });
});

describe('warmer', () => {
  it('queries both databases, renews the install token and reads the pages in one cycle', async () => {
    const warmer = startWarmer(opts);
    await warmer!.cycle();
    warmer!.stop();
    expect(dbQuery).toHaveBeenCalledWith('select * from brains order by id');
    expect(sessionsQuery).toHaveBeenCalledWith('select 1');
    expect(installationOctokit).toHaveBeenCalledWith('7');
    expect(contentReads()).toBe(2); // index page and me card
  });

  it('a second cycle on the same commit reads no page again', async () => {
    const warmer = startWarmer(opts);
    await warmer!.cycle();
    await warmer!.cycle();
    warmer!.stop();
    expect(contentReads()).toBe(2);
  });

  it('survives a failing step and still runs the others', async () => {
    sessionsQuery.mockRejectedValue(new Error('sessions down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warmer = startWarmer(opts);
    await warmer!.cycle();
    warmer!.stop();
    expect(installationOctokit).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sessions-database'));
    log.mockRestore();
  });

  it('leaves Neon alone after the database window, but keeps the rest warm', async () => {
    vi.useFakeTimers();
    const warmer = startWarmer(opts);
    await warmer!.cycle();
    dbQuery.mockClear();
    installationOctokit.mockClear();
    vi.setSystemTime(Date.now() + 31 * 60_000); // no timer callbacks fire on the way
    await warmer!.cycle();
    warmer!.stop();
    expect(dbQuery).not.toHaveBeenCalledWith('select * from brains order by id');
    expect(sessionsQuery).toHaveBeenCalledWith('select 1');
    expect(installationOctokit).toHaveBeenCalledWith('7');
  });

  it('is off when the interval is 0', () => {
    expect(startWarmer({ ...opts, intervalMs: 0 })).toBeNull();
  });
});

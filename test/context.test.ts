/**
 * `context` walks me card, index, claims and chats within a budget. Invented
 * brains, people and chats only.
 */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.SESSIONS_DATABASE_URL = process.env.DATABASE_URL;

const { closeDb, db } = await import('../src/db/client.js');
const { migrate } = await import('../src/db/migrate.js');
const { sessionsDb, closeSessionsDb, migrateSessions } = await import('../src/sessions/db.js');
const { resetSessionColumnsCache, searchSessions } = await import('../src/sessions/store.js');
const { claimId } = await import('../src/indexer/parse.js');
const { buildContext, CONTEXT_HEADER, trimPage } = await import('../src/context/build.js');
const { Forbidden, clearAccessCaches } = await import('../src/auth/access.js');
import type { BrainRow } from '../src/types.js';

const ME = 'user_context_test_me';
const OTHER = 'user_context_test_other';
const PERSONAL = 'context-test/me-notes';
const ORCHARD = 'context-test/orchard-knowledge';
const HARBOR = 'context-test/harbor-knowledge';
const FOREIGN = 'context-test/foreign';

const pages: Record<string, string> = {
  [`${PERSONAL}::wiki/me.md`]: '---\ntitle: me\n---\n# Me\nI am a fictional person.\nI like short answers.\n' + 'Filler line.\n'.repeat(400),
  [`${ORCHARD}::wiki/index.md`]: '# Orchard\n- milestones.md: dates and demos\n- billing.md: invoices',
  [`${HARBOR}::wiki/index.md`]: '# Harbor\n- boats.md',
  [`${FOREIGN}::wiki/me.md`]: '# Someone else entirely',
};
const readPage = vi.fn(async (brain: BrainRow, path: string) => {
  const text = pages[`${brain.id}::${path}`];
  return text === undefined ? null : { path, text, updated_at: '2026-11-20', url: `https://example.invalid/${path}` };
});

async function brain(id: string, owner: string, profile: object) {
  await db().query(
    `insert into brains (id, owner_workos_user_id, owner_github_login, repo_owner, repo_name, installation_id, profile)
     values ($1, $2, $2, 'context-test', $3, 1, $4)`,
    [id, owner, id.split('/')[1], JSON.stringify(profile)],
  );
}
async function claim(brainId: string, text: string, page = 'wiki/milestones.md', verified: string | null = null) {
  await db().query(
    `insert into claims (id, brain_id, text, page_path, line, verified_at, commit_sha) values ($1, $2, $3, $4, 1, $5, 'cafe')`,
    [claimId(brainId, page, text), brainId, text, page, verified],
  );
}
async function chat(id: string, owner: string, brainId: string, title: string, card: string | null, body: string) {
  await sessionsDb().query(
    `insert into sessions (source, id, machine, provider, title, body, turns, owner, brain, updated_at, card, card_updated_at)
     values ('contexttest', $1, 'box', 'codex', $2, $3, '[]', $4, $5, '2026-11-10', $6, '2026-11-11')`,
    [id, title, body, owner, brainId, card],
  );
}
async function clean() {
  await db().query('delete from brains where id like $1', ['context-test/%']);
  await sessionsDb().query("delete from sessions where source = 'contexttest'");
}

const realFetch = globalThis.fetch;
beforeAll(async () => {
  // No WorkOS in tests: identity lookups find no GitHub login, so only the
  // registered owner can reach a brain.
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) =>
    String(url).includes('api.workos.com') ? new Response(null, { status: 404 }) : realFetch(url, init),
  );
  await migrate();
  await sessionsDb().query(await readFile(new URL('./fixtures/sessions-table.sql', import.meta.url), 'utf8'));
  await sessionsDb().query('alter table sessions add column if not exists card text, add column if not exists card_updated_at timestamptz');
  await migrateSessions();
  resetSessionColumnsCache();
  clearAccessCaches();
  await clean();
  await brain(PERSONAL, ME, { meCard: 'wiki/me.md', aliases: ['personal'] });
  await brain(ORCHARD, ME, { aliases: ['Orchard Co', 'Pear Pilot'] });
  await brain(HARBOR, ME, {});
  await brain(FOREIGN, OTHER, { meCard: 'wiki/me.md', aliases: ['orchard'] });
  await claim(ORCHARD, 'Milestone 2 demo is on 2026-12-03.', 'wiki/milestones.md', '2026-11-01');
  await claim(ORCHARD, 'Invoices go out on the first business day.', 'wiki/billing.md');
  await claim(HARBOR, 'The harbor tug is serviced every March.', 'wiki/boats.md');
  await claim(PERSONAL, '`app.personal.autoupdate`: builds the personal site every 5 minutes.', 'wiki/machines.md');
  await claim(FOREIGN, 'Foreign secret: the orchard demo is cancelled.', 'wiki/milestones.md');
  await chat('c1', ME, ORCHARD, 'Planning the milestone demo', 'Agreed the milestone 2 demo agenda with the orchard board.', 'long body');
  await chat('c2', ME, ORCHARD, 'Unrelated', null, 'we talked about the milestone demo in passing');
  await chat('c3', OTHER, ORCHARD, 'Other person milestone demo', 'Other person secret demo card.', 'milestone demo');
  await chat('c4', ME, HARBOR, 'Tug chat', 'Harbor tug service.', 'tug');
});

afterAll(async () => {
  await clean();
  await sessionsDb().query('alter table sessions drop column if exists card, drop column if exists card_updated_at');
  await closeSessionsDb();
  await closeDb();
  vi.unstubAllGlobals();
});

describe('brain choice', () => {
  it('picks a brain whose alias the question names', async () => {
    const result = await buildContext(ME, { question: 'When is the Orchard Co milestone 2 demo?' }, { readPage });
    expect(result.brains).toEqual([ORCHARD]);
    expect(result.brain_choice).toBe('alias');
  });

  it('picks a brain from the cwd hint', async () => {
    const result = await buildContext(ME, { question: 'when is the next service?', cwd: '/home/x/dev/harbor/app' }, { readPage });
    expect(result.brains).toEqual([HARBOR]);
  });

  it('falls back to the brain whose claims match best', async () => {
    const result = await buildContext(ME, { question: 'When is the tug serviced?' }, { readPage });
    expect(result.brains[0]).toBe(HARBOR);
    expect(result.brain_choice).toBe('search');
  });

  it('never picks a brain the caller cannot read, even when its alias matches', async () => {
    const result = await buildContext(ME, { question: 'orchard demo' }, { readPage });
    expect(result.brains).not.toContain(FOREIGN);
    expect(result.text).not.toContain('Foreign secret');
  });

  it('refuses an explicit brain the caller cannot read', async () => {
    await expect(buildContext(ME, { question: 'demo', brain: FOREIGN }, { readPage })).rejects.toBeInstanceOf(Forbidden);
  });
});

describe('levels', () => {
  it('puts the header, then the caller\'s own me card, dated and trimmed', async () => {
    const result = await buildContext(ME, { question: 'Orchard Co demo date' }, { readPage });
    expect(result.text.split('\n')[1]).toBe(CONTEXT_HEADER);
    expect(result.me?.brain).toBe(PERSONAL);
    expect(result.me?.truncated).toBe(true);
    expect(result.text).toContain(`## Me card (${PERSONAL} wiki/me.md, updated 2026-11-20)`);
    expect(result.text).not.toContain('title: me');
    expect(result.text).not.toContain('Someone else entirely');
  });

  it('gives another user no me card of ours', async () => {
    const result = await buildContext(OTHER, { question: 'orchard demo' }, { readPage });
    expect(result.me?.brain ?? null).not.toBe(PERSONAL);
    expect(result.text).not.toContain('fictional person');
  });

  it('includes the index and dated claims', async () => {
    const result = await buildContext(ME, { question: 'When is the Orchard Co milestone 2 demo?' }, { readPage });
    expect(result.index.map((p) => p.brain)).toEqual([ORCHARD]);
    expect(result.claims[0]?.text).toBe('Milestone 2 demo is on 2026-12-03.');
    expect(result.text).toMatch(/Milestone 2 demo is on 2026-12-03\. \[verified 2026-11-01/);
    for (const line of result.text.split('\n').filter((l) => l.startsWith('- ') && l.includes('['))) {
      expect(line).toMatch(/\[(verified \d{4}-\d{2}-\d{2}|page updated \d{4}-\d{2}-\d{2}|undated|chat, updated \d{4}-\d{2}-\d{2})/);
    }
  });

  it('adds the caller\'s own chats, card first, and never another person\'s', async () => {
    const result = await buildContext(ME, { question: 'Orchard Co milestone demo agenda', depth: 4 }, { readPage });
    expect(result.stopped_at).toBe(4);
    expect(result.sessions.map((s) => s.id)).toContain('c1');
    expect(result.sessions[0]!.id).toBe('c1');
    expect(result.sessions[0]!.match).toBe('card');
    expect(result.sessions.map((s) => s.id)).not.toContain('c3');
    expect(result.text).not.toContain('Other person secret');
    expect(result.text).not.toContain('Tug chat');
  });

  it('finds a fact whose own words include the brain alias', async () => {
    // "personal" is the brain's alias and also the claim's own word: dropping
    // it before searching would leave only "machine" (from the page path).
    const result = await buildContext(ME, { question: 'Which machine runs the personal update job?', brain: PERSONAL, depth: 3 }, { readPage });
    expect(result.claims[0]?.text).toMatch(/autoupdate/);
  });

  it('stops at the depth asked for', async () => {
    const one = await buildContext(ME, { question: 'Orchard Co demo', depth: 1 }, { readPage });
    expect([one.stopped_at, one.stopped_because, one.index, one.claims]).toEqual([1, 'depth', [], []]);
    const three = await buildContext(ME, { question: 'Orchard Co demo', depth: 3 }, { readPage });
    expect(three.claims.length).toBeGreaterThan(0);
    expect(three.sessions).toEqual([]);
  });

  it('stays within the budget', async () => {
    for (const [budget, question] of [[1000, 'Orchard Co milestone demo invoices'], [2500, 'Orchard Co milestone demo agenda'], [6000, 'Orchard Co milestone demo'], [1000, `Orchard Co demo ${'very long question '.repeat(100)}`]] as const) {
      const result = await buildContext(ME, { question, budget, depth: 4 }, { readPage });
      expect(result.text.length, String(budget)).toBeLessThanOrEqual(budget);
      expect(result.used).toBe(result.text.length);
    }
  });
});

describe('trimPage', () => {
  it('keeps whole lines and says when it cut', () => {
    expect(trimPage('a\nbb\nccc', 100)).toEqual({ text: 'a\nbb\nccc', truncated: false });
    const cut = trimPage('line one\n'.repeat(50), 120);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(120);
    expect(cut.text).toMatch(/\[trimmed/);
  });
});

describe('search_sessions with cards', () => {
  it('finds a chat by its card first and marks the tier', async () => {
    const hits = await searchSessions(ME, { query: 'agenda', brain: ORCHARD });
    expect(hits.map((h) => [h.id, h.match])).toEqual([['c1', 'card']]);
    expect(hits[0]!.card).toMatch(/agenda/);
  });

  it('still finds body-only matches after the card matches', async () => {
    const hits = await searchSessions(ME, { query: 'milestone demo', brain: ORCHARD });
    expect(hits.map((h) => h.id)).toEqual(['c1', 'c2']);
    expect(hits.map((h) => h.match)).toEqual(['card', 'body']);
  });

  it('never returns another person\'s card match', async () => {
    const hits = await searchSessions(ME, { query: 'secret' });
    expect(hits).toEqual([]);
  });
});

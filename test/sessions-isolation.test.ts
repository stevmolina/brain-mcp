/**
 * Chats are private: a test, not an assumption.
 *
 * Two invented people. Alice owns chats; Bob owns one of his own. Every read
 * path is asked for Alice's chats while acting as Bob, and must return nothing
 * until Alice shares one, then exactly that chat and only its granted turns,
 * and nothing again once the share is revoked or expires. No tenant data here.
 */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.SESSIONS_DATABASE_URL ||= process.env.DATABASE_URL;

const { closeSessionsDb, migrateSessions, sessionsDb } = await import('../src/sessions/db.js');
const store = await import('../src/sessions/store.js');

const ALICE = 'user_sessions_test_alice';
const BOB = 'user_sessions_test_bob';
const BOB_EMAIL = 'bob@sessions-test.invalid';
const CAROL_EMAIL = 'carol@sessions-test.invalid';
const SRC = 'isotest';

const alice = { userId: ALICE, email: 'alice@sessions-test.invalid' };
const bob = { userId: BOB, email: BOB_EMAIL };

const ALICE_PLAN = 'alice-plan-0001';
const ALICE_DIARY = 'alice-diary-0002';
const BOB_NOTES = 'bob-notes-0003';

function turns(...texts: string[]) {
  return JSON.stringify(texts.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', text })));
}

async function seed(id: string, owner: string, brain: string | null, title: string, texts: string[]) {
  await sessionsDb().query(
    `insert into sessions (source, id, machine, provider, cwd, title, started_at, updated_at, body, turns, owner, brain)
     values ($1, $2, 'test-box', 'claude', '/work', $3, now() - interval '2 days', now() - interval '1 day', $4, $5::jsonb, $6, $7)`,
    [SRC, id, title, texts.join('\n'), turns(...texts), owner, brain],
  );
}

async function cleanup() {
  await sessionsDb().query('delete from brain_mcp.session_shares where source = $1', [SRC]);
  await sessionsDb().query('delete from sessions where source = $1', [SRC]);
}

beforeAll(async () => {
  await sessionsDb().query(await readFile(new URL('./fixtures/sessions-table.sql', import.meta.url), 'utf8'));
  await migrateSessions();
  await cleanup();
  await seed(ALICE_PLAN, ALICE, 'test-org/alpha-knowledge', 'Pelican migration plan', [
    'Where should the pelican service run?',
    'Run pelican in Frankfurt, close to the data.',
    'Agreed, Frankfurt it is. Budget is 4200 per month.',
    'Noted: Frankfurt, 4200 monthly.',
  ]);
  await seed(ALICE_DIARY, ALICE, null, 'Private diary', ['The walrus password hint is the lighthouse.', 'Understood.']);
  await seed(BOB_NOTES, BOB, 'test-org/beta-knowledge', 'Bob builds a kiosk', ['Kiosk runs in Sydney.', 'Fine.']);
});

afterAll(async () => {
  await cleanup();
  await closeSessionsDb();
});

describe('before any share, Bob sees none of Alice\'s chats', () => {
  it('search for her words finds nothing', async () => {
    expect(await store.searchSessions(BOB, { query: 'pelican Frankfurt' })).toEqual([]);
    expect(await store.searchSessions(BOB, { query: 'walrus lighthouse' })).toEqual([]);
  });

  it('listing his recent chats shows only his own', async () => {
    const mine = await store.searchSessions(BOB, {});
    expect(mine.map((s) => s.id).filter((id) => [ALICE_PLAN, ALICE_DIARY, BOB_NOTES].includes(id))).toEqual([BOB_NOTES]);
  });

  it('filtering by her brain finds nothing', async () => {
    expect(await store.searchSessions(BOB, { brain: 'test-org/alpha-knowledge' })).toEqual([]);
  });

  it('opening her chat by id, or source:id, returns nothing', async () => {
    expect(await store.openSession(bob, { session: ALICE_PLAN })).toBeNull();
    expect(await store.openSession(bob, { session: `${SRC}:${ALICE_PLAN}` })).toBeNull();
    expect(await store.findOwnSession(BOB, { session: ALICE_PLAN })).toBeNull();
  });

  it('cannot share her chat or see her facets', async () => {
    await expect(store.planShare(BOB, { session: ALICE_PLAN, email: CAROL_EMAIL })).rejects.toBeInstanceOf(store.ShareRefused);
    const facets = await store.sessionFacets(BOB);
    expect(facets.brains.map((b) => b.brain)).not.toContain('test-org/alpha-knowledge');
  });

  it('Alice does see her own, so the queries do work', async () => {
    const hits = await store.searchSessions(ALICE, { query: 'pelican Frankfurt' });
    expect(hits.map((h) => h.id)).toEqual([ALICE_PLAN]);
    expect(hits[0]!.snippet).toMatch(/<b>/);
    const opened = await store.openSession(alice, { session: ALICE_PLAN });
    expect(opened?.access).toBe('owner');
    expect(opened?.turns).toHaveLength(4);
  });
});

describe('after Alice shares turns 2 to 3 of one chat with Bob', () => {
  let shareId = '';

  beforeAll(async () => {
    const plan = await store.planShare(ALICE, { session: ALICE_PLAN, email: 'Bob@Sessions-Test.invalid', turnFrom: 2, turnTo: 3 });
    expect(plan.email).toBe(BOB_EMAIL);
    expect(store.describePlan(plan)).toContain('turns 2 to 3 of 4');
    shareId = (await store.createShare(plan)).id;
  });

  it('Bob opens exactly that chat, by share id or chat id', async () => {
    for (const session of [shareId, ALICE_PLAN]) {
      const opened = await store.openSession(bob, { session });
      expect(opened?.id).toBe(ALICE_PLAN);
      expect(opened?.access).toBe('shared');
      expect(opened?.share?.id).toBe(shareId);
      expect(opened?.allowed).toEqual({ from: 2, to: 3 });
      expect(opened?.turns.map((t) => t.text)).toEqual([
        'Run pelican in Frankfurt, close to the data.',
        'Agreed, Frankfurt it is. Budget is 4200 per month.',
      ]);
    }
  });

  it('asking for turns outside the range is clamped to it', async () => {
    const opened = await store.openSession(bob, { session: shareId }, { from: 1, max: 10 });
    expect(opened?.window).toEqual({ from: 2, to: 3 });
    const late = await store.openSession(bob, { session: shareId }, { from: 4, max: 10 });
    expect(late?.turns).toEqual([]);
  });

  it('her other chat stays invisible, and his search still returns none of hers', async () => {
    expect(await store.openSession(bob, { session: ALICE_DIARY })).toBeNull();
    expect(await store.searchSessions(BOB, { query: 'pelican' })).toEqual([]);
  });

  it('only Bob\'s verified email opens it', async () => {
    expect(await store.openSession({ userId: BOB, email: null }, { session: shareId })).toBeNull();
    expect(await store.openSession({ userId: 'user_sessions_test_carol', email: CAROL_EMAIL }, { session: shareId })).toBeNull();
  });

  it('it shows up in his shared list and her shares list', async () => {
    expect((await store.listSharedWithMe(BOB_EMAIL)).map((s) => s.id)).toContain(shareId);
    expect((await store.listSharedWithMe(CAROL_EMAIL)).map((s) => s.id)).not.toContain(shareId);
    expect((await store.listMyShares(ALICE)).map((s) => s.id)).toContain(shareId);
    expect((await store.listMyShares(BOB)).map((s) => s.id)).not.toContain(shareId);
  });

  it('Bob cannot revoke it; Alice can, and then it is gone', async () => {
    expect(await store.revokeShare(BOB, shareId)).toBe(false);
    expect(await store.openSession(bob, { session: shareId })).not.toBeNull();
    expect(await store.revokeShare(ALICE, shareId)).toBe(true);
    expect(await store.openSession(bob, { session: shareId })).toBeNull();
    expect(await store.openSession(bob, { session: ALICE_PLAN })).toBeNull();
    expect((await store.listSharedWithMe(BOB_EMAIL)).map((s) => s.id)).not.toContain(shareId);
  });
});

describe('a share stops working', () => {
  it('when it expires', async () => {
    const plan = await store.planShare(ALICE, { session: ALICE_DIARY, email: BOB_EMAIL, expires: 1 });
    const share = await store.createShare(plan);
    expect(await store.openSession(bob, { session: share.id })).not.toBeNull();
    await sessionsDb().query(`update brain_mcp.session_shares set expires_at = now() - interval '1 minute' where id = $1`, [share.id]);
    expect(await store.openSession(bob, { session: share.id })).toBeNull();
    expect((await store.listMyShares(ALICE)).find((s) => s.id === share.id)?.status).toBe('expired');
  });

  it('when the chat no longer belongs to the person who shared it', async () => {
    const share = await store.createShare(await store.planShare(ALICE, { session: ALICE_DIARY, email: BOB_EMAIL }));
    await sessionsDb().query('update sessions set owner = $1 where source = $2 and id = $3', ['user_sessions_test_other', SRC, ALICE_DIARY]);
    try {
      expect(await store.openSession(bob, { session: share.id })).toBeNull();
    } finally {
      await sessionsDb().query('update sessions set owner = $1 where source = $2 and id = $3', [ALICE, SRC, ALICE_DIARY]);
    }
  });
});

describe('share input', () => {
  it('refuses bad emails and ranges', async () => {
    await expect(store.planShare(ALICE, { session: ALICE_PLAN, email: 'not-an-email' })).rejects.toThrow(/not an email/);
    await expect(store.planShare(ALICE, { session: ALICE_PLAN, email: BOB_EMAIL, turnFrom: 9 })).rejects.toThrow(/between 1 and 4/);
    await expect(store.planShare(ALICE, { session: ALICE_PLAN, email: BOB_EMAIL, turnFrom: 3, turnTo: 2 })).rejects.toThrow(/to_turn/);
  });

  it('parses expiry: default 30 days, days, dates, never; refuses the past', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(store.parseExpiry(undefined, now)?.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(store.parseExpiry(7, now)?.toISOString()).toBe('2026-01-08T00:00:00.000Z');
    expect(store.parseExpiry('7', now)?.toISOString()).toBe('2026-01-08T00:00:00.000Z');
    expect(store.parseExpiry('2026-02-01', now)?.toISOString()).toBe('2026-02-01T23:59:59.000Z');
    expect(store.parseExpiry('never', now)).toBeNull();
    expect(() => store.parseExpiry('2025-12-01', now)).toThrow(/future/);
    expect(() => store.parseExpiry('soon', now)).toThrow(/not a date/);
  });

  it('reads source:id and plain ids', () => {
    expect(store.parseRef({ session: 'claude:abc-123' })).toEqual({ source: 'claude', id: 'abc-123' });
    expect(store.parseRef({ session: 'abc-123' })).toEqual({ source: null, id: 'abc-123' });
    expect(store.parseRef({ session: 'abc', source: 'codex' })).toEqual({ source: 'codex', id: 'abc' });
  });
});

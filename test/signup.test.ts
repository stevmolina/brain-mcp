/**
 * Self-serve signup. Invented users only. A hosted brain is created from the
 * WorkOS user id, notes are searchable immediately, and the Free cap refuses
 * the next one. A git brain is not capped.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { Forbidden, requireBrain } from '../src/auth/access.js';
import { readAuthState, sealSession } from '../src/auth/session.js';
import { FREE_NOTE_LIMIT } from '../src/billing/plans.js';
import { getAccount, provisionAccount, starterBrainId } from '../src/hosted/brain.js';
import { assertCanAddNote, countClaims, PlanLimit, rememberHosted } from '../src/hosted/notes.js';
import { searchClaims } from '../src/tools/read.js';
import { createApp } from '../src/index.js';
import type { BrainRow } from '../src/types.js';

const ADA = 'user_signup_test_ada';
const BEA = 'user_signup_test_bea';
const LINK_SECRET = 'test-link-secret';

process.env.BILLING_LINK_SECRET = LINK_SECRET;

let server: Server | undefined;
let base: string;

beforeAll(async () => {
  await migrate();
  await cleanup();
  const app = await createApp();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) {
    const listening = server;
    await new Promise<void>((resolve, reject) => listening.close((err) => (err ? reject(err) : resolve())));
  }
  await cleanup();
  await closeDb();
});

async function cleanup() {
  const ids = [starterBrainId(ADA), starterBrainId(BEA), starterBrainId('user_http_signup'), 'signup-test/repo'];
  await db().query('delete from brains where id = any($1::text[])', [ids]);
  await db().query('delete from accounts where workos_user_id = any($1::text[])', [
    [ADA, BEA, 'user_http_signup'],
  ]);
}

describe('provisioning a starter brain', () => {
  it('creates a free account, a hosted brain, and a searchable welcome note', async () => {
    const first = await provisionAccount({ id: ADA, email: 'ada@example.com' });
    expect(first.created).toBe(true);
    expect(first.account.plan).toBe('free');
    expect(first.brain.kind).toBe('hosted');
    expect(first.brain.owner_github_login).toBeNull();
    expect(first.brain.id).toBe(starterBrainId(ADA));
    expect(await countClaims(first.brain.id)).toBe(1);

    const hits = await searchClaims(first.brain, 'starter', 5);
    expect(hits.map((hit) => hit.text)).toEqual(['This starter brain is ready for notes.']);
    expect(hits[0]?.url).toBe('wiki/index.md#L5');
    expect(hits[0]?.url).not.toContain('github.com');

    const again = await provisionAccount({ id: ADA, email: 'ada.renamed@example.com' });
    expect(again.created).toBe(false);
    expect(again.account.email).toBe('ada.renamed@example.com');
    expect(await countClaims(first.brain.id)).toBe(1);
  });

  it('records a note immediately and hides it from someone else', async () => {
    const { brain } = await provisionAccount({ id: ADA, email: 'ada.renamed@example.com' });
    await rememberHosted(brain, { text: 'Launch is November 4.' });
    const hits = await searchClaims(brain, 'November', 5);
    expect(hits.map((hit) => hit.text)).toContain('Launch is November 4.');

    await provisionAccount({ id: BEA, email: 'bea@example.com' });
    await expect(requireBrain(BEA, brain.id)).rejects.toBeInstanceOf(Forbidden);
    const beaBrain = await requireBrain(BEA);
    const leaked = await searchClaims(beaBrain, 'November', 5);
    expect(leaked).toEqual([]);
  });

  it('refuses the note past the Free cap and says how to upgrade', async () => {
    const { brain } = await provisionAccount({ id: ADA, email: 'ada.renamed@example.com' });
    const have = await countClaims(brain.id);
    for (let i = have; i < FREE_NOTE_LIMIT; i++) {
      await rememberHosted(brain, { text: `Note number ${i} is kept.` });
    }
    expect(await countClaims(brain.id)).toBe(FREE_NOTE_LIMIT);
    await expect(rememberHosted(brain, { text: 'This one does not fit.' })).rejects.toBeInstanceOf(PlanLimit);
    await expect(rememberHosted(brain, { text: 'This one does not fit.' })).rejects.toThrow(/Team \(\$10\/mo\)/);
    await expect(rememberHosted(brain, { text: 'This one does not fit.' })).rejects.toThrow(/\/billing\/checkout/);
    expect(await countClaims(brain.id)).toBe(FREE_NOTE_LIMIT);
  });

  it('does not cap a git brain', async () => {
    await db().query(
      `insert into brains (id, owner_workos_user_id, owner_github_login, repo_owner, repo_name, kind)
       values ('signup-test/repo', $1, 'signup-test', 'signup-test', 'repo', 'github')`,
      [ADA],
    );
    for (let i = 0; i < FREE_NOTE_LIMIT + 1; i++) {
      await db().query(
        `insert into claims (id, brain_id, text, page_path, line, commit_sha)
         values ($1, 'signup-test/repo', $2, 'wiki/index.md', $3, 'abc')`,
        [`signup-claim-${i}`, `Git note ${i} stays.`, i + 1],
      );
    }
    const { rows } = await db().query<BrainRow>('select * from brains where id = $1', ['signup-test/repo']);
    await expect(assertCanAddNote(rows[0]!)).resolves.toBeUndefined();
  });
});

describe('the signup routes', () => {
  it('sends a new person to AuthKit, and Team checkout after they return', async () => {
    const res = await fetch(`${base}/signup`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/user_management/authorize');
    expect(location.searchParams.get('provider')).toBe('authkit');
    expect(location.searchParams.get('screen_hint')).toBe('sign-up');
    expect(location.searchParams.get('redirect_uri')).toBe(`${base}/auth/callback`);
    const state = readAuthState(location.searchParams.get('state') ?? '', LINK_SECRET);
    expect(state?.next).toBe('app');

    const team = await fetch(`${base}/signup?plan=team`, { redirect: 'manual' });
    const teamUrl = new URL(team.headers.get('location') ?? '');
    expect(readAuthState(teamUrl.searchParams.get('state') ?? '', LINK_SECRET)?.next).toBe('checkout');
  });

  it('turns the callback into a session and a starter brain', async () => {
    const start = await fetch(`${base}/signup`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/user_management/authenticate')) {
        return new Response(JSON.stringify({ user: { id: 'user_http_signup', email: 'new@example.com' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const res = await fetch(`${base}/auth/callback?code=ok&state=${encodeURIComponent(state ?? '')}`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/app');
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('brain_session=');
      const account = await getAccount('user_http_signup');
      expect(account?.email).toBe('new@example.com');
      expect(account?.plan).toBe('free');

      const app = await fetch(`${base}/app`, { headers: { cookie: cookie.split(';')[0]! }, redirect: 'manual' });
      expect(app.status).toBe(200);
      const html = await app.text();
      expect(html).toContain('new@example.com');
      expect(html).toContain('Connect Claude, ChatGPT, or Cursor');
      expect(html).toContain('https://brain.mcpbox.dev/mcp');
      expect(html).toContain('1 of 5 notes');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('saves a note from the page and finds it with search', async () => {
    const cookie = `brain_session=${encodeURIComponent(sealSession({ sub: 'user_http_signup', email: 'new@example.com' }, LINK_SECRET))}`;
    const saved = await fetch(`${base}/app/notes`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'text=The+warehouse+is+in+Lisbon.',
      redirect: 'manual',
    });
    expect(saved.status).toBe(303);
    const page = await fetch(`${base}/app?q=Lisbon`, { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('The warehouse is in Lisbon.');
    expect(html).toContain('1 result');
  });
});

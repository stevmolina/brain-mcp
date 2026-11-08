/**
 * The web pages: signed out gets a login redirect, signed in gets only your own
 * chats, a share link opens only for its email, and a cross-site post is
 * refused. Identity is mocked; the people and chats are invented.
 */
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.SESSIONS_DATABASE_URL ||= process.env.DATABASE_URL;
process.env.WEB_SESSION_SECRET = 'web-test-secret-0123456789abcdef-0123456789';

const PEOPLE: Record<string, { email: string; name: string }> = {
  user_web_test_owner: { email: 'owner@web-test.invalid', name: 'Olive Owner' },
  user_web_test_reader: { email: 'reader@web-test.invalid', name: 'Reed Reader' },
  user_web_test_stranger: { email: 'stranger@web-test.invalid', name: 'Sam Stranger' },
};
vi.mock('../src/auth/identity.js', () => ({
  workosProfile: vi.fn(async (id: string) => (PEOPLE[id] ? { id, verifiedEmail: PEOPLE[id].email, name: PEOPLE[id].name } : null)),
  verifiedEmailOf: vi.fn(async (id: string) => PEOPLE[id]?.email ?? null),
  clearIdentityCache: vi.fn(),
}));

const { createApp } = await import('../src/index.js');
const { sessionCookieFor, safeNext } = await import('../src/web/auth.js');
const { loadWebConfig } = await import('../src/config.js');
const { closeSessionsDb, migrateSessions, sessionsDb } = await import('../src/sessions/db.js');

const SRC = 'webtest';
let server: Server;
let base: string;
const web = loadWebConfig()!;
const cookie = (user: string) => `bm_session=${encodeURIComponent(sessionCookieFor(user, web))}`;

beforeAll(async () => {
  await sessionsDb().query(await readFile(new URL('./fixtures/sessions-table.sql', import.meta.url), 'utf8'));
  await migrateSessions();
  await sessionsDb().query('delete from brain_mcp.session_shares where source = $1', [SRC]);
  await sessionsDb().query('delete from sessions where source = $1', [SRC]);
  await sessionsDb().query(
    `insert into sessions (source, id, machine, provider, title, started_at, updated_at, body, turns, owner, brain) values
     ($1, 'web-owner-1', 'box', 'claude', 'Heron launch checklist', now(), now(), 'heron launch on tuesday',
      '[{"role":"user","text":"heron launch on tuesday?"},{"role":"assistant","text":"Yes, tuesday."}]', 'user_web_test_owner', 'web-test/heron'),
     ($1, 'web-owner-2', 'box', 'codex', 'Secret recipe', now(), now(), 'otter secret recipe',
      '[{"role":"user","text":"otter secret recipe"}]', 'user_web_test_owner', null)`,
    [SRC],
  );
  const app = await createApp();
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await sessionsDb().query('delete from brain_mcp.session_shares where source = $1', [SRC]);
  await sessionsDb().query('delete from sessions where source = $1', [SRC]);
  await closeSessionsDb();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('signed out', () => {
  it('pages redirect to login, keeping where you were going', async () => {
    const res = await fetch(`${base}/sessions`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?next=%2Fsessions');
    const share = await fetch(`${base}/s/abc123`, { redirect: 'manual' });
    expect(share.headers.get('location')).toBe('/login?next=%2Fs%2Fabc123');
  });

  it('the API answers 401', async () => {
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
  });

  it('login sends the browser to AuthKit with PKCE, as a CIMD client', async () => {
    const res = await fetch(`${base}/login?next=/s/xyz`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.origin).toBe(process.env.AUTHKIT_ISSUER);
    expect(url.searchParams.get('client_id')).toBe('https://brain.mcpbox.dev/oauth/client-metadata.json');
    expect(url.searchParams.get('redirect_uri')).toBe('https://brain.mcpbox.dev/auth/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe('https://brain.mcpbox.dev/mcp');
    expect(res.headers.get('set-cookie')).toMatch(/bm_oauth=.*HttpOnly; SameSite=Lax; Secure/);
  });

  it('serves the client metadata document AuthKit reads', async () => {
    const doc = await (await fetch(`${base}/oauth/client-metadata.json`)).json();
    expect(doc).toMatchObject({
      client_id: 'https://brain.mcpbox.dev/oauth/client-metadata.json',
      redirect_uris: ['https://brain.mcpbox.dev/auth/callback'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('a forged or stale callback is refused', async () => {
    const res = await fetch(`${base}/auth/callback?code=x&state=y`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  it('a forged cookie is ignored', async () => {
    const forged = `bm_session=${Buffer.from(JSON.stringify({ sub: 'user_web_test_owner', exp: Date.now() + 1e6 })).toString('base64url')}.bad`;
    expect((await fetch(`${base}/api/sessions`, { headers: { cookie: forged } })).status).toBe(401);
  });

  it('next only allows same-site paths', () => {
    expect(safeNext('/s/abc')).toBe('/s/abc');
    expect(safeNext('//evil.example')).toBe('/sessions');
    expect(safeNext('https://evil.example')).toBe('/sessions');
    expect(safeNext('/\\evil')).toBe('/sessions');
  });
});

describe('signed in', () => {
  it('the owner finds their chat, filtered by client and tool', async () => {
    const res = await fetch(`${base}/api/sessions?q=heron&brain=web-test/heron`, { headers: { cookie: cookie('user_web_test_owner') } });
    const { sessions } = await res.json();
    expect(sessions.map((s: { id: string }) => s.id)).toEqual(['web-owner-1']);
    const byTool = await (await fetch(`${base}/api/sessions?tool=codex&q=otter`, { headers: { cookie: cookie('user_web_test_owner') } })).json();
    expect(byTool.sessions.map((s: { id: string }) => s.id)).toEqual(['web-owner-2']);
  });

  it('someone else sees none of the owner\'s chats', async () => {
    const res = await fetch(`${base}/api/sessions?q=heron`, { headers: { cookie: cookie('user_web_test_reader') } });
    expect((await res.json()).sessions).toEqual([]);
    const open = await fetch(`${base}/api/session?session=web-owner-1`, { headers: { cookie: cookie('user_web_test_reader') } });
    expect(open.status).toBe(404);
  });

  it('a share needs this site\'s Origin', async () => {
    const res = await fetch(`${base}/api/shares`, {
      method: 'POST',
      headers: { cookie: cookie('user_web_test_owner'), 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ session: 'web-owner-1', with: 'reader@web-test.invalid' }),
    });
    expect(res.status).toBe(403);
  });

  it('preview, share, open as the reader, refused to a stranger, revoke', async () => {
    const owner = { cookie: cookie('user_web_test_owner'), 'content-type': 'application/json', origin: 'https://brain.mcpbox.dev' };
    const body = JSON.stringify({ session: 'web-owner-1', source: SRC, with: 'reader@web-test.invalid', expires: 7 });

    const preview = await (await fetch(`${base}/api/shares/preview`, { method: 'POST', headers: owner, body })).json();
    expect(preview.preview).toContain('With: reader@web-test.invalid');
    expect((await (await fetch(`${base}/api/shares`, { headers: owner })).json()).shares).toEqual([]);

    const created = await fetch(`${base}/api/shares`, { method: 'POST', headers: owner, body });
    expect(created.status).toBe(201);
    const { share, link } = await created.json();
    expect(link).toBe(`https://brain.mcpbox.dev/s/${share.id}`);

    const asReader = await fetch(`${base}/api/share/${share.id}`, { headers: { cookie: cookie('user_web_test_reader') } });
    expect(asReader.status).toBe(200);
    const opened = await asReader.json();
    expect(opened.owner).toBe('Olive Owner');
    expect(opened.session.title).toBe('Heron launch checklist');
    expect(opened.session.ownerId).toBeUndefined();
    expect(opened.session.turns).toHaveLength(2);

    const listed = await (await fetch(`${base}/api/shared-with-me`, { headers: { cookie: cookie('user_web_test_reader') } })).json();
    expect(listed.shares.map((s: { id: string }) => s.id)).toEqual([share.id]);
    // The reader still has no chats of their own, and cannot see the owner's other chat.
    expect((await (await fetch(`${base}/api/sessions?q=otter`, { headers: { cookie: cookie('user_web_test_reader') } })).json()).sessions).toEqual([]);

    const asStranger = await fetch(`${base}/api/share/${share.id}`, { headers: { cookie: cookie('user_web_test_stranger') } });
    expect(asStranger.status).toBe(404);

    const revoke = await fetch(`${base}/api/shares/${share.id}/revoke`, { method: 'POST', headers: owner });
    expect(revoke.status).toBe(200);
    expect((await fetch(`${base}/api/share/${share.id}`, { headers: { cookie: cookie('user_web_test_reader') } })).status).toBe(404);
  });

  it('serves the page to a signed-in user, not cacheable and not frameable', async () => {
    const res = await fetch(`${base}/sessions`, { headers: { cookie: cookie('user_web_test_owner') } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(await res.text()).toContain('/app/app.js');
  });
});

/**
 * Personal access tokens, and above all their brain scoping: a token made for
 * one brain must never reach another, by any path. Sits beside
 * test/isolation.test.ts. Invented brains and users only.
 */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.SESSIONS_DATABASE_URL = process.env.DATABASE_URL;

const { closeDb, db } = await import('../src/db/client.js');
const { migrate } = await import('../src/db/migrate.js');
const { sessionsDb, closeSessionsDb, migrateSessions } = await import('../src/sessions/db.js');
const { searchSessions } = await import('../src/sessions/store.js');
const { createTokenVerifier } = await import('../src/auth/workos.js');
const { Forbidden, accessibleBrains, clearAccessCaches, githubLoginForWorkosUser, requireBrain, requireBrainWriter } =
  await import('../src/auth/access.js');
const { createAccessToken, hashToken, listAccessTokens, revokeAccessToken, scopeOf } = await import('../src/auth/tokens.js');
const { verifiedEmailOf } = await import('../src/auth/identity.js');
const { listBrains } = await import('../src/tools/brains.js');

const USER = 'user_tokentestowner';
const STRANGER = 'user_tokenteststranger';
const CLIENT_A = 'token-test/client-a';
const CLIENT_B = 'token-test/client-b';
const PERSONAL = 'token-test/personal';
const NOT_MINE = 'token-test/not-mine';

async function brain(id: string, owner: string) {
  await db().query(
    `insert into brains (id, owner_workos_user_id, owner_github_login, repo_owner, repo_name) values ($1, $2, $2, 'token-test', $3)`,
    [id, owner, id.split('/')[1]],
  );
}
async function clean() {
  await db().query("delete from brains where id like 'token-test/%'");
  await sessionsDb().query("delete from brain_mcp.access_tokens where name like 'token-test%'");
  await sessionsDb().query("delete from sessions where source = 'tokentest'");
}

const verifier = () => createTokenVerifier({ allowAccessTokens: true });
const realFetch = globalThis.fetch;

beforeAll(async () => {
  // No WorkOS here: only registered owners reach brains, nobody has a GitHub login.
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) =>
    String(url).includes('api.workos.com') ? new Response(null, { status: 404 }) : realFetch(url, init),
  );
  await migrate();
  await sessionsDb().query(await readFile(new URL('./fixtures/sessions-table.sql', import.meta.url), 'utf8'));
  await migrateSessions();
  clearAccessCaches();
  await clean();
  for (const id of [CLIENT_A, CLIENT_B, PERSONAL]) await brain(id, USER);
  await brain(NOT_MINE, STRANGER);
  await sessionsDb().query(
    `insert into sessions (source, id, machine, provider, title, body, turns, owner, brain)
     values ('tokentest', 'chat-1', 'box', 'codex', 'Owner chat about client a', 'client a plans', '[]', $1, $2)`,
    [USER, CLIENT_A],
  );
});

afterAll(async () => {
  await clean();
  await closeSessionsDb();
  await closeDb();
  vi.unstubAllGlobals();
});

describe('making and verifying tokens', () => {
  it('stores only a hash and shows the token once', async () => {
    const { id, token } = await createAccessToken({ workosUserId: USER, name: 'token-test hash' });
    expect(token).toMatch(/^bmt_[A-Za-z0-9_-]{43}$/);
    const { rows } = await sessionsDb().query('select * from brain_mcp.access_tokens where id = $1', [id]);
    expect(JSON.stringify(rows)).not.toContain(token.slice(4));
    expect(rows[0].token_hash).toBe(hashToken(token));
    expect((await listAccessTokens(USER)).map((t) => t.id)).toContain(id);
  });

  it('accepts an unscoped token as its user', async () => {
    const { token } = await createAccessToken({ workosUserId: USER, name: 'token-test unscoped' });
    const info = await verifier().verifyAccessToken(token);
    expect(info.extra).toMatchObject({ workosUserId: USER });
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it('rejects an unknown, a revoked, and a disabled-endpoint token as invalid_token', async () => {
    const { id, token } = await createAccessToken({ workosUserId: USER, name: 'token-test revoke' });
    const invalid = (e: unknown) => (e as { code?: string }).code === 'invalid_token';
    await expect(verifier().verifyAccessToken(`bmt_${'x'.repeat(43)}`)).rejects.toSatisfy(invalid);
    await expect(createTokenVerifier().verifyAccessToken(token)).rejects.toSatisfy(invalid);
    expect(await revokeAccessToken(id)).toBe(true);
    await expect(verifier().verifyAccessToken(token)).rejects.toSatisfy(invalid);
  });

  it('refuses a user id that is not a WorkOS id', async () => {
    await expect(createAccessToken({ workosUserId: 'pat:tok_x', name: 'token-test bad' })).rejects.toThrow();
  });
});

describe('a token scoped to one brain', () => {
  let principal: string;
  let tokenId: string;

  beforeAll(async () => {
    const made = await createAccessToken({ workosUserId: USER, name: 'token-test scoped', brains: [CLIENT_A] });
    tokenId = made.id;
    principal = (await verifier().verifyAccessToken(made.token)).extra!.workosUserId as string;
  });

  it('acts as a scoped principal, not as the user', () => {
    expect(principal).toBe(`pat:${tokenId}`);
  });

  it('reaches its brain', async () => {
    expect((await requireBrain(principal, CLIENT_A)).id).toBe(CLIENT_A);
    expect((await requireBrain(principal)).id).toBe(CLIENT_A);
  });

  it('never reaches the user\'s other brains, with the same answer as a missing brain', async () => {
    for (const other of [CLIENT_B, PERSONAL]) {
      const denied = await requireBrain(principal, other).catch((e: Error) => e);
      expect(denied).toBeInstanceOf(Forbidden);
      const missing = await requireBrain(principal, 'token-test/missing').catch((e: Error) => e.message);
      expect((denied as Error).message).toBe(missing.replace('token-test/missing', other));
      await expect(requireBrainWriter(principal, other)).rejects.toBeInstanceOf(Forbidden);
    }
  });

  it('lists only its brain', async () => {
    expect((await accessibleBrains(principal)).map((b) => b.id)).toEqual([CLIENT_A]);
    const listed = await listBrains(principal);
    expect(JSON.stringify(listed)).not.toContain(CLIENT_B);
    expect(JSON.stringify(listed)).not.toContain(PERSONAL);
  });

  it('gains nothing from listing a brain its user cannot read', async () => {
    const made = await createAccessToken({ workosUserId: USER, name: 'token-test overreach', brains: [NOT_MINE] });
    const p = (await verifier().verifyAccessToken(made.token)).extra!.workosUserId as string;
    await expect(requireBrain(p, NOT_MINE)).rejects.toBeInstanceOf(Forbidden);
    expect(await accessibleBrains(p)).toEqual([]);
  });

  it('reads no chats and has no email, so it cannot share or open shares', async () => {
    expect(await searchSessions(principal, { query: 'client' })).toEqual([]);
    expect(await searchSessions(USER, { query: 'client' })).toHaveLength(1);
    expect(await verifiedEmailOf(principal)).toBeNull();
  });

  it('stops working the moment it is revoked', async () => {
    const made = await createAccessToken({ workosUserId: USER, name: 'token-test live-revoke', brains: [CLIENT_A] });
    const p = (await verifier().verifyAccessToken(made.token)).extra!.workosUserId as string;
    expect((await requireBrain(p, CLIENT_A)).id).toBe(CLIENT_A);
    await revokeAccessToken(made.id);
    expect(await scopeOf(p)).toBeNull();
    await expect(requireBrain(p, CLIENT_A)).rejects.toBeInstanceOf(Forbidden);
    await expect(requireBrain(p)).rejects.toBeInstanceOf(Forbidden);
    expect(await accessibleBrains(p)).toEqual([]);
    expect(await githubLoginForWorkosUser(p)).toBeNull();
  });

  it('cannot be forged: a principal string for a token that does not exist reaches nothing', async () => {
    await expect(requireBrain('pat:tok_000000000000', CLIENT_A)).rejects.toBeInstanceOf(Forbidden);
    expect(await accessibleBrains('pat:tok_000000000000')).toEqual([]);
  });
});

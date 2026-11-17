import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

process.env.SESSIONS_DATABASE_URL = process.env.DATABASE_URL;
process.env.WEB_SESSION_SECRET = 'rest-test-secret-0123456789abcdef-0123456789';
const request = vi.hoisted(() => vi.fn());
const fileList = vi.hoisted(() => vi.fn(async () => ({ files: [], next_cursor: null })));
const fileGet = vi.hoisted(() => vi.fn(async () => ({ file: { path: 'input.txt' }, download_url: 'https://files.invalid/signed', expires_in_seconds: 900 })));
const fileAdd = vi.hoisted(() => vi.fn(async () => ({ status: 'stored', file: { path: 'input.txt', size: 4 } })));
const pr = vi.hoisted(() => vi.fn(async () => ({ url: 'https://github.com/example/notes/pull/1', branch: 'brain/test', page: 'wiki/index.md' })));
vi.mock('../src/github/app.js', () => ({
  installationOctokit: vi.fn(async () => ({ request })), appOctokit: vi.fn(),
  githubLoginForAccountId: vi.fn(async (id: string) => id),
}));
vi.mock('../src/files/index.js', () => ({ brainFilesFromEnv: () => ({ list: fileList, get: fileGet, add: fileAdd }) }));
vi.mock('../src/github/write.js', async (original) => ({ ...await original<object>(), openPullRequest: pr, commitDirect: vi.fn(async () => ({ mode: 'commit', commit: { sha: 'direct123', branch: 'main', url: 'https://github.com/example/notes/commit/direct123', page: 'wiki/index.md' } })) }));
vi.mock('../src/auth/identity.js', () => ({
  verifiedEmailOf: async (id: string) => `${id}@rest.invalid`,
  workosProfile: async (id: string) => ({ id, verifiedEmail: `${id}@rest.invalid`, name: id }),
}));

const { db, closeDb } = await import('../src/db/client.js');
const { migrate } = await import('../src/db/migrate.js');
const { sessionsDb, migrateSessions, closeSessionsDb } = await import('../src/sessions/db.js');
const { createApp } = await import('../src/index.js');
const { claimId } = await import('../src/indexer/parse.js');
const brain = 'rest-test/alpha';
const otherBrain = 'rest-test/beta';
const claim = claimId(brain, 'wiki/index.md', 'Fictional launch is Tuesday.');
let server: Server;
let base: string;
let key: Awaited<ReturnType<typeof generateKeyPair>>;
const realFetch = globalThis.fetch;
const issuer = process.env.AUTHKIT_ISSUER!;
const audience = process.env.MCP_RESOURCE_URL!;
async function token(user = 'rest-owner', overrides: { exp?: number; aud?: string; iss?: string } = {}) {
  return new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'rest-test' }).setSubject(user)
    .setIssuer(overrides.iss ?? issuer).setAudience(overrides.aud ?? audience)
    .setExpirationTime(overrides.exp ?? Math.floor(Date.now() / 1000) + 600).sign(key.privateKey);
}
async function call(path: string, user = 'rest-owner', body?: unknown) {
  return realFetch(`${base}/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${await token(user)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function clean() {
  await sessionsDb().query("delete from brain_mcp.session_shares where source = 'resttest'");
  await sessionsDb().query("delete from sessions where source = 'resttest'");
  await db().query('delete from brains where id = any($1)', [[brain, otherBrain]]);
}

beforeAll(async () => {
  key = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(key.publicKey), kid: 'rest-test', alg: 'RS256', use: 'sig' };
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target === `${issuer}/.well-known/oauth-authorization-server`) return Response.json({ issuer, authorization_endpoint: `${issuer}/oauth2/authorize`, token_endpoint: `${issuer}/oauth2/token`, jwks_uri: `${issuer}/oauth2/jwks`, response_types_supported: ['code'] });
    if (target === `${issuer}/oauth2/jwks`) return Response.json({ keys: [jwk] });
    if (target.includes('api.workos.com/user_management/users/')) {
      const id = target.split('/users/')[1]!.split('/')[0];
      return Response.json([{ provider: 'GitHubOAuth', idp_id: id }]);
    }
    return realFetch(url, init);
  });
  request.mockImplementation(async (route: string, args: Record<string, string>) => {
    if (route.endsWith('/collaborators/{username}')) {
      if (args.repo === 'alpha' && ['rest-reader', 'rest-writer'].includes(args.username!)) return { status: 204 };
      throw Object.assign(new Error('missing'), { status: 404 });
    }
    if (route.endsWith('/permission')) return { data: { permission: ['rest-writer', 'rest-owner'].includes(args.username!) ? 'write' : 'read' } };
    if (route.endsWith('/commits/{ref}')) return { data: { sha: 'abc123' } };
    if (route.endsWith('/git/trees/{tree_sha}')) return { data: { tree: [{ type: 'blob', path: 'wiki/index.md', sha: 'page123', size: 30 }], truncated: false } };
    if (route.endsWith('/commits')) return { data: [{ sha: 'abc123', commit: { message: 'Fictional change', committer: { date: '2026-11-17' } }, html_url: 'https://github.com/example/notes/commit/abc123' }] };
    if (route.endsWith('/contents/{path}')) return { data: { type: 'file', encoding: 'base64', content: Buffer.from('# Fictional page').toString('base64'), sha: 'page123', html_url: 'https://github.com/example/notes' } };
    throw new Error('Unexpected GitHub route');
  });
  await migrate();
  await sessionsDb().query(await readFile(new URL('./fixtures/sessions-table.sql', import.meta.url), 'utf8'));
  await migrateSessions();
  await clean();
  for (const [id, owner] of [[brain, 'rest-owner'], [otherBrain, 'rest-other']]) {
    await db().query(`insert into brains (id, owner_workos_user_id, owner_github_login, repo_owner, repo_name, installation_id) values ($1, $2, $2, 'rest-test', $3, 1)`, [id, owner, id!.split('/')[1]]);
  }
  await db().query(`insert into claims (id, brain_id, text, page_path, line, commit_sha) values ($1, $2, 'Fictional launch is Tuesday.', 'wiki/index.md', 1, 'abc123')`, [claim, brain]);
  await sessionsDb().query(`insert into sessions (source, id, machine, provider, title, body, turns, owner, brain) values ('resttest', 'rest-chat-1', 'box', 'codex', 'Fictional launch', 'Fictional launch Tuesday', '[{"role":"user","text":"Tuesday launch"}]', 'rest-owner', $1)`, [brain]);
  server = (await createApp()).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await clean(); await closeSessionsDb(); await closeDb(); vi.unstubAllGlobals();
});

describe('REST authentication and errors', () => {
  it('publishes OpenAPI without auth and describes every enabled operation', async () => {
    const response = await realFetch(`${base}/api/v1/openapi.json`);
    const doc = await response.json();
    expect(response.status).toBe(200);
    expect(Object.values(doc.paths).flatMap((methods: any) => Object.values(methods)).length).toBe(19);
    expect(doc.paths['/search'].get.parameters.find((p: any) => p.name === 'include_sessions').schema.type).toBe('boolean');
    expect(doc.paths['/search'].get.parameters.find((p: any) => p.name === 'limit').required).toBe(false);
  });
  it('rejects missing, invalid, expired, wrong issuer and wrong audience tokens; cookies do not grant access', async () => {
    for (const bearer of [undefined, 'invalid', await token('rest-owner', { exp: 1 }), await token('rest-owner', { aud: 'https://elsewhere.invalid' }), await token('rest-owner', { iss: 'https://elsewhere.invalid' })]) {
      const res = await realFetch(`${base}/api/v1/brains`, { headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), cookie: 'bm_session=forged' } });
      expect(res.status).toBe(401); expect(res.headers.get('www-authenticate')).toContain('Bearer');
      expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
    }
  });
  it('gives identical errors for absent and inaccessible brains on each brain endpoint', async () => {
    for (const path of ['/search?query=launch', `/claims/get?claim_id=${claim}`, `/claims/explain?claim_id=${claim}`, '/files?', '/files/get?path=input.txt', '/brains/overview?', '/pages/get?path=wiki/index.md']) {
      const separator = path.endsWith('?') ? '' : '&';
      const denied = await call(`${path}${separator}brain=${otherBrain}`);
      const missing = await call(`${path}${separator}brain=rest-test/missing`);
      expect(denied.status, path).toBe(404); expect(missing.status).toBe(404);
      expect(await denied.json()).toEqual(await missing.json());
    }
  });
  it('rejects bad input and malformed JSON without leaking internals', async () => {
    expect((await call(`/search?brain=${brain}&query=launch&include_sessions=no`)).status).toBe(400);
    const bad = await realFetch(`${base}/api/v1/remember`, { method: 'POST', headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' }, body: '{' });
    expect(bad.status).toBe(400); expect(await bad.json()).toMatchObject({ error: { code: 'invalid_json' } });
  });
});

describe('brain, claims, pages, files, writes, sessions and shares', () => {
  it('lists only accessible brains and scopes claim search/get/explain', async () => {
    expect((await (await call('/brains')).json()).brains.map((b: any) => b.id)).toContain(brain);
    expect((await (await call('/brains')).json()).brains.map((b: any) => b.id)).not.toContain(otherBrain);
    expect((await (await call(`/search?brain=${brain}&query=launch&limit=1&include_superseded=false`)).json()).claims[0].id).toBe(claim);
    expect((await (await call(`/claims/get?brain=${brain}&claim_id=${claim}`)).json()).claim.commit).toBe('abc123');
    const explained = await (await call(`/claims/explain?brain=${brain}&claim_id=${claim}`)).json();
    expect(explained.claim.id).toBe(claim); expect(explained.sources).toEqual([]);
    expect((await call(`/claims/get?brain=${otherBrain}&claim_id=${claim}`, 'rest-other')).status).toBe(404);
  });
  it('reads full pages and recent commits only after access, and rejects traversal', async () => {
    const overview = await (await call(`/brains/overview?brain=${brain}`)).json();
    expect(overview.pages[0].path).toBe('wiki/index.md'); expect(overview.recent_changes[0].sha).toBe('abc123');
    expect((await (await call(`/pages/get?brain=${brain}&path=wiki/index.md`)).json()).text).toBe('# Fictional page');
    expect((await call(`/pages/get?brain=${brain}&path=../secret.md`)).status).toBe(422);
  });
  it('lists files, signs downloads, and requires push for add-only uploads', async () => {
    expect((await call(`/files?brain=${brain}`, 'rest-reader')).status).toBe(200);
    expect((await (await call(`/files/get?brain=${brain}&path=input.txt`)).json()).download_url).toBe('https://files.invalid/signed');
    const previous = fileAdd.mock.calls.length;
    expect((await call('/files', 'rest-reader', { brain, path: 'input.txt', content: 'dGVzdA==' })).status).toBe(404);
    expect(fileAdd.mock.calls.length).toBe(previous);
    expect((await call('/files', 'rest-writer', { brain, path: 'input.txt', content: 'dGVzdA==' })).status).toBe(200);
  });
  it('preserves MCP reader PR proposals and returns the mode and PR URL for each claim write', async () => {
    for (const [path, fields] of [['/remember', { text: 'Fictional new fact.' }], ['/update-fact', { claim_id: claim, text: 'Fictional replacement.' }], ['/forget', { claim_id: claim }]] as const) {
      const denied = await call(path, 'rest-other', { brain, ...fields });
      expect(denied.status).toBe(404);
      const res = await call(path, 'rest-reader', { brain, ...fields });
      expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ mode: 'pull_request', recorded: false, pull_request: { url: 'https://github.com/example/notes/pull/1' } });
    }
  });
  it('returns the direct commit for an opted-in owner with current push access', async () => {
    await db().query(`update brains set profile = '{"directWrites":true}' where id = $1`, [brain]);
    try {
      const res = await call('/remember', 'rest-owner', { brain, text: 'Fictional direct fact.' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ mode: 'commit', recorded: true, commit: { sha: 'direct123' } });
    } finally { await db().query("update brains set profile = '{}' where id = $1", [brain]); }
  });
  it('keeps sessions private, includes turns and saves through the common write path', async () => {
    expect((await (await call('/sessions?query=Fictional&tool=codex')).json()).sessions.some((s: any) => s.id === 'rest-chat-1')).toBe(true);
    expect((await (await call('/sessions?query=Fictional', 'rest-other')).json()).sessions).toEqual([]);
    expect((await call('/sessions/show?session=rest-chat-1', 'rest-other')).status).toBe(422);
    const opened = await (await call('/sessions/show?session=rest-chat-1')).json();
    expect(opened.session.turns).toEqual([{ role: 'user', text: 'Tuesday launch' }]); expect(opened.session.ownerId).toBeUndefined();
    const saved = await call('/sessions/save-to-brain', 'rest-owner', { session: 'rest-chat-1', text: 'Fictional decision.', brain });
    expect(await saved.json()).toMatchObject({ mode: 'pull_request', pull_request: { url: 'https://github.com/example/notes/pull/1' } });
  });
  it('previews, creates, lists and revokes shares; only the recipient can read', async () => {
    const body = { session: 'rest-chat-1', with: 'rest-reader@rest.invalid', from_turn: 1, to_turn: 1 };
    expect((await (await call('/shares', 'rest-owner', body)).json()).preview).toBe(true);
    const created = await (await call('/shares', 'rest-owner', { ...body, confirm: true })).json();
    const id = created.share.id;
    expect((await (await call('/shares')).json()).shares.some((s: any) => s.id === id)).toBe(true);
    expect((await (await call('/shares/received', 'rest-reader')).json()).shares.some((s: any) => s.id === id)).toBe(true);
    expect((await call(`/sessions/show?session=${id}`, 'rest-reader')).status).toBe(200);
    expect((await call(`/sessions/show?session=${id}`, 'rest-other')).status).toBe(422);
    expect((await call('/shares/revoke', 'rest-other', { share: id })).status).toBe(422);
    expect((await call('/shares/revoke', 'rest-owner', { share: id })).status).toBe(200);
    expect((await call(`/sessions/show?session=${id}`, 'rest-reader')).status).toBe(422);
  });
  it('serves authenticated MCP calls through the same registration and access checks', async () => {
    const invoke = async (name: string, args: unknown) => {
      const res = await realFetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      return text.startsWith('event:') ? JSON.parse(text.split('data: ')[1]!.split('\n')[0]!) : JSON.parse(text);
    };
    const listed = await invoke('list_brains', {});
    expect(listed.result.structuredContent.brains.some((b: any) => b.id === brain)).toBe(true);
    const denied = await invoke('search', { brain: otherBrain, query: 'secret' });
    expect(denied.result.isError).toBe(true);
  });
  it('keeps browser routes and MCP challenges working', async () => {
    expect((await realFetch(`${base}/api/sessions`)).status).toBe(401);
    expect((await realFetch(`${base}/sessions`, { redirect: 'manual' })).status).toBe(302);
    expect((await realFetch(`${base}/mcp`)).status).toBe(401);
  });
});

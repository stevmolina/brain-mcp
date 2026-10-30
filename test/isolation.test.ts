/**
 * Isolation is a test, not an assumption.
 *
 * Two invented brains, owned by two different WorkOS users. Every read path is
 * asked a brain-A question while scoped to brain-B, and must return nothing of
 * A's. No tenant data here: both brains are fictional.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { Forbidden, requireBrain, requireBrainWriter } from '../src/auth/access.js';
import { listBrains } from '../src/tools/brains.js';
import { loadClaim } from '../src/tools/read.js';
import { claimId } from '../src/indexer/parse.js';

const A = 'isolation-test/alpha';
const B = 'isolation-test/beta';
const USER_A = 'user_isolation_test_alpha';
const USER_B = 'user_isolation_test_beta';

const SECRET_A = 'Alpha keeps its production database in Frankfurt.';
const SECRET_B = 'Beta keeps its production database in Sydney.';

const claimA = claimId(A, 'wiki/index.md', SECRET_A);
const claimB = claimId(B, 'wiki/index.md', SECRET_B);

async function seedBrain(id: string, user: string, text: string, claim: string) {
  await db().query(
    `insert into brains (id, owner_workos_user_id, owner_github_login, repo_owner, repo_name, default_branch)
     values ($1, $2, $3, $4, $5, 'main')`,
    [id, user, id.split('/')[0], id.split('/')[0], id.split('/')[1]],
  );
  await db().query(
    `insert into claims (id, brain_id, text, page_path, line, authority, verified_at, commit_sha)
     values ($1, $2, $3, 'wiki/index.md', 1, 'live', '2026-08-01', 'deadbeef')`,
    [claim, id, text],
  );
  await db().query(
    `insert into sources (id, brain_id, path, sha256, bytes, commit_sha)
     values ($1, $2, 'sources/raw/contract.pdf', repeat('a', 64), 10, 'deadbeef')`,
    [`src-${id}`, id],
  );
  await db().query(
    'insert into claim_sources (brain_id, claim_id, source_id) values ($1, $2, $3)',
    [id, claim, `src-${id}`],
  );
}

async function cleanup() {
  await db().query('delete from brains where id in ($1, $2)', [A, B]);
}

beforeAll(async () => {
  await migrate();
  await cleanup();
  await seedBrain(A, USER_A, SECRET_A, claimA);
  await seedBrain(B, USER_B, SECRET_B, claimB);
});

afterAll(async () => {
  await cleanup();
  await closeDb();
});

describe('a brain-A question asked while scoped to brain-B', () => {
  it('finds nothing in full-text search', async () => {
    const { rows } = await db().query(
      `select text from claims
        where brain_id = $1 and fts @@ websearch_to_tsquery('english', $2)`,
      [B, 'Frankfurt'],
    );
    expect(rows).toEqual([]);
  });

  it('finds nothing through the ILIKE fallback either', async () => {
    const { rows } = await db().query('select text from claims where brain_id = $1 and text ilike $2', [
      B,
      '%Frankfurt%',
    ]);
    expect(rows).toEqual([]);
  });

  it('cannot fetch brain-A claim by its full id', async () => {
    expect(await loadClaim(B, claimA)).toBeNull();
  });

  it('cannot fetch brain-A claim by an id prefix', async () => {
    expect(await loadClaim(B, claimA.slice(0, 12))).toBeNull();
  });

  it('returns no provenance edges across brains', async () => {
    const { rows } = await db().query(
      `select s.path from sources s
         join claim_sources cs on cs.source_id = s.id and cs.brain_id = s.brain_id
        where cs.brain_id = $1 and cs.claim_id = $2`,
      [B, claimA],
    );
    expect(rows).toEqual([]);
  });

  it('sees brain-B content when correctly scoped, so the queries do work', async () => {
    const { rows } = await db().query(
      `select text from claims where brain_id = $1 and fts @@ websearch_to_tsquery('english', $2)`,
      [B, 'Sydney'],
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { text: string }).text).toBe(SECRET_B);
  });
});

describe('brain resolution', () => {
  it('refuses a brain the caller does not own', async () => {
    await expect(requireBrain(USER_B, A)).rejects.toBeInstanceOf(Forbidden);
  });

  it('gives the same answer for a forbidden brain and one that does not exist', async () => {
    const forbidden = await requireBrain(USER_B, A).catch((e: Error) => e.message);
    const missing = await requireBrain(USER_B, 'isolation-test/does-not-exist').catch((e: Error) => e.message);
    // Otherwise a caller could enumerate other tenants' brain ids by the wording.
    expect(forbidden).toBe(missing.replace('isolation-test/does-not-exist', A));
  });

  it('resolves a brain the caller does own', async () => {
    const brain = await requireBrain(USER_B, B);
    expect(brain.id).toBe(B);
  });

  it('refuses file writes to a brain the caller cannot even read', async () => {
    await expect(requireBrainWriter(USER_B, A)).rejects.toBeInstanceOf(Forbidden);
  });

  it('lets the owner write files to their own brain', async () => {
    const brain = await requireBrainWriter(USER_B, B);
    expect(brain.id).toBe(B);
  });

  it('refuses to guess when the caller has no brains', async () => {
    await expect(requireBrain('user_isolation_test_nobody')).rejects.toBeInstanceOf(Forbidden);
  });
});

describe('list_brains', () => {
  function ids(result: Awaited<ReturnType<typeof listBrains>>): string[] {
    return (result.structuredContent!.brains as Array<{ id: string }>).map((b) => b.id);
  }

  it('lists only the brains the caller can reach', async () => {
    const result = await listBrains(USER_B);
    expect(ids(result)).toEqual([B]);
    expect(result.content[0]!.text).toContain(B);
    expect(result.content[0]!.text).not.toContain(A);
  });

  it('never names another tenant\'s brain, in the text or the structured result', async () => {
    const result = await listBrains(USER_A);
    expect(ids(result)).toEqual([A]);
    expect(JSON.stringify(result)).not.toContain(B);
  });

  it('returns an empty list, not an error, for a caller with no brains', async () => {
    const result = await listBrains('user_isolation_test_nobody');
    expect(ids(result)).toEqual([]);
    expect(result.content[0]!.text).toMatch(/no brains yet/);
  });
});

describe('rebuildability', () => {
  it('drops a brain and every derived row with it', async () => {
    await db().query('delete from brains where id = $1', [A]);
    for (const table of ['claims', 'sources', 'claim_sources', 'supersessions', 'audit_findings']) {
      const { rows } = await db().query(`select count(*)::int as n from ${table} where brain_id = $1`, [A]);
      expect((rows[0] as { n: number }).n, `${table} still holds rows for a deleted brain`).toBe(0);
    }
    // Re-seed so afterAll's cleanup stays symmetric.
    await seedBrain(A, USER_A, SECRET_A, claimA);
  });
});

describe('token verification', () => {
  it('reports a bad token as invalid_token, so a client knows to refresh', async () => {
    process.env.AUTHKIT_ISSUER ||= 'https://navigable-desert-09-staging.authkit.app';
    process.env.MCP_RESOURCE_URL ||= 'https://brain.mcpbox.dev/mcp';
    const { createTokenVerifier } = await import('../src/auth/workos.js');
    const { OAuthError } = await import('@modelcontextprotocol/server');
    // A 500 would tell an MCP client the server is broken rather than that its
    // token expired, so it would never refresh and retry.
    await expect(createTokenVerifier().verifyAccessToken('not.a.jwt')).rejects.toSatisfy(
      (e: unknown) => e instanceof OAuthError && (e as { code: string }).code === 'invalid_token',
    );
  });
});

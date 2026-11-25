/**
 * Personal access tokens: a long random secret a hook or a server bot sends as
 * its bearer token, standing in for one WorkOS user.
 *
 *   bmt_<43 base64url characters>   (32 random bytes)
 *
 * Only the SHA-256 is stored. A plain hash is enough: the token is random, so
 * there is nothing to guess, and a slow hash would only slow every request.
 *
 * An unscoped token acts as the user (principal = the WorkOS user id). A
 * scoped token acts as `pat:<token id>`; src/auth/access.ts resolves that to
 * the user plus an allow list of brains on every brain lookup, so a scoped
 * token can never reach a brain outside its list, and a revoked token stops
 * working on its next request. A scoped principal owns no chats.
 */
import { createHash, randomBytes } from 'node:crypto';
import { sessionsDb, sessionsEnabled } from '../sessions/db.js';

export const TOKEN_PREFIX = 'bmt_';
const SCOPED = 'pat:';

export interface AccessTokenRow {
  id: string;
  workos_user_id: string;
  name: string;
  brains: string[] | null;
  created_at: Date;
  last_used_at: Date | null;
}

export function looksLikeAccessToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

export function isScopedPrincipal(id: string): boolean {
  return id.startsWith(SCOPED);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Makes a token and stores its hash. The returned token is never stored. */
export async function createAccessToken(input: {
  workosUserId: string;
  name: string;
  brains?: string[] | null;
}): Promise<{ id: string; token: string }> {
  if (!/^user_[A-Za-z0-9]+$/.test(input.workosUserId)) throw new Error('workos user id must look like user_...');
  const brains = input.brains?.length ? [...new Set(input.brains)] : null;
  const id = `tok_${randomBytes(6).toString('hex')}`;
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  await sessionsDb().query(
    `insert into brain_mcp.access_tokens (id, token_hash, workos_user_id, name, brains) values ($1, $2, $3, $4, $5)`,
    [id, hashToken(token), input.workosUserId, input.name, brains],
  );
  return { id, token };
}

export async function revokeAccessToken(id: string): Promise<boolean> {
  const { rowCount } = await sessionsDb().query('delete from brain_mcp.access_tokens where id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

export async function listAccessTokens(workosUserId?: string): Promise<AccessTokenRow[]> {
  const { rows } = await sessionsDb().query<AccessTokenRow>(
    `select id, workos_user_id, name, brains, created_at, last_used_at
       from brain_mcp.access_tokens
      where $1::text is null or workos_user_id = $1
      order by created_at`,
    [workosUserId ?? null],
  );
  return rows;
}

/**
 * The principal a token acts as, or null when the token is unknown. Without
 * the sessions database there are no tokens, so every one is unknown.
 */
export async function principalForToken(token: string): Promise<string | null> {
  if (!looksLikeAccessToken(token) || !sessionsEnabled()) return null;
  const { rows } = await sessionsDb().query<AccessTokenRow>(
    `update brain_mcp.access_tokens
        set last_used_at = case when last_used_at is null or last_used_at < now() - interval '1 hour' then now() else last_used_at end
      where token_hash = $1
      returning id, workos_user_id, brains`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return row.brains ? `${SCOPED}${row.id}` : row.workos_user_id;
}

export interface TokenScope {
  workosUserId: string;
  brains: Set<string>;
}

/**
 * What a scoped principal may reach, read fresh on every call so a deleted
 * token stops at once. Null means the token is gone: reach nothing.
 */
export async function scopeOf(principal: string): Promise<TokenScope | null> {
  if (!isScopedPrincipal(principal) || !sessionsEnabled()) return null;
  const { rows } = await sessionsDb().query<{ workos_user_id: string; brains: string[] | null }>(
    'select workos_user_id, brains from brain_mcp.access_tokens where id = $1',
    [principal.slice(SCOPED.length)],
  );
  const row = rows[0];
  if (!row?.brains?.length) return null;
  return { workosUserId: row.workos_user_id, brains: new Set(row.brains) };
}

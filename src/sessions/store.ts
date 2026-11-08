/**
 * Session reads and share grants. The access boundary for chats.
 *
 * A brain belongs to a team and follows GitHub repo access. A session belongs
 * to one person. The hard rule, held in this file and nowhere else:
 *
 *     a session row is returned only when owner = caller,
 *     or an active share grants the caller's verified email access to it.
 *
 * Every query that reads `sessions` filters on `owner = $caller` or joins an
 * active share for the caller's email, and a share only counts while its
 * creator still owns the chat. test/sessions-isolation.test.ts holds this.
 */
import { randomBytes } from 'node:crypto';
import { sessionsDb } from './db.js';

export interface Turn {
  role: string;
  text: string;
}

export interface SessionSummary {
  source: string;
  id: string;
  provider: string;
  title: string;
  brain: string | null;
  cwd: string | null;
  started_at: string | null;
  updated_at: string | null;
  turn_count: number;
  snippet?: string;
}

export interface ShareView {
  id: string;
  source: string;
  session_id: string;
  with: string;
  turn_from: number | null;
  turn_to: number | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  status: 'active' | 'revoked' | 'expired';
  note: string | null;
  title?: string;
  owner?: string;
}

export interface OpenedSession extends SessionSummary {
  access: 'owner' | 'shared';
  share: ShareView | null;
  /** The chat owner's WorkOS user id. Internal: strip it before replying. */
  ownerId: string;
  /** The turns the caller may see, as 1-based numbers in the original chat. */
  allowed: { from: number; to: number };
  /** The page returned, 1-based and inclusive. Empty when from > to. */
  window: { from: number; to: number };
  turns: Turn[];
}

export interface SearchOptions {
  query?: string;
  brain?: string;
  tool?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface SessionRef {
  session: string;
  source?: string;
}

/** Accepts `id`, or `source:id` as the old sessions server printed it. */
export function parseRef(ref: SessionRef): { id: string; source: string | null } {
  if (ref.source) return { id: ref.session.trim(), source: ref.source.trim() };
  const match = ref.session.trim().match(/^([a-z][a-z0-9-]{1,31}):(.+)$/);
  return match ? { source: match[1]!, id: match[2]! } : { id: ref.session.trim(), source: null };
}

const iso = (value: Date | string | null): string | null =>
  value ? (value instanceof Date ? value.toISOString() : new Date(value).toISOString()) : null;

interface SummaryRow {
  source: string;
  id: string;
  provider: string;
  title: string | null;
  brain: string | null;
  cwd: string | null;
  started_at: Date | null;
  updated_at: Date | null;
  turn_count: number;
  snippet?: string | null;
}

function toSummary(row: SummaryRow): SessionSummary {
  return {
    source: row.source,
    id: row.id,
    provider: row.provider,
    title: row.title?.trim() || '(untitled chat)',
    brain: row.brain,
    cwd: row.cwd,
    started_at: iso(row.started_at),
    updated_at: iso(row.updated_at),
    turn_count: Number(row.turn_count),
    ...(row.snippet !== undefined ? { snippet: (row.snippet ?? '').replace(/\s+/g, ' ').trim() } : {}),
  };
}

const SUMMARY_COLUMNS = `s.source, s.id, s.provider, s.title, s.brain, s.cwd, s.started_at, s.updated_at,
  jsonb_array_length(s.turns) as turn_count`;

/**
 * Searches the caller's own chats only. An empty query lists the most recent.
 * Ranks first and only then builds snippets, so ts_headline runs on the page of
 * results rather than on every match (some chats are a quarter of a megabyte).
 */
export async function searchSessions(ownerId: string, options: SearchOptions): Promise<SessionSummary[]> {
  const query = options.query?.trim() ?? '';
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const filters = `s.owner = $1
          and ($2::text is null or s.brain = $2)
          and ($3::text is null or s.source = $3 or s.provider = $3)
          and ($4::timestamptz is null or coalesce(s.updated_at, s.started_at) >= $4)
          and ($5::timestamptz is null or coalesce(s.started_at, s.updated_at) < $5)`;
  const args = [ownerId, options.brain || null, options.tool || null, options.since || null, endOfDay(options.until), limit];

  // Two plans on purpose. The page is picked from narrow columns only; the
  // turn count, title and snippet are read for that page alone, because they
  // unpack the turns and body (up to a quarter of a megabyte per chat).
  const sql = query
    ? `with hits as (
         select s.source, s.id, ts_rank(s.search, websearch_to_tsquery('english', $7)) as rank,
                coalesce(s.updated_at, s.started_at) as at
           from sessions s
          where ${filters} and s.search @@ websearch_to_tsquery('english', $7)
          order by rank desc, at desc nulls last
          limit $6)
       select ${SUMMARY_COLUMNS},
              ts_headline('english', s.body, websearch_to_tsquery('english', $7), 'MaxWords=30, MinWords=10, MaxFragments=2') as snippet
         from hits h join sessions s on s.source = h.source and s.id = h.id and s.owner = $1
        order by h.rank desc, h.at desc nulls last`
    : `with hits as (
         select s.source, s.id, coalesce(s.updated_at, s.started_at) as at
           from sessions s
          where ${filters}
          order by at desc nulls last
          limit $6)
       select ${SUMMARY_COLUMNS},
              left(coalesce((select t->>'text' from jsonb_array_elements(s.turns) t
                              where t->>'role' = 'user' limit 1), ''), 240) as snippet
         from hits h join sessions s on s.source = h.source and s.id = h.id and s.owner = $1
        order by h.at desc nulls last`;
  const { rows } = await sessionsDb().query<SummaryRow>(sql, query ? [...args, query] : args);
  return rows.map(toSummary);
}

/** `until` is a day, inclusive: everything before the next midnight UTC. */
function endOfDay(until: string | undefined): string | null {
  if (!until) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    const next = new Date(`${until}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }
  return until;
}

/** The filters the caller's own chats offer: brains and tools, with counts. */
export async function sessionFacets(ownerId: string): Promise<{
  brains: Array<{ brain: string | null; count: number }>;
  tools: Array<{ tool: string; count: number }>;
}> {
  const db = sessionsDb();
  const [brains, tools] = await Promise.all([
    db.query<{ brain: string | null; count: string }>(
      'select brain, count(*) as count from sessions where owner = $1 group by brain order by count(*) desc',
      [ownerId],
    ),
    db.query<{ tool: string; count: string }>(
      `select tool, count(*) as count from (
         select source as tool from sessions where owner = $1
         union all
         select provider from sessions where owner = $1 and provider <> source
       ) t group by tool order by count(*) desc`,
      [ownerId],
    ),
  ]);
  return {
    brains: brains.rows.map((r) => ({ brain: r.brain, count: Number(r.count) })),
    tools: tools.rows.map((r) => ({ tool: r.tool, count: Number(r.count) })),
  };
}

/** One of the caller's own chats, or null. Refuses to guess between two sources. */
export async function findOwnSession(ownerId: string, ref: SessionRef): Promise<SessionSummary | null> {
  const { id, source } = parseRef(ref);
  const { rows } = await sessionsDb().query<SummaryRow>(
    `select ${SUMMARY_COLUMNS} from sessions s
      where s.owner = $1 and s.id = $2 and ($3::text is null or s.source = $3)
      limit 2`,
    [ownerId, id, source],
  );
  if (rows.length > 1) {
    throw new AmbiguousSession(`Two of your chats have id ${id}. Pass source too: ${rows.map((r) => r.source).join(' or ')}.`);
  }
  return rows[0] ? toSummary(rows[0]) : null;
}

export class AmbiguousSession extends Error {}

interface ShareRow {
  id: string;
  owner: string;
  source: string;
  session_id: string;
  grantee_email: string;
  turn_from: number | null;
  turn_to: number | null;
  note: string | null;
  expires_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
  title?: string | null;
}

function toShare(row: ShareRow): ShareView {
  const expired = row.expires_at !== null && row.expires_at.getTime() <= Date.now();
  return {
    id: row.id,
    source: row.source,
    session_id: row.session_id,
    with: row.grantee_email,
    turn_from: row.turn_from,
    turn_to: row.turn_to,
    expires_at: iso(row.expires_at),
    created_at: iso(row.created_at)!,
    revoked_at: iso(row.revoked_at),
    status: row.revoked_at ? 'revoked' : expired ? 'expired' : 'active',
    note: row.note,
    ...(row.title !== undefined ? { title: row.title?.trim() || '(untitled chat)' } : {}),
  };
}

const ACTIVE = `g.revoked_at is null and (g.expires_at is null or g.expires_at > now())`;

/**
 * The share that lets `email` read a chat, by share id or by the chat's id.
 * Joined on `s.owner = g.owner`, so a share dies with its creator's ownership.
 */
async function findGrant(email: string, ref: SessionRef): Promise<{ share: ShareRow; session: SummaryRow } | null> {
  const { id, source } = parseRef(ref);
  // Share columns are aliased: the chat's own id and source would otherwise
  // overwrite the share's in the row object.
  const { rows } = await sessionsDb().query<SummaryRow & {
    share_id: string; share_owner: string; share_source: string; share_session_id: string; grantee_email: string;
    turn_from: number | null; turn_to: number | null; note: string | null;
    expires_at: Date | null; created_at: Date; revoked_at: Date | null;
  }>(
    `select g.id as share_id, g.owner as share_owner, g.source as share_source, g.session_id as share_session_id,
            g.grantee_email, g.turn_from, g.turn_to, g.note, g.expires_at, g.created_at, g.revoked_at,
            ${SUMMARY_COLUMNS}
       from brain_mcp.session_shares g
       join sessions s on s.source = g.source and s.id = g.session_id and s.owner = g.owner
      where g.grantee_email = $1 and ${ACTIVE}
        and (g.id = $2 or (g.session_id = $2 and ($3::text is null or g.source = $3)))
      order by (g.id = $2) desc, g.created_at desc
      limit 1`,
    [email.toLowerCase(), id, source],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    session: row,
    share: {
      id: row.share_id,
      owner: row.share_owner,
      source: row.share_source,
      session_id: row.share_session_id,
      grantee_email: row.grantee_email,
      turn_from: row.turn_from,
      turn_to: row.turn_to,
      note: row.note,
      expires_at: row.expires_at,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
    },
  };
}

/**
 * Opens a chat for a caller: their own in full, or a shared one within its
 * granted turns. Returns null whether the chat is missing or forbidden, so a
 * caller cannot probe for other people's chat ids.
 */
export async function openSession(
  caller: { userId: string; email: string | null },
  ref: SessionRef,
  page: { from?: number; max?: number } = {},
): Promise<OpenedSession | null> {
  let summary: SessionSummary | null = await findOwnSession(caller.userId, ref);
  let share: ShareView | null = null;
  let ownerId = caller.userId;

  if (!summary) {
    if (!caller.email) return null;
    const grant = await findGrant(caller.email, ref);
    if (!grant) return null;
    summary = toSummary(grant.session);
    // A chat's title is usually its first prompt, and cwd is the owner's own
    // path: a share that starts after turn 1 shows neither.
    if ((grant.share.turn_from ?? 1) > 1) {
      summary = { ...summary, title: `Part of a chat (turns ${grant.share.turn_from} to ${grant.share.turn_to ?? summary.turn_count})` };
    }
    summary = { ...summary, cwd: null };
    share = { ...toShare(grant.share), title: summary.title };
    ownerId = grant.share.owner;
  }

  const total = summary.turn_count;
  const allowed = {
    from: Math.max(1, share?.turn_from ?? 1),
    to: Math.min(total, share?.turn_to ?? total),
  };
  const max = Math.min(Math.max(page.max ?? 40, 1), 500);
  const from = Math.max(allowed.from, page.from ?? allowed.from);
  const to = Math.min(allowed.to, from + max - 1);

  const { rows } = await sessionsDb().query<{ turns: Turn[] | null }>(
    `select coalesce((select jsonb_agg(t order by i)
                        from jsonb_array_elements(s.turns) with ordinality as x(t, i)
                       where i between $4 and $5), '[]'::jsonb) as turns
       from sessions s
      where s.owner = $1 and s.source = $2 and s.id = $3`,
    [ownerId, summary.source, summary.id, from, to],
  );

  return {
    ...summary,
    access: share ? 'shared' : 'owner',
    share,
    ownerId,
    allowed,
    window: { from, to },
    turns: (rows[0]?.turns ?? []).map((t) => ({ role: String(t.role ?? ''), text: String(t.text ?? '') })),
  };
}

export interface SharePlan {
  ownerId: string;
  session: SessionSummary;
  email: string;
  turnFrom: number | null;
  turnTo: number | null;
  expiresAt: Date | null;
  note: string | null;
  first: Turn | null;
  last: Turn | null;
}

export class ShareRefused extends Error {}

const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i;
const DEFAULT_SHARE_DAYS = 30;

/**
 * Checks a share and builds its preview, without creating anything. The
 * caller must own the chat. `expires` is a date, a number of days, or "never";
 * it defaults to 30 days so a forgotten share does not last forever.
 */
export async function planShare(
  ownerId: string,
  input: SessionRef & { email: string; turnFrom?: number; turnTo?: number; expires?: string | number; note?: string },
): Promise<SharePlan> {
  const session = await findOwnSession(ownerId, input);
  if (!session) throw new ShareRefused(`You have no chat ${input.session}. Only your own chats can be shared.`);

  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new ShareRefused(`"${input.email}" is not an email address.`);

  const total = session.turn_count;
  if (total === 0) throw new ShareRefused('That chat has no turns to share.');
  const turnFrom = input.turnFrom ?? null;
  const turnTo = input.turnTo ?? null;
  if (turnFrom !== null && (turnFrom < 1 || turnFrom > total)) {
    throw new ShareRefused(`from_turn must be between 1 and ${total}.`);
  }
  if (turnTo !== null && (turnTo < (turnFrom ?? 1) || turnTo > total)) {
    throw new ShareRefused(`to_turn must be between ${turnFrom ?? 1} and ${total}.`);
  }

  const expiresAt = parseExpiry(input.expires);
  const from = turnFrom ?? 1;
  const to = turnTo ?? total;
  const { rows } = await sessionsDb().query<{ first: Turn | null; last: Turn | null }>(
    `select s.turns -> ($4::int - 1) as first, s.turns -> ($5::int - 1) as last
       from sessions s where s.owner = $1 and s.source = $2 and s.id = $3`,
    [ownerId, session.source, session.id, from, to],
  );
  return {
    ownerId,
    session,
    email,
    turnFrom,
    turnTo,
    expiresAt,
    note: input.note?.trim() || null,
    first: rows[0]?.first ?? null,
    last: from === to ? null : (rows[0]?.last ?? null),
  };
}

export function parseExpiry(expires: string | number | undefined, now = new Date()): Date | null {
  if (expires === 'never') return null;
  const days = expires === undefined ? DEFAULT_SHARE_DAYS : typeof expires === 'number' ? expires : null;
  if (days !== null) {
    if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new ShareRefused('expires must be 1 to 3650 days.');
    return new Date(now.getTime() + days * 86_400_000);
  }
  if (/^\d+$/.test(String(expires))) return parseExpiry(Number(expires), now);
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(expires)) ? `${expires}T23:59:59Z` : String(expires));
  if (Number.isNaN(date.getTime())) throw new ShareRefused(`"${expires}" is not a date, a number of days, or "never".`);
  if (date.getTime() <= now.getTime()) throw new ShareRefused('expires must be in the future.');
  return date;
}

/** The preview text a person reads before saying yes. */
export function describePlan(plan: SharePlan): string {
  const range =
    plan.turnFrom === null && plan.turnTo === null
      ? `the whole chat (${plan.session.turn_count} turns)`
      : `turns ${plan.turnFrom ?? 1} to ${plan.turnTo ?? plan.session.turn_count} of ${plan.session.turn_count}`;
  const excerpt = (turn: Turn | null) =>
    turn ? `${turn.role}: ${turn.text.replace(/\s+/g, ' ').trim().slice(0, 280)}` : null;
  return [
    `Share "${plan.session.title}" (${plan.session.source}, ${plan.session.started_at?.slice(0, 10) ?? 'undated'})`,
    `With: ${plan.email}`,
    `What: ${range}`,
    `Expires: ${plan.expiresAt ? plan.expiresAt.toISOString().slice(0, 10) : 'never'}`,
    ...(plan.note ? [`Note: ${plan.note}`] : []),
    '',
    `Starts with: ${excerpt(plan.first) ?? '(empty)'}`,
    ...(plan.last ? [`Ends with: ${excerpt(plan.last)}`] : []),
    '',
    plan.turnFrom && plan.turnFrom > 1
      ? 'They read only these turns, cleaned (secrets redacted), after signing in as that email. The chat title is hidden from them.'
      : 'They read the chat title and these turns, cleaned (secrets redacted), after signing in as that email. Nothing else of yours becomes visible.',
  ].join('\n');
}

export async function createShare(plan: SharePlan): Promise<ShareView> {
  const id = randomBytes(18).toString('base64url');
  const { rows } = await sessionsDb().query<ShareRow>(
    `insert into brain_mcp.session_shares
       (id, owner, source, session_id, grantee_email, turn_from, turn_to, note, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [id, plan.ownerId, plan.session.source, plan.session.id, plan.email, plan.turnFrom, plan.turnTo, plan.note, plan.expiresAt],
  );
  return { ...toShare(rows[0]!), title: plan.session.title };
}

/** Revokes one of the caller's shares. False when it is not theirs or already revoked. */
export async function revokeShare(ownerId: string, shareId: string): Promise<boolean> {
  const { rowCount } = await sessionsDb().query(
    `update brain_mcp.session_shares set revoked_at = now()
      where id = $1 and owner = $2 and revoked_at is null`,
    [shareId, ownerId],
  );
  return (rowCount ?? 0) > 0;
}

/** Shares the caller created, newest first. */
export async function listMyShares(ownerId: string, limit = 50): Promise<ShareView[]> {
  const { rows } = await sessionsDb().query<ShareRow>(
    `select g.*, s.title
       from brain_mcp.session_shares g
       left join sessions s on s.source = g.source and s.id = g.session_id and s.owner = g.owner
      where g.owner = $1
      order by g.created_at desc
      limit $2`,
    [ownerId, limit],
  );
  return rows.map(toShare);
}

/** Active shares granted to this email, newest first. */
export async function listSharedWithMe(email: string | null, limit = 50): Promise<Array<ShareView & { ownerId: string }>> {
  if (!email) return [];
  const { rows } = await sessionsDb().query<ShareRow>(
    `select g.*, s.title
       from brain_mcp.session_shares g
       join sessions s on s.source = g.source and s.id = g.session_id and s.owner = g.owner
      where g.grantee_email = $1 and ${ACTIVE}
      order by g.created_at desc
      limit $2`,
    [email.toLowerCase(), limit],
  );
  return rows.map((row) => ({ ...toShare(row), ownerId: row.owner }));
}

/** The caller's own chats tagged with a brain, for the combined `search`. */
export async function searchOwnSessionsInBrain(ownerId: string, brainId: string, query: string, limit: number) {
  return searchSessions(ownerId, { query, brain: brainId, limit });
}

/** One share the caller created, by id, or null. */
export async function findMyShare(ownerId: string, shareId: string): Promise<ShareView | null> {
  const { rows } = await sessionsDb().query<ShareRow>(
    `select g.*, s.title
       from brain_mcp.session_shares g
       left join sessions s on s.source = g.source and s.id = g.session_id and s.owner = g.owner
      where g.owner = $1 and g.id = $2`,
    [ownerId, shareId],
  );
  return rows[0] ? toShare(rows[0]) : null;
}

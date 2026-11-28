/**
 * The chat-search index: a derived copy of each person's chats, built for
 * finding the right past chat from a new message.
 *
 * It lives in the sessions database, in brain-mcp's own schema, and is always
 * rebuildable from the `sessions` table: drop the schema and the next sync
 * writes it again. Per chat it holds:
 *
 *   - postings: each word (Postgres lexeme) with how often it occurs, in three
 *     fields: about (title and card), user (what the person wrote, cleaned of
 *     pasted instructions) and agent (what the agent answered). Keyword search
 *     scores them with BM25: rare words count for more, a word said many times
 *     counts with diminishing returns, long chats do not win by being long.
 *   - chunks: a few short passages (the card, each user message with the start
 *     of its answer), each with a vector from a multilingual model. Meaning
 *     search takes the best passage per chat.
 *
 * The two ranked lists are joined with reciprocal rank fusion (`rank.ts`).
 *
 * Words are read in both Spanish and English: Spanish stopwords are dropped,
 * accents removed, then English stemming and stopwords. The question goes
 * through the same steps, so both sides agree.
 *
 * Privacy: every row carries its chat's owner, and every read in `rank.ts`
 * filters on it, like every read in store.ts.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { BoilerplateCounter, cleanTurn, splitIdentifiers, stripInjected } from './clean.js';
import { toVector, type Embedder } from './embed.js';

/** Bump when what is indexed changes: the next sync rebuilds every chat. */
export const INDEX_VERSION = '3';

/** Where the shared vector cache lives, whatever schema the index is in. */
export const EMBED_CACHE = 'brain_mcp.session_embeddings';

export const DEFAULT_INDEX_SCHEMA = 'brain_mcp';

/** Postgres text search configuration name for a schema. */
export const tsConfig = (schema: string) => `${schema}.chat_words`;

export function checkSchema(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(schema)) throw new Error(`bad index schema name: ${schema}`);
  return schema;
}

/**
 * Creates the index tables and the word configuration, once per process and
 * schema. A different INDEX_VERSION in the meta table drops the index tables
 * first: they are derived, so nothing is lost.
 */
const ready = new Map<string, Promise<void>>();
export function ensureIndexSchema(db: pg.Pool, schema = DEFAULT_INDEX_SCHEMA): Promise<void> {
  checkSchema(schema);
  let p = ready.get(schema);
  if (!p) {
    p = createIndexSchema(db, schema).catch((error) => {
      ready.delete(schema);
      throw error;
    });
    ready.set(schema, p);
  }
  return p;
}

export function forgetIndexSchema(schema?: string): void {
  if (schema) ready.delete(schema);
  else ready.clear();
}

async function createIndexSchema(db: pg.Pool, schema: string): Promise<void> {
  const s = schema;
  const client = await db.connect();
  try {
    await client.query('begin');
    // One builder at a time, across processes.
    await client.query(`select pg_advisory_xact_lock(hashtext('brain_mcp.session_index_schema'))`);
    await client.query(`create schema if not exists ${s}`);
    await client.query('create schema if not exists brain_mcp');
    // pgvector is created once by a superuser on the server; unaccent is a
    // trusted extension any role with CREATE on the database may add.
    await client.query(`create extension if not exists unaccent`);
    await client.query(`create table if not exists ${s}.session_index_meta (key text primary key, value text not null)`);
    const { rows } = await client.query<{ value: string }>(`select value from ${s}.session_index_meta where key = 'version'`);
    if (rows[0]?.value !== INDEX_VERSION) {
      // Nobody is "ready" on a rebuilt index until a full sync finishes.
      await client.query(`delete from ${s}.session_index_meta where key like 'ready:%' or key = 'embed_model'`);
      await client.query(`drop table if exists ${s}.session_docs, ${s}.session_postings, ${s}.session_chunks, ${s}.session_boilerplate`);
      await client.query(`drop text search configuration if exists ${tsConfig(s)}`);
      await client.query(`drop text search dictionary if exists ${s}.chat_es_stop`);
    }

    const { rows: dict } = await client.query<{ schema: string }>(
      `select n.nspname as schema from pg_ts_dict d join pg_namespace n on n.oid = d.dictnamespace where d.dictname = 'unaccent' limit 1`,
    );
    const unaccent = `${dict[0]?.schema ?? 'public'}.unaccent`;
    const { rows: hasConfig } = await client.query(
      `select 1 from pg_ts_config c join pg_namespace n on n.oid = c.cfgnamespace where n.nspname = $1 and c.cfgname = 'chat_words'`,
      [s],
    );
    if (!hasConfig.length) {
      await client.query(`create text search dictionary ${s}.chat_es_stop (template = simple, stopwords = spanish, accept = false)`);
      await client.query(`create text search configuration ${tsConfig(s)} (copy = simple)`);
      await client.query(
        `alter text search configuration ${tsConfig(s)}
           alter mapping for asciiword, asciihword, hword_asciipart, word, hword, hword_part, numword, numhword, hword_numpart
           with ${s}.chat_es_stop, ${unaccent}, english_stem`,
      );
    }

    await client.query(`
      create table if not exists ${s}.session_docs (
        source     text not null,
        id         text not null,
        owner      text not null,
        brain      text,
        src_fp     text not null,
        about_len  int  not null default 0,
        user_len   int  not null default 0,
        agent_len  int  not null default 0,
        indexed_at timestamptz not null default now(),
        primary key (source, id)
      )`);
    await client.query(`create index if not exists session_docs_owner on ${s}.session_docs (owner, brain)`);
    // field: 1 about (title and card), 2 user, 3 agent.
    await client.query(`
      create table if not exists ${s}.session_postings (
        owner  text     not null,
        lexeme text     not null,
        field  smallint not null,
        source text     not null,
        id     text     not null,
        tf     int      not null,
        primary key (owner, lexeme, field, source, id)
      )`);
    await client.query(`create index if not exists session_postings_chat on ${s}.session_postings (source, id)`);
    await client.query(`
      create table if not exists ${s}.session_chunks (
        source text not null,
        id     text not null,
        n      int  not null,
        sha    text not null,
        primary key (source, id, n)
      )`);
    await client.query(`create table if not exists ${s}.session_boilerplate (owner text not null, key text not null, primary key (owner, key))`);
    // The vector cache is keyed by model and text, never by chat or owner, so
    // a rebuild (or an evaluation in a scratch schema) re-embeds nothing.
    await client.query(`
      create table if not exists ${EMBED_CACHE} (
        model     text   not null,
        sha       text   not null,
        embedding vector not null,
        primary key (model, sha)
      )`);
    await client.query(
      `insert into ${s}.session_index_meta (key, value) values ('version', $1)
       on conflict (key) do update set value = excluded.value`,
      [INDEX_VERSION],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** What a chat looked like when indexed. Any change re-indexes it. */
const SOURCE_FP = `md5(coalesce(s.clean_fingerprint, md5(s.body)) || '|' || coalesce(s.title, '') || '|' || coalesce(s.brain, '')
  || '|' || coalesce(s.owner, '') || '|' || coalesce(s.card, '') || '|' || $V::text)`;

interface SourceRow {
  source: string;
  id: string;
  owner: string;
  brain: string | null;
  title: string | null;
  card: string | null;
  turns: { role?: string; text?: string }[];
  fp: string;
}

export interface IndexedChat {
  source: string;
  id: string;
  owner: string;
  brain: string | null;
  fp: string;
  about: string;
  user: string[];
  agent: string[];
  chunks: string[];
}

const MAX_CHUNKS = 24;
const CHUNK_USER = 1000;
const CHUNK_AGENT = 300;

/** A card's "Where:" line names folders and tools, not the subject. */
function cardForMeaning(card: string | null): string {
  return (card ?? '')
    .split('\n')
    .filter((line) => !/^\s*Where:/i.test(line))
    .join('\n')
    .trim();
}

/** Turns a raw chat into what the index stores. Pure, so tests can call it. */
export function prepareChat(
  row: Omit<SourceRow, 'fp'> & { fp?: string },
  boilerplate?: ReadonlySet<string>,
  options: { raw?: boolean } = {},
): IndexedChat {
  const user: string[] = [];
  const agent: string[] = [];
  const pairs: { user: string; agent: string }[] = [];
  for (const turn of row.turns ?? []) {
    const text = String(turn.text ?? '');
    if (turn.role === 'user') {
      const clean = options.raw ? text.replace(/[ \t]+/g, ' ').trim() : cleanTurn(text, boilerplate);
      if (clean) {
        user.push(clean);
        pairs.push({ user: clean, agent: '' });
      }
    } else {
      const clean = text.replace(/[ \t]+/g, ' ').trim();
      if (!clean) continue;
      agent.push(clean);
      const last = pairs[pairs.length - 1];
      if (last && !last.agent) last.agent = clean;
    }
  }
  const title = (row.title ?? '').trim();
  const about = [title, row.card ?? ''].join('\n').trim();
  const chunks: string[] = [];
  const head = [title, cardForMeaning(row.card)].filter(Boolean).join('\n');
  if (head) chunks.push(head.slice(0, CHUNK_USER + CHUNK_AGENT));
  const passages = pairs
    .filter((p) => p.user.length >= 8)
    .map((p) => `${p.user.slice(0, CHUNK_USER)}${p.agent ? `\n${p.agent.slice(0, CHUNK_AGENT)}` : ''}`);
  const keep = passages.length <= MAX_CHUNKS - 1 ? passages : [...passages.slice(0, 16), ...passages.slice(-(MAX_CHUNKS - 17))];
  chunks.push(...keep);
  return { source: row.source, id: row.id, owner: row.owner, brain: row.brain, fp: row.fp ?? '', about, user, agent, chunks };
}

export const chunkSha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

export interface SyncOptions {
  schema?: string;
  embedder?: Embedder | null;
  /** Only this owner's chats (eval, tests). */
  owner?: string;
  /** Chats per batch. */
  batch?: number;
  /** Stop after this many chats in one call (the background loop keeps cycles short). */
  max?: number;
  /** Recount pasted lines and rebuild every chat. */
  rebuild?: boolean;
  /** Index raw turns, without cleaning (only to measure what cleaning buys). */
  raw?: boolean;
  log?: (message: string) => void;
}

export interface SyncResult {
  indexed: number;
  removed: number;
  embedded: number;
  pending: number;
}

/**
 * Brings the index up to date with `sessions`: indexes new and changed chats,
 * removes deleted ones. Safe to run from several processes (advisory lock).
 */
export async function syncSessionIndex(db: pg.Pool, options: SyncOptions = {}): Promise<SyncResult> {
  const schema = checkSchema(options.schema ?? DEFAULT_INDEX_SCHEMA);
  await ensureIndexSchema(db, schema);
  const lock = await db.connect();
  const result: SyncResult = { indexed: 0, removed: 0, embedded: 0, pending: 0 };
  try {
    const { rows: got } = await lock.query<{ ok: boolean }>(
      `select pg_try_advisory_lock(hashtext($1)) as ok`,
      [`brain_mcp.session_index_sync:${schema}`],
    );
    if (!got[0]?.ok) return result;
    try {
      const s = schema;
      await checkEmbedModel(db, s, options.embedder ?? null);
      // Owners with chats, plus owners only the index still has (all their
      // chats deleted), so their rows are cleaned up too.
      const owners = options.owner
        ? [options.owner]
        : (
            await db.query<{ owner: string }>(
              `select owner from sessions where owner is not null union select owner from ${s}.session_docs`,
            )
          ).rows.map((r) => r.owner);
      let budget = options.max ?? Infinity;

      for (const owner of owners) {
        const boiler = options.raw ? undefined : await loadBoilerplate(db, s, owner, options.rebuild ?? false, options.log);
        if (options.rebuild) await db.query(`update ${s}.session_docs set src_fp = '' where owner = $1`, [owner]);

        const { rowCount } = await db.query(
          `delete from ${s}.session_docs d
            where d.owner = $1 and not exists (select 1 from sessions s where s.source = d.source and s.id = d.id and s.owner = $1)`,
          [owner],
        );
        result.removed += rowCount ?? 0;
        await db.query(
          `delete from ${s}.session_postings p where p.owner = $1
              and not exists (select 1 from ${s}.session_docs d where d.source = p.source and d.id = p.id)`,
          [owner],
        );
        await db.query(
          `delete from ${s}.session_chunks c
            where not exists (select 1 from ${s}.session_docs d where d.source = c.source and d.id = c.id)`,
        );

        const { rows: stale } = await db.query<{ source: string; id: string }>(
          `select s.source, s.id from sessions s
             left join ${s}.session_docs d on d.source = s.source and d.id = s.id
            where s.owner = $1 and (d.src_fp is null or d.src_fp <> ${SOURCE_FP.replace('$V', '$2')})
            order by coalesce(s.updated_at, s.started_at) desc nulls last`,
          [owner, INDEX_VERSION],
        );
        const todo = stale.slice(0, Math.max(0, budget));
        budget -= todo.length;
        result.pending += stale.length - todo.length;
        const size = options.batch ?? 50;
        for (let i = 0; i < todo.length; i += size) {
          const keys = todo.slice(i, i + size);
          const { rows } = await db.query<SourceRow>(
            `select s.source, s.id, s.owner, s.brain, s.title, s.card, s.turns, ${SOURCE_FP.replace('$V', '$4')} as fp
               from sessions s
               join unnest($1::text[], $2::text[]) k(source, id) on k.source = s.source and k.id = s.id
              where s.owner = $3`,
            [keys.map((k) => k.source), keys.map((k) => k.id), owner, INDEX_VERSION],
          );
          const chats = rows.map((row) => prepareChat(row, boiler, { raw: options.raw }));
          // Vectors first: if embedding fails, the chats stay stale and the
          // next cycle tries again, instead of counting as indexed without them.
          result.embedded += await embedChunks(db, s, chats, options.embedder ?? null);
          await writeChats(db, s, chats);
          result.indexed += chats.length;
          options.log?.(`indexed ${result.indexed}/${todo.length} (${owner})`);
        }
        // Search uses the index for an owner only once all their chats are in
        // it; until then the old search answers (rank.ts indexReady).
        if (todo.length === stale.length) {
          await db.query(
            `insert into ${s}.session_index_meta (key, value) values ($1, now()::text)
             on conflict (key) do update set value = excluded.value`,
            [`ready:${owner}`],
          );
        }
      }
    } finally {
      await lock.query(`select pg_advisory_unlock(hashtext($1))`, [`brain_mcp.session_index_sync:${schema}`]);
    }
  } finally {
    lock.release();
  }
  return result;
}

/**
 * Vectors belong to one model. When the model changes (or meaning search is
 * turned on after running without it), every chat is marked stale so its
 * passages are embedded with the new one. An index without the marker yet is
 * taken to match the current model.
 */
async function checkEmbedModel(db: pg.Pool, s: string, embedder: Embedder | null): Promise<void> {
  const current = embedder?.model ?? '';
  const { rows } = await db.query<{ value: string }>(`select value from ${s}.session_index_meta where key = 'embed_model'`);
  const stored = rows[0]?.value;
  if (stored === current) return;
  if (stored !== undefined && current) await db.query(`update ${s}.session_docs set src_fp = ''`);
  await db.query(
    `insert into ${s}.session_index_meta (key, value) values ('embed_model', $1)
     on conflict (key) do update set value = excluded.value`,
    [current],
  );
}

/**
 * The owner's pasted lines: counted over all their user turns the first time
 * (or on rebuild), then read from the table.
 */
async function loadBoilerplate(
  db: pg.Pool,
  s: string,
  owner: string,
  rebuild: boolean,
  log?: (message: string) => void,
): Promise<Set<string>> {
  if (!rebuild) {
    const { rows } = await db.query<{ key: string }>(`select key from ${s}.session_boilerplate where owner = $1`, [owner]);
    if (rows.length) return new Set(rows.map((r) => r.key));
    const { rows: any } = await db.query(`select 1 from ${s}.session_docs where owner = $1 limit 1`, [owner]);
    if (any.length) return new Set();
  }
  const counter = new BoilerplateCounter();
  const { rows: ids } = await db.query<{ source: string; id: string }>(`select source, id from sessions where owner = $1`, [owner]);
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const { rows } = await db.query<{ texts: string[] | null }>(
      `select (select array_agg(t->>'text') from jsonb_array_elements(s.turns) t
                  where t->>'role' = 'user' and t->>'text' is not null) as texts
         from sessions s join unnest($1::text[], $2::text[]) k(source, id) on k.source = s.source and k.id = s.id
        where s.owner = $3`,
      [part.map((r) => r.source), part.map((r) => r.id), owner],
    );
    for (const row of rows) counter.addChat(row.texts ?? []);
  }
  const keys = [...counter.result()];
  await db.query(`delete from ${s}.session_boilerplate where owner = $1`, [owner]);
  for (let i = 0; i < keys.length; i += 5000) {
    await db.query(
      `insert into ${s}.session_boilerplate (owner, key) select $1, unnest($2::text[]) on conflict do nothing`,
      [owner, keys.slice(i, i + 5000)],
    );
  }
  log?.(`pasted lines for ${owner}: ${keys.length}`);
  return new Set(keys);
}

/** Replaces the postings, chunks and doc rows of these chats, in one transaction. */
async function writeChats(db: pg.Pool, s: string, chats: IndexedChat[]): Promise<void> {
  if (!chats.length) return;
  const src: string[] = [];
  const ids: string[] = [];
  const owners: string[] = [];
  const fields: number[] = [];
  const texts: string[] = [];
  const push = (chat: IndexedChat, field: number, text: string) => {
    // Long turns are split so no tsvector hits Postgres' position limits.
    for (let i = 0; i < text.length; i += 20_000) {
      src.push(chat.source);
      ids.push(chat.id);
      owners.push(chat.owner);
      fields.push(field);
      texts.push(splitIdentifiers(text.slice(i, i + 20_000)));
    }
  };
  for (const chat of chats) {
    push(chat, 1, chat.about);
    for (const t of chat.user) push(chat, 2, t);
    for (const t of chat.agent) push(chat, 3, t);
  }
  const client = await db.connect();
  try {
    await client.query('begin');
    const keys = [chats.map((c) => c.source), chats.map((c) => c.id)];
    await client.query(
      `delete from ${s}.session_postings p using unnest($1::text[], $2::text[]) k(source, id) where p.source = k.source and p.id = k.id`,
      keys,
    );
    await client.query(
      `delete from ${s}.session_chunks c using unnest($1::text[], $2::text[]) k(source, id) where c.source = k.source and c.id = k.id`,
      keys,
    );
    await client.query(
      `insert into ${s}.session_postings (owner, lexeme, field, source, id, tf)
       select i.owner, l.lexeme, i.field, i.source, i.id, sum(coalesce(array_length(l.positions, 1), 1))::int
         from unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[]) i(source, id, owner, field, txt)
         cross join lateral unnest(to_tsvector('${tsConfig(s)}', i.txt)) l
        where length(l.lexeme) between 2 and 40
        group by i.owner, l.lexeme, i.field, i.source, i.id`,
      [src, ids, owners, fields, texts],
    );
    await client.query(
      `insert into ${s}.session_docs (source, id, owner, brain, src_fp, about_len, user_len, agent_len, indexed_at)
       select k.source, k.id, k.owner, k.brain, k.fp,
              coalesce(sum(p.tf) filter (where p.field = 1), 0),
              coalesce(sum(p.tf) filter (where p.field = 2), 0),
              coalesce(sum(p.tf) filter (where p.field = 3), 0),
              now()
         from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) k(source, id, owner, brain, fp)
         left join ${s}.session_postings p on p.source = k.source and p.id = k.id and p.owner = k.owner
        group by k.source, k.id, k.owner, k.brain, k.fp
       on conflict (source, id) do update set owner = excluded.owner, brain = excluded.brain, src_fp = excluded.src_fp,
         about_len = excluded.about_len, user_len = excluded.user_len, agent_len = excluded.agent_len, indexed_at = now()`,
      [chats.map((c) => c.source), chats.map((c) => c.id), chats.map((c) => c.owner), chats.map((c) => c.brain), chats.map((c) => c.fp)],
    );
    const cs: string[] = [];
    const ci: string[] = [];
    const cn: number[] = [];
    const ch: string[] = [];
    for (const chat of chats) {
      chat.chunks.forEach((text, n) => {
        cs.push(chat.source);
        ci.push(chat.id);
        cn.push(n);
        ch.push(chunkSha(text));
      });
    }
    await client.query(
      `insert into ${s}.session_chunks (source, id, n, sha) select * from unnest($1::text[], $2::text[], $3::int[], $4::text[])
       on conflict do nothing`,
      [cs, ci, cn, ch],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Embeds the chunks whose text has no vector yet for this model. Returns how many. */
async function embedChunks(db: pg.Pool, _s: string, chats: IndexedChat[], embedder: Embedder | null): Promise<number> {
  if (!embedder) return 0;
  const bySha = new Map<string, string>();
  for (const chat of chats) for (const text of chat.chunks) bySha.set(chunkSha(text), text);
  if (!bySha.size) return 0;
  const { rows } = await db.query<{ sha: string }>(
    `select sha from ${EMBED_CACHE} where model = $1 and sha = any($2)`,
    [embedder.model, [...bySha.keys()]],
  );
  for (const row of rows) bySha.delete(row.sha);
  const missing = [...bySha.entries()];
  for (let i = 0; i < missing.length; i += 64) {
    const part = missing.slice(i, i + 64);
    const vectors = await embedder.embed(part.map(([, text]) => text), 'passage');
    await db.query(
      `insert into ${EMBED_CACHE} (model, sha, embedding)
       select $1, u.sha, u.v::vector from unnest($2::text[], $3::text[]) u(sha, v)
       on conflict do nothing`,
      [embedder.model, part.map(([sha]) => sha), vectors.map(toVector)],
    );
  }
  return missing.length;
}

/** Strips pasted text from a raw turn; exported for the eval's inspection tool. */
export { stripInjected };

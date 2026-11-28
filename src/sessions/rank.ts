/**
 * Ranks one person's chats for a question, in one database round trip.
 *
 *   1. Keyword list (BM25F). The question loses its stopwords and filler in
 *      Spanish and English, then goes through the same word steps as the
 *      index. Each remaining word scores a chat by how rare it is across the
 *      person's chats and how often it appears in the chat's title and card,
 *      the person's own messages and the agent's answers, with diminishing
 *      returns and a correction for long chats.
 *   2. Meaning list. The question's vector against each chat's passages; a
 *      chat scores its best passage. Skipped when no embedder is loaded.
 *   3. Reciprocal rank fusion: score = sum of 1 / (K + rank) over the lists.
 *      A chat high in either list comes first; high in both, higher still.
 *
 * A chat comes back only when one list vouches for it: it covers at least
 * `minKeyword` of the question's rarity-weighted words, or its best passage is
 * at least `minMeaning` similar. Below both, nothing is better than a wrong chat.
 *
 * Isolation: every CTE filters on `owner = $1` (index rows and `sessions`
 * rows both), like every read in store.ts.
 */
import type pg from 'pg';
import { isFiller } from '../search/words.js';
import { splitIdentifiers } from './clean.js';
import { toVector, type Embedder } from './embed.js';
import { checkSchema, DEFAULT_INDEX_SCHEMA, EMBED_CACHE, tsConfig } from './search-index.js';

export interface RankParams {
  k1: number;
  b: number;
  /** Field weights: title and card, the person's messages, the agent's answers. */
  wAbout: number;
  wUser: number;
  wAgent: number;
  /** RRF constant. */
  rrfK: number;
  /** How many chats each list contributes before fusion. 0 turns a list off. */
  depthKeyword: number;
  depthMeaning: number;
  /** Weight of the meaning list in the fusion (keyword list is 1). */
  wMeaning: number;
  /**
   * A chat must reach one of these to be returned. Keyword: the share of the
   * best possible score (every question word present, weighted by rarity),
   * 0 to 1, so it means the same in a small corpus and a large one. Meaning:
   * cosine similarity of the best passage.
   */
  minKeyword: number;
  minMeaning: number;
}

export const DEFAULT_RANK: RankParams = {
  // Tuned on the private eval set (AGENTS.md, Chat search), 2026-11-28.
  k1: 1.2,
  b: 0.75,
  wAbout: 6,
  wUser: 1,
  wAgent: 0.3,
  rrfK: 10,
  depthKeyword: 50,
  depthMeaning: 50,
  wMeaning: 0.75,
  minKeyword: 0.3,
  minMeaning: 0.86,
};

export interface RankedChat {
  source: string;
  id: string;
  score: number;
  keyword: number | null;
  keyword_rank: number | null;
  meaning: number | null;
  meaning_rank: number | null;
}

export interface RankOptions {
  ownerId: string;
  question: string;
  limit: number;
  /** Only chats filed under these brains. */
  brains?: string[] | null;
  /**
   * Extra SQL over `sessions s` (already owner-filtered), with its own
   * parameters numbered from `$${firstParam}`. Used by search_sessions filters.
   */
  filter?: { sql: string; args: unknown[] };
  schema?: string;
  embedder?: Embedder | null;
  params?: Partial<RankParams>;
  /** Precomputed question vector (the eval reuses one across settings). */
  vector?: number[] | null;
  /** Extra columns over `sessions s` to return with each chat (store.ts summary columns). */
  select?: string;
  /** Limit for the ranking query, in ms (default 8000; `context` passes less). */
  timeoutMs?: number;
}

/** The question without filler, or the question itself when only filler is left. */
export function questionWords(question: string): string {
  const words = splitIdentifiers(question).split(/\s+/).filter(Boolean);
  const kept = words.filter((word) => !isFiller(word));
  return (kept.length ? kept : words).join(' ');
}

export async function rankChats<T extends object = object>(
  db: pg.Pool,
  options: RankOptions,
): Promise<Array<RankedChat & { row: T }>> {
  const schema = checkSchema(options.schema ?? DEFAULT_INDEX_SCHEMA);
  const p = { ...DEFAULT_RANK, ...options.params };
  const words = questionWords(options.question);
  if (!words.trim()) return [];

  let vector = options.vector ?? null;
  const embedder = options.embedder ?? null;
  if (!vector && embedder && p.depthMeaning > 0) {
    vector = (await embedder.embed([options.question], 'query'))[0] ?? null;
  }

  const s = schema;
  const args: unknown[] = [
    options.ownerId, // $1
    options.brains?.length ? options.brains : null, // $2
    words, // $3
    vector ? toVector(vector) : null, // $4
    embedder?.model ?? null, // $5
    p.depthKeyword, // $6
    options.limit, // $7
    p.k1, p.b, p.wAbout, p.wUser, p.wAgent, // $8..$12
    p.rrfK, p.wMeaning, p.minKeyword, p.minMeaning, // $13..$16
    p.depthMeaning, // $17
  ];
  const extra = options.filter ? options.filter.sql.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + args.length}`) : 'true';
  if (options.filter) args.push(...options.filter.args);

  const sql = `
    with allowed as (
      select d.source, d.id, d.about_len, d.user_len, d.agent_len
        from ${s}.session_docs d
        join sessions s on s.source = d.source and s.id = d.id and s.owner = $1
       where d.owner = $1 and ($2::text[] is null or s.brain = any($2)) and (${extra})
    ), terms as (
      select distinct lexeme from unnest(to_tsvector('${tsConfig(s)}', $3::text))
       where length(lexeme) between 2 and 40
    ), stats as (
      select count(*)::float8 as n,
             greatest(avg(about_len), 1)::float8 as la, greatest(avg(user_len), 1)::float8 as lu,
             greatest(avg(agent_len), 1)::float8 as lg
        from ${s}.session_docs where owner = $1
    ), df as (
      select t.lexeme,
             ln(1 + (st.n - coalesce(c.df, 0) + 0.5) / (coalesce(c.df, 0) + 0.5)) as idf
        from terms t
        cross join stats st
        left join (
          select p.lexeme, count(distinct (p.source, p.id))::float8 as df
            from ${s}.session_postings p
           where p.owner = $1 and p.lexeme in (select lexeme from terms)
           group by p.lexeme
        ) c on c.lexeme = t.lexeme
    ), qmax as (
      -- The most a chat could score: every word present, fully saturated.
      select greatest(sum(idf), 1e-9) as v from df
    ), tf as (
      select p.source, p.id, p.lexeme,
             coalesce(sum(p.tf) filter (where p.field = 1), 0)::float8 as fa,
             coalesce(sum(p.tf) filter (where p.field = 2), 0)::float8 as fu,
             coalesce(sum(p.tf) filter (where p.field = 3), 0)::float8 as fg
        from ${s}.session_postings p
       where p.owner = $1 and p.lexeme in (select lexeme from terms)
       group by p.source, p.id, p.lexeme
    ), kw as (
      select tf.source, tf.id,
             sum(df.idf * x.v / ($8::float8 + x.v)) as score
        from tf
        join df on df.lexeme = tf.lexeme
        join allowed a on a.source = tf.source and a.id = tf.id
        cross join stats st
        cross join lateral (select
              $10::float8 * tf.fa / (1 - $9::float8 + $9::float8 * a.about_len / st.la)
            + $11::float8 * tf.fu / (1 - $9::float8 + $9::float8 * a.user_len / st.lu)
            + $12::float8 * tf.fg / (1 - $9::float8 + $9::float8 * a.agent_len / st.lg) as v) x
       group by tf.source, tf.id
    ), kw_ranked as (
      select source, id, score, score / (select v from qmax) as share,
             row_number() over (order by score desc, id) as r
        from kw order by score desc limit $6
    ), mn as (
      select c.source, c.id, max(1 - (e.embedding <=> $4::vector)) as sim
        from ${s}.session_chunks c
        join ${EMBED_CACHE} e on e.model = $5 and e.sha = c.sha
        join allowed a on a.source = c.source and a.id = c.id
       where $4::vector is not null
       group by c.source, c.id
    ), mn_ranked as (
      select source, id, sim, row_number() over (order by sim desc, id) as r
        from mn order by sim desc limit $17
    ), fused as (
      select coalesce(k.source, m.source) as source, coalesce(k.id, m.id) as id,
             coalesce(1.0 / ($13::float8 + k.r), 0) + coalesce($14::float8 / ($13::float8 + m.r), 0) as score,
             k.share as keyword, k.r as keyword_rank, m.sim as meaning, m.r as meaning_rank
        from kw_ranked k
        full join mn_ranked m on m.source = k.source and m.id = k.id
       where coalesce(k.share, 0) >= $15 or coalesce(m.sim, 0) >= $16
       order by score desc, coalesce(k.score, 0) desc
       limit $7
    )
    select f.source as rank_source, f.id as rank_id, f.score as rank_score, f.keyword as rank_keyword,
           f.keyword_rank as rank_keyword_rank, f.meaning as rank_meaning, f.meaning_rank as rank_meaning_rank
           ${options.select ? `, ${options.select}` : ''}
      from fused f
      join sessions s on s.source = f.source and s.id = f.id and s.owner = $1
     order by f.score desc, coalesce(f.keyword, 0) desc`;
  // Context waits at most a few seconds; a stuck query must not hold it.
  const { rows } = await db.query<Record<string, unknown>>({ text: sql, values: args, query_timeout: options.timeoutMs ?? 8_000 } as pg.QueryConfig);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return rows.map((r) => {
    const {
      rank_source, rank_id, rank_score, rank_keyword, rank_keyword_rank, rank_meaning, rank_meaning_rank, ...row
    } = r;
    return {
      source: String(rank_source),
      id: String(rank_id),
      score: Number(rank_score),
      keyword: num(rank_keyword),
      keyword_rank: num(rank_keyword_rank),
      meaning: num(rank_meaning),
      meaning_rank: num(rank_meaning_rank),
      row: row as T,
    };
  });
}

/**
 * Whether a full sync has put all of this owner's chats in the index (else
 * callers use the old search). A yes is kept for five minutes, so the check
 * costs a round trip only now and then; a no is asked again each time.
 */
const readyCache = new Map<string, number>();
export async function indexReady(db: pg.Pool, ownerId: string, schema = DEFAULT_INDEX_SCHEMA): Promise<boolean> {
  checkSchema(schema);
  const key = `${schema}:${ownerId}`;
  if ((readyCache.get(key) ?? 0) > Date.now()) return true;
  try {
    const { rows } = await db.query(`select 1 from ${schema}.session_index_meta where key = $1`, [`ready:${ownerId}`]);
    if (rows.length) readyCache.set(key, Date.now() + 5 * 60_000);
    return rows.length > 0;
  } catch {
    return false;
  }
}

export function resetIndexReady(): void {
  readyCache.clear();
}

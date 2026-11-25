/**
 * Claim search, in two tiers.
 *
 *   1. all_words: every word of the query is in the claim, its heading or its
 *      page path (websearch syntax), or the whole query appears as a phrase.
 *   2. any_words: runs only when tier 1 returns fewer than the limit. Stopwords
 *      are dropped, each remaining word also matches as a prefix, and a claim
 *      must cover enough of them: 1 of 1-2 words, 2 of 3-5, 3 of 6 or more.
 *      One word of a six-word question is usually noise. Claims that cover
 *      more of the query words rank first.
 *
 * Inside each tier, ties go to the newest: verified_at first, then the date the
 * page last changed in git.
 *
 * Every query filters on brain_id = any($1). Callers pass only brain ids they
 * resolved through requireBrain; this module never chooses brains itself.
 */
import { db } from '../db/client.js';
import type { ClaimRow } from '../types.js';

export type MatchTier = 'all_words' | 'any_words';

export interface ClaimHit extends ClaimRow {
  match: MatchTier;
  /** Query words the claim covers, of `terms`. Tier 1 covers all of them. */
  covered: number;
  terms: number;
  page_updated_at: Date | null;
}

export interface ClaimSearchOptions {
  limit: number;
  includeSuperseded?: boolean;
}


const RECENCY = 'c.verified_at desc nulls last, p.last_commit_at desc nulls last, c.page_path, c.line';

export async function searchClaims(
  brainIds: string[],
  query: string,
  options: ClaimSearchOptions,
): Promise<ClaimHit[]> {
  const text = query.trim();
  if (!brainIds.length || !text) return [];
  const includeSuperseded = options.includeSuperseded ?? false;

  const { rows: strict } = await db().query<ClaimRow & { page_updated_at: Date | null; terms: number }>(
    `select c.*, p.last_commit_at as page_updated_at,
            (select count(distinct lexeme)::int from unnest(to_tsvector('english', $2))) as terms
       from claims c
       left join pages p on p.brain_id = c.brain_id and p.path = c.page_path
      where c.brain_id = any($1)
        and (c.fts @@ websearch_to_tsquery('english', $2) or c.text ilike $3)
        and ($4 or c.superseded_by is null)
      order by ts_rank_cd(c.fts, websearch_to_tsquery('english', $2)) desc, ${RECENCY}
      limit $5`,
    [brainIds, text, `%${escapeLike(text)}%`, includeSuperseded, options.limit],
  );
  const hits: ClaimHit[] = strict.map((row) => ({
    ...row,
    match: 'all_words',
    covered: row.terms,
    terms: row.terms,
  }));
  if (hits.length >= options.limit) return hits;

  // Lexemes come from Postgres itself, so stemming and stopwords match the
  // index. Each becomes its own tsquery (a prefix when 3+ characters), and a
  // claim's coverage is how many of them it matches.
  const { rows: loose } = await db().query<ClaimRow & { page_updated_at: Date | null; covered: number; terms: number }>(
    `with lex as (
       select distinct lexeme from unnest(to_tsvector('english', $2))
        where lexeme !~ '[''\\\\:&|!()<>*]'
     ), q as (
       select array_agg(to_tsquery('simple', quote_literal(lexeme) || case when length(lexeme) >= 3 then ':*' else '' end)) as each,
              to_tsquery('simple', string_agg(quote_literal(lexeme) || case when length(lexeme) >= 3 then ':*' else '' end, ' | ')) as anyq,
              count(*)::int as terms
         from lex
     )
     select c.*, p.last_commit_at as page_updated_at, cov.n as covered, q.terms
       from q
       join claims c on c.brain_id = any($1) and c.fts @@ q.anyq
       left join pages p on p.brain_id = c.brain_id and p.path = c.page_path
       cross join lateral (select count(*)::int as n from unnest(q.each) t where c.fts @@ t) cov
      where q.terms > 0
        and ($4 or c.superseded_by is null)
        and not (c.id = any($5))
        and cov.n >= case when q.terms <= 2 then 1 when q.terms <= 5 then 2 else 3 end
      order by cov.n desc, ts_rank_cd(c.fts, q.anyq) desc, ${RECENCY}
      limit $3`,
    [
      brainIds,
      text,
      options.limit - hits.length,
      includeSuperseded,
      hits.map((h) => h.id),
    ],
  );
  for (const row of loose) hits.push({ ...row, match: 'any_words' });
  return hits;
}

/** Makes text safe inside an ILIKE pattern. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

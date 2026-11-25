/**
 * Claim search, in two tiers.
 *
 *   1. all_words: every word of the query is in the claim, its heading or its
 *      page path (websearch syntax), or the whole query appears as a phrase.
 *   2. any_words: runs only when tier 1 returns fewer than the limit. Stopwords
 *      are dropped, each remaining word also matches as a prefix, and a claim
 *      must cover enough of them: 1 of 1-2 words, 2 of 3-5, 3 of 6 or more.
 *      One word of a six-word question is usually noise. Claims that cover
 *      more of the query words rank first, each word weighted by how rare it
 *      is (numbers and names count for more), then rows from the brain's
 *      register pages, then more words, then recency.
 *
 * Filler words a question carries ("still", "currently") are dropped first.
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
  /**
   * Register pages: where a brain keeps its asks, facts and the like, as
   * `{ brainId, path }`. Rows from them win ties on coverage. A ranking hint
   * only: it never adds a brain or a page to what is searched.
   */
  registers?: { brainId: string; path: string }[];
}

/**
 * Words of a question that say nothing about the subject. Postgres' own
 * stopwords (what, is, the, ...) are already dropped; these are the ones it
 * keeps. Stripped from the query unless nothing else would be left.
 */
const FILLER = new Set([
  'still', 'yet', 'currently', 'now', 'today', 'please', 'tell', 'know', 'anything', 'everything', 'something',
  'also', 'ever', 'just', 'really', 'actually',
]);

/** The query without filler words, or the query itself when only filler is left. */
export function withoutFiller(query: string): string {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const kept = words.filter((word) => !FILLER.has(word.toLowerCase().replace(/[^a-z]/g, '')));
  return kept.length ? kept.join(' ') : query.trim();
}


const RECENCY = 'c.verified_at desc nulls last, p.last_commit_at desc nulls last, c.page_path, c.line';

export async function searchClaims(
  brainIds: string[],
  query: string,
  options: ClaimSearchOptions,
): Promise<ClaimHit[]> {
  const text = withoutFiller(query);
  if (!brainIds.length || !text) return [];
  // Register rows win ties. Keys are "brain id::path", so a path never counts
  // for a brain it was not given for.
  const registers = (options.registers ?? []).filter((r) => brainIds.includes(r.brainId)).map((r) => `${r.brainId}::${r.path}`);
  const REGISTER = 'case when (c.brain_id || \'::\' || c.page_path) = any($6) then 0 else 1 end';
  const includeSuperseded = options.includeSuperseded ?? false;

  const { rows: strict } = await db().query<ClaimRow & { page_updated_at: Date | null; terms: number }>(
    `select c.*, p.last_commit_at as page_updated_at,
            (select count(distinct lexeme)::int from unnest(to_tsvector('english', $2))) as terms
       from claims c
       left join pages p on p.brain_id = c.brain_id and p.path = c.page_path
      where c.brain_id = any($1)
        and (c.fts @@ websearch_to_tsquery('english', $2) or c.text ilike $3)
        and ($4 or c.superseded_by is null)
      order by ${REGISTER}, ts_rank_cd(c.fts, websearch_to_tsquery('english', $2)) desc, ${RECENCY}
      limit $5`,
    [brainIds, text, `%${escapeLike(text)}%`, includeSuperseded, options.limit, registers],
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
  // claim's coverage is how many of them it matches. Each word also has a
  // weight: how rare it is among the claims of these brains, so a number or a
  // name ("22", a client) counts for more than a word that is in every row
  // ("open"). Rows are ranked by the weighted share they cover, in tenths.
  const { rows: loose } = await db().query<ClaimRow & { page_updated_at: Date | null; covered: number; terms: number }>(
    `with lex as (
       select distinct lexeme from unnest(to_tsvector('english', $2))
        where lexeme !~ '[''\\\\:&|!()<>*]'
     ), tq as (
       select quote_literal(lexeme) || case when length(lexeme) >= 3 then ':*' else '' end as qtext from lex
     ), total as (
       select count(*)::float as n from claims where brain_id = any($1) and ($4 or superseded_by is null)
     ), w as (
       select tq.qtext, to_tsquery('simple', tq.qtext) as t,
              greatest(0.2, ln((total.n + 1) / (1 + (
                select count(*) from claims c2
                 where c2.brain_id = any($1) and ($4 or c2.superseded_by is null)
                   and c2.fts @@ to_tsquery('simple', tq.qtext)
              )))) as weight
         from tq cross join total
     ), q as (
       select array_agg(t) as each, array_agg(weight) as weights, sum(weight) as weight_total,
              to_tsquery('simple', string_agg(qtext, ' | ')) as anyq,
              count(*)::int as terms
         from w
     )
     select c.*, p.last_commit_at as page_updated_at, cov.n as covered, q.terms
       from q
       join claims c on c.brain_id = any($1) and c.fts @@ q.anyq
       left join pages p on p.brain_id = c.brain_id and p.path = c.page_path
       cross join lateral (
         select count(*)::int as n, coalesce(sum(wt), 0) as weight
           from unnest(q.each, q.weights) as u(t, wt)
          where c.fts @@ u.t
       ) cov
      where q.terms > 0
        and ($4 or c.superseded_by is null)
        and not (c.id = any($5))
        and cov.n >= case when q.terms <= 2 then 1 when q.terms <= 5 then 2 else 3 end
      order by round((cov.weight / q.weight_total)::numeric, 1) desc, ${REGISTER}, cov.n desc,
               ts_rank_cd(c.fts, q.anyq) desc, ${RECENCY}
      limit $3`,
    [
      brainIds,
      text,
      options.limit - hits.length,
      includeSuperseded,
      hits.map((h) => h.id),
      registers,
    ],
  );
  for (const row of loose) hits.push({ ...row, match: 'any_words' });
  return hits;
}

/** Makes text safe inside an ILIKE pattern. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

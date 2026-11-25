-- Search finds a claim by its heading and page path too, not only its own words.
--
-- Weights: A the claim text, B the heading it sits under, C the page path (with
-- / _ . - turned into spaces, so "wiki/payments.md" matches "payments").
-- ts_rank_cd weighs A highest, so a hit in the claim beats a hit in its path.
--
-- Derived data only (rule 2). Re-adding a generated column recomputes it for
-- every existing row, so this migration is its own reindex.

drop index if exists claims_fts;
alter table claims drop column fts;
alter table claims add column fts tsvector generated always as (
  setweight(to_tsvector('english', text), 'A') ||
  setweight(to_tsvector('english', coalesce(heading, '')), 'B') ||
  setweight(to_tsvector('english', regexp_replace(page_path, '[/_.-]+', ' ', 'g')), 'C')
) stored;
create index claims_fts on claims using gin (fts);

-- One row per indexed page: when the page last changed in git. Recency ranks
-- search hits (verified_at first, then this) and dates whole pages that a
-- caller reads, such as an index or a profile page. Rebuilt on every index run.
create table pages (
  brain_id        text not null references brains (id) on delete cascade,
  path            text not null,
  last_commit_sha text,
  last_commit_at  timestamptz,
  primary key (brain_id, path)
);

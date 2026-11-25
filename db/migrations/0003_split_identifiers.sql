-- Dotted and slashed names (`app.pokebots.autoupdate`, `src/auth/access.ts`)
-- are one token to the english parser, so none of their parts could be found.
-- The claim text is now indexed twice under weight A: as written, and with
-- . _ / between letters or digits read as spaces. Derived data; re-adding the
-- generated column recomputes every row.

drop index if exists claims_fts;
alter table claims drop column fts;
alter table claims add column fts tsvector generated always as (
  setweight(to_tsvector('english', text), 'A') ||
  setweight(to_tsvector('english', regexp_replace(text, '([[:alnum:]])[._/]+(?=[[:alnum:]])', '\1 ', 'g')), 'A') ||
  setweight(to_tsvector('english', coalesce(heading, '')), 'B') ||
  setweight(to_tsvector('english', regexp_replace(page_path, '[/_.-]+', ' ', 'g')), 'C')
) stored;
create index claims_fts on claims using gin (fts);

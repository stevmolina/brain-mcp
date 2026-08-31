-- brain-mcp initial schema.
-- Every table below is derived. The git repo is canonical; if a row here cannot be
-- regenerated from a commit, it belongs in markdown instead.
-- Every tenant-scoped row carries brain_id.

create table brains (
  id                    text primary key,
  owner_workos_user_id  text        not null,
  owner_github_login    text        not null,
  repo_owner            text        not null,
  repo_name             text        not null,
  default_branch        text        not null default 'main',
  installation_id       bigint,
  profile               jsonb       not null default '{}'::jsonb,
  last_indexed_commit   text,
  last_indexed_at       timestamptz,
  created_at            timestamptz not null default now(),
  unique (repo_owner, repo_name)
);

-- Immutable received evidence. Never written by the MCP write path.
create table sources (
  id          text primary key,
  brain_id    text not null references brains (id) on delete cascade,
  path        text not null,
  sha256      text not null,
  bytes       integer not null,
  origin      text,
  received_at date,
  commit_sha  text not null,
  unique (brain_id, path)
);

create index sources_brain on sources (brain_id);

create table claims (
  id            text primary key,
  brain_id      text not null references brains (id) on delete cascade,
  text          text not null,
  page_path     text not null,
  line          integer not null,
  heading       text,
  authority     text,
  verified_at   date,
  commit_sha    text not null,
  superseded_by text,
  fts           tsvector generated always as (to_tsvector('english', text)) stored,
  created_at    timestamptz not null default now()
);

create index claims_brain on claims (brain_id);
create index claims_fts on claims using gin (fts);
create index claims_brain_page on claims (brain_id, page_path);
create index claims_trgm_fallback on claims (brain_id, lower(text) text_pattern_ops);

-- Provenance edges. Powers explain_claim.
create table claim_sources (
  brain_id  text not null references brains (id) on delete cascade,
  claim_id  text not null references claims (id) on delete cascade,
  source_id text not null references sources (id) on delete cascade,
  relation  text not null default 'cites',
  primary key (claim_id, source_id)
);

create index claim_sources_brain on claim_sources (brain_id);

create table supersessions (
  brain_id     text not null references brains (id) on delete cascade,
  old_claim_id text not null,
  new_claim_id text not null,
  noted_at     date,
  primary key (brain_id, old_claim_id, new_claim_id)
);

create table audit_findings (
  id          bigserial primary key,
  brain_id    text not null references brains (id) on delete cascade,
  check_name  text not null,
  severity    text not null,
  claim_id    text,
  page_path   text,
  detail      text not null,
  commit_sha  text,
  found_at    timestamptz not null default now(),
  resolved_at timestamptz
);

create index audit_findings_brain_open
  on audit_findings (brain_id)
  where resolved_at is null;

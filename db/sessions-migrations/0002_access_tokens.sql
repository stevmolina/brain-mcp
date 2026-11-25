-- Personal access tokens, for callers that cannot do OAuth: hooks on a laptop,
-- bots on a server. In the sessions database, beside the share grants, because
-- a token is a person's decision and cannot be rebuilt from git.
--
-- Only a SHA-256 of the token is stored; the token is shown once, when made.
-- `brains` null means every brain the user can reach. Set, it is an allow
-- list: the token reaches only those brains, and only while the user can.
-- Revoking is deleting the row.

create table if not exists brain_mcp.access_tokens (
  id             text primary key,
  token_hash     text        not null unique,
  workos_user_id text        not null,
  name           text        not null,
  brains         text[],
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  check (brains is null or cardinality(brains) > 0)
);

create index if not exists access_tokens_user on brain_mcp.access_tokens (workos_user_id);

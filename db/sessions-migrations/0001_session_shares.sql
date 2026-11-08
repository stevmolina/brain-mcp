-- Share grants, in the sessions database (not the brain database).
--
-- The brain database is derived from git and can be rebuilt. A share is a
-- person's decision and cannot be, so it lives beside the chats it points at,
-- in brain-mcp's own schema there. The `sessions` table itself belongs to the
-- sessions CLI; brain-mcp only reads it.
--
-- A share is one chat, or a turn range of it, for one verified email address.
-- The id is a random token and doubles as the link, but the link alone grants
-- nothing: the reader must sign in as that email.

create schema if not exists brain_mcp;

create table if not exists brain_mcp.session_shares (
  id             text primary key,
  owner          text        not null,  -- WorkOS user id of the chat's owner
  source         text        not null,  -- sessions.source
  session_id     text        not null,  -- sessions.id
  grantee_email  text        not null,  -- lowercased
  turn_from      integer,               -- 1-based, inclusive; null = from the start
  turn_to        integer,               -- 1-based, inclusive; null = to the end
  note           text,
  expires_at     timestamptz,
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  check (turn_from is null or turn_from >= 1),
  check (turn_to is null or turn_from is null or turn_to >= turn_from)
);

create index if not exists session_shares_owner on brain_mcp.session_shares (owner, created_at desc);
create index if not exists session_shares_grantee on brain_mcp.session_shares (grantee_email, created_at desc);
create index if not exists session_shares_session on brain_mcp.session_shares (source, session_id);

-- Per-brain write policy. Not derived from a commit: it is the owner's choice
-- of how this server writes, the same kind of setting as the profile jsonb
-- already on this table. Empty object means review for every action.

alter table brains
  add column write_modes jsonb not null default '{}'::jsonb;

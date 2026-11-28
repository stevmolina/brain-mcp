-- Labeled questions for scoring chat search (scripts/eval-sessions.ts).
-- They quote a person's real chats, so they live here, next to those chats,
-- under the same owner rule, and never in the repository.
create table if not exists brain_mcp.search_eval_cases (
  owner      text not null,
  id         text not null,
  query      text not null,
  lang       text,
  kinds      text[] not null default '{}',
  -- {"source:id": grade}: 2 exactly about it, 1 helpful. Empty: no chat should come back.
  relevant   jsonb not null default '{}',
  -- Chats the scorer ignores (the chat being asked from, helper chats).
  exclude    text[] not null default '{}',
  note       text,
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

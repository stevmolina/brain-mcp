-- The shape of the `sessions` table the sessions CLI creates and pushes to
-- (agent-sessions internal/remote/schema.sql), trimmed to what brain-mcp reads.
-- Tests create it in the test database; production reads the CLI's own table.
CREATE TABLE IF NOT EXISTS sessions (
  source text NOT NULL,
  id text NOT NULL,
  machine text NOT NULL,
  provider text NOT NULL,
  cwd text,
  title text,
  started_at timestamptz,
  updated_at timestamptz,
  body text NOT NULL,
  turns jsonb NOT NULL,
  owner text,
  brain text,
  repos text[],
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))
  ) STORED,
  PRIMARY KEY (source, id)
);
-- Added by the CLI after the first release; the chat-search index keys on it.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS clean_fingerprint text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS repos text[];

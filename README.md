# brain-mcp

Remote second brains served over MCP.

Any user brings any git repo of markdown and registers it as a brain. The repo is
canonical; everything else is a disposable copy.

```
brain repo (markdown in git)  -- the truth
     | push webhook
INDEXER                       -- full rebuild per push, no incremental diffing
     |
NEON                          -- searchable copy; drop it, rebuild it, lose nothing
     |
MCP SERVER                    -- reads from Neon, writes to git as a branch + PR
```

Reads come from the copy because it's fast. Writes go to the truth because it's
reviewable: every write opens a pull request, never a merge, and never touches a
brain's `sources/`.

Seven tools: `list_brains`, `search`, `get_claim`, `explain_claim`, `remember`,
`update_fact`, `forget`. Every returned claim carries where it came from, when it was verified,
and its authority.

Each brain can also keep private files (spreadsheets, exports, anything that is
not markdown) in a Cloudflare R2 bucket, through three more tools: `list_files`,
`get_file` and `add_file`. Reading needs read access to the brain repo; adding
needs push access. Adding is not a git write and opens no pull request. Instead
it is add-only: an existing path is refused, and there is no overwrite or delete.
The tools appear only when `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` and `R2_BUCKET` are set. `pnpm upload-files <brain id>
<local dir>` loads a folder the same way.

## How agents use it

An agent with only this server connected, and no rules of its own, should use it
without being told. The server instructions say when, and every tool description
repeats its own trigger, because some clients (Composio, for one) pass only tool
names, descriptions and schemas.

- **Before answering** about a project, client, person or past decision, the agent
  calls `search` on the matching brain and cites the page and date. If it does not
  know the brain id, it calls `list_brains` first.
- **Before asking for a file**, it looks with `list_files` and `get_file`.
- **When a file worth keeping** is shared or produced, it stores it with
  `add_file`, named date first (`inputs/2026-09-01-report.xlsx`), without asking.
- **When a decision is settled**, it proposes it with `remember` and tells the user
  that this opens a pull request a person merges. `update_fact` and `forget` do
  the same for claims that are out of date.
- It picks the brain by the project or client the user names, and says which one
  it used when several match.

See [AGENTS.md](AGENTS.md) for the rules, the claim format and how to run it, and
[docs/plan-multi-org.md](docs/plan-multi-org.md) for where multi-user brains go next.

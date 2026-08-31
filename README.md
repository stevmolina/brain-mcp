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

Six tools: `search`, `get_claim`, `explain_claim`, `remember`, `update_fact`,
`forget`. Every returned claim carries where it came from, when it was verified,
and its authority.

See [AGENTS.md](AGENTS.md) for the rules, the claim format and how to run it.

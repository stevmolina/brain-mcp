# brain-mcp

Remote second brains served over MCP. Any user brings any git repo of markdown and
connects it as a brain. This is not anyone's brain: Steven's own repo and the
Resorsi client brains are tenants like any other, so the engine carries no client
names, no fixed page names and no house conventions.

## Three rules

1. **No tenant data in this repo.** No client names, no brain content, no fixtures
   copied out of a real brain, no ids that identify an engagement. Tests use
   invented brains. If you need a real example, point at the live brain by id.
2. **The database is always rebuildable from git.** Every row in Neon is derived.
   The test for a new column: if it cannot be regenerated from a commit, it belongs
   in markdown instead, not here.
3. **Writes never merge, and never touch `sources/`.** The default mode opens a
   pull request. A brain can set an action to commit straight to the default
   branch, or to refuse the write. No merge call belongs in this codebase. A new
   row appears only after the indexer reprocesses the commit: the merged one, or
   the direct one.

## Shape

```
brain repo (markdown in git)  -- the truth
     | push webhook
INDEXER   src/indexer/        -- parses claims; full rebuild per push, no diffing
     |
NEON      db/migrations/      -- searchable copy; drop it, rebuild it, lose nothing
     |
MCP       src/index.ts        -- reads from Neon, writes to git as a commit or a pull request
```

The asymmetry is the design: reads come from the copy because it's fast, writes go
to the truth because it's reviewable.

## Claim format

Two fields, deliberately minimal. No `profile.yaml` in a tenant repo until a real
failure demands one; per-brain settings live on the `brains` row.

```markdown
- Production runs in the client's Vercel account.
  <!-- authority: live | verified_at: 2026-08-19 -->
```

An unmarked claim is durable and is never chased. `authority` says whether the line
is truth or a summary of something else; only a human knows that, which is why it
is never derived. `supersedes:` and `source:` are also recognised.

Write modes are the other setting that lives on the `brains` row, next to
`profile`. They are the owner's choice of how this server writes (`auto`,
`review`, `read_only`, per action), not a fact the repo states. The default is
`review`. Changing a mode does not open a pull request, so a brain set to
`read_only` can still be changed by its owner.

Claim id is `sha256(brain_id + page path + normalized text)`, so it is stable
across reflows and changes when the claim changes.

## Auth

WorkOS AuthKit is the authorization server; this is a **resource server only**.
Use `requireBearerAuth`, `mcpAuthMetadataRouter` and `OAuthTokenVerifier` from
`@modelcontextprotocol/express`. The v1 AS helpers (`mcpAuthRouter`,
`ProxyOAuthServerProvider`) are frozen in `@modelcontextprotocol/server-legacy`;
do not use them.

WorkOS answers *who this is*. The GitHub API answers *which brains they may read*.
There is no second permission list in this database, and there must not be one.
Repo access is cached for a minute so removal takes effect without a deploy.

## Multi-tenancy

Every tenant-scoped row carries `brain_id`, and every query filters on it. All
brain resolution goes through `requireBrain` in `src/auth/access.ts`; nothing else
loads a brain row for a request. `test/isolation.test.ts` asks a brain-A question
while scoped to brain-B and asserts nothing leaks. Keep it passing.

## Running

Secrets live in Doppler project `brain-mcp`, configs `dev` and `prd`. Never write
a `.env`, on the box or here.

```sh
doppler run -- pnpm migrate
doppler run -- pnpm dev
doppler run -- pnpm test
doppler run -- pnpm register-brain <owner/repo> --workos-user <id>
doppler run -- pnpm reindex [<brain id>]
doppler run -- pnpm reconcile [<brain id>]
doppler run -- pnpm offboard-brain <brain id> [--confirm]
```

Deployed to the OVH VPS under Dokploy (lane 1), behind Traefik at
`brain.mcpbox.dev`. The container binds `0.0.0.0` because Dokploy publishes no host
port and Traefik reaches it over the docker network; nothing on the box binds a
public port but Traefik. Memory-cap the container.

## Open, deliberately

- **No embeddings.** Sending tenant text to an embedding provider is a
  subprocessor question, sharper because this runs on a personal box. Postgres
  full-text is enough at current volume. Do not add embeddings without asking.
- The reconciler records findings only. Turning a finding into a proposed edit
  goes through the write path, which opens a pull request.

# brain-mcp

Remote second brains served over MCP. Any user brings any git repo of markdown and
registers it as a brain. This is not anyone's brain: Steven's own repo and the
Resorsi client brains are tenants like any other, so the engine carries no client
names, no fixed page names and no house conventions.

## Three rules

1. **No tenant data in this repo.** No client names, no brain content, no fixtures
   copied out of a real brain, no ids that identify an engagement. Tests use
   invented brains. If you need a real example, point at the live brain by id.
2. **The database is always rebuildable from git.** Every row in Neon is derived.
   The test for a new column: if it cannot be regenerated from a commit, it belongs
   in markdown instead, not here.
3. **Writes only ever produce a pull request.** No merge call belongs in this
   codebase. Nothing writes to a brain's `sources/`. A new row appears only after
   the indexer reprocesses the merged commit.
   File adds (`add_file`, `pnpm upload-files`) are not git writes: they go to R2,
   not the repo, and are add-only instead of reviewed. See Files below.

## Shape

```
brain repo (markdown in git)  -- the truth
     | push webhook
INDEXER   src/indexer/        -- parses claims; full rebuild per push, no diffing
     |
NEON      db/migrations/      -- searchable copy; drop it, rebuild it, lose nothing
     |
MCP       src/index.ts        -- reads from Neon, writes to git as a branch + PR
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

Each body row of a markdown table is a claim too, with the header cells paired to
the row cells (`Date: 2026-09-08; Status: Active; Decision: ...`). A marker in any
cell of the row works the same way. `update_fact` and `forget` only edit list
items, so they refuse a table-row claim.

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

## Files

Each brain also has a private file space for inputs that are not markdown (a
spreadsheet a client sent, an export). It lives in one Cloudflare R2 bucket owned
by the service, never in the brain repo and never in Neon.

- Object key is `<brain id>/<relative path>`, e.g. `owner/repo/inputs/2026-09-01-x.xlsx`.
  Only brain ids of the form `owner/repo` get a file space, so the first two
  segments of a key always name exactly one brain.
- Tools: `list_files` and `get_file` need read access to the brain repo,
  `add_file` needs push access. All three resolve the brain through `requireBrain`
  (`requireBrainWriter` for adds), so GitHub stays the only permission list.
- `get_file` returns a presigned download link (15 minutes), plus the text inline
  for csv, md, txt and json under 200 KB.
- `add_file` takes base64 content up to 10 MB, or returns a presigned PUT for
  bigger files. **Add-only:** every put carries `If-None-Match: *`, including the
  signed upload URL, so an existing file is refused, never replaced. There is no
  overwrite and no delete tool, on purpose. Do not add one without asking.
- Paths with `..`, `.`, a leading `/`, an empty segment or a backslash are refused.
- Env, all four or the file tools are not registered and the server still starts:
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
  `R2_ENDPOINT` optionally points at a local S3-compatible server in development.
- `test/files.test.ts` fakes the bucket in memory and asks for brain-A files while
  scoped to brain-B. Keep it passing alongside `test/isolation.test.ts`.

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
doppler run -- pnpm upload-files <brain id> <local dir>
```

`upload-files` copies a local folder into a brain's file space and skips any path
that already exists, then prints how many it added, skipped and refused.

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

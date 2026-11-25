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
3. **Writes produce a pull request, unless the owner opted in.** A brain whose
   profile sets `directWrites: true` lets its owner (the registered WorkOS user
   or GitHub login, whose own login GitHub says can push right now) commit
   straight to the default branch; everyone else, and
   every brain without the switch, gets a branch and a pull request. A direct
   write is one contents commit guarded by the page's blob sha; on a conflict it
   re-applies once, then falls back to a PR. No merge call belongs in this
   codebase. Nothing writes to a brain's `sources/`, in either mode. A new row
   appears only after the indexer reprocesses the commit on the default branch.
   File adds (`add_file`, `pnpm upload-files`) are not git writes: they go to R2,
   not the repo, and are add-only instead of reviewed. See Files below.

4. **Chats are private to their owner.** Brains are shared and follow GitHub.
   Sessions (a person's agent chats) belong to one person: a session row is
   returned only when `owner = caller`, or when an active share grants the
   caller's verified email that chat. All of it lives in
   `src/sessions/store.ts`; `test/sessions-isolation.test.ts` and
   `test/web.test.ts` hold it. Keep them passing.

## Shape

```
brain repo (markdown in git)  -- the truth
     | push webhook
INDEXER   src/indexer/        -- parses claims; full rebuild per push, no diffing
     |
NEON      db/migrations/      -- searchable copy; drop it, rebuild it, lose nothing
     |
MCP       src/index.ts        -- reads from Neon, writes to git as a branch + PR
                                 (or a direct commit for an opted-in owner)
```

The asymmetry is the design: reads come from the copy because it's fast, writes go
to the truth because it's reviewable.

## Claim format

Two fields, deliberately minimal. No `profile.yaml` in a tenant repo until a real
failure demands one; per-brain settings live on the `brains` row (`profile`
jsonb, e.g. `{"directWrites": true}`; only a literal `true` turns that on).

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

## Search

`src/search/claims.ts`, in two tiers. First every query word (in the claim, its
heading or its page path, weighted A, B, C). When that returns fewer than the
limit, any word: stopwords dropped, prefixes, and a claim must cover 1 of 1-2
words, 2 of 3-5, 3 of 6+. Filler a question carries and Postgres keeps
("still", "currently", `FILLER` in the file) is dropped first. Ranking in the
any-word tier: the share of query words covered, each weighted by how rare it
is in these brains (so "22" or a client name outweighs "open"), in quarters;
then rows from the brain's register pages (profile `registerPages`); then more
words; then `verified_at`, then the page's last commit date (`pages`, filled by
the indexer). Each hit says which tier found it (`match`).

## Context

`context` (MCP tool, REST `GET|POST /api/v1/context`) answers "what should I
read before answering this question" in one call, within a character budget
(default 6000). `src/context/build.ts` walks four levels and stops when the
budget is spent or claims already answer (3+ all-words hits, unless `depth: 4`
was asked for): 1 the caller's own me card, 2 the target brain's index page,
3 claims, 4 the caller's own chats in that brain. Every line carries a date.

Brain choice: explicit `brain` (through `requireBrain`), else a reachable
brain named in the question or `cwd` by a profile alias or its repo name, else
the brains whose claims match best. At most two. Never a brain outside
`accessibleBrains`.

When claims matched, the me card and the index are cut to a short head (1,200
characters, or a tenth of the budget when that is more) so claims get most of
the budget; with no match they keep their full share. A claim row over 700
characters is cut in the output (its id opens the rest), and a row that does
not fit is skipped, not allowed to hide the shorter rows after it.

Profile keys it reads, all on the `brains` row: `meCard` (path of the owner's
me card; only on a personal brain, used only for its owner), `indexPage`
(default `wiki/index.md`), `aliases` (string array: client and product names).
`registerPages` (string array of paths: a brain's asks, facts and other lookup
tables) ranks their rows ahead of rows with the same coverage, in `search` and
`context`. Default none. Aliases and register pages are tenant data, so they
live in the database, never in this repo.

Chats: `card` and `card_updated_at` on `sessions` come from the sessions CLI.
When both columns exist, `search_sessions` and `context` search title + card
first, then the body; without them, everything works as before.

## Auth

WorkOS AuthKit is the authorization server; this is a **resource server only**.
Use `requireBearerAuth`, `mcpAuthMetadataRouter` and `OAuthTokenVerifier` from
`@modelcontextprotocol/express`. The v1 AS helpers (`mcpAuthRouter`,
`ProxyOAuthServerProvider`) are frozen in `@modelcontextprotocol/server-legacy`;
do not use them.

Callers that cannot do OAuth (hooks on a laptop, bots on a server) send a
personal access token instead: `bmt_` plus 32 random bytes, made with
`pnpm create-token`, stored only as a SHA-256 in the sessions database
(`brain_mcp.access_tokens`, not the brain database: a token cannot be rebuilt
from git). An unscoped token acts as its WorkOS user. A token made with
`--brains` acts as `pat:<token id>`, and `src/auth/access.ts` resolves that on
every brain lookup to its user plus an allow list: it reaches only those brains,
and only while the user can; it owns no chats and has no email. Revoking deletes
the row and takes effect on the next request. `test/tokens.test.ts` holds the
scoping; keep it passing beside `test/isolation.test.ts`. Pokebots bots keep their
own signed JWTs (`src/auth/pokebots.ts`).

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

## Sessions

The second store. The `sessions` CLI (repo `stevmolina/agent-sessions`) cleans
each person's Claude Code, Codex, Cursor and T3 chats, plus imported ChatGPT,
Claude.ai and Grok exports, and pushes them to its own Postgres. Each row
carries `owner` (the pusher's WorkOS user id) and `brain` (a brain id derived
from the folder the chat ran in). brain-mcp reads that database through
`SESSIONS_DATABASE_URL`, as a role that can SELECT `sessions` and owns the
`brain_mcp` schema there, which holds share grants (`db/sessions-migrations`,
applied by `pnpm migrate`). That role also needs `CREATE` on the database,
because the migrate runs `create schema if not exists brain_mcp`.

Since 2026-11-24 that database is Postgres 17 on the Contabo VPS
(`pg-eu.stevmolina.com:5432`, database `sessions`, TLS only, Let's Encrypt
cert, so the URL uses `sslmode=verify-full`). The runbook is
`/srv/stacks/sessions-db/README.md` on that box (repo `stevmolina/srv-stacks`,
branch `contabo`). Before that it was Neon project `sessions`, which ran out of
free compute; its URL stays in Doppler as `NEON_SESSIONS_DATABASE_URL`. Share
grants made on Neon were not copied: Neon refused every connection at the time.

It is a separate database on purpose: the brain database is derived from git
(rule 2), chats and shares are not.

- Tools: `search_sessions`, `show_session`, `save_to_brain` (a claim citing the
  chat, through the same write path as `remember`), `share_session` (preview
  unless `confirm`), `revoke_share`, `list_my_shares`, `list_shared_with_me`.
  `search` takes `include_sessions` to add the caller's own chats for that
  brain, in their own labeled section.
- A share is one chat, or a turn range, for one email, 30 days by default.
  Its id is the link `/s/<id>`, but the link alone grants nothing: the reader
  signs in, and WorkOS must have verified that email.
- Web: `/sessions` (search, filters, share, revoke) and `/s/<id>`. The browser
  signs in through the same AuthKit as a CIMD client
  (`/oauth/client-metadata.json`), the token is verified like an MCP token and
  dropped, and a cookie signed with `WEB_SESSION_SECRET` holds the user id.
- Without `SESSIONS_DATABASE_URL` the tools are not registered; without
  `WEB_SESSION_SECRET` (32+ chars) the pages are not mounted. Tests point
  `SESSIONS_DATABASE_URL` at `DATABASE_URL` and create a fixture `sessions` table.

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
doppler run -- pnpm create-token --workos-user <id> --name <label> [--brains a/b,c/d]
doppler run -- pnpm list-tokens [--workos-user <id>]
doppler run -- pnpm revoke-token <tok_...>
```

`create-token` prints the token alone on stdout, once. Pipe it into a secret
store; never paste it into a chat, a log or a commit.

`upload-files` copies a local folder into a brain's file space and skips any path
that already exists, then prints how many it added, skipped and refused.

Deployed to the OVH VPS under Dokploy (lane 1), behind Traefik at
`brain.mcpbox.dev`. The container binds `0.0.0.0` because Dokploy publishes no host
port and Traefik reaches it over the docker network; nothing on the box binds a
public port but Traefik. Memory-cap the container.

The container reads its env from the Dokploy app, not from Doppler. After a
Doppler change (for example `SESSIONS_DATABASE_URL`), read the app with
`application.one`, change that one line in its `env`, and send the whole `env`
back with `application.saveEnvironment` (plus its current `buildArgs`,
`buildSecrets` and `createEnvFile`): the call replaces the env, so a partial
one drops every other variable. Then redeploy with `application.deploy` on the
OVH Dokploy API. `SESSIONS_DATABASE_URL` is set in
`prd` only: in `dev` the tests fall back to `DATABASE_URL` and write fixture
rows, so never point `dev` at the real sessions database.

## Open, deliberately

- **No embeddings.** Sending tenant text to an embedding provider is a
  subprocessor question, sharper because this runs on a personal box. Postgres
  full-text is enough at current volume. Do not add embeddings without asking.
- The reconciler records findings only. Turning a finding into a proposed edit
  goes through the write path, which opens a pull request.

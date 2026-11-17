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
MCP SERVER                    -- reads from Neon, writes to git (a PR, or a direct commit for an opted-in owner)
```

Reads come from the copy because it's fast. Writes go to the truth because it's
reviewable: a write opens a pull request, never a merge, and never touches a
brain's `sources/`. The one exception is opt-in: a brain whose profile sets
`directWrites: true` lets its owner commit straight to the default branch. Everyone
else still gets a pull request.

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
- **When a decision is settled**, it records it with `remember` and tells the user
  what the result says: a pull request a person merges, or, for an owner with
  direct writes on, a commit already on the default branch. `update_fact` and
  `forget` do the same for claims that are out of date.
- It picks the brain by the project or client the user names, and says which one
  it used when several match.

See [AGENTS.md](AGENTS.md) for the rules, the claim format and how to run it, and
[docs/plan-multi-org.md](docs/plan-multi-org.md) for where multi-user brains go next.

## REST API

Base URL: `https://brain.mcpbox.dev/api/v1`.
[OpenAPI 3.1](https://brain.mcpbox.dev/api/v1/openapi.json) is public and uses the
same input schemas as the MCP tools. Optional file and session operations appear
in that document only when their stores are configured. An unconfigured operation
returns `503` with code `not_configured`.

Send `Authorization: Bearer <WorkOS access token>`. Use the same OAuth token as
`/mcp`, with audience `https://brain.mcpbox.dev/mcp`. No new token, scope, or
permission list is needed. Browser cookies do not grant REST access. The existing
cookie API under `/api` still serves `/sessions`.

GitHub access checks and their cache are shared with MCP. A reader can read a
brain and propose a claim change by PR, just as in MCP. File uploads need push
access because they take effect at once. A registered owner has the same owner
access as MCP. Direct commits also need the owner's opt-in and a current GitHub
push check. Sessions remain private to their owner or to the verified email of an
active share. Sharing returns a preview unless `confirm` is `true`.

All paths below are relative to `/api/v1`. GET inputs are query fields; POST
inputs are JSON fields. Names and defaults match the corresponding MCP tool.
Pass the full `brain=owner/repo` value, URL-encoded in a query. Omit it only when
you have exactly one accessible brain, except for session filters.

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/brains` | `list_brains` |
| GET | `/search` | `search`, including `limit`, `include_superseded`, `include_sessions` |
| GET | `/claims/get` | `get_claim` with `claim_id` |
| GET | `/claims/explain` | `explain_claim`, with commit, sources and replacement history |
| GET | `/files` | `list_files`, with folder, cursor and limit |
| GET | `/files/get` | `get_file`, with path; returns a signed download link |
| POST | `/files` | `add_file`; add-only base64 content or signed PUT link |
| POST | `/remember` | `remember` |
| POST | `/update-fact` | `update_fact` |
| POST | `/forget` | `forget` |
| GET | `/sessions` | `search_sessions`, with query, brain, tool, since, until and limit |
| GET | `/sessions/show` | `show_session`, with session, source, from_turn and max_turns |
| POST | `/sessions/save-to-brain` | `save_to_brain` |
| POST | `/shares` | `share_session`; preview, then confirm |
| GET | `/shares` | `list_my_shares` |
| GET | `/shares/received` | `list_shared_with_me` |
| POST | `/shares/revoke` | `revoke_share` with share id |
| GET | `/brains/overview` | Page list and 20 recent commits on the default branch |
| GET | `/pages/get` | Whole markdown page by path on the default branch |

Successful responses are the domain JSON object, without an MCP text envelope.
Claim writes and save-to-brain return `mode: "pull_request"`, `recorded: false`
and `pull_request.url`, or `mode: "commit"`, `recorded: true` and `commit.url`.
Session reads include visible turns, omit the internal owner id, and return
`next_from_turn` for paging. Files remain add-only. No file delete route exists.
Overview and page reads use GitHub and can be ahead of the search index. Overview
refuses a truncated GitHub tree; page reads use the GitHub contents size limit.

Errors have a stable shape:

```json
{"error":{"code":"not_found","message":"The requested brain is not available."}}
```

Codes: `unauthorized` (401), `auth_failed` (auth service error), `not_found` (404),
`invalid_request` or `invalid_json` (400), `body_too_large` (413),
`operation_refused` (422), `not_configured` (503), `internal_error` (500).
An inaccessible brain and a missing brain return the same 404 object. Expected
domain refusals, including missing private sessions, use `operation_refused`.
Responses use `Cache-Control: no-store`. Request bodies are limited to 16 MB and
are parsed only after authentication. Upstream failure details are not returned.

```sh
# TOKEN is an OAuth access token obtained from AuthKit for the MCP resource.
curl -H "Authorization: Bearer $TOKEN" https://brain.mcpbox.dev/api/v1/brains
curl -G -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'brain=example/notes' --data-urlencode 'query=launch' \
  https://brain.mcpbox.dev/api/v1/search
```

Run checks with `pnpm typecheck` and `pnpm test --maxWorkers=1`. Tests need a
throwaway PostgreSQL database in `DATABASE_URL` and the placeholder auth settings
shown in `.github/workflows/test.yml`. REST tests sign local JWTs and supply a
test JWKS. GitHub and R2 adapters are test doubles; no client repo is changed.

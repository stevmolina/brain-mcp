# brain-mcp

Remote second brains served over MCP. The public name is Agent Brain.

Any user brings any git repo of markdown and connects it as a brain. The repo is
canonical; everything else is a disposable copy.

```
brain repo (markdown in git)  -- the truth
     | push webhook
INDEXER                       -- full rebuild per push, no incremental diffing
     |
NEON                          -- searchable copy; drop it, rebuild it, lose nothing
     |
MCP SERVER                    -- reads from Neon, writes to git as a commit or a pull request
```

Reads come from the copy because it's fast. Writes go to the truth because git
history stays reviewable and revertible. Nothing here merges a pull request, and
nothing writes a brain's `sources/`.

## Write modes

Each brain has a mode per action (`remember`, `update_fact`, `forget`). The
default for every action is `review`, so an existing brain does not change
behavior until its owner says so. Apply `pnpm migrate` so the `write_modes`
column exists. Rows that omit it stay on review.

| Mode | What a write does |
| --- | --- |
| `review` | Opens a pull request. The tool says `Proposed as PR #n. Approve to save.` The claim is searchable after the pull request is merged. |
| `auto` | Commits to the default branch and rebuilds the index immediately. The tool says `Saved.` Revert it by reverting that commit. |
| `read_only` | Refuses. The tool says `Not saved.` |

The owner sees the modes with `get_write_modes` (or the `brain://settings`
resource) and changes them with `set_write_mode`. Anyone who can read the brain
can call the write tools, and the mode applies to all of them. Only the owner
can change it. A mode change takes effect on the next call. It is not itself a
git write, so `read_only` cannot lock the owner out.

Example: remember commits immediately, and edits still wait for approval.

```
set_write_mode  remember=auto  update_fact=review  forget=review
```

## Getting started

A signed-in user with no brain does not need an operator to register one.

1. Sign in through WorkOS with GitHub linked, so the server can see which repos
   that account may use.
2. Install the GitHub App on the account or repository.
3. Call `list_connectable_repos` to see repositories the app can already see on
   the user account.
4. Call `connect_brain` with `repo` set to `owner/name` to register one and
   index it. This includes an organization repository, as long as the app is
   installed there and the user has access.
5. Or call `create_brain` to make a new private repository named `agent-brain`
   (or another name) on the user's own GitHub account, with a starter claims
   page, and connect it.

`create_brain` needs a one-time GitHub approval because creating a repository
on a user account cannot be done with the app's installation token. Until the
owner config below is in place, `create_brain` explains how to create the
repository on GitHub and then `connect_brain`.

The operator command still works for a repo the app is already installed on:

```sh
doppler run -- pnpm register-brain <owner/repo> --workos-user <id>
```

## Owner setup for one-step creation

Connecting an existing repository needs the permissions the app already has
(Contents, Pull requests, Metadata) plus the app installed on that repository.

Creating a repository needs extra GitHub App configuration. Add all of this, or
one-step creation stays off and users follow the manual steps above.

1. Repository permission **Administration: Read and write**. This is what
   `POST /user/repos` requires on a user access token. Contents and Pull
   requests stay Read and write. Metadata stays Read.
2. Under "Identifying and authorizing users", add this callback URL (the public
   MCP path does not change):

   `https://brain.mcpbox.dev/oauth/github/callback`

3. Generate a client secret for the app.
4. In Doppler, project `brain-mcp`, configs `dev` and `prd`, set
   `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`. Do not put them in
   the repo.
5. Existing installations must accept the new Administration permission before
   `create_brain` can succeed for those accounts.

`create_brain` only creates a private repository on the signed-in user's own
GitHub account. It checks the approving GitHub login matches the account that
asked. Organization repositories are connected with `connect_brain`, not created
here.

## Tools

`search`, `get_claim`, `explain_claim`, `remember`, `update_fact`, `forget`,
`get_write_modes`, `set_write_mode`, `list_connectable_repos`, `connect_brain`,
`create_brain`.

Every returned claim carries where it came from, when it was verified, and its
authority.

See [AGENTS.md](AGENTS.md) for the rules, the claim format and how to run it.

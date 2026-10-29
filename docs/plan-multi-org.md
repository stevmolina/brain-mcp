# Plan: many users, many organizations

brain.mcpbox.dev is becoming a service anyone can use, alone or with their team.
It gets there in three phases. Phase 1, private files per brain, ships with this
plan. Phases 2 and 3 are decisions and steps only; no code yet.

The rule that does not move in any phase: **GitHub is the only permission list.**
A person may read a brain if GitHub says they can read its repo, and write if
GitHub says they can push. This database never stores who may see what.

## Phase 1: private files per brain (built)

Each brain keeps files that are not markdown (a spreadsheet, an export) in one R2
bucket, under `<brain id>/<path>`. Read needs repo read access, add needs push
access, and adding never overwrites. Details are in AGENTS.md under Files.

## Phase 2: self-serve brains

Today only the admin command `pnpm register-brain` turns a repo into a brain. In
phase 2 a signed-in user does it for their own repo.

### Decisions

- **Installing the GitHub App is the gate.** Only someone who administers a repo
  can install the App on it, so the install is both their consent and the proof
  that the repo is theirs to register. We add no check of our own on top.
- **Registration is one MCP tool, `register_brain(repo)`.** It refuses unless the
  App is installed on the repo and GitHub says the caller has admin on it. The
  caller becomes the owner.
- **The brain id is always `owner/repo`.** No custom ids for self-serve brains.
  That keeps ids unique and keeps file keys unambiguous.
- **Uninstalling is unregistering.** When GitHub tells us the App was removed
  from a repo, the brain and every derived row go, as `offboard-brain` does now.
  Its files stay in R2 for 30 days, then a sweep removes them.
- **Limits protect the box.** A cap on brains per user and on repo size at index
  time, both in config. Over a cap, the tool says so plainly.

### Steps

1. Add `register_brain`: find the installation, check admin, insert the row, index once.
2. Handle the `installation` and `installation_repositories` webhooks: removal offboards.
3. Add the caps and their refusals.
4. Point the landing's "get started" at the App install page, then at the tool.
5. Extend the isolation test: a user without admin cannot register someone else's repo.

## Phase 3: organization spaces

One login, several spaces. A space is a GitHub owner: **Personal** (your own
account) plus **each GitHub organization** whose repos hold brains you can read.

### Decisions

- **A space is derived, never stored.** A brain's space is its repo owner. Your
  spaces are the owners of the brains you can read. No spaces table and no
  membership table, so nothing can drift from GitHub.
- **Access still comes only from GitHub.** Belonging to an org gives you nothing
  by itself; each brain in the space is checked against its repo, as today.
- **WorkOS organizations are not used for access.** WorkOS keeps answering who
  you are. If it ever groups users, that is for billing, not permissions.
- **Search can be scoped to a space.** `search` takes `space` as well as `brain`
  and searches every brain in the space that you can read, with one query filtered
  on that list of brain ids.
- **Files stay per brain.** No space-wide file listing in this phase.

### Steps

1. Add `requireSpace` beside `requireBrain` in `src/auth/access.ts`: the readable
   brains whose repo owner matches. All space resolution goes through it.
2. Give `search` an optional `space`; results name the brain of each claim.
3. Group the `brain://mine` resource by space.
4. Narrow `accessibleBrains` to one owner before asking GitHub, so a space costs
   one check per brain in it, not one per brain on the server.
5. Extend the isolation test: a space query never returns a brain from another
   space or a brain the caller cannot read.

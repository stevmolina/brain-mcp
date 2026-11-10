# The real run, 2026-11-10

Two agents, one brain. Both were signed in to `https://brain.mcpbox.dev/mcp` as the same
person and had only the brain's tools. The demo brain was a private repo with one invented
page (Kettlebird's roasting days). It was registered with direct writes on, so `remember`
commits straight to the default branch. The repo and the brain were removed afterwards.

Trimmed from this record: the `list_brains` result (it names the account's other brains),
tool result fields that carry ids, and the "Sources" lists the agents added at the end of
their replies.

## 1. Claude

Claude Code in print mode, model `claude-sonnet-5-5`, brain tools only.

Prompt:

> Let's lock the Kettlebird subscription: $18 a bag, ships every two weeks, launches March 3.
> Remember that in the brain.

Tool calls:

1. `list_brains`: found the Kettlebird demo brain.
2. `search` in that brain, "subscription price shipping cadence launch": no claims.
3. `remember` in that brain, heading "Subscription", text:
   "The Kettlebird subscription is locked: $18 per bag, ships every two weeks, and launches March 3."
   Result: `mode: commit`, branch `main`, page `wiki/index.md`, `recorded: true`.

Reply (first paragraph, the rest explained the commit):

> Saved to the Kettlebird brain: $18 a bag, ships every two weeks, launches March 3.

## 2. The brain

The commit landed on the repo's main branch. GitHub's push webhook told the server, which
rebuilt the index. A search right after returned the new claim on `wiki/index.md` line 3.

## 3. OpenAI

Codex (OpenAI's agent, model `gpt-6.1-terra`), in an empty folder, using the account's
ChatGPT app for Agent Brain (`codex_apps`, tool `agent_brain.search`). The first run was
blocked by a tool approval prompt that print mode cannot answer; the second ran with
approvals off.

Prompt:

> Write a short launch email for the Kettlebird coffee subscription. Use what's in our brain.

Tool calls: six `search` calls. The first two named no brain and got the list of brains
back; the next ones searched the Kettlebird brain for "launch", "subscription",
"Kettlebird" and "voice". "launch" returned the claim Claude wrote, on `wiki/index.md`
line 3. "Kettlebird" also returned the roasting line from `wiki/decisions.md`.

Reply (without its Sources list):

> Subject: Coffee, every two weeks
>
> Hi,
>
> The Kettlebird coffee subscription launches March 3.
>
> It’s $18 per bag, shipped every two weeks. We roast on Tuesdays and ship on Wednesdays.
>
> Join us for your next cup.
>
> The Kettlebird team

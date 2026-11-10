# Agents share context: demo film and how-to clip

Two short clips for social: captions and an original music bed, no voiceover.

- **The film** (21 s): you settle something in Claude, Claude saves it to Agent Brain,
  and later ChatGPT writes the launch email with the same facts, without anyone pasting
  anything.
- **How to start** (16 s): copy the link, add it to Claude or ChatGPT, sign in once, tell one
  agent and ask another. The steps are on screen as titles, so there are no captions to duck
  the music under.

Kettlebird Coffee and everything about it are invented.

## What is real and what is redrawn

- **Real:** the conversation. `run/run.sh` sent the two prompts to two real agents connected
  to `https://brain.mcpbox.dev/mcp` as the same signed-in person: Claude (Claude Code in print
  mode) called `remember`, the brain committed the line to the demo repo, the push webhook
  reindexed it, and Codex (OpenAI's agent) called `search` through the account's ChatGPT app
  for Agent Brain and wrote the email. The ChatGPT scene's tag says it was Codex.
  `run/transcript.md` is the trimmed record; every line on screen comes from it.
- **Redrawn:** the Claude and ChatGPT windows, the note page and the sign-in page are motion
  design in Remotion, drawn from screenshots of the real apps (November 2026). Typing and
  waits are shortened. Every app scene carries a tag that says so.
- The two apps can do this for real: Claude adds the server under Customize, Connectors,
  Add custom connector, and ChatGPT under Plugins, add a custom server. The brain's sign-in
  (WorkOS AuthKit) supports both client metadata documents and dynamic registration, which is
  how those apps register themselves.

## Files

- `film/`: the Remotion project, on the product-demo-video film kit with Agent Brain's tokens
  (`src/products/brain/theme.ts`). The app recreations are `src/products/brain/ui.tsx`, the
  scenes `panels.tsx`, the timing `filmCuts.ts`, the run's text `run.ts`.
- `renders/`: both cuts at 1080p, square versions, stills, contact sheets, loudness reports.
- `run/`: the run script and its trimmed transcript.

## Make it again

1. Make a private markdown repo for the demo brain, add the Agent Brain GitHub App to it, and
   register it (`pnpm register-brain <owner/repo> --workos-user <id>`), with
   `{"directWrites": true}` in its profile so `remember` commits straight away.
2. Sign Claude Code and Codex in to the brain server, then `run/run.sh <scratch dir>`.
3. Copy the replies into `film/src/products/brain/run.ts`.
4. In `film/`: `pnpm install`, then the audio
   (`uv run --with numpy --with scipy python scripts/make_audio.py sfx --dir public/audio/sfx`
   and `node scripts/film-plan.mjs --beds | sh`), then `pnpm render`.
5. Offboard the brain (`pnpm offboard-brain <id> --confirm`) and delete the demo repo.

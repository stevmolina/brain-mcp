#!/usr/bin/env bash
# The real run behind the film: Claude writes a decision to the demo brain, then an OpenAI
# agent (Codex) finds it with no copy and paste. Both talk to https://brain.mcpbox.dev/mcp as
# the same signed-in person. Only the brain tools are allowed, like a chat app with one connector.
#   run.sh <out dir>        raw logs land there (they name every brain the account can see,
#                           so they stay out of the repo; transcript.md is the trimmed copy)
set -euo pipefail
out="${1:?out dir}"; mkdir -p "$out"; cd "$out"
claude_prompt="Let's lock the Kettlebird subscription: \$18 a bag, ships every two weeks, launches March 3. Remember that in the brain."
gpt_prompt="Write a short launch email for the Kettlebird coffee subscription. Use what's in our brain."
app="You are a chat assistant inside a desktop chat app. Your only tools are the Agent Brain connector. Answer like a chat app: short, plain text."

# 1. Claude (Claude Code in print mode, brain tools only). The tool names below assume the server
#    is registered in Claude Code as "second_brain":
#      claude mcp add --transport http second_brain https://brain.mcpbox.dev/mcp
claude -p "$claude_prompt" --output-format stream-json --verbose \
  --append-system-prompt "$app" \
  --allowedTools "mcp__second_brain__list_brains mcp__second_brain__search mcp__second_brain__remember" \
  --disallowedTools "Bash Edit Write Read Glob Grep WebFetch WebSearch Task Agent" > claude.jsonl
date -u +%FT%TZ > claude.done

# 2. The push webhook reindexes the brain; wait until search sees the new claim.
echo "waiting for the index"; sleep 20

# 3. Codex (OpenAI). It reaches the brain through the account's ChatGPT app for Agent Brain.
# Print mode cannot answer the tool approval prompt, so approvals are off; the folder is empty.
mkdir -p empty && cd empty
codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  "$app

$gpt_prompt" < /dev/null > ../codex.jsonl
date -u +%FT%TZ > ../codex.done

# Your chats in Agent Brain: demo film

A 31-second film of the live sessions pages: search every chat at once, filter by
client, share two turns of one chat with a teammate, the teammate's read-only view,
then revoke. Every chat, person and company on screen is invented.

- `renders/`: the 1080p film, a square cut, three stills, the contact sheet and the
  loudness report.
- `seed/`: the invented chats (`chats.json`) and `seed.py`, which adds them under a
  demo user's WorkOS id and removes them again (only `demo-` ids for that owner, and
  their shares).
- `capture/`: `assemble.py` turns a capture into 30 fps footage plus the film kit's cursor
  and highlight data; `logs/` keeps each clip's action log.
- `film/`: the Remotion project, built on the product-demo-video film kit with Agent
  Brain's own tokens (`src/products/brain/theme.ts`). `scripts/capture.mjs` records the
  live pages with Playwright.

## Make it again

1. Create two demo WorkOS users with verified emails, seed the chats for the first
   (`seed.py add <id>`), and sign each in.
2. In `film/`, `node scripts/capture.mjs <cookies.json> <dir>` records four clips: a CDP
   screencast of a 1600x900 page at 2x pixels, one JPEG per repaint, driven by real mouse
   moves and typing. (The T3 preview recorder saved about 0.35 Mbit/s, which blurred text.)
3. `python3 capture/assemble.py <dir> film/public/footage/chats`.
4. In `film/`: `pnpm install`, generate audio
   (`uv run --with numpy --with scipy python scripts/make_audio.py sfx --dir public/audio/sfx`
   and the bed from `node scripts/film-plan.mjs --beds`), then `pnpm render`.
5. Remove the seed (`seed.py remove <id>`) and the demo users.

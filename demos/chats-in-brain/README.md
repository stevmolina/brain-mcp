# Your chats in Agent Brain: demo film

A 44-second film of the live sessions pages: search every chat at once, filter by
client, share two turns of one chat with a teammate, the teammate's read-only view,
then revoke. Every chat, person and company on screen is invented.

- `renders/`: the 1080p film, a square cut, three stills, the contact sheet and the
  loudness report.
- `seed/`: the invented chats (`chats.json`) and `seed.py`, which adds them under a
  demo user's WorkOS id and removes them again (only `demo-` ids for that owner, and
  their shares).
- `capture/`: `director.js`, pasted into the live page to click and type through the
  page's own handlers while the preview records, and `logs.json`, what it logged.
  `make-meta.py` turns the logs into the film kit's cursor and highlight data.
- `film/`: the Remotion project, built on the product-demo-video film kit with Agent
  Brain's own tokens (`src/products/brain/theme.ts`).

## Make it again

1. Create two demo WorkOS users with verified emails, seed the chats for the first
   (`seed.py add <id>`), and sign each in.
2. Record with T3 preview at 1600x900, driving the page with `director.js`. A hidden
   preview tab delivers frames late when the page goes still: keep a tiny element
   repainting and leave a few seconds of tail before stopping.
3. Normalize each clip to 30 fps (`ffmpeg -vf fps=30,scale=2400:1350`), name it
   `<clip>-30.mp4`, run `python3 capture/make-meta.py <dir> film/public/footage/chats`.
4. In `film/`: `pnpm install`, generate audio
   (`uv run --with numpy --with scipy python scripts/make_audio.py sfx --dir public/audio/sfx`
   and the bed from `node scripts/film-plan.mjs --beds`), then `pnpm render`.
5. Remove the seed (`seed.py remove <id>`) and the demo users.

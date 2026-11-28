/**
 * Builds or refreshes the chat-search index (src/sessions/search-index.ts).
 * The server does the same every few minutes; this is for the first backfill
 * (faster from a laptop, and the vectors land in the shared cache) and for a
 * forced rebuild.
 *
 *   doppler run -- pnpm index-sessions [--rebuild] [--owner <workos id>] [--schema brain_mcp]
 */
import { parseArgs } from 'node:util';
import { closeSessionsDb, migrateSessions, sessionsDb } from '../src/sessions/db.js';
import { getEmbedder } from '../src/sessions/embed.js';
import { syncSessionIndex } from '../src/sessions/search-index.js';

const { values } = parseArgs({
  options: {
    rebuild: { type: 'boolean', default: false },
    owner: { type: 'string' },
    schema: { type: 'string', default: 'brain_mcp' },
  },
});

try {
  await migrateSessions();
  const started = Date.now();
  const result = await syncSessionIndex(sessionsDb(), {
    schema: values.schema,
    owner: values.owner,
    rebuild: values.rebuild,
    embedder: getEmbedder(),
    log: (message) => console.error(message),
  });
  console.log(JSON.stringify({ ...result, ms: Date.now() - started }));
  if (values.rebuild && !result.indexed && !result.removed) {
    console.error('Nothing was rebuilt: another sync holds the lock (the server loop?). Run it again in a minute.');
    process.exitCode = 1;
  }
} finally {
  await closeSessionsDb();
}

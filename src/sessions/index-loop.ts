/**
 * Keeps the chat-search index current from inside the server.
 *
 * The sessions CLI pushes chats straight into the sessions database, so this
 * server never sees an upload. Instead, every `SESSION_INDEX_INTERVAL_MS`
 * (default 2 minutes) it compares each chat's fingerprint with the index and
 * indexes what changed, at most `SESSION_INDEX_BATCH` chats per cycle (default
 * 200), embedding only passages whose text has no vector yet. The sessions
 * database is a server of Steven's, not Neon, so a light query every two
 * minutes costs nothing. `SESSION_INDEX_INTERVAL_MS=0` turns it off.
 *
 * It also loads the embedding model in the background at boot, so the first
 * `context` call after a deploy is not held up by it.
 */
import { sessionsDb } from './db.js';
import { getEmbedder, warmEmbedder } from './embed.js';
import { syncSessionIndex } from './search-index.js';

export function startSessionIndexer(env: NodeJS.ProcessEnv = process.env): { stop(): void } | null {
  void warmEmbedder();
  const every = Number(env.SESSION_INDEX_INTERVAL_MS ?? 120_000);
  if (!(every > 0)) return null;
  const max = Number(env.SESSION_INDEX_BATCH ?? 200);
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    const started = Date.now();
    try {
      const result = await syncSessionIndex(sessionsDb(), { embedder: getEmbedder(), max });
      if (result.indexed || result.removed) {
        console.log(JSON.stringify({ level: 'info', at: 'sessions.index', ...result, ms: Date.now() - started }));
      }
    } catch (error) {
      console.error(JSON.stringify({ level: 'warn', at: 'sessions.index', message: String(error) }));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void cycle(), 5_000);
  const timer = setInterval(() => void cycle(), every);
  first.unref();
  timer.unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}

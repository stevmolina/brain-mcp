import { migrate } from '../src/db/migrate.js';
import { closeDb } from '../src/db/client.js';
import { closeSessionsDb, migrateSessions, sessionsEnabled } from '../src/sessions/db.js';

const ran = await migrate();
console.log(ran.length ? `brain db applied: ${ran.join(', ')}` : 'brain db up to date');
await closeDb();

// The share grants live in the sessions database, in brain-mcp's own schema.
if (sessionsEnabled()) {
  const ranSessions = await migrateSessions();
  console.log(ranSessions.length ? `sessions db applied: ${ranSessions.join(', ')}` : 'sessions db up to date');
  await closeSessionsDb();
}

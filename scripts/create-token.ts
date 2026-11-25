/**
 * Makes a personal access token for a hook or a server bot.
 *
 *   pnpm create-token --workos-user <id> --name <label> [--brains owner/a,owner/b]
 *
 * Prints the token once, alone on stdout, so it can be piped straight into a
 * secret store. Everything else goes to stderr. Only a hash is stored.
 * With --brains the token reaches only those brains; without, every brain the
 * user can reach. Revoke with `pnpm revoke-token <token id>`.
 */
import { db, closeDb } from '../src/db/client.js';
import { closeSessionsDb, sessionsEnabled } from '../src/sessions/db.js';
import { createAccessToken } from '../src/auth/tokens.js';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const user = arg('workos-user');
const name = arg('name');
const brains = arg('brains')?.split(',').map((b) => b.trim()).filter(Boolean);
if (!user || !name) {
  console.error('usage: pnpm create-token --workos-user <id> --name <label> [--brains owner/a,owner/b]');
  process.exit(1);
}
if (!sessionsEnabled()) {
  console.error('SESSIONS_DATABASE_URL is not set: tokens live in the sessions database.');
  process.exit(1);
}
if (brains?.length) {
  const { rows } = await db().query<{ id: string }>('select id from brains where id = any($1)', [brains]);
  const missing = brains.filter((b) => !rows.some((r) => r.id === b));
  if (missing.length) {
    console.error(`No such brain: ${missing.join(', ')}`);
    await closeDb();
    await closeSessionsDb();
    process.exit(1);
  }
}

const { id, token } = await createAccessToken({ workosUserId: user, name, brains });
console.error(`created ${id} "${name}" for ${user}, ${brains?.length ? `brains ${brains.join(', ')}` : 'every brain the user can reach'}. Shown once:`);
process.stdout.write(`${token}\n`);
await closeDb();
await closeSessionsDb();

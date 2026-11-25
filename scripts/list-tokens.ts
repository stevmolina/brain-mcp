/**
 * Lists personal access tokens: id, name, user, brains, created, last used.
 * Never the token itself, which is not stored.
 *
 *   pnpm list-tokens [--workos-user <id>]
 */
import { closeSessionsDb } from '../src/sessions/db.js';
import { listAccessTokens } from '../src/auth/tokens.js';

const at = process.argv.indexOf('--workos-user');
for (const t of await listAccessTokens(at === -1 ? undefined : process.argv[at + 1])) {
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : 'never');
  console.log(`${t.id}  ${t.name}  ${t.workos_user_id}  ${t.brains ? t.brains.join(',') : 'all brains'}  created ${day(t.created_at)}  used ${day(t.last_used_at)}`);
}
await closeSessionsDb();

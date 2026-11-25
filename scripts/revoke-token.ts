/**
 * Deletes a personal access token. It stops working on its next request.
 *
 *   pnpm revoke-token <token id>     (tok_..., from pnpm list-tokens)
 */
import { closeSessionsDb } from '../src/sessions/db.js';
import { revokeAccessToken } from '../src/auth/tokens.js';

const id = process.argv[2];
if (!id?.startsWith('tok_')) {
  console.error('usage: pnpm revoke-token <tok_...>');
  process.exit(1);
}
console.log((await revokeAccessToken(id)) ? `revoked ${id}` : `no token ${id}`);
await closeSessionsDb();

/**
 * A starter brain for someone who signed up with an email and has no GitHub
 * repo. The id is a hash of the WorkOS user, not the email, so it stays put
 * when the email changes and does not put the address in a URL.
 */
import { createHash } from 'node:crypto';
import { db, withTransaction } from '../db/client.js';
import { reindexHosted } from './index.js';
import type { BrainRow } from '../types.js';
import type { PlanName } from '../billing/plans.js';

export const WELCOME_PAGE = 'wiki/index.md';
export const WELCOME_MARKDOWN = `# Notes

## Claims

- This starter brain is ready for notes.
`;

export interface AccountRow {
  workos_user_id: string;
  email: string;
  plan: PlanName;
  polar_customer_id: string | null;
  polar_subscription_id: string | null;
  polar_subscription_status: string | null;
  current_period_end: Date | null;
}

export function starterBrainId(workosUserId: string): string {
  const slug = createHash('sha256').update(workosUserId).digest('hex').slice(0, 12);
  return `hosted/${slug}`;
}

export function isHostedBrain(brain: BrainRow): boolean {
  return brain.kind === 'hosted';
}

export async function getAccount(workosUserId: string): Promise<AccountRow | null> {
  const { rows } = await db().query<AccountRow>('select * from accounts where workos_user_id = $1', [workosUserId]);
  return rows[0] ?? null;
}

/**
 * Creates the account and the starter brain on first sign-in. A second call
 * refreshes the email and leaves the brain alone.
 */
export async function provisionAccount(user: { id: string; email: string }): Promise<{ account: AccountRow; brain: BrainRow; created: boolean }> {
  const brainId = starterBrainId(user.id);
  const created = await withTransaction(async (client) => {
    await client.query(
      `insert into accounts (workos_user_id, email)
       values ($1, $2)
       on conflict (workos_user_id) do update set email = excluded.email, updated_at = now()`,
      [user.id, user.email],
    );

    const inserted = await client.query(
      `insert into brains (
         id, owner_workos_user_id, owner_github_login, repo_owner, repo_name, default_branch, installation_id, kind
       ) values ($1, $2, null, 'hosted', $3, 'main', null, 'hosted')
       on conflict (id) do nothing
       returning id`,
      [brainId, user.id, brainId.split('/')[1]],
    );
    if ((inserted.rowCount ?? 0) === 0) return false;

    await client.query(
      `insert into pages (brain_id, path, content) values ($1, $2, $3)
       on conflict (brain_id, path) do nothing`,
      [brainId, WELCOME_PAGE, WELCOME_MARKDOWN],
    );
    const { rows } = await client.query<BrainRow>('select * from brains where id = $1', [brainId]);
    await reindexHosted(client, rows[0]!);
    return true;
  });

  const account = await getAccount(user.id);
  const { rows } = await db().query<BrainRow>('select * from brains where id = $1', [brainId]);
  if (!account || !rows[0]) throw new Error('Signup did not create an account');
  return { account, brain: rows[0], created };
}

/** An authority with no date is a claim nobody can age. */
import { db } from '../../db/client.js';
import type { Check, Finding } from './types.js';

export const missingVerifiedAt: Check = {
  name: 'missing-verified-at',
  async run(brain) {
    const { rows } = await db().query<{ id: string; page_path: string; authority: string }>(
      `select id, page_path, authority from claims
        where brain_id = $1 and authority is not null and verified_at is null
        order by page_path`,
      [brain.id],
    );
    return rows.map<Finding>((row) => ({
      checkName: 'missing-verified-at',
      severity: 'warn',
      claimId: row.id,
      pagePath: row.page_path,
      detail: `authority: ${row.authority} with no verified_at.`,
    }));
  },
};

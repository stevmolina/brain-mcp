/** An `authority: live` claim is a summary of something that moves. Past the
 * profile's threshold it needs re-checking against the live system. */
import { db } from '../../db/client.js';
import { resolveProfile } from '../../profiles/index.js';
import type { Check, Finding } from './types.js';

export const staleLive: Check = {
  name: 'stale-live',
  async run(brain) {
    const { staleLiveDays } = resolveProfile(brain.profile);
    const { rows } = await db().query<{ id: string; page_path: string; verified_at: Date; days: number }>(
      `select id, page_path, verified_at, extract(day from now() - verified_at)::int as days
         from claims
        where brain_id = $1
          and authority is not null
          and verified_at is not null
          and verified_at < now() - ($2 || ' days')::interval
          and superseded_by is null
        order by verified_at`,
      [brain.id, staleLiveDays],
    );
    return rows.map<Finding>((row) => ({
      checkName: 'stale-live',
      severity: 'warn',
      claimId: row.id,
      pagePath: row.page_path,
      detail: `Verified ${String(row.verified_at).slice(0, 10)}, ${row.days} days ago; threshold is ${staleLiveDays}.`,
    }));
  },
};

/** A superseded claim still marked live will be quoted as current by a reader
 * that ignores the supersession. Worth flagging rather than silently fixing. */
import { db } from '../../db/client.js';
import type { Check, Finding } from './types.js';

export const supersededStillLive: Check = {
  name: 'superseded-still-live',
  async run(brain) {
    const { rows } = await db().query<{ id: string; page_path: string; superseded_by: string }>(
      `select id, page_path, superseded_by from claims
        where brain_id = $1 and superseded_by is not null and authority is not null
        order by page_path`,
      [brain.id],
    );
    return rows.map<Finding>((row) => ({
      checkName: 'superseded-still-live',
      severity: 'warn',
      claimId: row.id,
      pagePath: row.page_path,
      detail: `Superseded by ${row.superseded_by.slice(0, 12)} but still carries an authority marker.`,
    }));
  },
};

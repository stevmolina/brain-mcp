/** Received evidence no claim cites: either an unread source or a lost citation. */
import { db } from '../../db/client.js';
import type { Check, Finding } from './types.js';

export const orphanSources: Check = {
  name: 'orphan-sources',
  async run(brain) {
    const { rows } = await db().query<{ path: string }>(
      `select s.path from sources s
        where s.brain_id = $1
          and s.path not like '%/README.md'
          and not exists (
            select 1 from claim_sources cs where cs.source_id = s.id and cs.brain_id = s.brain_id
          )
        order by s.path`,
      [brain.id],
    );
    return rows.map<Finding>((row) => ({
      checkName: 'orphan-sources',
      severity: 'info',
      pagePath: row.path,
      detail: 'No claim cites this source file.',
    }));
  },
};

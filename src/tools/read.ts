/**
 * The three read tools. Reads come from the copy because it's fast.
 *
 * Every query in this file is keyed by brain_id in its WHERE clause. That is the
 * isolation boundary, and test/isolation.test.ts holds it.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { db } from '../db/client.js';
import { requireBrain } from '../auth/access.js';
import { workosUserId } from '../auth/workos.js';
import { handling, renderClaimLine, textResult, toClaimView } from './shared.js';
import type { ClaimRow, SourceRow } from '../types.js';
import type { ToolContext } from './index.js';

const brainArg = z
  .string()
  .optional()
  .describe('Brain id, e.g. "owner/repo". Omit when you have exactly one brain.');

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search',
    {
      title: 'Search a brain',
      description:
        'Full-text search over a brain\'s claims. Returns each claim with its page, line, authority and verification date.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Words to search for.'),
        brain: brainArg,
        limit: z.number().int().min(1).max(50).default(10),
        include_superseded: z
          .boolean()
          .default(false)
          .describe('Include claims a later claim has replaced.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handling(async (args, mcp) => {
      const brain = await requireBrain(workosUserId(mcp.http?.authInfo), args.brain);
      const { rows } = await db().query<ClaimRow & { rank: number }>(
        `select c.*, ts_rank(c.fts, websearch_to_tsquery('english', $2)) as rank
           from claims c
          where c.brain_id = $1
            and (c.fts @@ websearch_to_tsquery('english', $2) or c.text ilike $3)
            and ($4 or c.superseded_by is null)
          order by rank desc, c.page_path, c.line
          limit $5`,
        [brain.id, args.query, `%${args.query}%`, args.include_superseded, args.limit],
      );

      const views = rows.map((row) => toClaimView(brain, row));
      const header = `${views.length} claim${views.length === 1 ? '' : 's'} in ${brain.id} for "${args.query}"`;
      const body = views.length ? views.map(renderClaimLine).join('\n') : 'No matching claims.';
      return textResult(`${header}\n\n${body}`, { brain: brain.id, claims: views });
    }),
  );

  server.registerTool(
    'get_claim',
    {
      title: 'Get one claim',
      description: 'Fetch a single claim by id, with its neighbours on the same page for context.',
      inputSchema: z.object({
        claim_id: z.string().min(8).describe('Claim id, or a prefix of at least 8 characters.'),
        brain: brainArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handling(async (args, mcp) => {
      const brain = await requireBrain(workosUserId(mcp.http?.authInfo), args.brain);
      const claim = await loadClaim(brain.id, args.claim_id);
      if (!claim) return textResult(`No claim ${args.claim_id} in ${brain.id}.`);

      const view = toClaimView(brain, claim);
      const { rows: neighbours } = await db().query<ClaimRow>(
        `select * from claims
          where brain_id = $1 and page_path = $2 and id <> $3
          order by abs(line - $4) limit 4`,
        [brain.id, claim.page_path, claim.id, claim.line],
      );

      const text = [
        renderClaimLine(view),
        '',
        `Page: ${view.page}${view.heading ? ` (${view.heading})` : ''}`,
        `Commit: ${view.commit}`,
        `Link: ${view.url}`,
        '',
        'Nearby on the same page:',
        ...neighbours.map((row) => renderClaimLine(toClaimView(brain, row))),
      ].join('\n');

      return textResult(text, {
        brain: brain.id,
        claim: view,
        nearby: neighbours.map((row) => toClaimView(brain, row)),
      });
    }),
  );

  server.registerTool(
    'explain_claim',
    {
      title: 'Explain a claim',
      description:
        'Show where a claim came from: its page and commit, the received evidence it cites, and what it superseded or was superseded by.',
      inputSchema: z.object({
        claim_id: z.string().min(8),
        brain: brainArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handling(async (args, mcp) => {
      const brain = await requireBrain(workosUserId(mcp.http?.authInfo), args.brain);
      const claim = await loadClaim(brain.id, args.claim_id);
      if (!claim) return textResult(`No claim ${args.claim_id} in ${brain.id}.`);
      const view = toClaimView(brain, claim);

      const { rows: sources } = await db().query<SourceRow>(
        `select s.* from sources s
           join claim_sources cs on cs.source_id = s.id and cs.brain_id = s.brain_id
          where cs.brain_id = $1 and cs.claim_id = $2
          order by s.path`,
        [brain.id, claim.id],
      );

      // old_claim_id is usually a claim that no longer exists in the repo, so
      // this reports the pointer itself and fills in the claim only when the
      // superseded wording happens to still be there.
      const { rows: replaced } = await db().query<{ old_claim_id: string; text: string | null; page_path: string | null }>(
        `select s.old_claim_id, c.text, c.page_path
           from supersessions s
           left join claims c on c.brain_id = s.brain_id and c.id = s.old_claim_id
          where s.brain_id = $1 and s.new_claim_id = $2`,
        [brain.id, claim.id],
      );

      const { rows: replacedBy } = await db().query<ClaimRow>(
        `select c.* from claims c
           join supersessions s on s.new_claim_id = c.id and s.brain_id = c.brain_id
          where s.brain_id = $1 and s.old_claim_id = $2`,
        [brain.id, claim.id],
      );

      const lines = [
        `Claim ${view.id.slice(0, 12)} in ${brain.id}`,
        '',
        view.text,
        '',
        `Stated in ${view.page}:${view.line}${view.heading ? ` under "${view.heading}"` : ''}`,
        `As of commit ${view.commit}`,
        view.authority
          ? `Authority: ${view.authority}${view.verified_at ? `, last verified ${view.verified_at}` : ' (no verification date)'}`
          : 'Authority: unmarked, so durable. Never chased.',
        '',
        sources.length
          ? `Cites ${sources.length} source file${sources.length === 1 ? '' : 's'}:\n${sources
              .map(
                (s) =>
                  `- ${s.path} (sha256 ${s.sha256.slice(0, 12)}…${s.origin ? `, from ${s.origin}` : ''}${
                    s.received_at ? `, received ${String(s.received_at).slice(0, 10)}` : ''
                  })`,
              )
              .join('\n')}`
          : 'Cites no file under the brain\'s sources directory.',
      ];

      if (replaced.length) {
        lines.push(
          '',
          'Replaces:',
          ...replaced.map((r) =>
            r.text
              ? `- ${r.text}\n  ${r.page_path} [${r.old_claim_id.slice(0, 12)}]`
              : `- claim ${r.old_claim_id.slice(0, 16)}, no longer present in the repo`,
          ),
        );
      }
      if (replacedBy.length) {
        lines.push('', 'Replaced by:', ...replacedBy.map((r) => renderClaimLine(toClaimView(brain, r))));
      }

      return textResult(lines.join('\n'), {
        brain: brain.id,
        claim: view,
        sources,
        replaces: replaced,
        replaced_by: replacedBy.map((r) => toClaimView(brain, r)),
      });
    }),
  );

  void ctx;
}

export async function loadClaim(brainId: string, claimIdOrPrefix: string): Promise<ClaimRow | null> {
  const { rows } = await db().query<ClaimRow>(
    'select * from claims where brain_id = $1 and id like $2 limit 2',
    [brainId, `${claimIdOrPrefix}%`],
  );
  return rows.length === 1 ? rows[0]! : null;
}

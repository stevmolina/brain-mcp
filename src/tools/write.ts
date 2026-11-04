/**
 * The three write tools. Writes go to the truth, the brain repo.
 *
 * By default each one opens a pull request and stops. When the brain's profile
 * turns direct writes on and the caller is the brain's owner, the edit is one
 * commit on the default branch instead. Either way nothing merges, nothing
 * touches the brain's sources directory, and no row appears in the index until
 * the indexer reprocesses the commit on the default branch. The tool result
 * says which path ran, so a caller never mistakes an open PR for a recorded fact.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ServerContext } from '@modelcontextprotocol/server';
import { directWriteAllowed, githubLoginForWorkosUser, requireBrain } from '../auth/access.js';
import { workosUserId } from '../auth/workos.js';
import { commitDirect, openPullRequest, WriteRefused, type EditPlan, type WriteResult } from '../github/write.js';
import { resolveProfile } from '../profiles/index.js';
import { appendClaim, locateClaim, readMarker, removeClaim, replaceClaim } from './edits.js';
import { loadClaim } from './read.js';
import { brainArg, errorResult, handling, textResult, today } from './shared.js';
import type { ToolContext } from './index.js';
import type { BrainRow } from '../types.js';

const authorityArg = z
  .string()
  .optional()
  .describe(
    'Whether this line is truth or a summary of something else, e.g. "live". Only a human knows; leave it off for a durable fact that is never chased.',
  );

/**
 * Lands one edit: a direct commit when the brain allows it for this caller,
 * otherwise a pull request. The only place the two paths are chosen between.
 */
export async function landEdit(
  brain: BrainRow,
  plan: EditPlan,
  caller: { workosUserId: string; agent?: string | null },
): Promise<WriteResult> {
  // Ask WorkOS for the login only when the switch is on; a PR needs no identity.
  if (resolveProfile(brain.profile).directWrites) {
    // A failed lookup must not fail the write: no login just means a pull request.
    const login = await githubLoginForWorkosUser(caller.workosUserId).catch((error: unknown) => {
      console.error(
        JSON.stringify({ level: 'warn', at: 'write.landEdit', brain: brain.id, message: `identity lookup failed: ${String(error)}` }),
      );
      return null;
    });
    if (login && (await directWriteAllowed(brain, caller.workosUserId, login))) {
      return commitDirect(brain, plan, { caller: login, agent: caller.agent });
    }
  }
  return { mode: 'pull_request', pullRequest: await openPullRequest(brain, plan) };
}

/** The tool result for either path, worded so the caller cannot confuse them. */
export function describeWrite(result: WriteResult, done: { committed: string; proposed: string }): string {
  if (result.mode === 'commit') {
    const { commit } = result;
    return [
      done.committed,
      '',
      `Committed to ${commit.branch} ${commit.sha.slice(0, 7)} ${commit.url}`,
      `Page: ${commit.page}`,
      '',
      'Recorded in the brain repo. Search shows it once the push webhook reindexes that commit, usually within a minute.',
    ].join('\n');
  }
  const { pullRequest } = result;
  return [
    done.proposed,
    ...(result.fallbackReason ? ['', result.fallbackReason] : []),
    '',
    `Opened PR ${pullRequest.url}`,
    `Branch: ${pullRequest.branch} -> ${pullRequest.page}`,
    '',
    'Not recorded yet. The brain changes when this PR is merged and the indexer reprocesses that commit.',
  ].join('\n');
}

function structuredWrite(result: WriteResult): Record<string, unknown> {
  return result.mode === 'commit'
    ? { mode: 'commit', commit: result.commit, recorded: true }
    : {
        mode: 'pull_request',
        pull_request: result.pullRequest,
        ...(result.fallbackReason ? { fallback_reason: result.fallbackReason } : {}),
        recorded: false,
      };
}

/** Who is calling, for the commit message: the client's user agent or OAuth client id. */
function callerOf(mcp: ServerContext) {
  const auth = mcp.http?.authInfo;
  const userAgent = mcp.http?.req?.headers.get('user-agent')?.slice(0, 80) ?? null;
  const clientId = auth?.clientId && auth.clientId !== 'unknown' ? `OAuth client ${auth.clientId}` : null;
  return { workosUserId: workosUserId(auth), agent: userAgent ?? clientId };
}

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'remember',
    {
      title: 'Remember a new claim',
      description:
        'When a durable decision or fact is settled in the conversation, propose it here so the project remembers it; search first to avoid a duplicate. ' +
        'Usually opens a pull request on the brain repo and nothing changes until a person merges it; when the brain owner has direct writes on, it commits straight to the default branch instead. ' +
        'The result says which happened; tell the user. Pass `brain` (an id from list_brains).',
      inputSchema: z.object({
        text: z.string().min(3).describe('The claim, as one sentence.'),
        brain: brainArg,
        page: z.string().optional().describe('Markdown page to add it to. Defaults to the brain profile page.'),
        heading: z.string().optional().describe('Heading to append under. Created if absent.'),
        authority: authorityArg,
        verified_at: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('ISO date this was last checked. Defaults to today when authority is set.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    handling(async (args, mcp) => {
      const caller = callerOf(mcp);
      const brain = await requireBrain(caller.workosUserId, args.brain);
      const profile = resolveProfile(brain.profile);
      const page = args.page ?? profile.writePage;
      const heading = args.heading ?? profile.writeHeading;
      const verifiedAt = args.verified_at ?? (args.authority ? today() : null);

      try {
        const result = await landEdit(brain, {
          page,
          branchPrefix: 'brain/remember',
          commitMessage: `brain: remember a claim in ${page}`,
          title: `Remember: ${truncate(args.text)}`,
          ...described(brain.id, [
            `Adds one claim to \`${page}\` under **${heading}**.`,
            args.authority ? `Authority \`${args.authority}\`, verified \`${verifiedAt}\`.` : 'Unmarked, so durable.',
          ]),
          apply: (content) =>
            appendClaim(content, heading, args.text, {
              authority: args.authority ?? null,
              verifiedAt,
            }),
        }, caller);
        return textResult(
          describeWrite(result, {
            committed: `Committed a new claim to ${brain.id}.`,
            proposed: `Proposed a new claim in ${brain.id}.`,
          }),
          { brain: brain.id, ...structuredWrite(result) },
        );
      } catch (error) {
        return refusal(error);
      }
    }),
  );

  server.registerTool(
    'update_fact',
    {
      title: 'Update an existing claim',
      description:
        'When a claim you found is out of date or wrong, propose the corrected wording here, or just refresh its verification date. ' +
        'Opens a pull request that links back to the old claim (or, for a brain owner with direct writes on, commits it to the default branch); the result says which. Pass the claim id and `brain` from your search.',
      inputSchema: z.object({
        claim_id: z.string().min(8),
        text: z.string().min(3).optional().describe('New wording. Omit to only refresh the verification date.'),
        brain: brainArg,
        authority: authorityArg,
        verified_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    handling(async (args, mcp) => {
      const caller = callerOf(mcp);
      const brain = await requireBrain(caller.workosUserId, args.brain);
      const claim = await loadClaim(brain.id, args.claim_id);
      if (!claim) return errorResult(`No claim ${args.claim_id} in ${brain.id}.`);

      const newText = args.text ?? claim.text;

      try {
        const result = await landEdit(brain, {
          page: claim.page_path,
          branchPrefix: 'brain/update',
          commitMessage: `brain: update a claim in ${claim.page_path}`,
          title: `Update: ${truncate(newText)}`,
          ...described(brain.id, [
            `Replaces claim \`${claim.id.slice(0, 12)}\` in \`${claim.page_path}\`.`,
            '',
            `Was: ${claim.text}`,
            `Now: ${newText}`,
          ]),
          apply: (content) => {
            const line = locateClaim(content, claim.text, claim.line);
            if (line === null) {
              throw new WriteRefused(
                `Could not find that claim in ${claim.page_path} on ${brain.default_branch}; the page has changed since it was indexed. Search again and retry.`,
              );
            }
            const existing = readMarker(content, line);
            return replaceClaim(content, line, newText, {
              authority: args.authority ?? existing.authority ?? null,
              verifiedAt: args.verified_at ?? today(),
              // The old id survives the edit, so provenance is not lost when the
              // text changes and the new claim gets a different id.
              supersedes: claim.id.slice(0, 16),
            });
          },
        }, caller);
        return textResult(
          describeWrite(result, {
            committed: `Committed an update to a claim in ${brain.id}.`,
            proposed: `Proposed an update to a claim in ${brain.id}.`,
          }),
          { brain: brain.id, previous_claim_id: claim.id, ...structuredWrite(result) },
        );
      } catch (error) {
        return refusal(error);
      }
    }),
  );

  server.registerTool(
    'forget',
    {
      title: 'Forget a claim',
      description:
        'When a claim is no longer true and nothing replaces it, propose removing it; use update_fact instead when there is a new value. ' +
        'Opens a pull request (or, for a brain owner with direct writes on, commits to the default branch); the result says which, and the evidence files are untouched. Pass the claim id and `brain` from your search.',
      inputSchema: z.object({
        claim_id: z.string().min(8),
        brain: brainArg,
        reason: z.string().optional().describe('Why it should go. Shown in the pull request.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    handling(async (args, mcp) => {
      const caller = callerOf(mcp);
      const brain = await requireBrain(caller.workosUserId, args.brain);
      const claim = await loadClaim(brain.id, args.claim_id);
      if (!claim) return errorResult(`No claim ${args.claim_id} in ${brain.id}.`);

      try {
        const result = await landEdit(brain, {
          page: claim.page_path,
          branchPrefix: 'brain/forget',
          commitMessage: `brain: forget a claim in ${claim.page_path}`,
          title: `Forget: ${truncate(claim.text)}`,
          ...described(brain.id, [
            `Removes claim \`${claim.id.slice(0, 12)}\` from \`${claim.page_path}\`.`,
            '',
            `Claim: ${claim.text}`,
            args.reason ? `Reason: ${args.reason}` : 'No reason given.',
          ]),
          apply: (content) => {
            const line = locateClaim(content, claim.text, claim.line);
            if (line === null) {
              throw new WriteRefused(
                `Could not find that claim in ${claim.page_path} on ${brain.default_branch}; it may already be gone.`,
              );
            }
            return removeClaim(content, line);
          },
        }, caller);
        return textResult(
          describeWrite(result, {
            committed: `Committed the removal of a claim from ${brain.id}.`,
            proposed: `Proposed removing a claim from ${brain.id}.`,
          }),
          { brain: brain.id, ...structuredWrite(result) },
        );
      } catch (error) {
        return refusal(error);
      }
    }),
  );

  void ctx;
}

function refusal(error: unknown) {
  if (error instanceof WriteRefused) return errorResult(error.message);
  throw error;
}

function truncate(text: string, max = 68): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The same explanation for both paths: the PR body, and the direct commit's message body. */
function described(brainId: string, lines: string[]): { body: string; details: string[] } {
  return {
    details: lines,
    body: [
      ...lines,
      '',
      '---',
      `Opened by brain-mcp for the \`${brainId}\` brain. Review and merge; the index rebuilds from the merged commit.`,
    ].join('\n'),
  };
}

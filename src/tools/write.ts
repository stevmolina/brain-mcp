/**
 * The three write tools. Writes go to the truth because it's reviewable.
 *
 * Each one opens a pull request and stops. Nothing merges, nothing touches the
 * brain's sources directory, and no row appears in the index until the indexer
 * reprocesses the merged commit -- which the tool result says out loud, so a
 * caller never mistakes an open PR for a recorded fact.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { requireBrain } from '../auth/access.js';
import { workosUserId } from '../auth/workos.js';
import { openPullRequest, WriteRefused, type PullRequestResult } from '../github/write.js';
import { resolveProfile } from '../profiles/index.js';
import { appendClaim, locateClaim, readMarker, removeClaim, replaceClaim } from './edits.js';
import { loadClaim } from './read.js';
import { errorResult, textResult, today } from './shared.js';
import type { ToolContext } from './index.js';

const brainArg = z.string().optional().describe('Brain id, e.g. "owner/repo".');

const authorityArg = z
  .string()
  .optional()
  .describe(
    'Whether this line is truth or a summary of something else, e.g. "live". Only a human knows; leave it off for a durable fact that is never chased.',
  );

function pending(result: PullRequestResult, what: string): string {
  return [
    `${what}`,
    '',
    `Pull request: ${result.url}`,
    `Branch: ${result.branch} -> ${result.page}`,
    '',
    'Not recorded yet. The brain changes when this PR is merged and the indexer reprocesses that commit.',
  ].join('\n');
}

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'remember',
    {
      title: 'Remember a new claim',
      description:
        'Propose a new claim for a brain. Opens a pull request against the brain repo. Never merges, never writes to the sources directory.',
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
    async (args, mcp) => {
      const brain = await requireBrain(workosUserId(mcp.http?.authInfo), args.brain);
      const profile = resolveProfile(brain.profile);
      const page = args.page ?? profile.writePage;
      const heading = args.heading ?? profile.writeHeading;
      const verifiedAt = args.verified_at ?? (args.authority ? today() : null);

      try {
        const result = await openPullRequest(brain, {
          page,
          branchPrefix: 'brain/remember',
          commitMessage: `brain: remember a claim in ${page}`,
          title: `Remember: ${truncate(args.text)}`,
          body: prBody(brain.id, [
            `Adds one claim to \`${page}\` under **${heading}**.`,
            args.authority ? `Authority \`${args.authority}\`, verified \`${verifiedAt}\`.` : 'Unmarked, so durable.',
          ]),
          apply: (content) =>
            appendClaim(content, heading, args.text, {
              authority: args.authority ?? null,
              verifiedAt,
            }),
        });
        return textResult(pending(result, `Proposed a new claim in ${brain.id}.`), {
          brain: brain.id,
          pull_request: result,
          recorded: false,
        });
      } catch (error) {
        return refusal(error);
      }
    },
  );

  server.registerTool(
    'update_fact',
    {
      title: 'Update an existing claim',
      description:
        'Propose a replacement for a claim, keeping a supersedes marker back to the old one. Opens a pull request; never merges.',
      inputSchema: z.object({
        claim_id: z.string().min(8),
        text: z.string().min(3).optional().describe('New wording. Omit to only refresh the verification date.'),
        brain: brainArg,
        authority: authorityArg,
        verified_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args, mcp) => {
      const brain = await requireBrain(workosUserId(mcp.http?.authInfo), args.brain);
      const claim = await loadClaim(brain.id, args.claim_id);
      if (!claim) return errorResult(`No claim ${args.claim_id} in ${brain.id}.`);

      const newText = args.text ?? claim.text;

      try {
        const result = await openPullRequest(brain, {
          page: claim.page_path,
          branchPrefix: 'brain/update',
          commitMessage: `brain: update a claim in ${claim.page_path}`,
          title: `Update: ${truncate(newText)}`,
          body: prBody(brain.id, [
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
        });
        return textResult(pending(result, `Proposed an update to a claim in ${brain.id}.`), {
          brain: brain.id,
          pull_request: result,
          previous_claim_id: claim.id,
          recorded: false,
        });
      } catch (error) {
        return refusal(error);
      }
    },
  );

  server.registerTool(
    'forget',
    {
      title: 'Forget a claim',
      description:
        'Propose removing a claim from its page. Opens a pull request; never merges, and the received evidence in the sources directory is untouched.',
      inputSchema: z.object({
        claim_id: z.string().min(8),
        brain: brainArg,
        reason: z.string().optional().describe('Why it should go. Shown in the pull request.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (args, mcp) => {
      const brain = await requireBrain(workosUserId(mcp.http?.authInfo), args.brain);
      const claim = await loadClaim(brain.id, args.claim_id);
      if (!claim) return errorResult(`No claim ${args.claim_id} in ${brain.id}.`);

      try {
        const result = await openPullRequest(brain, {
          page: claim.page_path,
          branchPrefix: 'brain/forget',
          commitMessage: `brain: forget a claim in ${claim.page_path}`,
          title: `Forget: ${truncate(claim.text)}`,
          body: prBody(brain.id, [
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
        });
        return textResult(pending(result, `Proposed removing a claim from ${brain.id}.`), {
          brain: brain.id,
          pull_request: result,
          recorded: false,
        });
      } catch (error) {
        return refusal(error);
      }
    },
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

function prBody(brainId: string, lines: string[]): string {
  return [
    ...lines,
    '',
    '---',
    `Opened by brain-mcp for the \`${brainId}\` brain. Review and merge; the index rebuilds from the merged commit.`,
  ].join('\n');
}

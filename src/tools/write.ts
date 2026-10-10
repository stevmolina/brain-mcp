/**
 * The three write tools. Writes go to the truth, in git.
 *
 * The brain's mode for the action decides the outcome:
 *   review (the default) opens a pull request and stops
 *   auto commits on the default branch and reindexes
 *   read_only refuses
 *
 * Nothing in this file merges. Nothing writes the brain's sources directory.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { requireBrain } from '../auth/access.js';
import { workosUserId } from '../auth/workos.js';
import { commitToDefaultBranch, openPullRequest, WriteRefused } from '../github/write.js';
import { indexBrainAtCommit } from '../indexer/sync.js';
import { resolveProfile } from '../profiles/index.js';
import { auditCommitMessage, executeWrite, type WriteIO } from '../writes/execute.js';
import { appendClaim, locateClaim, readMarker, removeClaim, replaceClaim } from './edits.js';
import { loadClaim } from './read.js';
import { errorResult, handling, textResult, today } from './shared.js';
import type { ToolContext } from './index.js';

const brainArg = z.string().optional().describe('Brain id, e.g. "owner/repo".');

const authorityArg = z
  .string()
  .optional()
  .describe(
    'Whether this line is truth or a summary of something else, e.g. "live". Only a human knows; leave it off for a durable fact that is never chased.',
  );

const writeIo: WriteIO = {
  openPullRequest,
  commitToDefaultBranch,
  indexAtCommit: async (brain, sha) => {
    await indexBrainAtCommit(brain, sha);
  },
};

function refusal(error: unknown) {
  if (error instanceof WriteRefused) return errorResult(error.message);
  throw error;
}

function truncate(text: string, max = 68): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function prBody(brainId: string, requestedBy: string, lines: string[]): string {
  return [
    ...lines,
    '',
    '---',
    `Opened by brain-mcp for the \`${brainId}\` brain, requested by \`${requestedBy}\`.`,
    'Approve to save. The index rebuilds from the merged commit.',
  ].join('\n');
}

const modeNote =
  'review (the default) opens a pull request you approve to save. auto commits to the default branch and is searchable immediately. read_only refuses. See get_write_modes.';

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'remember',
    {
      title: 'Remember a new claim',
      description: `Save a new claim. ${modeNote}`,
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
      const userId = workosUserId(mcp.http?.authInfo);
      const brain = await requireBrain(userId, args.brain);
      const profile = resolveProfile(brain.profile);
      const page = args.page ?? profile.writePage;
      const heading = args.heading ?? profile.writeHeading;
      const verifiedAt = args.verified_at ?? (args.authority ? today() : null);

      try {
        const outcome = await executeWrite(
          brain,
          'remember',
          {
            page,
            branchPrefix: 'brain/remember',
            commitMessage: auditCommitMessage('remember', page, args.text, userId),
            title: `Remember: ${truncate(args.text)}`,
            body: prBody(brain.id, userId, [
              `Adds one claim to \`${page}\` under **${heading}**.`,
              args.authority ? `Authority \`${args.authority}\`, verified \`${verifiedAt}\`.` : 'Unmarked, so durable.',
            ]),
            apply: (content) =>
              appendClaim(content, heading, args.text, {
                authority: args.authority ?? null,
                verifiedAt,
              }),
          },
          writeIo,
          `New claim in ${brain.id}.`,
        );
        return textResult(outcome.text, outcome.structured);
      } catch (error) {
        return refusal(error);
      }
    }),
  );

  server.registerTool(
    'update_fact',
    {
      title: 'Update an existing claim',
      description: `Replace a claim, keeping a supersedes marker back to the old one. ${modeNote}`,
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
      const userId = workosUserId(mcp.http?.authInfo);
      const brain = await requireBrain(userId, args.brain);
      const claim = await loadClaim(brain.id, args.claim_id);
      if (!claim) return errorResult(`No claim ${args.claim_id} in ${brain.id}.`);

      const newText = args.text ?? claim.text;

      try {
        const outcome = await executeWrite(
          brain,
          'update_fact',
          {
            page: claim.page_path,
            branchPrefix: 'brain/update',
            commitMessage: auditCommitMessage(
              'update_fact',
              claim.page_path,
              `Was: ${claim.text}\nNow: ${newText}`,
              userId,
            ),
            title: `Update: ${truncate(newText)}`,
            body: prBody(brain.id, userId, [
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
          },
          writeIo,
          `Update a claim in ${brain.id}.`,
        );
        return textResult(outcome.text, {
          ...outcome.structured,
          previous_claim_id: claim.id,
        });
      } catch (error) {
        return refusal(error);
      }
    }),
  );

  server.registerTool(
    'forget',
    {
      title: 'Forget a claim',
      description: `Remove a claim from its page. The sources directory is untouched. ${modeNote}`,
      inputSchema: z.object({
        claim_id: z.string().min(8),
        brain: brainArg,
        reason: z.string().optional().describe('Why it should go. Shown in the commit or pull request.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    handling(async (args, mcp) => {
      const userId = workosUserId(mcp.http?.authInfo);
      const brain = await requireBrain(userId, args.brain);
      const claim = await loadClaim(brain.id, args.claim_id);
      if (!claim) return errorResult(`No claim ${args.claim_id} in ${brain.id}.`);

      try {
        const outcome = await executeWrite(
          brain,
          'forget',
          {
            page: claim.page_path,
            branchPrefix: 'brain/forget',
            commitMessage: auditCommitMessage(
              'forget',
              claim.page_path,
              args.reason ? `${claim.text}\n\nReason: ${args.reason}` : claim.text,
              userId,
            ),
            title: `Forget: ${truncate(claim.text)}`,
            body: prBody(brain.id, userId, [
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
          },
          writeIo,
          `Remove a claim from ${brain.id}.`,
        );
        return textResult(outcome.text, outcome.structured);
      } catch (error) {
        return refusal(error);
      }
    }),
  );

  void ctx;
}

/**
 * One write, three outcomes. The caller builds the markdown edit; this decides
 * whether it is refused, proposed as a pull request, or committed and reindexed.
 */
import type { DirectCommit, EditPlan, PullRequestResult } from '../github/write.js';
import { WriteRefused } from '../github/write.js';
import type { BrainRow } from '../types.js';
import { resolveWriteMode, type WriteAction, type WriteMode } from './modes.js';

export interface WriteIO {
  openPullRequest(brain: BrainRow, plan: EditPlan): Promise<PullRequestResult>;
  commitToDefaultBranch(brain: BrainRow, plan: EditPlan): Promise<DirectCommit>;
  indexAtCommit(brain: BrainRow, sha: string): Promise<void>;
}

export interface WriteOutcome {
  mode: Exclude<WriteMode, 'read_only'>;
  text: string;
  structured: Record<string, unknown>;
}

/** First line of the commit, so git log says what the write was. The body is the claim. */
export function auditCommitMessage(action: WriteAction, page: string, detail: string, requestedBy: string): string {
  const trimmed = detail.trim();
  const body = trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
  return `brain: ${action} in ${page}\n\n${body}\n\nRequested by ${requestedBy}`;
}

export async function executeWrite(
  brain: BrainRow,
  action: WriteAction,
  plan: EditPlan,
  io: WriteIO,
  what: string,
): Promise<WriteOutcome> {
  const mode = resolveWriteMode(brain.write_modes, action);
  if (mode === 'read_only') {
    throw new WriteRefused(
      `Not saved. ${action} on ${brain.id} is read_only. The owner can change it with set_write_mode.`,
    );
  }

  if (mode === 'review') {
    const result = await io.openPullRequest(brain, plan);
    return {
      mode,
      text: [
        `Proposed as PR #${result.number}. Approve to save.`,
        '',
        what,
        '',
        `Pull request: ${result.url}`,
        `Branch: ${result.branch} -> ${result.page}`,
        '',
        'Not recorded yet. The brain changes when this pull request is merged and the indexer reprocesses that commit.',
      ].join('\n'),
      structured: {
        brain: brain.id,
        mode,
        saved_to_git: false,
        recorded: false,
        pull_request: result,
      },
    };
  }

  const commit = await io.commitToDefaultBranch(brain, plan);
  let recorded = true;
  let indexError: string | undefined;
  try {
    await io.indexAtCommit(brain, commit.sha);
  } catch (error) {
    recorded = false;
    indexError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  }

  const lines = [
    'Saved.',
    '',
    `Wrote ${commit.page} on ${brain.default_branch}.`,
    `Commit: ${commit.url}`,
    `Message: ${commit.message.split('\n')[0]}`,
    '',
  ];
  if (recorded) {
    lines.push('Searchable now. The index was rebuilt from that commit. Revert it by reverting the commit in git.');
  } else {
    lines.push(
      `The commit is in git, so you can revert it there. The search index could not be rebuilt just now (${indexError}). It should show up on the next push.`,
    );
  }

  return {
    mode,
    text: lines.join('\n'),
    structured: {
      brain: brain.id,
      mode,
      saved_to_git: true,
      recorded,
      commit: { sha: commit.sha, url: commit.url, page: commit.page },
    },
  };
}

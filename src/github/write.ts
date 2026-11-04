/**
 * The write path. Writes go to the truth, the brain repo, in one of two ways:
 *
 *   - Direct: the brain's profile has `directWrites: true` AND the caller is the
 *     brain's owner. The edit is one commit on the default branch, guarded by the
 *     page's current blob sha so a concurrent edit is never overwritten.
 *   - Pull request: everyone and everything else. A branch plus a PR, which a
 *     person reviews and merges.
 *
 * Invariants, enforced here rather than by convention:
 *   1. Never touch the brain's sources directory, in either mode.
 *   2. Never merge. This module has no merge call in it; a direct write is a
 *      contents commit, not a merge of anything.
 *   3. No row appears in the index until the indexer reprocesses the commit that
 *      lands on the default branch (the push webhook does that for both modes).
 */
import { randomBytes } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { installationOctokit } from './app.js';
import { resolveProfile } from '../profiles/index.js';
import { ToolRefusal } from '../tools/shared.js';
import type { BrainRow } from '../types.js';

export class WriteRefused extends ToolRefusal {}

export interface PullRequestResult {
  url: string;
  number: number;
  branch: string;
  page: string;
}

export interface DirectCommitResult {
  sha: string;
  url: string;
  branch: string;
  page: string;
}

/** Which path a write took. A PR may be a fallback from a direct write that conflicted. */
export type WriteResult =
  | { mode: 'commit'; commit: DirectCommitResult }
  | { mode: 'pull_request'; pullRequest: PullRequestResult; fallbackReason?: string };

/** Who is writing, for the commit message. Free text, never used for a decision. */
export interface WriteAuthor {
  /** The caller, e.g. their GitHub login. */
  caller: string;
  /** The agent or client that made the call, when known. */
  agent?: string | null;
}

export interface EditPlan {
  /** Repo-relative markdown page to change. */
  page: string;
  /** Applied to the page's current content on the default branch. */
  apply: (content: string) => string;
  branchPrefix: string;
  title: string;
  body: string;
  commitMessage: string;
}

function assertWritablePage(brain: BrainRow, page: string): void {
  const profile = resolveProfile(brain.profile);
  const normalized = page.replace(/^\.?\//, '');
  if (normalized.includes('..')) throw new WriteRefused(`Refusing to write outside the repo: ${page}`);
  if (!normalized.endsWith('.md')) throw new WriteRefused(`Claims live in markdown; refusing to write ${page}`);
  const sourcesPrefix = `${profile.sourcesDir.replace(/\/$/, '')}/`;
  if (normalized === profile.sourcesDir || normalized.startsWith(sourcesPrefix)) {
    throw new WriteRefused(
      `Refusing to write to ${page}: ${profile.sourcesDir}/ holds received evidence and is never written.`,
    );
  }
}

function isConflict(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  // 409: the branch moved or a rule blocked the push. 422: the sha we sent is no
  // longer the page's blob (or the page appeared since we read it).
  return status === 409 || status === 422;
}

async function readPage(
  octokit: Octokit,
  brain: BrainRow,
  page: string,
  ref: string,
): Promise<{ content: string; sha: string | null }> {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: brain.repo_owner,
      repo: brain.repo_name,
      path: page,
      ref,
    });
    if (Array.isArray(data) || data.type !== 'file') {
      throw new WriteRefused(`${page} is not a file`);
    }
    return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
  } catch (error) {
    if ((error as { status?: number }).status === 404) return { content: '', sha: null };
    throw error;
  }
}

/** Opens a pull request carrying one markdown edit. Returns the PR, never a merge. */
export async function openPullRequest(brain: BrainRow, plan: EditPlan): Promise<PullRequestResult> {
  assertWritablePage(brain, plan.page);
  if (!brain.installation_id) {
    throw new WriteRefused(
      `The ${brain.id} brain has no GitHub App installation; writes are unavailable until it is installed.`,
    );
  }

  const octokit = await installationOctokit(brain.installation_id);
  const owner = brain.repo_owner;
  const repo = brain.repo_name;
  const base = brain.default_branch;

  const { data: baseRef } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
    owner,
    repo,
    ref: `heads/${base}`,
  });

  const branch = `${plan.branchPrefix}-${randomBytes(4).toString('hex')}`;
  await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: baseRef.object.sha,
  });

  const current = await readPage(octokit, brain, plan.page, base);
  const next = plan.apply(current.content);
  if (next === current.content) {
    throw new WriteRefused(`That change is already the state of ${plan.page}; nothing to propose.`);
  }

  await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
    owner,
    repo,
    path: plan.page,
    branch,
    message: plan.commitMessage,
    content: Buffer.from(next, 'utf8').toString('base64'),
    ...(current.sha ? { sha: current.sha } : {}),
  });

  const { data: pr } = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
    owner,
    repo,
    head: branch,
    base,
    title: plan.title,
    body: plan.body,
  });

  return { url: pr.html_url, number: pr.number, branch, page: plan.page };
}

/**
 * Commits one markdown edit straight to the default branch. Only for a brain
 * whose profile turns direct writes on, and only for its owner: the caller
 * decides that (see `directWriteAllowed` in auth/access.ts) and this function
 * trusts nothing else about it.
 *
 * The PUT carries the page's current blob sha, so GitHub refuses it if the page
 * changed after we read it. On that conflict the page is re-read and the edit
 * re-applied once; a second conflict falls back to a pull request.
 */
export async function commitDirect(
  brain: BrainRow,
  plan: EditPlan,
  author: WriteAuthor,
): Promise<WriteResult> {
  assertWritablePage(brain, plan.page);
  if (!brain.installation_id) {
    throw new WriteRefused(
      `The ${brain.id} brain has no GitHub App installation; writes are unavailable until it is installed.`,
    );
  }

  const octokit = await installationOctokit(brain.installation_id);
  const branch = brain.default_branch;
  const message = [
    plan.commitMessage,
    '',
    `Committed directly by brain-mcp for ${author.caller}${author.agent ? ` via ${author.agent}` : ''}.`,
  ].join('\n');

  for (let attempt = 1; attempt <= 2; attempt++) {
    const current = await readPage(octokit, brain, plan.page, branch);
    const next = plan.apply(current.content);
    if (next === current.content) {
      throw new WriteRefused(`That change is already the state of ${plan.page}; nothing to commit.`);
    }
    try {
      const { data } = await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
        owner: brain.repo_owner,
        repo: brain.repo_name,
        path: plan.page,
        branch,
        message,
        content: Buffer.from(next, 'utf8').toString('base64'),
        ...(current.sha ? { sha: current.sha } : {}),
      });
      const commit = (data as { commit?: { sha?: string; html_url?: string } }).commit ?? {};
      return {
        mode: 'commit',
        commit: {
          sha: commit.sha ?? '',
          url: commit.html_url ?? `https://github.com/${brain.repo_owner}/${brain.repo_name}/commit/${commit.sha ?? ''}`,
          branch,
          page: plan.page,
        },
      };
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  const pullRequest = await openPullRequest(brain, plan);
  return {
    mode: 'pull_request',
    pullRequest,
    fallbackReason: `${plan.page} kept changing on ${branch} while committing, so this opened a pull request instead.`,
  };
}

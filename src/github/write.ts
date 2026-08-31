/**
 * The write path. Writes go to the truth because it's reviewable: every write
 * produces a branch and a pull request against the brain repo, and nothing else.
 *
 * Three invariants, enforced here rather than by convention:
 *   1. Never touch the brain's sources directory.
 *   2. Never merge. This module has no merge call in it.
 *   3. No row appears in the index until the indexer reprocesses the merged commit.
 */
import { randomBytes } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { installationOctokit } from './app.js';
import { resolveProfile } from '../profiles/index.js';
import type { BrainRow } from '../types.js';

export class WriteRefused extends Error {}

export interface PullRequestResult {
  url: string;
  number: number;
  branch: string;
  page: string;
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

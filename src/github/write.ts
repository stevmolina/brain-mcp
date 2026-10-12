/**
 * The write path. Writes go to the truth, in git.
 *
 * review mode opens a pull request and stops. auto mode commits on the default
 * branch, which stays auditable and revertible in git history. This module has
 * no merge call in it.
 *
 * Two invariants, enforced here rather than by convention:
 *   1. Never touch the brain's sources directory.
 *   2. Never merge.
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

export interface DirectCommit {
  sha: string;
  url: string;
  page: string;
  message: string;
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

interface PreparedEdit {
  octokit: Octokit;
  owner: string;
  repo: string;
  base: string;
  baseSha: string;
  page: string;
  next: string;
  blobSha: string | null;
}

async function prepareEdit(brain: BrainRow, plan: EditPlan): Promise<PreparedEdit> {
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

  const current = await readPage(octokit, brain, plan.page, base);
  const next = plan.apply(current.content);
  if (next === current.content) {
    throw new WriteRefused(`That change is already the state of ${plan.page}; nothing to write.`);
  }

  return { octokit, owner, repo, base, baseSha: baseRef.object.sha, page: plan.page, next, blobSha: current.sha };
}

function encoded(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

/** Opens a pull request carrying one markdown edit. Returns the PR, never a merge. */
export async function openPullRequest(brain: BrainRow, plan: EditPlan): Promise<PullRequestResult> {
  const edit = await prepareEdit(brain, plan);
  const branch = `${plan.branchPrefix}-${randomBytes(4).toString('hex')}`;

  await edit.octokit.request('POST /repos/{owner}/{repo}/git/refs', {
    owner: edit.owner,
    repo: edit.repo,
    ref: `refs/heads/${branch}`,
    sha: edit.baseSha,
  });

  await edit.octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
    owner: edit.owner,
    repo: edit.repo,
    path: edit.page,
    branch,
    message: plan.commitMessage,
    content: encoded(edit.next),
    ...(edit.blobSha ? { sha: edit.blobSha } : {}),
  });

  const { data: pr } = await edit.octokit.request('POST /repos/{owner}/{repo}/pulls', {
    owner: edit.owner,
    repo: edit.repo,
    head: branch,
    base: edit.base,
    title: plan.title,
    body: plan.body,
  });

  return { url: pr.html_url, number: pr.number, branch, page: edit.page };
}

/**
 * Commits one markdown edit straight onto the default branch.
 * The commit is ordinary git history: visible, attributable to the app, revertible.
 */
export async function commitToDefaultBranch(brain: BrainRow, plan: EditPlan): Promise<DirectCommit> {
  const edit = await prepareEdit(brain, plan);

  let data: { commit?: { sha?: string; html_url?: string | null } };
  try {
    const response = await edit.octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: edit.owner,
      repo: edit.repo,
      path: edit.page,
      branch: edit.base,
      message: plan.commitMessage,
      content: encoded(edit.next),
      ...(edit.blobSha ? { sha: edit.blobSha } : {}),
    });
    data = response.data;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 409 || status === 422) {
      throw new WriteRefused(`Could not write ${edit.page} on ${edit.base}; the page changed. Search again and retry.`);
    }
    throw error;
  }

  const sha = data.commit?.sha;
  if (!sha) throw new WriteRefused(`GitHub did not return a commit for ${edit.page}.`);

  console.log(JSON.stringify({ level: 'info', at: 'write.auto', brain: brain.id, page: edit.page, sha }));

  return {
    sha,
    url: data.commit?.html_url || `https://github.com/${edit.owner}/${edit.repo}/commit/${sha}`,
    page: edit.page,
    message: plan.commitMessage,
  };
}

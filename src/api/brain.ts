import { requireBrain } from '../auth/access.js';
import { installationOctokit } from '../github/app.js';
import { validatePath } from '../files/paths.js';
import { resolveCommit } from '../github/repo.js';
import { ToolRefusal } from '../tools/shared.js';

/** Resolve access before using the installation credential for any repo read. */
export async function brainOverview(userId: string, requested?: string) {
  const brain = await requireBrain(userId, requested);
  if (!brain.installation_id) throw new ToolRefusal('This brain has no GitHub installation.');
  const github = await installationOctokit(brain.installation_id);
  const repo = { owner: brain.repo_owner, repo: brain.repo_name };
  const commit = await resolveCommit(github, repo.owner, repo.repo, brain.default_branch);
  const { data: tree } = await github.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
    ...repo, tree_sha: commit, recursive: '1',
  });
  if (tree.truncated) throw new ToolRefusal('The page list exceeds the GitHub tree limit.');
  const { data: changes } = await github.request('GET /repos/{owner}/{repo}/commits', {
    ...repo, sha: commit, per_page: 20,
  });
  return {
    brain: brain.id, commit,
    pages: tree.tree.filter((entry) => entry.type === 'blob' && /\.md$/i.test(entry.path ?? ''))
      .map((entry) => ({ path: entry.path, sha: entry.sha, bytes: entry.size })),
    recent_changes: changes.map((entry) => ({
      sha: entry.sha, message: entry.commit.message, date: entry.commit.committer?.date, url: entry.html_url,
    })),
    last_indexed_commit: brain.last_indexed_commit,
    last_indexed_at: brain.last_indexed_at,
  };
}

export async function readPage(userId: string, requested: string | undefined, pagePath: string) {
  const brain = await requireBrain(userId, requested);
  const path = validatePath(pagePath);
  if (!/\.md$/i.test(path)) throw new ToolRefusal('A page must have a .md path.');
  if (!brain.installation_id) throw new ToolRefusal('This brain has no GitHub installation.');
  const github = await installationOctokit(brain.installation_id);
  const { data } = await github.request('GET /repos/{owner}/{repo}/contents/{path}', {
    owner: brain.repo_owner, repo: brain.repo_name, path, ref: brain.default_branch,
  });
  if (Array.isArray(data) || data.type !== 'file' || data.encoding !== 'base64') {
    throw new ToolRefusal('The page is not a text file within the GitHub content size limit.');
  }
  return { brain: brain.id, path, sha: data.sha, text: Buffer.from(data.content, 'base64').toString('utf8'), url: data.html_url };
}

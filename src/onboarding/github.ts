/**
 * GitHub and database side of onboarding.
 *
 * Access checks go through the same GitHub App installation the rest of the
 * server uses. Creating a repository is the exception: POST /user/repos needs
 * a user access token, so it only runs after the OAuth callback.
 */
import { Octokit } from '@octokit/rest';
import { canReadRepo, githubLoginForWorkosUser } from '../auth/access.js';
import { loadConfig } from '../config.js';
import { db } from '../db/client.js';
import { appOctokit, findInstallationId, installationOctokit } from '../github/app.js';
import { resolveCommit } from '../github/repo.js';
import { indexBrainAtCommit } from '../indexer/sync.js';
import type { BrainRow } from '../types.js';
import { explainCreateRepoFailure, repoAttachCanContinue } from './flow.js';
import { githubAuthorizeUrl, githubOAuthCallbackUrl, privateRepoBody } from './oauth.js';
import { readCreateState, signCreateState, type CreateBrainState } from './state.js';
import type { SeedFile } from './starter.js';
import { OnboardingError, type CreatedRepo, type InsertBrainInput, type OnboardingIO, type RepoRef } from './types.js';

let cachedInstallUrl: string | undefined;

export async function githubAppInstallUrl(): Promise<string> {
  if (!cachedInstallUrl) {
    const { data } = await appOctokit().request('GET /app');
    if (!data?.slug) throw new OnboardingError('Could not read the GitHub App install URL.');
    cachedInstallUrl = `https://github.com/apps/${data.slug}/installations/new`;
  }
  return cachedInstallUrl;
}

async function userInstallation(login: string): Promise<{ id: number } | null> {
  try {
    const { data } = await appOctokit().request('GET /users/{username}/installation', { username: login });
    return { id: data.id };
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

async function listRepos(installationId: number): Promise<RepoRef[]> {
  const octokit = await installationOctokit(installationId);
  const out: RepoRef[] = [];
  for (let page = 1; page <= 3; page++) {
    const { data } = await octokit.request('GET /installation/repositories', { per_page: 100, page });
    for (const repo of data.repositories) {
      out.push({ owner: repo.owner.login, name: repo.name, private: Boolean(repo.private) });
    }
    if (data.repositories.length < 100) break;
  }
  return out;
}

async function insertBrain(input: InsertBrainInput): Promise<BrainRow | null> {
  try {
    const { rows } = await db().query<BrainRow>(
      `insert into brains (
         id, owner_workos_user_id, owner_github_login, repo_owner, repo_name, default_branch, installation_id
       ) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (repo_owner, repo_name) do nothing
       returning *`,
      [
        input.id,
        input.workosUserId,
        input.ownerGithubLogin,
        input.repoOwner,
        input.repoName,
        input.defaultBranch,
        input.installationId,
      ],
    );
    return rows[0] ?? null;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return null;
    throw error;
  }
}

async function commitFiles(
  installationId: number,
  owner: string,
  repo: string,
  branch: string,
  files: SeedFile[],
  message: string,
): Promise<string> {
  const octokit = await installationOctokit(installationId);
  try {
    const { data: ref } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    const parent = ref.object.sha;
    const { data: parentCommit } = await octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
      owner,
      repo,
      commit_sha: parent,
    });
    const { data: tree } = await octokit.request('POST /repos/{owner}/{repo}/git/trees', {
      owner,
      repo,
      base_tree: parentCommit.tree.sha,
      tree: files.map((file) => ({
        path: file.path,
        mode: '100644' as const,
        type: 'blob' as const,
        content: file.content,
      })),
    });
    const { data: commit } = await octokit.request('POST /repos/{owner}/{repo}/git/commits', {
      owner,
      repo,
      message,
      tree: tree.sha,
      parents: [parent],
    });
    await octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: commit.sha,
    });
    return commit.sha;
  } catch (error) {
    const status = (error as { status?: number }).status;
    throw new OnboardingError(
      `Created ${owner}/${repo}, but the starter files could not be committed${status ? ` (GitHub ${status})` : ''}. Call connect_brain with repo "${owner}/${repo}" once the GitHub App can see it.`,
    );
  }
}

export function createOnboardingHost(): OnboardingIO {
  const config = () => loadConfig();

  return {
    githubLogin: (workosUserId) => githubLoginForWorkosUser(workosUserId),
    installUrl: () => githubAppInstallUrl(),
    callbackUrl: () => githubOAuthCallbackUrl(config().mcpResourceUrl),
    oauthConfigured: () => Boolean(config().githubAppClientId && config().githubAppClientSecret),
    mintAuthorizeUrl: (state: CreateBrainState) => {
      const current = config();
      if (!current.githubAppClientId) {
        throw new OnboardingError('GitHub App client id is not configured.');
      }
      const signed = signCreateState(state, current.githubWebhookSecret);
      return githubAuthorizeUrl(current.githubAppClientId, githubOAuthCallbackUrl(current.mcpResourceUrl), signed);
    },
    readState: (state) => readCreateState(state, config().githubWebhookSecret),
    userInstallation,
    installationForRepo: (owner, repo) => findInstallationId(owner, repo),
    async canonicalRepo(installationId, owner, repo) {
      const octokit = await installationOctokit(installationId);
      const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
      return { owner: data.owner.login, name: data.name, defaultBranch: data.default_branch || 'main' };
    },
    async findBrainByRepo(owner, name) {
      const { rows } = await db().query<BrainRow>(
        'select * from brains where lower(repo_owner) = lower($1) and lower(repo_name) = lower($2)',
        [owner, name],
      );
      return rows[0] ?? null;
    },
    callerCanReadRepo: (installationId, owner, repo, login) => canReadRepo(installationId, owner, repo, login),
    async headSha(installationId, owner, repo, branch) {
      const octokit = await installationOctokit(installationId);
      return resolveCommit(octokit, owner, repo, branch);
    },
    insertBrain,
    async indexBrain(brain, sha) {
      await indexBrainAtCommit(brain, sha);
    },
    listRepos,
    async githubLoginForToken(token) {
      const { data } = await new Octokit({ auth: token }).request('GET /user');
      if (!data.login) throw new OnboardingError('GitHub did not return the account for that authorization.');
      return data.login;
    },
    async createPrivateRepo(token, name) {
      const octokit = new Octokit({ auth: token });
      try {
        const { data } = await octokit.request('POST /user/repos', privateRepoBody(name));
        const created: CreatedRepo = {
          id: Number(data.id),
          owner: data.owner?.login ?? '',
          name: data.name,
          defaultBranch: data.default_branch || 'main',
        };
        if (!created.owner) throw new OnboardingError('GitHub created a repository but did not name the owner.');
        return created;
      } catch (error) {
        if (error instanceof OnboardingError) throw error;
        const status = (error as { status?: number }).status;
        const message = (error as { message?: string }).message ?? 'request failed';
        throw new OnboardingError(explainCreateRepoFailure(status, message));
      }
    },
    async attachRepo(token, installationId, repoId) {
      try {
        await new Octokit({ auth: token }).request(
          'PUT /user/installations/{installation_id}/repositories/{repository_id}',
          { installation_id: installationId, repository_id: repoId },
        );
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (repoAttachCanContinue(status)) return;
        throw new OnboardingError(
          `The repository was created, but it could not be added to the GitHub App installation${status ? ` (GitHub ${status})` : ''}. Add it in GitHub, then call connect_brain.`,
        );
      }
    },
    commitFiles,
    async exchangeCode(code) {
      const current = config();
      if (!current.githubAppClientId || !current.githubAppClientSecret) {
        throw new OnboardingError('GitHub App client credentials are not configured.');
      }
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: current.githubAppClientId,
          client_secret: current.githubAppClientSecret,
          code,
          redirect_uri: githubOAuthCallbackUrl(current.mcpResourceUrl),
        }),
      });
      const body = (await response.json()) as { access_token?: string; error_description?: string };
      if (!body.access_token) {
        throw new OnboardingError(body.error_description || 'GitHub did not return an access token. Call create_brain again.');
      }
      return body.access_token;
    },
  };
}

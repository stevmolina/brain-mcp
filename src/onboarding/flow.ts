/**
 * Self-serve onboarding.
 *
 * connect_brain registers a repo the caller can already access, once the GitHub
 * App is installed on it. create_brain makes a private repo on the caller's own
 * GitHub account. Creating a repo needs a user access token, which installation
 * tokens cannot get, so that path redirects through GitHub and comes back to
 * /oauth/github/callback.
 */
import type { BrainRow } from '../types.js';
import { CREATE_STATE_TTL_MS, type CreateBrainState } from './state.js';
import { STARTER_COMMIT_MESSAGE, starterFiles } from './starter.js';
import { OnboardingError, type CallbackResult, type OnboardingIO, type OnboardingReply } from './types.js';

const REPO_NAME = /^(?!\.)(?!\.\.)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/;

export function parseRepoSlug(slug: string): { owner: string; repo: string } | null {
  const match = slug.trim().match(/^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]{1,100})$/);
  if (!match?.[1] || !match[2]) return null;
  if (!REPO_NAME.test(match[2])) return null;
  return { owner: match[1], repo: match[2] };
}

export function normalizeRepoName(name: string | undefined): string | null {
  const value = (name ?? 'agent-brain').trim();
  if (!REPO_NAME.test(value)) return null;
  if (value.toLowerCase().endsWith('.git')) return null;
  return value;
}

/** A 403 or 422 from "add repo to installation" means the install already covers it. */
export function repoAttachCanContinue(status: number | undefined): boolean {
  return status === 403 || status === 409 || status === 422;
}

export function explainCreateRepoFailure(status: number | undefined, githubMessage: string): string {
  if (status === 422) {
    return 'A repository with that name already exists on your GitHub account. Pick another name, or connect it with connect_brain if the GitHub App is installed on it.';
  }
  if (status === 401 || status === 403) {
    return `GitHub refused to create the repository. The GitHub App needs Administration set to Read and write, and this authorization has to include that permission. GitHub said: ${githubMessage}`;
  }
  return `Could not create the repository. GitHub said: ${githubMessage}`;
}

function noGithubIdentity(): OnboardingReply {
  return {
    isError: true,
    text: 'No GitHub account is linked to this login, so repo access cannot be checked. Sign in with GitHub through WorkOS and try again.',
  };
}

function unavailable(installUrl: string): OnboardingReply {
  return {
    isError: true,
    text: [
      'Could not connect that repo. The GitHub App has to be installed on it, and your GitHub account needs access. Nothing was registered.',
      '',
      `Install the app: ${installUrl}`,
      '',
      'Then call connect_brain again with repo set to "owner/name".',
    ].join('\n'),
  };
}

function already(brain: BrainRow): OnboardingReply {
  return {
    text: `Already connected as ${brain.id}. You can search it.`,
    structured: { brain: brain.id, connected: true },
  };
}

export async function listConnectableRepos(workosUserId: string, io: OnboardingIO): Promise<OnboardingReply> {
  const login = await io.githubLogin(workosUserId);
  if (!login) return noGithubIdentity();

  const installUrl = await io.installUrl();
  const installation = await io.userInstallation(login);
  if (!installation) {
    return {
      text: [
        `The GitHub App is not installed on your GitHub account (${login}).`,
        '',
        `Install it: ${installUrl}`,
        '',
        'Then call list_connectable_repos again. To use a repository that already exists, including one in an organization, install the app on that repository and call connect_brain.',
      ].join('\n'),
      structured: { installed: false, install_url: installUrl },
    };
  }

  const repos = await io.listRepos(installation.id);
  if (repos.length === 0) {
    return {
      text: [
        `The GitHub App is installed on ${login}, but it cannot see any repositories yet.`,
        '',
        `Add a repository to the installation: ${installUrl}`,
        '',
        'Then call connect_brain with repo set to "owner/name".',
      ].join('\n'),
      structured: { installed: true, repos: [] },
    };
  }

  const lines = [`Repositories the GitHub App can see on ${login}:`, ''];
  const listed = [];
  for (const repo of repos) {
    const existing = await io.findBrainByRepo(repo.owner, repo.name);
    const slug = `${repo.owner}/${repo.name}`;
    lines.push(existing ? `- ${slug} (already a brain)` : `- ${slug}`);
    listed.push({ repo: slug, private: repo.private, brain: existing?.id ?? null });
  }
  lines.push('', 'Call connect_brain with repo set to "owner/name" to use one that is not a brain yet.');
  lines.push(`Install the app on another account or repository: ${installUrl}`);

  return { text: lines.join('\n'), structured: { installed: true, repos: listed } };
}

export async function connectBrain(workosUserId: string, slug: string, io: OnboardingIO): Promise<OnboardingReply> {
  const parsed = parseRepoSlug(slug);
  if (!parsed) {
    return { isError: true, text: 'Pass the repository as owner/name, for example "ada/notes".' };
  }

  const login = await io.githubLogin(workosUserId);
  if (!login) return noGithubIdentity();

  const installUrl = await io.installUrl();
  const installationId = await io.installationForRepo(parsed.owner, parsed.repo);
  if (!installationId) return unavailable(installUrl);

  let meta: { owner: string; name: string; defaultBranch: string };
  try {
    meta = await io.canonicalRepo(installationId, parsed.owner, parsed.repo);
  } catch {
    return unavailable(installUrl);
  }

  const canRead = await io.callerCanReadRepo(installationId, meta.owner, meta.name, login);
  if (!canRead) return unavailable(installUrl);

  const existing = await io.findBrainByRepo(meta.owner, meta.name);
  if (existing) return already(existing);

  let sha: string;
  try {
    sha = await io.headSha(installationId, meta.owner, meta.name, meta.defaultBranch);
  } catch {
    return {
      isError: true,
      text: `Could not read the default branch of ${meta.owner}/${meta.name}, so it was not registered.`,
    };
  }
  const brain = await io.insertBrain({
    id: `${meta.owner}/${meta.name}`,
    workosUserId,
    ownerGithubLogin: meta.owner,
    repoOwner: meta.owner,
    repoName: meta.name,
    defaultBranch: meta.defaultBranch,
    installationId,
  });
  if (!brain) {
    const raced = await io.findBrainByRepo(meta.owner, meta.name);
    if (raced) return already(raced);
    return { isError: true, text: `Could not register ${meta.owner}/${meta.name}. Try connect_brain again.` };
  }

  return finishIndex(brain, sha, io, true);
}

function manualCreate(login: string, installUrl: string, callbackUrl: string): OnboardingReply {
  return {
    text: [
      'Creating a repository from here is not turned on yet.',
      '',
      'Start with a repository you create yourself:',
      '1. On GitHub, create a private repository.',
      `2. Install the GitHub App on it: ${installUrl}`,
      '3. Call connect_brain with repo set to "your-login/your-repo".',
      '',
      'list_connectable_repos shows repositories the app can already see on your account.',
      '',
      'The server owner turns on one-step creation by setting GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET, registering this callback URL on the GitHub App, and granting Administration: Read and write.',
      `Callback URL: ${callbackUrl}`,
    ].join('\n'),
    structured: { created: false, oauth_configured: false, install_url: installUrl, callback_url: callbackUrl, login },
  };
}

export async function startCreateBrain(
  workosUserId: string,
  requestedName: string | undefined,
  io: OnboardingIO,
  now = Date.now(),
): Promise<OnboardingReply> {
  const repo = normalizeRepoName(requestedName);
  if (!repo) {
    return {
      isError: true,
      text: 'Repository names are 1 to 100 characters of letters, numbers, dots, underscores, and hyphens, and cannot start with a dot.',
    };
  }

  const login = await io.githubLogin(workosUserId);
  if (!login) return noGithubIdentity();

  const installUrl = await io.installUrl();
  const installation = await io.userInstallation(login);
  if (!installation) {
    return {
      isError: true,
      text: [
        `The GitHub App is not installed on your GitHub account (${login}), so a repository cannot be created there yet.`,
        '',
        `Install it: ${installUrl}`,
        '',
        'Then call create_brain again. To use a repository that already exists, including one in an organization, install the app on that repository and call connect_brain.',
      ].join('\n'),
    };
  }

  const existing = await io.findBrainByRepo(login, repo);
  if (existing) {
    const owns =
      existing.owner_workos_user_id === workosUserId ||
      existing.owner_github_login.toLowerCase() === login.toLowerCase();
    if (!owns) return unavailable(installUrl);
    return already(existing);
  }

  if (!io.oauthConfigured()) return manualCreate(login, installUrl, io.callbackUrl());

  const state: CreateBrainState = {
    purpose: 'create_brain',
    sub: workosUserId,
    login,
    repo,
    exp: now + CREATE_STATE_TTL_MS,
  };
  const url = io.mintAuthorizeUrl(state);
  return {
    text: [
      `To create a private repository ${login}/${repo}, approve GitHub access once:`,
      '',
      url,
      '',
      'After you approve, the repository is created and connected. Come back and search. The link expires in 15 minutes.',
    ].join('\n'),
    structured: { created: false, authorize_url: url, repo: `${login}/${repo}` },
  };
}

async function finishIndex(brain: BrainRow, sha: string, io: OnboardingIO, fresh: boolean): Promise<OnboardingReply> {
  try {
    await io.indexBrain(brain, sha);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: 'error', at: 'onboarding.index', brain: brain.id, message }));
    return {
      text: [
        `Connected ${brain.id}, but the search index could not be rebuilt just now.`,
        '',
        'The brain is registered. Call connect_brain again, or push a commit, and it will be indexed.',
      ].join('\n'),
      structured: { brain: brain.id, connected: true, indexed: false },
    };
  }

  console.log(JSON.stringify({ level: 'info', at: fresh ? 'onboarding.connect' : 'onboarding.create', brain: brain.id }));
  return {
    text: [
      `Connected ${brain.id}.`,
      '',
      'It is searchable now. Writes use review mode until the owner changes them with set_write_mode.',
    ].join('\n'),
    structured: { brain: brain.id, connected: true, indexed: true },
  };
}

export async function finishCreateFromCallback(
  query: { code?: string; state?: string; error?: string; error_description?: string },
  io: OnboardingIO,
): Promise<CallbackResult> {
  if (query.error) {
    return page(400, 'GitHub authorization was declined', 'The repository was not created. Call create_brain again if you want to retry.');
  }
  if (!query.code || !query.state) {
    return page(400, 'Missing authorization', 'That link did not include an authorization code. Call create_brain from your client to get a fresh link.');
  }

  const state = io.readState(query.state);
  if (!state) {
    return page(400, 'Link not valid', 'That link is not valid or it expired. Call create_brain again.');
  }

  try {
    const token = await io.exchangeCode(query.code);
    const login = await io.githubLoginForToken(token);
    if (login.toLowerCase() !== state.login.toLowerCase()) {
      return page(
        400,
        'GitHub account does not match',
        `This GitHub account is ${login}, but the link was started for ${state.login}. The repository was not created.`,
      );
    }

    const created = await io.createPrivateRepo(token, state.repo);
    const installation = await io.userInstallation(state.login);
    if (!installation) {
      return page(
        400,
        'GitHub App is not installed',
        `Created ${created.owner}/${created.name}, but the GitHub App is not installed on ${state.login}. Install the app on that repository, then call connect_brain.`,
      );
    }

    await io.attachRepo(token, installation.id, created.id);
    const sha = await io.commitFiles(
      installation.id,
      created.owner,
      created.name,
      created.defaultBranch,
      starterFiles(),
      STARTER_COMMIT_MESSAGE,
    );
    const brain = await io.insertBrain({
      id: `${created.owner}/${created.name}`,
      workosUserId: state.sub,
      ownerGithubLogin: created.owner,
      repoOwner: created.owner,
      repoName: created.name,
      defaultBranch: created.defaultBranch,
      installationId: installation.id,
    });
    const saved = brain ?? (await io.findBrainByRepo(created.owner, created.name));
    if (!saved) {
      return page(
        500,
        'Repository created, brain not registered',
        `${created.owner}/${created.name} exists on GitHub. Call connect_brain with that repo to finish.`,
      );
    }

    try {
      await io.indexBrain(saved, sha);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ level: 'error', at: 'onboarding.index', brain: saved.id, message }));
      return page(
        200,
        'Repository created',
        `Connected ${saved.id}, but the search index could not be rebuilt. Call connect_brain again, or push a commit, and it will be indexed.`,
      );
    }

    console.log(JSON.stringify({ level: 'info', at: 'onboarding.create', brain: saved.id }));
    return page(200, 'Your brain is ready', `Connected ${saved.id}. Go back to your client and ask it to search.`);
  } catch (error) {
    const message = error instanceof OnboardingError ? error.message : 'Something went wrong creating the repository. Call create_brain again.';
    if (!(error instanceof OnboardingError)) {
      console.error(JSON.stringify({ level: 'error', at: 'onboarding.create', message: String(error) }));
    }
    return page(400, 'Could not create the brain', message);
  }
}

function page(status: number, title: string, body: string): CallbackResult {
  const html = `<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>`;
  return { status, html };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&#39;';
  });
}

import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { loadConfig } from '../config.js';

let appKit: Octokit | undefined;

/** Octokit authenticated as the GitHub App itself (JWT). */
export function appOctokit(): Octokit {
  if (!appKit) {
    const config = loadConfig();
    appKit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: config.githubAppId, privateKey: config.githubAppPrivateKey },
    });
  }
  return appKit;
}

const installationTokens = new Map<string, { token: string; expiresAt: number }>();

/** Octokit authenticated as one installation, with a cached token. */
export async function installationOctokit(installationId: number | string): Promise<Octokit> {
  const key = String(installationId);
  const cached = installationTokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return new Octokit({ auth: cached.token });
  }

  const config = loadConfig();
  const auth = createAppAuth({
    appId: config.githubAppId,
    privateKey: config.githubAppPrivateKey,
    installationId: Number(installationId),
  });
  const result = await auth({ type: 'installation' });
  installationTokens.set(key, {
    token: result.token,
    expiresAt: new Date(result.expiresAt).getTime(),
  });
  return new Octokit({ auth: result.token });
}

/** The installation covering a repo, or null when the App is not installed on it. */
export async function findInstallationId(owner: string, repo: string): Promise<number | null> {
  try {
    const { data } = await appOctokit().request('GET /repos/{owner}/{repo}/installation', { owner, repo });
    return data.id;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

/** GitHub login for a numeric account id. WorkOS gives us the id, not the login. */
export async function githubLoginForAccountId(accountId: string | number): Promise<string | null> {
  try {
    const { data } = await appOctokit().request('GET /user/{account_id}', {
      account_id: Number(accountId),
    } as never);
    return (data as { login?: string }).login ?? null;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

import { describe, expect, it } from 'vitest';
import { parsePage } from '../src/indexer/parse.js';
import {
  connectBrain,
  explainCreateRepoFailure,
  finishCreateFromCallback,
  listConnectableRepos,
  normalizeRepoName,
  parseRepoSlug,
  repoAttachCanContinue,
  startCreateBrain,
} from '../src/onboarding/flow.js';
import { githubAuthorizeUrl, githubOAuthCallbackUrl, privateRepoBody } from '../src/onboarding/oauth.js';
import { readCreateState, signCreateState, type CreateBrainState } from '../src/onboarding/state.js';
import { STARTER_COMMIT_MESSAGE, starterFiles } from '../src/onboarding/starter.js';
import type { OnboardingIO } from '../src/onboarding/types.js';
import type { BrainRow } from '../src/types.js';

const INSTALL = 'https://github.com/apps/agent-brain/installations/new';
const CALLBACK = 'https://brain.mcpbox.dev/oauth/github/callback';

function brain(partial: Partial<BrainRow> = {}): BrainRow {
  return {
    id: 'ada/notes',
    owner_workos_user_id: 'user_ada',
    owner_github_login: 'ada',
    repo_owner: 'ada',
    repo_name: 'notes',
    default_branch: 'main',
    installation_id: '9',
    profile: {},
    write_modes: {},
    last_indexed_commit: null,
    last_indexed_at: null,
    ...partial,
  };
}

function host(overrides: Partial<OnboardingIO> = {}): OnboardingIO {
  const unexpected = async () => {
    throw new Error('unexpected onboarding call');
  };
  return {
    githubLogin: unexpected,
    installUrl: async () => INSTALL,
    callbackUrl: () => CALLBACK,
    oauthConfigured: () => false,
    mintAuthorizeUrl: () => {
      throw new Error('unexpected authorize');
    },
    readState: () => null,
    userInstallation: unexpected,
    installationForRepo: unexpected,
    canonicalRepo: unexpected,
    findBrainByRepo: async () => null,
    callerCanReadRepo: unexpected,
    headSha: unexpected,
    insertBrain: unexpected,
    indexBrain: unexpected,
    listRepos: unexpected,
    githubLoginForToken: unexpected,
    createPrivateRepo: unexpected,
    attachRepo: unexpected,
    commitFiles: unexpected,
    exchangeCode: unexpected,
    ...overrides,
  };
}

describe('repository names', () => {
  it('parses owner/name and rejects anything else', () => {
    expect(parseRepoSlug('ada/notes')).toEqual({ owner: 'ada', repo: 'notes' });
    expect(parseRepoSlug('  Ada/my.repo  ')).toEqual({ owner: 'Ada', repo: 'my.repo' });
    expect(parseRepoSlug('notes')).toBeNull();
    expect(parseRepoSlug('ada/../secrets')).toBeNull();
    expect(parseRepoSlug('/etc/passwd')).toBeNull();
  });

  it('defaults a created repo to agent-brain', () => {
    expect(normalizeRepoName(undefined)).toBe('agent-brain');
    expect(normalizeRepoName(' Notes ')).toBe('Notes');
    expect(normalizeRepoName('bad name')).toBeNull();
    expect(normalizeRepoName('.hidden')).toBeNull();
    expect(normalizeRepoName('notes.git')).toBeNull();
  });
});

describe('starter repository', () => {
  it('is private, with one claim on the wiki page and none in sources or the readme', () => {
    expect(privateRepoBody('agent-brain')).toMatchObject({
      name: 'agent-brain',
      private: true,
      auto_init: true,
    });

    const files = starterFiles();
    expect(files.map((file) => file.path).sort()).toEqual(['README.md', 'sources/README.md', 'wiki/index.md']);

    const wiki = files.find((file) => file.path === 'wiki/index.md')!;
    const claims = parsePage({
      brainId: 'ada/agent-brain',
      pagePath: wiki.path,
      content: wiki.content,
      sourcesDir: 'sources',
    });
    expect(claims.map((claim) => claim.text)).toEqual(['This brain stores claims as markdown bullets in git.']);

    for (const path of ['README.md', 'sources/README.md']) {
      const file = files.find((item) => item.path === path)!;
      expect(
        parsePage({ brainId: 'ada/agent-brain', pagePath: file.path, content: file.content, sourcesDir: 'sources' }),
      ).toEqual([]);
    }
  });
});

describe('create_brain authorization', () => {
  const secret = 'test-secret';
  const payload: CreateBrainState = {
    purpose: 'create_brain',
    sub: 'user_ada',
    login: 'ada',
    repo: 'agent-brain',
    exp: Date.now() + 60_000,
  };

  it('round-trips a signed state and rejects tampering and expiry', () => {
    const token = signCreateState(payload, secret);
    expect(readCreateState(token, secret)?.sub).toBe('user_ada');
    expect(readCreateState(`${token}x`, secret)).toBeNull();
    expect(readCreateState(token, 'other-secret')).toBeNull();
    expect(readCreateState(token, secret, payload.exp + 1)).toBeNull();
  });

  it('keeps the public MCP path and uses a separate callback', () => {
    expect(githubOAuthCallbackUrl('https://brain.mcpbox.dev/mcp')).toBe(
      'https://brain.mcpbox.dev/oauth/github/callback',
    );
    const url = new URL(githubAuthorizeUrl('client', CALLBACK, 'state-value'));
    expect(url.origin).toBe('https://github.com');
    expect(url.searchParams.get('client_id')).toBe('client');
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(url.searchParams.get('state')).toBe('state-value');
  });

  it('explains a name clash and a missing Administration permission', () => {
    expect(explainCreateRepoFailure(422, 'name already exists')).toContain('connect_brain');
    expect(explainCreateRepoFailure(403, 'Resource not accessible by integration')).toContain('Administration');
    expect(repoAttachCanContinue(422)).toBe(true);
    expect(repoAttachCanContinue(500)).toBe(false);
  });
});

describe('connecting a repository', () => {
  it('refuses when the account has no GitHub identity', async () => {
    const reply = await connectBrain('user_ada', 'ada/notes', host({ githubLogin: async () => null }));
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('Sign in with GitHub');
  });

  it('does not register a repo the caller cannot access, and does not reveal an existing brain', async () => {
    let inserted = false;
    const reply = await connectBrain(
      'user_ada',
      'ada/notes',
      host({
        githubLogin: async () => 'ada',
        installationForRepo: async () => 9,
        canonicalRepo: async () => ({ owner: 'ada', name: 'notes', defaultBranch: 'main' }),
        callerCanReadRepo: async () => false,
        findBrainByRepo: async () => brain({ id: 'secret-brain-id' }),
        insertBrain: async () => {
          inserted = true;
          return null;
        },
      }),
    );
    expect(inserted).toBe(false);
    expect(reply.isError).toBe(true);
    expect(reply.text).not.toContain('secret-brain-id');
    expect(reply.text).toContain(INSTALL);
  });

  it('gives the same kind of answer when the app is not installed', async () => {
    const reply = await connectBrain(
      'user_ada',
      'ada/notes',
      host({
        githubLogin: async () => 'ada',
        installationForRepo: async () => null,
      }),
    );
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('Nothing was registered');
    expect(reply.text).toContain(INSTALL);
  });

  it('says so when the repo is already a brain the caller can read', async () => {
    const reply = await connectBrain(
      'user_ada',
      'ada/notes',
      host({
        githubLogin: async () => 'ada',
        installationForRepo: async () => 9,
        canonicalRepo: async () => ({ owner: 'ada', name: 'notes', defaultBranch: 'main' }),
        callerCanReadRepo: async () => true,
        findBrainByRepo: async () => brain(),
      }),
    );
    expect(reply.text).toContain('Already connected as ada/notes');
    expect(reply.isError).toBeUndefined();
  });

  it('registers and indexes a repo the caller can read', async () => {
    let indexed = '';
    const reply = await connectBrain(
      'user_ada',
      'Ada/Notes',
      host({
        githubLogin: async () => 'ada',
        installationForRepo: async () => 9,
        canonicalRepo: async () => ({ owner: 'ada', name: 'notes', defaultBranch: 'main' }),
        callerCanReadRepo: async (_id, owner, repo, login) => owner === 'ada' && repo === 'notes' && login === 'ada',
        findBrainByRepo: async () => null,
        headSha: async () => 'cafebabe',
        insertBrain: async (input) =>
          brain({
            id: input.id,
            owner_workos_user_id: input.workosUserId,
            repo_owner: input.repoOwner,
            repo_name: input.repoName,
            installation_id: String(input.installationId),
          }),
        indexBrain: async (_brain, sha) => {
          indexed = sha;
        },
      }),
    );

    expect(reply.text).toContain('Connected ada/notes.');
    expect(reply.text).toContain('searchable now');
    expect(reply.text).toContain('review mode');
    expect(indexed).toBe('cafebabe');
    expect(reply.structured).toMatchObject({ brain: 'ada/notes', indexed: true });
  });
});

describe('listing repos to connect', () => {
  it('asks only the caller installation, never a global installation list', async () => {
    const asked: number[] = [];
    const reply = await listConnectableRepos(
      'user_ada',
      host({
        githubLogin: async () => 'ada',
        userInstallation: async (login) => (login === 'ada' ? { id: 5 } : null),
        listRepos: async (installationId) => {
          asked.push(installationId);
          return [
            { owner: 'ada', name: 'notes', private: true },
            { owner: 'ada', name: 'scratch', private: true },
          ];
        },
        findBrainByRepo: async (owner, name) => (name === 'notes' ? brain({ id: `${owner}/${name}` }) : null),
      }),
    );

    expect(asked).toEqual([5]);
    expect(reply.text).toContain('ada/notes (already a brain)');
    expect(reply.text).toContain('ada/scratch');
    expect(reply.text).not.toContain('other-tenant');
  });
});

describe('creating a brain', () => {
  it('tells the caller how to start by hand when one-step creation is not configured', async () => {
    const reply = await startCreateBrain(
      'user_ada',
      undefined,
      host({
        githubLogin: async () => 'ada',
        userInstallation: async () => ({ id: 5 }),
        oauthConfigured: () => false,
      }),
    );

    expect(reply.text).toContain('GITHUB_APP_CLIENT_ID');
    expect(reply.text).toContain('GITHUB_APP_CLIENT_SECRET');
    expect(reply.text).toContain(CALLBACK);
    expect(reply.text).toContain('connect_brain');
    expect(reply.text).toContain('Administration');
    expect(reply.structured).toMatchObject({ oauth_configured: false });
  });

  it('returns an authorize link and does not create a repo yet', async () => {
    let minted = '';
    const reply = await startCreateBrain(
      'user_ada',
      'agent-brain',
      host({
        githubLogin: async () => 'ada',
        userInstallation: async () => ({ id: 5 }),
        oauthConfigured: () => true,
        mintAuthorizeUrl: (state) => {
          minted = `${state.login}/${state.repo}`;
          return `https://github.com/login/oauth/authorize?state=${state.repo}`;
        },
      }),
      1_700_000_000_000,
    );

    expect(minted).toBe('ada/agent-brain');
    expect(reply.text).toContain('https://github.com/login/oauth/authorize?state=agent-brain');
    expect(reply.text).toContain('private repository ada/agent-brain');
  });

  it('does not create a repo when the approving GitHub account is not the one that asked', async () => {
    let created = false;
    const result = await finishCreateFromCallback(
      { code: 'code', state: 'signed' },
      host({
        readState: () => ({
          purpose: 'create_brain',
          sub: 'user_ada',
          login: 'ada',
          repo: 'agent-brain',
          exp: Date.now() + 1000,
        }),
        exchangeCode: async () => 'token',
        githubLoginForToken: async () => 'bob',
        createPrivateRepo: async () => {
          created = true;
          return { id: 1, owner: 'bob', name: 'agent-brain', defaultBranch: 'main' };
        },
      }),
    );

    expect(created).toBe(false);
    expect(result.status).toBe(400);
    expect(result.html).toContain('was not created');
    expect(result.html).toContain('bob');
  });

  it('escapes account names in the callback page', async () => {
    const result = await finishCreateFromCallback(
      { code: 'code', state: 'signed' },
      host({
        readState: () => ({
          purpose: 'create_brain',
          sub: 'user_ada',
          login: 'ada',
          repo: 'agent-brain',
          exp: Date.now() + 1000,
        }),
        exchangeCode: async () => 'token',
        githubLoginForToken: async () => '<script>',
      }),
    );
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.html).not.toContain('<script>');
  });

  it('creates a private repo, commits the starter, registers it, and indexes it', async () => {
    const createdWith: { token?: string; name?: string } = {};
    let files: string[] = [];
    let message = '';
    let indexed = '';

    const result = await finishCreateFromCallback(
      { code: 'code', state: 'signed' },
      host({
        readState: () => ({
          purpose: 'create_brain',
          sub: 'user_ada',
          login: 'ada',
          repo: 'agent-brain',
          exp: Date.now() + 1000,
        }),
        exchangeCode: async () => 'user-token',
        githubLoginForToken: async (token) => (token === 'user-token' ? 'ada' : 'other'),
        createPrivateRepo: async (token, name) => {
          createdWith.token = token;
          createdWith.name = name;
          return { id: 42, owner: 'ada', name, defaultBranch: 'main' };
        },
        userInstallation: async () => ({ id: 5 }),
        attachRepo: async () => undefined,
        commitFiles: async (_installation, _owner, _repo, _branch, seed, commitMessage) => {
          files = seed.map((file) => file.path);
          message = commitMessage;
          return 'startersha';
        },
        insertBrain: async (input) => brain({ id: input.id, owner_workos_user_id: input.workosUserId }),
        indexBrain: async (row, sha) => {
          indexed = `${row.id}@${sha}`;
        },
      }),
    );

    expect(createdWith).toEqual({ token: 'user-token', name: 'agent-brain' });
    expect(files.sort()).toEqual(['README.md', 'sources/README.md', 'wiki/index.md']);
    expect(message).toBe(STARTER_COMMIT_MESSAGE);
    expect(indexed).toBe('ada/agent-brain@startersha');
    expect(result.status).toBe(200);
    expect(result.html).toContain('Connected ada/agent-brain');
  });

  it('rejects an expired or missing link before talking to GitHub', async () => {
    const missing = await finishCreateFromCallback({}, host());
    expect(missing.status).toBe(400);

    const expired = await finishCreateFromCallback(
      { code: 'code', state: 'nope', error: 'access_denied' },
      host(),
    );
    expect(expired.status).toBe(400);
    expect(expired.html).toContain('not created');
  });
});

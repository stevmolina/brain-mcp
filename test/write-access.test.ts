/**
 * Push access, for add_file, and the direct-write path for a brain's owner.
 * Asked of GitHub, never of a list in this database. The GitHub App is mocked;
 * the brain is invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('../src/github/app.js', () => ({
  appOctokit: vi.fn(),
  githubLoginForAccountId: vi.fn(),
  installationOctokit: vi.fn(async () => ({ request })),
}));

// loadConfig() needs these to read the cache TTL; none is a secret.
for (const [name, value] of Object.entries({
  DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
  MCP_RESOURCE_URL: 'https://brain.mcpbox.dev/mcp',
  AUTHKIT_ISSUER: 'https://navigable-desert-09-staging.authkit.app',
  WORKOS_API_KEY: 'test-placeholder',
  WORKOS_CLIENT_ID: 'test-placeholder',
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY_B64: 'Y2k=',
  GITHUB_WEBHOOK_SECRET: 'test-placeholder',
})) {
  process.env[name] ||= value;
}

const { canWriteBrain, clearAccessCaches } = await import('../src/auth/access.js');
import type { BrainRow } from '../src/types.js';

const brain: BrainRow = {
  id: 'write-test/notes',
  owner_workos_user_id: 'user_write_test_owner',
  owner_github_login: 'write-test',
  repo_owner: 'write-test',
  repo_name: 'notes',
  default_branch: 'main',
  installation_id: '42',
  profile: {},
  last_indexed_commit: null,
  last_indexed_at: null,
};

beforeEach(() => {
  request.mockReset();
  clearAccessCaches();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('canWriteBrain', () => {
  it.each([
    ['admin', true],
    ['write', true],
    ['read', false],
    ['none', false],
  ])('GitHub permission %s means write access is %s', async (permission, expected) => {
    request.mockResolvedValue({ data: { permission } });
    expect(await canWriteBrain(brain, 'someone')).toBe(expected);
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/collaborators/{username}/permission', {
      owner: 'write-test',
      repo: 'notes',
      username: 'someone',
    });
  });

  it('denies a login that is not a collaborator', async () => {
    request.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    expect(await canWriteBrain(brain, 'stranger')).toBe(false);
  });

  it('fails closed when GitHub cannot answer', async () => {
    request.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await canWriteBrain(brain, 'someone')).toBe(false);
  });

  it('denies a caller with no linked GitHub login, without asking GitHub', async () => {
    expect(await canWriteBrain(brain, null)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('lets the repo owner write without a lookup', async () => {
    expect(await canWriteBrain(brain, 'Write-Test')).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('caches the answer, and clearing the cache asks again', async () => {
    request.mockResolvedValue({ data: { permission: 'write' } });
    await canWriteBrain(brain, 'someone');
    await canWriteBrain(brain, 'someone');
    expect(request).toHaveBeenCalledTimes(1);
    clearAccessCaches(brain.id);
    await canWriteBrain(brain, 'someone');
    expect(request).toHaveBeenCalledTimes(2);
  });
});

/**
 * Direct writes: owner + `directWrites: true` commits to the default branch;
 * everything else opens a pull request. GitHub is the mocked `request` above.
 */
const { githubLoginForAccountId } = await import('../src/github/app.js');
const { directWriteAllowed } = await import('../src/auth/access.js');
const { landEdit, describeWrite } = await import('../src/tools/write.js');
const { WriteRefused } = await import('../src/github/write.js');
const { resolveProfile } = await import('../src/profiles/index.js');
import type { EditPlan } from '../src/github/write.js';

const PAGE = '# Notes\n\n## Claims\n\n- The first claim.\n';
const OWNER = brain.owner_workos_user_id;

function brainWith(profile: unknown): BrainRow {
  return { ...brain, profile };
}

function plan(page = 'wiki/index.md'): EditPlan {
  return {
    page,
    apply: (content) => `${content}- A new claim.\n`,
    branchPrefix: 'brain/remember',
    title: 'Remember: A new claim.',
    body: 'test',
    commitMessage: `brain: remember a claim in ${page}`,
    details: ['Adds one claim to the page.'],
  };
}

const conflict = () => Object.assign(new Error('sha does not match'), { status: 409 });

/** A tiny fake of the GitHub routes the write path uses. `putToMain` decides each direct PUT. */
function fakeGitHub(
  putToMain: () => unknown = () => ({
    data: { commit: { sha: 'c0ffee1234567', html_url: 'https://github.com/write-test/notes/commit/c0ffee1234567' } },
  }),
  permissions: Record<string, string> = { 'write-test': 'admin', 'a-collaborator': 'write' },
) {
  let blob = 0;
  request.mockImplementation(async (route: string, params: Record<string, unknown>) => {
    switch (route) {
      case 'GET /repos/{owner}/{repo}/collaborators/{username}/permission': {
        const permission = permissions[String(params.username).toLowerCase()];
        if (!permission) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { data: { permission } };
      }
      case 'GET /repos/{owner}/{repo}/contents/{path}':
        blob += 1;
        return { data: { type: 'file', content: Buffer.from(PAGE).toString('base64'), sha: `blob${blob}` } };
      case 'PUT /repos/{owner}/{repo}/contents/{path}':
        if (params.branch === 'main') {
          const outcome = putToMain();
          if (outcome instanceof Error) throw outcome;
          return outcome;
        }
        return { data: { commit: { sha: 'branchcommit' } } };
      case 'GET /repos/{owner}/{repo}/git/ref/{ref}':
        return { data: { object: { sha: 'basesha' } } };
      case 'POST /repos/{owner}/{repo}/git/refs':
        return { data: {} };
      case 'POST /repos/{owner}/{repo}/pulls':
        return { data: { html_url: 'https://github.com/write-test/notes/pull/7', number: 7 } };
      default:
        throw new Error(`unexpected route ${route}`);
    }
  });
}

const routes = () => request.mock.calls.map(([route]) => route as string);
const mainPuts = () =>
  request.mock.calls.filter(
    ([route, params]) =>
      route === 'PUT /repos/{owner}/{repo}/contents/{path}' && (params as { branch?: string }).branch === 'main',
  );

/** A caller whose WorkOS id is not the owner's, linked to `login` on GitHub. */
function linkedTo(login: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ provider: 'GitHubOAuth', idp_id: '99' }]))));
  vi.mocked(githubLoginForAccountId).mockResolvedValue(login);
}

describe('the directWrites switch', () => {
  it('is off by default and only a literal true turns it on', () => {
    expect(resolveProfile({}).directWrites).toBe(false);
    expect(resolveProfile({ directWrites: 'true' }).directWrites).toBe(false);
    expect(resolveProfile({ directWrites: 1 }).directWrites).toBe(false);
    expect(resolveProfile({ directWrites: true }).directWrites).toBe(true);
  });

  it('allows only the owner, only with the switch on, and only if GitHub says they can push', async () => {
    fakeGitHub();
    const on = brainWith({ directWrites: true });
    expect(await directWriteAllowed(on, OWNER, 'write-test')).toBe(true);
    expect(await directWriteAllowed(on, 'user_other', 'WRITE-TEST')).toBe(true);
    expect(await directWriteAllowed(on, 'user_other', 'a-collaborator')).toBe(false);
    expect(await directWriteAllowed(on, 'user_other', null)).toBe(false);
    // The registered owner with no linked GitHub login cannot be checked, so no.
    expect(await directWriteAllowed(on, OWNER, null)).toBe(false);
    expect(await directWriteAllowed(brainWith({}), OWNER, 'write-test')).toBe(false);
  });

  it('asks GitHub even for the owner: lost push access means no direct write', async () => {
    fakeGitHub(undefined, { 'write-test': 'read' });
    expect(await directWriteAllowed(brainWith({ directWrites: true }), OWNER, 'write-test')).toBe(false);
  });
});

describe('landEdit', () => {
  it('owner with the switch on: one commit on main, guarded by the blob sha, no PR', async () => {
    fakeGitHub();
    linkedTo('write-test');
    const result = await landEdit(brainWith({ directWrites: true }), plan(), {
      workosUserId: OWNER,
      agent: 'claude-code/2.1',
    });
    expect(result).toMatchObject({
      mode: 'commit',
      commit: { sha: 'c0ffee1234567', branch: 'main', page: 'wiki/index.md' },
    });
    expect(mainPuts()).toHaveLength(1);
    const put = mainPuts()[0]![1] as { sha: string; message: string; content: string };
    expect(put.sha).toBe('blob1');
    expect(put.message).toContain('Committed directly by brain-mcp for write-test via claude-code/2.1');
    expect(put.message).toContain('Adds one claim to the page.');
    expect(Buffer.from(put.content, 'base64').toString()).toContain('- A new claim.');
    expect(routes()).not.toContain('POST /repos/{owner}/{repo}/pulls');
    expect(routes()).not.toContain('POST /repos/{owner}/{repo}/git/refs');
    expect(describeWrite(result, { committed: 'Committed.', proposed: 'Proposed.' })).toContain(
      'Committed to main c0ffee1 https://github.com/write-test/notes/commit/c0ffee1234567',
    );
  });

  it('owner by GitHub login (another WorkOS user) with the switch on: direct commit', async () => {
    fakeGitHub();
    linkedTo('Write-Test');
    const result = await landEdit(brainWith({ directWrites: true }), plan(), { workosUserId: 'user_second_login' });
    expect(result.mode).toBe('commit');
  });

  it('owner with the switch off: a pull request, nothing on main, no identity lookup', async () => {
    fakeGitHub();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await landEdit(brainWith({}), plan(), { workosUserId: OWNER });
    expect(result.mode).toBe('pull_request');
    expect(mainPuts()).toHaveLength(0);
    expect(routes()).toContain('POST /repos/{owner}/{repo}/pulls');
    expect(describeWrite(result, { committed: 'Committed.', proposed: 'Proposed.' })).toContain(
      'Opened PR https://github.com/write-test/notes/pull/7',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('owner who lost push access on GitHub, switch on: a pull request', async () => {
    fakeGitHub(undefined, { 'write-test': 'read' });
    linkedTo('write-test');
    const result = await landEdit(brainWith({ directWrites: true }), plan(), { workosUserId: OWNER });
    expect(result.mode).toBe('pull_request');
    expect(mainPuts()).toHaveLength(0);
  });

  it('a collaborator who is not the owner, switch on: a pull request', async () => {
    fakeGitHub();
    linkedTo('a-collaborator');
    const result = await landEdit(brainWith({ directWrites: true }), plan(), { workosUserId: 'user_collaborator' });
    expect(result.mode).toBe('pull_request');
    expect(mainPuts()).toHaveLength(0);
  });

  it('a conflict re-reads the page and retries once', async () => {
    let n = 0;
    fakeGitHub(() => (++n === 1 ? conflict() : { data: { commit: { sha: 'second', html_url: 'u' } } }));
    linkedTo('write-test');
    const result = await landEdit(brainWith({ directWrites: true }), plan(), { workosUserId: OWNER });
    expect(result).toMatchObject({ mode: 'commit', commit: { sha: 'second' } });
    expect(mainPuts().map(([, p]) => (p as { sha: string }).sha)).toEqual(['blob1', 'blob2']);
  });

  it('a second conflict falls back to a pull request and says so', async () => {
    fakeGitHub(() => Object.assign(new Error('Unprocessable'), { status: 422 }));
    linkedTo('write-test');
    const result = await landEdit(brainWith({ directWrites: true }), plan(), { workosUserId: OWNER });
    expect(result.mode).toBe('pull_request');
    expect(mainPuts()).toHaveLength(2);
    expect(routes()).toContain('POST /repos/{owner}/{repo}/pulls');
    const text = describeWrite(result, { committed: 'Committed.', proposed: 'Proposed.' });
    expect(text).toContain('opened a pull request instead');
    expect(text).toContain('Opened PR');
  });

  it('any other GitHub error is not swallowed into a PR', async () => {
    fakeGitHub(() => Object.assign(new Error('Server Error'), { status: 500 }));
    linkedTo('write-test');
    await expect(landEdit(brainWith({ directWrites: true }), plan(), { workosUserId: OWNER })).rejects.toThrow(
      'Server Error',
    );
    expect(routes()).not.toContain('POST /repos/{owner}/{repo}/pulls');
  });

  it('still refuses sources/, non-markdown and .. in direct mode, before calling GitHub', async () => {
    fakeGitHub();
    linkedTo('write-test');
    for (const page of ['sources/2026-01-01-email.md', 'wiki/data.json', 'wiki/../../etc.md']) {
      await expect(
        landEdit(brainWith({ directWrites: true }), plan(page), { workosUserId: OWNER }),
      ).rejects.toBeInstanceOf(WriteRefused);
    }
    expect(mainPuts()).toHaveLength(0);
    expect(routes()).not.toContain('GET /repos/{owner}/{repo}/contents/{path}');
  });

  it('still refuses a change that is already the state of the page', async () => {
    fakeGitHub();
    linkedTo('write-test');
    const noop = { ...plan(), apply: (content: string) => content };
    await expect(landEdit(brainWith({ directWrites: true }), noop, { workosUserId: OWNER })).rejects.toThrow(
      /already the state/,
    );
    expect(mainPuts()).toHaveLength(0);
  });
});

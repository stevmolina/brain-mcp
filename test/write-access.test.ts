/**
 * Push access, for add_file. Asked of GitHub, never of a list in this database.
 * The GitHub App is mocked; the brain is invented.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

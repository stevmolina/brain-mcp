import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditPlan } from '../src/github/write.js';
import type { BrainRow } from '../src/types.js';
import { auditCommitMessage, executeWrite, type WriteIO } from '../src/writes/execute.js';
import {
  assertCanEditModes,
  DEFAULT_WRITE_MODES,
  describeWriteModes,
  resolveWriteModes,
  withWriteMode,
} from '../src/writes/modes.js';
import { ToolRefusal } from '../src/tools/shared.js';

function brain(write_modes: unknown, owner = 'user_ada'): BrainRow {
  return {
    id: 'ada/notes',
    owner_workos_user_id: owner,
    owner_github_login: 'ada',
    repo_owner: 'ada',
    repo_name: 'notes',
    default_branch: 'main',
    installation_id: '9',
    profile: {},
    write_modes,
    last_indexed_commit: null,
    last_indexed_at: null,
  };
}

const plan: EditPlan = {
  page: 'wiki/index.md',
  apply: (content) => content,
  branchPrefix: 'brain/remember',
  title: 'Remember: hi',
  body: 'body',
  commitMessage: 'brain: remember in wiki/index.md\n\nProduction runs in one account.\n\nRequested by user_ada',
};

function io(overrides: Partial<WriteIO> = {}): WriteIO {
  return {
    openPullRequest: async () => {
      throw new Error('openPullRequest should not have been called');
    },
    commitToDefaultBranch: async () => {
      throw new Error('commitToDefaultBranch should not have been called');
    },
    indexAtCommit: async () => {
      throw new Error('indexAtCommit should not have been called');
    },
    ...overrides,
  };
}

describe('write mode defaults', () => {
  it('treats a missing, empty, or junk value as review for every action', () => {
    for (const stored of [undefined, null, {}, [], 'review', { remember: 'yolo', extra: 'auto' }]) {
      expect(resolveWriteModes(stored)).toEqual(DEFAULT_WRITE_MODES);
    }
  });

  it('keeps a valid per-action override and ignores the rest', () => {
    expect(resolveWriteModes({ remember: 'auto', forget: 'read_only', update_fact: 'nope' })).toEqual({
      remember: 'auto',
      update_fact: 'review',
      forget: 'read_only',
    });
  });

  it('patches one action without resetting the others', () => {
    expect(withWriteMode({ remember: 'auto' }, { forget: 'read_only' })).toEqual({
      remember: 'auto',
      update_fact: 'review',
      forget: 'read_only',
    });
  });
});

describe('who can change modes', () => {
  it('lets the owner through', () => {
    expect(() => assertCanEditModes(brain({}), 'user_ada')).not.toThrow();
  });

  it('refuses anyone else', () => {
    expect(() => assertCanEditModes(brain({}), 'user_collaborator')).toThrow(ToolRefusal);
    expect(() => assertCanEditModes(brain({}), 'user_collaborator')).toThrow(/Only the owner of ada\/notes/);
  });
});

describe('what a write tells the caller', () => {
  it('refuses read_only before any git call', async () => {
    await expect(
      executeWrite(brain({ remember: 'read_only' }), 'remember', plan, io(), 'New claim.'),
    ).rejects.toThrow('Not saved. remember on ada/notes is read_only. The owner can change it with set_write_mode.');
  });

  it('proposes a pull request in review mode, which is the default', async () => {
    const outcome = await executeWrite(
      brain({}),
      'remember',
      plan,
      io({
        openPullRequest: async () => ({
          url: 'https://github.com/ada/notes/pull/12',
          number: 12,
          branch: 'brain/remember-ab',
          page: 'wiki/index.md',
        }),
      }),
      'New claim in ada/notes.',
    );

    expect(outcome.text).toContain('Proposed as PR #12. Approve to save.');
    expect(outcome.text).toContain('https://github.com/ada/notes/pull/12');
    expect(outcome.text).toContain('Not recorded yet.');
    expect(outcome.text.startsWith('Saved.')).toBe(false);
    expect(outcome.structured).toMatchObject({ mode: 'review', recorded: false, saved_to_git: false });
  });

  it('commits and reindexes in auto mode, and says it was saved', async () => {
    let indexed = '';
    const outcome = await executeWrite(
      brain({ remember: 'auto' }),
      'remember',
      plan,
      io({
        commitToDefaultBranch: async (_brain, got) => {
          expect(got.commitMessage).toBe(plan.commitMessage);
          return {
            sha: 'abc123',
            url: 'https://github.com/ada/notes/commit/abc123',
            page: 'wiki/index.md',
            message: got.commitMessage,
          };
        },
        indexAtCommit: async (_brain, sha) => {
          indexed = sha;
        },
      }),
      'New claim in ada/notes.',
    );

    expect(outcome.text.startsWith('Saved.')).toBe(true);
    expect(outcome.text).toContain('https://github.com/ada/notes/commit/abc123');
    expect(outcome.text).toContain('Searchable now.');
    expect(outcome.text).toContain('Revert it by reverting the commit');
    expect(outcome.text).not.toContain('Proposed as PR');
    expect(indexed).toBe('abc123');
    expect(outcome.structured).toMatchObject({ mode: 'auto', recorded: true, saved_to_git: true });
  });

  it('still reports the git commit when the index rebuild fails', async () => {
    const outcome = await executeWrite(
      brain({ update_fact: 'auto' }),
      'update_fact',
      plan,
      io({
        commitToDefaultBranch: async () => ({
          sha: 'def456',
          url: 'https://github.com/ada/notes/commit/def456',
          page: 'wiki/index.md',
          message: 'brain: update_fact in wiki/index.md',
        }),
        indexAtCommit: async () => {
          throw new Error('index down');
        },
      }),
      'Update a claim.',
    );

    expect(outcome.text.startsWith('Saved.')).toBe(true);
    expect(outcome.text).toContain('could not be rebuilt');
    expect(outcome.text).toContain('index down');
    expect(outcome.structured).toMatchObject({ saved_to_git: true, recorded: false });
  });
});

describe('audit trail on the commit', () => {
  it('names the action, the page, the claim, and who asked', () => {
    expect(auditCommitMessage('remember', 'wiki/index.md', 'Production runs in one account.', 'user_ada')).toBe(
      'brain: remember in wiki/index.md\n\nProduction runs in one account.\n\nRequested by user_ada',
    );
  });
});

describe('settings copy', () => {
  it('lists every action and what the three modes mean', () => {
    const text = describeWriteModes('ada/notes', { remember: 'auto' });
    expect(text).toContain('remember: auto');
    expect(text).toContain('update_fact: review');
    expect(text).toContain('forget: review');
    expect(text).toContain('set_write_mode');
  });
});

describe('write modes survive in the database', () => {
  const id = 'modes-test/gamma';

  beforeAll(async () => {
    const { migrate } = await import('../src/db/migrate.js');
    const { db } = await import('../src/db/client.js');
    await migrate();
    await db().query('delete from brains where id = $1', [id]);
    await db().query(
      `insert into brains (id, owner_workos_user_id, owner_github_login, repo_owner, repo_name, default_branch)
       values ($1, 'user_modes', 'modes-test', 'modes-test', 'gamma', 'main')`,
      [id],
    );
  });

  afterAll(async () => {
    const { db, closeDb } = await import('../src/db/client.js');
    await db().query('delete from brains where id = $1', [id]);
    await closeDb();
  });

  it('defaults an existing row to review for every action', async () => {
    const { db } = await import('../src/db/client.js');
    const { rows } = await db().query<{ write_modes: unknown }>('select write_modes from brains where id = $1', [id]);
    expect(rows).toHaveLength(1);
    expect(resolveWriteModes(rows[0]?.write_modes)).toEqual(DEFAULT_WRITE_MODES);
  });

  it('stores a per-action choice and reads it back', async () => {
    const { saveWriteModes } = await import('../src/tools/settings.js');
    const { db } = await import('../src/db/client.js');
    await saveWriteModes(id, { remember: 'auto', update_fact: 'review', forget: 'read_only' });
    const { rows } = await db().query<{ write_modes: unknown }>('select write_modes from brains where id = $1', [id]);
    expect(rows).toHaveLength(1);
    expect(resolveWriteModes(rows[0]?.write_modes)).toEqual({
      remember: 'auto',
      update_fact: 'review',
      forget: 'read_only',
    });
  });
});

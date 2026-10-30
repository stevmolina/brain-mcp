/**
 * Private files per brain. The bucket is faked in memory behind
 * aws-sdk-client-mock, with real prefix filtering and real If-None-Match
 * semantics, so isolation and add-only are tested against behaviour rather than
 * against which calls were made. Both brains are invented.
 */
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadR2Config } from '../src/config.js';
import { brainPrefix, FileRefused, objectKey, validateFolder, validatePath } from '../src/files/paths.js';
import { BrainFiles, INLINE_TEXT_MAX_BYTES, INLINE_UPLOAD_MAX_BYTES, r2Client } from '../src/files/store.js';
import { Forbidden } from '../src/auth/access.js';
import { fileToolHandlers, type FileAccess } from '../src/tools/files.js';
import type { BrainRow } from '../src/types.js';

const A = 'files-test/alpha';
const B = 'files-test/beta';
const BUCKET = 'brain-files-test';

interface Stored {
  body: Buffer;
  lastModified: Date;
  contentType?: string;
}

const s3 = mockClient(S3Client);
let objects: Map<string, Stored>;

function s3Error(name: string, status: number): S3ServiceException {
  return new S3ServiceException({ name, $fault: 'client', $metadata: { httpStatusCode: status }, message: name });
}

/** A bucket in memory: lists by prefix in key order, refuses a conditional put on an existing key. */
function fakeBucket() {
  objects = new Map();
  s3.reset();
  s3.on(ListObjectsV2Command).callsFake((input) => {
    expect(input.Bucket).toBe(BUCKET);
    const keys = [...objects.keys()].filter((k) => k.startsWith(input.Prefix ?? '')).sort();
    const start = input.ContinuationToken ? keys.findIndex((k) => k > input.ContinuationToken!) : 0;
    const page = start === -1 ? [] : keys.slice(start, start + (input.MaxKeys ?? 1000));
    const truncated = start !== -1 && start + page.length < keys.length;
    return {
      Contents: page.map((Key) => ({ Key, Size: objects.get(Key)!.body.byteLength, LastModified: objects.get(Key)!.lastModified })),
      IsTruncated: truncated,
      NextContinuationToken: truncated ? page[page.length - 1] : undefined,
    };
  });
  s3.on(HeadObjectCommand).callsFake((input) => {
    const hit = objects.get(input.Key!);
    if (!hit) throw s3Error('NotFound', 404);
    return { ContentLength: hit.body.byteLength, LastModified: hit.lastModified, ContentType: hit.contentType };
  });
  s3.on(GetObjectCommand).callsFake((input) => {
    const hit = objects.get(input.Key!);
    if (!hit) throw s3Error('NoSuchKey', 404);
    return { Body: { transformToString: async () => hit.body.toString('utf8') } };
  });
  s3.on(PutObjectCommand).callsFake((input) => {
    if (input.IfNoneMatch === '*' && objects.has(input.Key!)) throw s3Error('PreconditionFailed', 412);
    objects.set(input.Key!, {
      body: Buffer.from(input.Body as Buffer),
      lastModified: new Date('2026-09-01T00:00:00Z'),
      contentType: input.ContentType,
    });
    return {};
  });
}

const client = r2Client({
  accountId: '0123456789abcdef0123456789abcdef',
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret',
  bucket: BUCKET,
});
const files = new BrainFiles(client, BUCKET);

beforeEach(() => {
  fakeBucket();
});

describe('paths', () => {
  it('keys a file under its brain id', () => {
    expect(objectKey(A, 'inputs/2026-09-01-x.xlsx')).toBe('files-test/alpha/inputs/2026-09-01-x.xlsx');
  });

  it.each([
    ['../beta/secret.txt', '..'],
    ['inputs/../../beta/x', '..'],
    ['/etc/passwd', 'absolute'],
    ['inputs//x.csv', 'empty segment'],
    ['inputs/', 'empty segment'],
    ['./x.csv', '"."'],
    ['inputs\\x.csv', 'backslash'],
    ['bad\u0000name', 'control'],
    ['', 'required'],
  ])('refuses %j (%s)', (path) => {
    expect(() => validatePath(path)).toThrow(FileRefused);
  });

  it('accepts ordinary relative paths', () => {
    expect(validatePath('inputs/2026-09-01 report (v2).xlsx')).toBe('inputs/2026-09-01 report (v2).xlsx');
    expect(validateFolder('inputs/')).toBe('inputs/');
    expect(validateFolder(undefined)).toBe('');
  });

  it('gives a file space only to owner/repo brain ids, so one key cannot belong to two brains', () => {
    expect(brainPrefix(A)).toBe(`${A}/`);
    for (const id of ['solo', 'a/b/c', '../x', 'a/..', '']) {
      expect(() => brainPrefix(id), id).toThrow(FileRefused);
    }
  });
});

describe('config', () => {
  it('is null unless all four R2 variables are set, so the server starts without them', () => {
    const full = { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_BUCKET: 'd' };
    expect(loadR2Config(full)).toEqual({ accountId: 'a', accessKeyId: 'b', secretAccessKey: 'c', bucket: 'd' });
    expect(loadR2Config({ ...full, R2_BUCKET: '' })).toBeNull();
    expect(loadR2Config({})).toBeNull();
  });
});

describe('listing', () => {
  it('lists a brain\'s files with path, size and last modified, relative to the brain', async () => {
    await files.add(A, 'inputs/one.csv', Buffer.from('a,b\n1,2\n'));
    await files.add(A, 'notes/two.md', Buffer.from('# Two\n'));
    const listing = await files.list(A);
    expect(listing.next_cursor).toBeNull();
    expect(listing.files).toEqual([
      { path: 'inputs/one.csv', size: 8, last_modified: '2026-09-01T00:00:00.000Z' },
      { path: 'notes/two.md', size: 6, last_modified: '2026-09-01T00:00:00.000Z' },
    ]);
  });

  it('narrows to a folder', async () => {
    await files.add(A, 'inputs/one.csv', Buffer.from('x'));
    await files.add(A, 'notes/two.md', Buffer.from('y'));
    expect((await files.list(A, { folder: 'inputs' })).files.map((f) => f.path)).toEqual(['inputs/one.csv']);
  });

  it('pages with a cursor', async () => {
    for (const n of [1, 2, 3]) await files.add(A, `inputs/${n}.txt`, Buffer.from(String(n)));
    const first = await files.list(A, { limit: 2 });
    expect(first.files.map((f) => f.path)).toEqual(['inputs/1.txt', 'inputs/2.txt']);
    expect(first.next_cursor).not.toBeNull();
    const second = await files.list(A, { limit: 2, cursor: first.next_cursor! });
    expect(second.files.map((f) => f.path)).toEqual(['inputs/3.txt']);
    expect(second.next_cursor).toBeNull();
  });
});

describe('get_file', () => {
  it('returns metadata, a presigned download URL of about 15 minutes, and small text inline', async () => {
    await files.add(A, 'inputs/one.csv', Buffer.from('a,b\n1,2\n'));
    const result = await files.get(A, 'inputs/one.csv');
    expect(result.file).toMatchObject({ path: 'inputs/one.csv', size: 8, content_type: 'text/csv; charset=utf-8' });
    expect(result.text).toBe('a,b\n1,2\n');
    expect(result.expires_in_seconds).toBe(900);

    const url = new URL(result.download_url);
    expect(url.host).toBe('0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com');
    expect(decodeURIComponent(url.pathname)).toBe(`/${BUCKET}/${A}/inputs/one.csv`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns no inline text for a binary or a big text file', async () => {
    await files.add(A, 'inputs/sheet.xlsx', Buffer.from('PK binary'));
    await files.add(A, 'inputs/big.csv', Buffer.alloc(INLINE_TEXT_MAX_BYTES + 1, 'x'));
    expect((await files.get(A, 'inputs/sheet.xlsx')).text).toBeUndefined();
    expect((await files.get(A, 'inputs/big.csv')).text).toBeUndefined();
  });

  it('refuses a file that is not there', async () => {
    await expect(files.get(A, 'inputs/missing.csv')).rejects.toThrow(/No file inputs\/missing.csv/);
  });
});

describe('add_file is add-only', () => {
  it('stores with a conditional put', async () => {
    const result = await files.add(A, 'inputs/one.csv', Buffer.from('v1'));
    expect(result.status).toBe('stored');
    const put = s3.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(put).toMatchObject({ Key: `${A}/inputs/one.csv`, IfNoneMatch: '*' });
  });

  it('refuses a path that already exists and leaves the first file untouched', async () => {
    await files.add(A, 'inputs/one.csv', Buffer.from('v1'));
    await expect(files.add(A, 'inputs/one.csv', Buffer.from('v2'))).rejects.toThrow(/already exists.*add-only/);
    expect(objects.get(`${A}/inputs/one.csv`)!.body.toString()).toBe('v1');
  });

  it('refuses inline content over 10 MB', async () => {
    await expect(files.add(A, 'inputs/huge.bin', Buffer.alloc(INLINE_UPLOAD_MAX_BYTES + 1))).rejects.toThrow(
      /upload URL/,
    );
    expect(objects.size).toBe(0);
  });

  it('without content, returns a presigned PUT that signs If-None-Match, so the upload cannot overwrite', async () => {
    const result = await files.add(A, 'inputs/big.zip');
    expect(result.status).toBe('upload_url');
    if (result.status !== 'upload_url') return;
    expect(result.required_headers).toEqual({ 'Content-Type': 'application/zip', 'If-None-Match': '*' });
    const url = new URL(result.upload_url);
    expect(decodeURIComponent(url.pathname)).toContain(`${A}/inputs/big.zip`);
    expect(url.searchParams.get('X-Amz-SignedHeaders')!.split(';')).toEqual(
      expect.arrayContaining(['content-type', 'if-none-match']),
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    // Presigning is local: nothing was written.
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('refuses an upload URL for a path that already exists', async () => {
    await files.add(A, 'inputs/big.zip', Buffer.from('zip'));
    await expect(files.add(A, 'inputs/big.zip')).rejects.toThrow(/already exists/);
  });

  it('putNew reports an existing path instead of overwriting', async () => {
    expect(await files.putNew(A, 'x.txt', Buffer.from('1'))).toBe('stored');
    expect(await files.putNew(A, 'x.txt', Buffer.from('2'))).toBe('exists');
    expect(objects.get(`${A}/x.txt`)!.body.toString()).toBe('1');
  });
});

describe('a brain-A file asked for while scoped to brain-B', () => {
  beforeEach(async () => {
    await files.add(A, 'inputs/secret.csv', Buffer.from('alpha only'));
    await files.add(B, 'inputs/public.csv', Buffer.from('beta'));
  });

  it('does not appear in brain-B\'s listing', async () => {
    const listing = await files.list(B);
    expect(listing.files.map((f) => f.path)).toEqual(['inputs/public.csv']);
  });

  it('cannot be fetched by its path', async () => {
    await expect(files.get(B, 'inputs/secret.csv')).rejects.toThrow(FileRefused);
    await expect(files.get(B, '../alpha/inputs/secret.csv')).rejects.toThrow(FileRefused);
  });

  it('cannot be reached by passing brain-A\'s cursor', async () => {
    await files.add(A, 'inputs/zzz.csv', Buffer.from('alpha'));
    const listing = await files.list(B, { cursor: `${A}/inputs/secret.csv` });
    expect(listing.files.every((f) => f.path === 'inputs/public.csv')).toBe(true);
  });

  it('is not overwritten by brain-B adding the same relative path', async () => {
    await files.add(B, 'inputs/secret.csv', Buffer.from('beta copy'));
    expect(objects.get(`${A}/inputs/secret.csv`)!.body.toString()).toBe('alpha only');
  });
});

describe('the tools resolve the brain before touching files', () => {
  const brainRow = (id: string): BrainRow => ({
    id,
    owner_workos_user_id: 'user_files_test',
    owner_github_login: 'files-test',
    repo_owner: id.split('/')[0]!,
    repo_name: id.split('/')[1]!,
    default_branch: 'main',
    installation_id: null,
    profile: {},
    last_indexed_commit: null,
    last_indexed_at: null,
  });

  /** Reader of B only, writer of nothing. */
  const calls: string[] = [];
  const access: FileAccess = {
    read: async (_user, brain) => {
      calls.push(`read:${brain}`);
      if (brain !== B) throw new Forbidden(`No brain "${brain}" is available to you.`);
      return brainRow(B);
    },
    write: async (_user, brain) => {
      calls.push(`write:${brain}`);
      throw new Forbidden(`You can read ${brain} but not write to it: adding files needs push access to its repo.`);
    },
  };
  const tools = fileToolHandlers(files, access);

  beforeEach(async () => {
    calls.length = 0;
    await files.add(A, 'inputs/secret.csv', Buffer.from('alpha only'));
  });

  it('list_files and get_file check read access, add_file checks write access', async () => {
    await tools.list_files({ brain: B, limit: 100 }, 'user_reader');
    await tools.get_file({ brain: B, path: 'inputs/x.csv' }, 'user_reader').catch(() => undefined);
    await tools.add_file({ brain: B, path: 'inputs/x.csv', content: 'eA==' }, 'user_reader').catch(() => undefined);
    expect(calls).toEqual([`read:${B}`, `read:${B}`, `write:${B}`]);
    expect(objects.has(`${B}/inputs/x.csv`)).toBe(false);
  });

  it('refuses a brain the caller cannot read, before any bucket call', async () => {
    s3.resetHistory();
    await expect(tools.list_files({ brain: A, limit: 100 }, 'user_reader')).rejects.toBeInstanceOf(Forbidden);
    await expect(tools.get_file({ brain: A, path: 'inputs/secret.csv' }, 'user_reader')).rejects.toBeInstanceOf(
      Forbidden,
    );
    expect(s3.calls()).toHaveLength(0);
  });

  it('add_file decodes base64 content and stores it for a writer', async () => {
    const writer = fileToolHandlers(files, { read: async () => brainRow(B), write: async () => brainRow(B) });
    const result = await writer.add_file(
      { brain: B, path: 'inputs/hello.txt', content: Buffer.from('hello').toString('base64') },
      'user_writer',
    );
    expect(result.structuredContent).toMatchObject({ brain: B, status: 'stored' });
    expect(objects.get(`${B}/inputs/hello.txt`)!.body.toString()).toBe('hello');
  });

  it('add_file refuses content that is not base64', async () => {
    const writer = fileToolHandlers(files, { read: async () => brainRow(B), write: async () => brainRow(B) });
    await expect(
      writer.add_file({ brain: B, path: 'inputs/x.txt', content: 'not base64!' }, 'user_writer'),
    ).rejects.toThrow(FileRefused);
  });
});

describe('registration', () => {
  const R2 = { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'bucket' };

  async function toolNames(env: Record<string, string | undefined>): Promise<string[]> {
    const saved = Object.fromEntries(Object.keys(R2).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      vi.resetModules();
      const { buildServer } = await import('../src/tools/index.js');
      // Private field, read only here: the tool list is what the test is about.
      const server = buildServer({ version: 'test' }) as unknown as { _registeredTools: Record<string, unknown> };
      return Object.keys(server._registeredTools).sort();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('leaves the file tools out when R2 is not configured', async () => {
    const names = await toolNames(Object.fromEntries(Object.keys(R2).map((k) => [k, undefined])));
    expect(names).toContain('search');
    expect(names).not.toContain('add_file');
  });

  it('registers list_files, get_file and add_file, and no overwrite or delete, when R2 is configured', async () => {
    const names = await toolNames(R2);
    expect(names).toEqual(expect.arrayContaining(['list_files', 'get_file', 'add_file']));
    expect(names.filter((n) => /file/.test(n)).sort()).toEqual(['add_file', 'get_file', 'list_files']);
  });
});

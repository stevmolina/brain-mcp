/**
 * Reading a brain repo at a commit.
 *
 * The indexer pulls a tarball rather than shelling out to git: no working copy on
 * the box, no credentials on disk, and a full rebuild is one HTTP request.
 */
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { extract } from 'tar-stream';
import type { Octokit } from '@octokit/rest';

export interface RepoFile {
  /** Path relative to the repo root. */
  path: string;
  bytes: number;
  sha256: string;
  /** Present only for text files under the size cap. */
  text?: string;
}

const MAX_TEXT_BYTES = 1_000_000;

export async function resolveCommit(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<string> {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', { owner, repo, ref });
  return data.sha;
}

export async function defaultBranch(octokit: Octokit, owner: string, repo: string): Promise<string> {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
  return data.default_branch;
}

/** Every file in the repo at `commit`, keyed by repo-relative path. */
export async function fetchRepoFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  commit: string,
): Promise<Map<string, RepoFile>> {
  const response = await octokit.request('GET /repos/{owner}/{repo}/tarball/{ref}', {
    owner,
    repo,
    ref: commit,
    request: { parseSuccessResponseBody: false },
  });

  const files = new Map<string, RepoFile>();
  const tar = extract();

  tar.on('entry', (header, stream, next) => {
    if (header.type !== 'file') {
      stream.on('end', next);
      stream.resume();
      return;
    }
    // The tarball root is "<owner>-<repo>-<sha>/"; drop it.
    const path = header.name.split('/').slice(1).join('/');
    const chunks: Buffer[] = [];
    let bytes = 0;
    const hash = createHash('sha256');

    stream.on('data', (data: unknown) => {
      const chunk = data as Buffer;
      bytes += chunk.length;
      hash.update(chunk);
      if (bytes <= MAX_TEXT_BYTES) chunks.push(chunk);
    });
    stream.on('end', () => {
      if (path) {
        const buffer = Buffer.concat(chunks);
        const file: RepoFile = { path, bytes, sha256: hash.digest('hex') };
        if (bytes <= MAX_TEXT_BYTES && !buffer.includes(0)) file.text = buffer.toString('utf8');
        files.set(path, file);
      }
      next();
    });
    stream.on('error', next);
    stream.resume();
  });

  await pipeline(toNodeStream(response.data), createGunzip(), tar);
  return files;
}

/** Octokit hands back a web ReadableStream on modern Node and a Node stream elsewhere. */
function toNodeStream(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof (body as ReadableStream).getReader === 'function') {
    return Readable.fromWeb(body as never);
  }
  return Readable.from(body as never);
}

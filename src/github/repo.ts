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

export interface PageCommit {
  sha: string;
  at: string;
}

/**
 * The last commit that touched each path, as of `commit`. One GraphQL request
 * per 40 paths instead of one REST request per path. Best effort: a page this
 * cannot date gets no entry, and the caller indexes it undated.
 */
export async function lastCommitPerPath(
  octokit: Octokit,
  owner: string,
  repo: string,
  commit: string,
  paths: string[],
): Promise<Map<string, PageCommit>> {
  const out = new Map<string, PageCommit>();
  for (let start = 0; start < paths.length; start += 40) {
    const batch = paths.slice(start, start + 40);
    const fields = batch
      .map((_, i) => `p${i}: history(first: 1, path: $path${i}) { nodes { oid committedDate } }`)
      .join('\n');
    const variables: Record<string, string> = { owner, repo, commit };
    batch.forEach((path, i) => {
      variables[`path${i}`] = path;
    });
    const query = `query(${['$owner: String!', '$repo: String!', '$commit: String!', ...batch.map((_, i) => `$path${i}: String!`)].join(', ')}) {
      repository(owner: $owner, name: $repo) {
        object(expression: $commit) { ... on Commit { ${fields} } }
      }
    }`;
    type Answer = { repository: { object: Record<string, { nodes: Array<{ oid: string; committedDate: string }> }> | null } };
    // One failed batch leaves its 40 pages undated, not the whole brain. One
    // retry covers a passing 502 or secondary rate limit.
    let data: Answer | undefined;
    for (let attempt = 0; attempt < 2 && !data; attempt++) {
      try {
        data = await octokit.graphql<Answer>(query, variables);
      } catch (error) {
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
        else console.error(JSON.stringify({ level: 'warn', at: 'repo.lastCommitPerPath', repo: `${owner}/${repo}`, first: batch[0], message: String(error) }));
      }
    }
    const object = data?.repository.object ?? {};
    batch.forEach((path, i) => {
      const node = object[`p${i}`]?.nodes[0];
      if (node) out.set(path, { sha: node.oid, at: node.committedDate });
    });
  }
  return out;
}

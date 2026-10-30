/**
 * Private files per brain, in one Cloudflare R2 bucket owned by the service.
 *
 * Files are not git. They are inputs a brain keeps beside its markdown (a
 * spreadsheet a client sent, an export) that do not belong in the repo. So the
 * three rules bend here on purpose, and only here:
 *   - Adding a file is not a git write. It opens no pull request.
 *   - It is add-only. There is no overwrite and no delete, in this module or in
 *     the tools, so a file once stored is what every later reader sees.
 *   - Nothing in Postgres describes a file. The bucket is its own truth.
 *
 * Every call takes a brain id that the caller has already resolved through
 * requireBrain, and every key is built from it, so one brain cannot name
 * another's objects.
 */
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { R2Config } from '../config.js';
import { brainPrefix, FileRefused, objectKey, relativePath, validateFolder } from './paths.js';

/** Presigned links last about a quarter of an hour. */
export const PRESIGN_SECONDS = 15 * 60;
/** Small text files come back inline as well as by link. */
export const INLINE_TEXT_MAX_BYTES = 200 * 1024;
/** Base64 uploads through the tool; anything bigger takes a presigned URL. */
export const INLINE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set(['csv', 'md', 'txt', 'json']);

const CONTENT_TYPES: Record<string, string> = {
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  zip: 'application/zip',
};

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extension(path)] ?? 'application/octet-stream';
}

export function isInlineText(path: string, size: number): boolean {
  return TEXT_EXTENSIONS.has(extension(path)) && size <= INLINE_TEXT_MAX_BYTES;
}

/** An S3 client pointed at R2. */
export function r2Client(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // One host for every bucket, so presigned links all point at the account endpoint.
    forcePathStyle: true,
    // R2 does not take every checksum the SDK now adds by default, and a
    // checksum signed into a presigned URL would bind the uploader to it.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export interface FileEntry {
  path: string;
  size: number;
  last_modified: string | null;
}

export interface FileDetails extends FileEntry {
  content_type: string | null;
}

export interface FileListing {
  files: FileEntry[];
  next_cursor: string | null;
}

export interface FileDownload {
  file: FileDetails;
  download_url: string;
  expires_in_seconds: number;
  /** Present for small text-like files only. */
  text?: string;
}

export type FileAdd =
  | { status: 'stored'; file: FileDetails }
  | {
      status: 'upload_url';
      path: string;
      upload_url: string;
      method: 'PUT';
      required_headers: Record<string, string>;
      expires_in_seconds: number;
    };

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return statusOf(error) === 404 || name === 'NotFound' || name === 'NoSuchKey';
}

/** 412 is the answer to `If-None-Match: *` on a key that exists; S3 can say 409 under a race. */
function isAlreadyThere(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  const status = statusOf(error);
  return status === 412 || status === 409 || name === 'PreconditionFailed' || name === 'ConditionalRequestConflict';
}

function alreadyExists(brainId: string, path: string): FileRefused {
  return new FileRefused(
    `${path} already exists in ${brainId}. Files are add-only: pick a new name, for example with a date in it.`,
  );
}

export class BrainFiles {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async list(
    brainId: string,
    options: { folder?: string; cursor?: string; limit?: number } = {},
  ): Promise<FileListing> {
    const prefix = brainPrefix(brainId) + validateFolder(options.folder);
    const result = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: Math.min(Math.max(options.limit ?? 100, 1), 1000),
        ...(options.cursor ? { ContinuationToken: options.cursor } : {}),
      }),
    );

    const files: FileEntry[] = [];
    for (const object of result.Contents ?? []) {
      // The prefix already scopes the listing; this re-check means a key of
      // another brain cannot reach a caller even if the store answered wrongly.
      const path = object.Key ? relativePath(brainId, object.Key) : null;
      if (!path || !object.Key!.startsWith(prefix)) continue;
      files.push({
        path,
        size: object.Size ?? 0,
        last_modified: object.LastModified ? object.LastModified.toISOString() : null,
      });
    }
    return { files, next_cursor: result.IsTruncated ? (result.NextContinuationToken ?? null) : null };
  }

  /** Metadata for one file, or null when the brain has no such file. */
  async stat(brainId: string, path: string): Promise<FileDetails | null> {
    const key = objectKey(brainId, path);
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        path,
        size: head.ContentLength ?? 0,
        last_modified: head.LastModified ? head.LastModified.toISOString() : null,
        content_type: head.ContentType ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async get(brainId: string, path: string): Promise<FileDownload> {
    const file = await this.stat(brainId, path);
    if (!file) throw new FileRefused(`No file ${path} in ${brainId}.`);
    const key = objectKey(brainId, path);

    const download_url = await getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: PRESIGN_SECONDS,
    });

    const result: FileDownload = { file, download_url, expires_in_seconds: PRESIGN_SECONDS };
    if (isInlineText(path, file.size)) {
      const object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = object.Body as { transformToString?: (encoding?: string) => Promise<string> } | undefined;
      if (body?.transformToString) result.text = await body.transformToString('utf-8');
    }
    return result;
  }

  /**
   * Adds a file. With content, stores it now; without, returns a presigned PUT
   * for the caller to upload to. Either way the write is conditional on the key
   * not existing, so nothing is ever overwritten.
   */
  async add(brainId: string, path: string, content?: Buffer): Promise<FileAdd> {
    const key = objectKey(brainId, path);
    const ContentType = contentTypeFor(path);

    if (content) {
      if (content.byteLength > INLINE_UPLOAD_MAX_BYTES) {
        throw new FileRefused(
          `That file is ${content.byteLength} bytes; inline uploads stop at ${INLINE_UPLOAD_MAX_BYTES}. ` +
            'Call add_file without content to get an upload URL instead.',
        );
      }
      if ((await this.putNew(brainId, path, content)) === 'exists') throw alreadyExists(brainId, path);
      return {
        status: 'stored',
        file: {
          path,
          size: content.byteLength,
          last_modified: new Date().toISOString(),
          content_type: ContentType,
        },
      };
    }

    // Refuse early with a clear message; the signed If-None-Match below is what
    // actually holds if someone else adds the same path in the meantime.
    if (await this.stat(brainId, path)) throw alreadyExists(brainId, path);
    // Both headers are signed into the URL, so the uploader must send them:
    // If-None-Match keeps the upload add-only, Content-Type keeps get_file honest.
    const upload_url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType, IfNoneMatch: '*' }),
      // The presigner leaves content-type unsigned unless asked.
      { expiresIn: PRESIGN_SECONDS, signableHeaders: new Set(['content-type']) },
    );
    return {
      status: 'upload_url',
      path,
      upload_url,
      method: 'PUT',
      required_headers: { 'Content-Type': ContentType, 'If-None-Match': '*' },
      expires_in_seconds: PRESIGN_SECONDS,
    };
  }

  /**
   * Stores bytes at a new path, with no size cap of its own (the upload script
   * uses this for big files). Says 'exists' rather than overwriting.
   */
  async putNew(brainId: string, path: string, body: Buffer): Promise<'stored' | 'exists'> {
    const key = objectKey(brainId, path);
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentTypeFor(path),
          IfNoneMatch: '*',
        }),
      );
      return 'stored';
    } catch (error) {
      if (isAlreadyThere(error)) return 'exists';
      throw error;
    }
  }
}

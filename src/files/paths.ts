/**
 * Where a brain's private files live in the bucket.
 *
 * Object key = `<brain id>/<relative path>`. The brain id is the first two
 * segments of every key, so a key can only ever belong to one brain. That holds
 * because a brain id here must be exactly `owner/repo`: with ids of any other
 * shape, brain "a" would own the key "a/b/x" that brain "a/b" also claims.
 */
import { ToolRefusal } from '../tools/shared.js';

export class FileRefused extends ToolRefusal {}

/** S3 and R2 cap a key at 1024 bytes. */
const MAX_KEY_BYTES = 1024;

const BRAIN_ID = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** The key prefix every object of this brain sits under, with its trailing slash. */
export function brainPrefix(brainId: string): string {
  if (!BRAIN_ID.test(brainId) || brainId.split('/').some((s) => s === '.' || s === '..')) {
    throw new FileRefused(
      `Files need a brain id of the form owner/repo; "${brainId}" is not one, so it has no file space.`,
    );
  }
  return `${brainId}/`;
}

/**
 * A relative file path, checked. Refuses `..` and `.` segments, absolute paths,
 * empty segments (a doubled or trailing slash), backslashes and control
 * characters, so a path can never climb out of its brain's prefix.
 */
export function validatePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) throw new FileRefused('A file path is required.');
  if (path.startsWith('/')) throw new FileRefused(`Refusing an absolute path: ${path}. Give it relative to the brain.`);
  if (path.includes('\\')) throw new FileRefused(`Refusing a path with a backslash: ${path}. Use forward slashes.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new FileRefused('Refusing a path with control characters.');
  const segments = path.split('/');
  if (segments.some((s) => s === '')) throw new FileRefused(`Refusing a path with an empty segment: ${path}`);
  if (segments.some((s) => s === '..')) throw new FileRefused(`Refusing a path that climbs with "..": ${path}`);
  if (segments.some((s) => s === '.')) throw new FileRefused(`Refusing a path with a "." segment: ${path}`);
  return path;
}

/**
 * An optional folder to list under. Same rules as a path, but a trailing slash
 * is allowed and an empty folder means the whole brain.
 */
export function validateFolder(folder: string | undefined): string {
  if (folder === undefined || folder === '' || folder === '/') return '';
  const trimmed = folder.endsWith('/') ? folder.slice(0, -1) : folder;
  return `${validatePath(trimmed)}/`;
}

/** The full object key for a file of a brain. */
export function objectKey(brainId: string, path: string): string {
  const key = brainPrefix(brainId) + validatePath(path);
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) {
    throw new FileRefused(`Path too long: the stored key would pass ${MAX_KEY_BYTES} bytes.`);
  }
  return key;
}

/** The relative path of a key, or null when the key is not this brain's. */
export function relativePath(brainId: string, key: string): string | null {
  const prefix = brainPrefix(brainId);
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

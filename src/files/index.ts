import { loadR2Config } from '../config.js';
import { BrainFiles, r2Client } from './store.js';

let cached: BrainFiles | null | undefined;

/**
 * The file store, or null when R2 is not configured. Built once per process:
 * the client holds no caller state, and every call names its brain.
 */
export function brainFilesFromEnv(): BrainFiles | null {
  if (cached !== undefined) return cached;
  const config = loadR2Config();
  cached = config ? new BrainFiles(r2Client(config), config.bucket) : null;
  return cached;
}

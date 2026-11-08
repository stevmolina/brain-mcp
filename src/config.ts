/**
 * Configuration. Every value comes from the process environment, which Doppler
 * supplies at deploy time. Nothing is read from a file on disk and no .env is
 * ever written on the box.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export interface Config {
  port: number;
  bindHost: string;
  allowedHosts: string[];
  databaseUrl: string;
  authkitIssuer: string;
  workosApiKey: string;
  workosClientId: string;
  mcpResourceUrl: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  githubWebhookSecret: string;
  accessCacheTtlMs: number;
  staleLiveDays: number;
  environment: string;
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  const mcpResourceUrl = required('MCP_RESOURCE_URL');
  const resourceHost = new URL(mcpResourceUrl).hostname;

  cached = {
    port: Number(optional('PORT', '8080')),
    // Only Traefik is public on the box; the app binds loopback.
    bindHost: optional('BIND_HOST', '127.0.0.1'),
    allowedHosts: [resourceHost, 'localhost', '127.0.0.1', '[::1]'],
    databaseUrl: required('DATABASE_URL'),
    authkitIssuer: required('AUTHKIT_ISSUER').replace(/\/$/, ''),
    workosApiKey: required('WORKOS_API_KEY'),
    workosClientId: required('WORKOS_CLIENT_ID'),
    mcpResourceUrl,
    githubAppId: required('GITHUB_APP_ID'),
    githubAppPrivateKey: Buffer.from(
      required('GITHUB_APP_PRIVATE_KEY_B64'),
      'base64',
    ).toString('utf8'),
    githubWebhookSecret: required('GITHUB_WEBHOOK_SECRET'),
    // Short, so someone removed from a repo loses access without a deploy.
    accessCacheTtlMs: Number(optional('ACCESS_CACHE_TTL_MS', '60000')),
    staleLiveDays: Number(optional('STALE_LIVE_DAYS', '90')),
    environment: optional('DOPPLER_CONFIG', 'dev'),
  };

  return cached;
}

/** Cloudflare R2, for the per-brain private files. */
export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Optional override, for pointing at a local S3-compatible server in development. */
  endpoint?: string;
}

export const R2_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;

/**
 * R2 settings, or null when any of the four is unset. Files are optional: with
 * no R2 env the file tools are simply not registered and the server still
 * starts. Read separately from loadConfig so the upload script needs only these.
 */
export function loadR2Config(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const [accountId, accessKeyId, secretAccessKey, bucket] = R2_ENV.map((name) => env[name]);
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket, ...(env.R2_ENDPOINT ? { endpoint: env.R2_ENDPOINT } : {}) };
}

/**
 * The sessions store: each person's cleaned agent chats, pushed by the
 * `sessions` CLI into their own Postgres database. It is a second database on
 * purpose. The brain database is derived from git and can be dropped and
 * rebuilt; chats and share grants cannot, so they never live in it.
 *
 * Optional, like R2: with no SESSIONS_DATABASE_URL the session tools and the
 * web pages are not registered and the server still starts.
 */
export interface SessionsConfig {
  databaseUrl: string;
}

export function loadSessionsConfig(env: NodeJS.ProcessEnv = process.env): SessionsConfig | null {
  const databaseUrl = env.SESSIONS_DATABASE_URL;
  return databaseUrl ? { databaseUrl } : null;
}

/**
 * The browser side: a signed cookie after an AuthKit login. Needs its own
 * secret; without one the web pages are not mounted.
 */
export interface WebConfig {
  sessionSecret: string;
  /** The public origin, e.g. https://brain.mcpbox.dev, from MCP_RESOURCE_URL. */
  publicOrigin: string;
}

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig | null {
  const secret = env.WEB_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  return { sessionSecret: secret, publicOrigin: new URL(loadConfig().mcpResourceUrl).origin };
}

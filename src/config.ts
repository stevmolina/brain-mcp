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

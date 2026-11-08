/**
 * Browser sign-in, with no new authorization server.
 *
 * The web pages are one more OAuth client of the same AuthKit that MCP clients
 * use. The client is a Client ID Metadata Document (CIMD) served from this
 * host, so nothing is registered by hand: AuthKit fetches
 * /oauth/client-metadata.json, checks the redirect URI against it, and issues
 * the same kind of token an MCP client gets for this resource. We verify it
 * with the same verifier as /mcp, keep only the user id, and drop the token.
 *
 * After that the browser holds one signed cookie: the WorkOS user id and an
 * expiry, HMAC'd with WEB_SESSION_SECRET. No token is stored anywhere.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type express from 'express';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { authorizationServerMetadata } from '../auth/workos.js';
import { loadConfig, type WebConfig } from '../config.js';

export const SESSION_COOKIE = 'bm_session';
const OAUTH_COOKIE = 'bm_oauth';
const SESSION_DAYS = 7;

export function sign(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function unsign<T extends { exp: number }>(value: string | undefined, secret: string): T | null {
  if (!value) return null;
  const [body, mac] = value.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    return typeof payload.exp === 'number' && payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export function readCookie(req: express.Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

function setCookie(res: express.Response, web: WebConfig, name: string, value: string, maxAgeSeconds: number, path = '/') {
  const secure = web.publicOrigin.startsWith('https://') ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`,
  );
}

export interface WebUser {
  sub: string;
  exp: number;
}

/** The signed-in WorkOS user id for this request, or null. */
export function webUser(req: express.Request, web: WebConfig): string | null {
  return unsign<WebUser>(readCookie(req, SESSION_COOKIE), web.sessionSecret)?.sub ?? null;
}

export function sessionCookieFor(sub: string, web: WebConfig): string {
  return sign({ sub, exp: Date.now() + SESSION_DAYS * 86_400_000 }, web.sessionSecret);
}

/** Only same-site relative paths, so /login cannot become an open redirect. */
export function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?![/\\])[^\s]*$/.test(next) ? next : '/sessions';
}

export function clientMetadataUrl(web: WebConfig): string {
  return `${web.publicOrigin}/oauth/client-metadata.json`;
}

function redirectUri(web: WebConfig): string {
  return `${web.publicOrigin}/auth/callback`;
}

export function mountAuthRoutes(app: express.Express, web: WebConfig, verifier: OAuthTokenVerifier): void {
  const { mcpResourceUrl } = loadConfig();

  app.get('/oauth/client-metadata.json', (_req, res) => {
    res.json({
      client_id: clientMetadataUrl(web),
      client_name: 'Agent Brain',
      client_uri: web.publicOrigin,
      logo_uri: `${web.publicOrigin}/favicon.svg`,
      redirect_uris: [redirectUri(web)],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid profile email',
    });
  });

  app.get('/login', async (req, res, next) => {
    try {
      const meta = await authorizationServerMetadata();
      const verifier = randomBytes(32).toString('base64url');
      const state = randomBytes(16).toString('base64url');
      setCookie(
        res,
        web,
        OAUTH_COOKIE,
        sign({ state, verifier, next: safeNext(req.query.next), exp: Date.now() + 10 * 60_000 }, web.sessionSecret),
        600,
        '/auth',
      );
      const url = new URL(meta.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: clientMetadataUrl(web),
        redirect_uri: redirectUri(web),
        response_type: 'code',
        scope: 'openid profile email',
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: mcpResourceUrl,
      }).toString();
      res.redirect(302, url.toString());
    } catch (error) {
      next(error);
    }
  });

  app.get('/auth/callback', async (req, res) => {
    const pending = unsign<{ state: string; verifier: string; next: string; exp: number }>(
      readCookie(req, OAUTH_COOKIE),
      web.sessionSecret,
    );
    setCookie(res, web, OAUTH_COOKIE, '', 0, '/auth');
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    if (!pending || !code || req.query.state !== pending.state) {
      res.status(400).type('text/plain').send('Sign-in expired or was tampered with. Go back and try again.');
      return;
    }
    try {
      const meta = await authorizationServerMetadata();
      const response = await fetch(meta.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(web),
          client_id: clientMetadataUrl(web),
          code_verifier: pending.verifier,
          resource: mcpResourceUrl,
        }),
      });
      const token = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string };
      if (!response.ok || !token.access_token) throw new Error(`token exchange failed: ${response.status} ${token.error ?? ''}`);
      const auth = await verifier.verifyAccessToken(token.access_token);
      const sub = (auth.extra as { workosUserId?: string } | undefined)?.workosUserId;
      if (!sub) throw new Error('token has no subject');
      setCookie(res, web, SESSION_COOKIE, sessionCookieFor(sub, web), SESSION_DAYS * 86_400);
      res.redirect(302, safeNext(pending.next));
    } catch (error) {
      console.error(JSON.stringify({ level: 'warn', at: 'web.callback', message: String(error) }));
      res.status(502).type('text/plain').send('Sign-in failed. Try again.');
    }
  });

  app.post('/logout', (req, res) => {
    if (req.headers.origin && req.headers.origin !== web.publicOrigin) {
      res.status(403).type('text/plain').send('cross-origin request refused');
      return;
    }
    setCookie(res, web, SESSION_COOKIE, '', 0);
    res.redirect(303, '/');
  });
}

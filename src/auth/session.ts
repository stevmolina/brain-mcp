/**
 * Signed session cookie for the browser signup flow. The MCP resource server
 * still only verifies AuthKit access tokens; this cookie is how the marketing
 * site knows who just signed up. BILLING_LINK_SECRET is the key.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

const COOKIE = 'brain_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;

export interface SessionClaims {
  sub: string;
  email: string;
  exp: number;
}

export interface AuthState {
  next: 'app' | 'checkout';
  exp: number;
}

export function seal(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function open<T>(token: string, secret: string): T | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sealSession(claims: { sub: string; email: string }, secret: string, now = Date.now()): string {
  return seal({ sub: claims.sub, email: claims.email, exp: now + SESSION_SECONDS * 1000 }, secret);
}

export function readSession(req: Request, secret: string, now = Date.now()): SessionClaims | null {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const claims = open<SessionClaims>(token, secret);
  if (!claims?.sub || !claims.email || typeof claims.exp !== 'number') return null;
  if (claims.exp <= now) return null;
  return claims;
}

export function readAuthState(token: string, secret: string, now = Date.now()): AuthState | null {
  const state = open<AuthState>(token, secret);
  if (!state || (state.next !== 'app' && state.next !== 'checkout')) return null;
  if (typeof state.exp !== 'number' || state.exp <= now) return null;
  return state;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_SECONDS}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sendHtml(res: Response, status: number, html: string): void {
  res.status(status).type('html').send(html);
}

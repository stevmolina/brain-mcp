/**
 * Signed, short-lived state for the create_brain GitHub redirect.
 * The browser comes back with this and a code. The signature is what ties the
 * callback to the WorkOS user who asked, since the callback itself has no bearer token.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CreateBrainState {
  purpose: 'create_brain';
  sub: string;
  login: string;
  repo: string;
  exp: number;
}

const PREFIX = 'onboarding.v1.';

export function signCreateState(payload: CreateBrainState, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${PREFIX}${body}`).digest('base64url');
  return `${body}.${sig}`;
}

export function readCreateState(token: string, secret: string, now = Date.now()): CreateBrainState | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(`${PREFIX}${body}`).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<CreateBrainState>;
    if (parsed.purpose !== 'create_brain') return null;
    if (!parsed.sub || !parsed.login || !parsed.repo) return null;
    if (typeof parsed.exp !== 'number' || parsed.exp <= now) return null;
    return { purpose: 'create_brain', sub: parsed.sub, login: parsed.login, repo: parsed.repo, exp: parsed.exp };
  } catch {
    return null;
  }
}

export const CREATE_STATE_TTL_MS = 15 * 60 * 1000;

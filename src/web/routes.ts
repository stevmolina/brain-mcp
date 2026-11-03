/**
 * Browser signup, the starter-brain page, and billing redirects.
 *
 * AuthKit answers who this is. The session cookie is only for these pages.
 * MCP calls still present a bearer token and never read this cookie.
 */
import express, { type Request, type Response } from 'express';
import { loadConfig } from '../config.js';
import { billingLinkSecret, loadBillingConfig } from '../billing/config.js';
import { BillingError, createPortalUrl, createTeamCheckout } from '../billing/polar.js';
import { FREE_NOTE_LIMIT } from '../billing/plans.js';
import { authenticateCode, authorizationUrl } from '../auth/authkit.js';
import { getBrain } from '../auth/access.js';
import {
  clearSessionCookie,
  readAuthState,
  readSession,
  seal,
  sealSession,
  sendHtml,
  sessionCookie,
  type SessionClaims,
} from '../auth/session.js';
import { getAccount, provisionAccount, starterBrainId } from '../hosted/brain.js';
import { countClaims, PlanLimit, rememberHosted } from '../hosted/notes.js';
import { WriteRefused } from '../github/write.js';
import { recentClaims, searchClaims } from '../tools/read.js';
import { appPage, simplePage } from './pages.js';

export function registerWebRoutes(app: express.Express): void {
  const web = express.Router();
  web.use(express.urlencoded({ extended: false, limit: '32kb' }));

  web.get('/signup', (req, res) => startAuth(req, res, 'sign-up'));
  web.get('/login', (req, res) => startAuth(req, res, 'sign-in'));
  web.get('/auth/callback', (req, res) => {
    finishAuth(req, res).catch((error) => {
      console.error(JSON.stringify({ level: 'error', at: 'auth.callback', message: String(error) }));
      if (!res.headersSent) sendHtml(res, 500, simplePage('Sign-in failed', '<p><a href="/signup">Try again</a></p>'));
    });
  });
  web.post('/logout', (req, res) => {
    res.setHeader('set-cookie', clearSessionCookie(req.secure));
    res.redirect(303, '/');
  });

  web.get('/app', (req, res) => {
    renderApp(req, res).catch((error) => fail(res, error));
  });
  web.post('/app/notes', (req, res) => {
    saveNote(req, res).catch((error) => fail(res, error));
  });
  web.get('/api/account', (req, res) => {
    accountJson(req, res).catch((error) => fail(res, error));
  });

  web.get('/billing/checkout', (req, res) => {
    beginCheckout(req, res).catch((error) => fail(res, error));
  });
  web.post('/billing/checkout', (req, res) => {
    beginCheckout(req, res).catch((error) => fail(res, error));
  });
  web.get('/billing/portal', (req, res) => {
    beginPortal(req, res).catch((error) => fail(res, error));
  });
  web.post('/billing/portal', (req, res) => {
    beginPortal(req, res).catch((error) => fail(res, error));
  });

  app.use(web);
}

function startAuth(req: Request, res: Response, screen: 'sign-up' | 'sign-in'): void {
  const secret = billingLinkSecret();
  if (!secret) {
    sendHtml(
      res,
      503,
      simplePage('Signup is not configured', '<p>This server needs BILLING_LINK_SECRET before anyone can sign up.</p>'),
    );
    return;
  }
  const session = readSession(req, secret);
  const wantTeam = req.query.plan === 'team';
  if (session && wantTeam) {
    res.redirect(302, '/billing/checkout');
    return;
  }
  if (session) {
    res.redirect(302, '/app');
    return;
  }
  const state = seal({ next: wantTeam ? 'checkout' : 'app', exp: Date.now() + 15 * 60 * 1000 }, secret);
  const url = authorizationUrl({
    redirectUri: `${requestOrigin(req)}/auth/callback`,
    screen,
    state,
  });
  res.redirect(302, url);
}

async function finishAuth(req: Request, res: Response): Promise<void> {
  const secret = billingLinkSecret();
  if (!secret) {
    sendHtml(res, 503, simplePage('Signup is not configured', '<p>This server needs BILLING_LINK_SECRET.</p>'));
    return;
  }
  if (queryOne(req.query.error)) {
    sendHtml(res, 401, simplePage('Sign-in did not finish', '<p><a href="/signup">Try again</a></p>'));
    return;
  }
  const code = queryOne(req.query.code);
  const state = readAuthState(queryOne(req.query.state), secret);
  if (!code || !state) {
    sendHtml(res, 400, simplePage('That sign-in link expired', '<p><a href="/signup">Start again</a></p>'));
    return;
  }

  const user = await authenticateCode(code, req.ip, req.get('user-agent') ?? undefined);
  const { account } = await provisionAccount(user);
  res.setHeader('set-cookie', sessionCookie(sealSession({ sub: user.id, email: user.email }, secret), req.secure));
  const next = state.next === 'checkout' && account.plan !== 'team' ? '/billing/checkout' : '/app';
  res.redirect(302, next);
}

async function renderApp(req: Request, res: Response, error: string | null = null): Promise<void> {
  const session = requireSession(req, res);
  if (!session) return;
  const brain = await loadStarter(session);
  const account = await getAccount(session.sub);
  const plan = account?.plan === 'team' ? 'team' : 'free';
  const query = queryOne(req.query.q);
  const [notes, noteCount, results] = await Promise.all([
    recentClaims(brain, 20),
    countClaims(brain.id),
    query ? searchClaims(brain, query, 10) : Promise.resolve(null),
  ]);
  const checkout = queryOne(req.query.checkout);
  const billing = queryOne(req.query.billing);
  const waiting = checkout === 'success' && plan !== 'team' ? 'team' : billing === 'updated' && plan === 'team' ? 'cancel' : null;
  sendHtml(
    res,
    200,
    appPage({
      email: session.email,
      brainId: brain.id,
      plan,
      noteCount,
      notes,
      query,
      results,
      error,
      saved: queryOne(req.query.saved) === '1' && !error,
      waiting,
      mcpUrl: loadConfig().mcpResourceUrl,
    }),
  );
}

async function saveNote(req: Request, res: Response): Promise<void> {
  if (!sameOrigin(req)) {
    sendHtml(res, 403, simplePage('That request was refused', '<p><a href="/app">Back</a></p>'));
    return;
  }
  const session = requireSession(req, res);
  if (!session) return;
  const brain = await loadStarter(session);
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  try {
    await rememberHosted(brain, { text });
    res.redirect(303, '/app?saved=1');
  } catch (error) {
    if (error instanceof PlanLimit) {
      await renderApp(req, res, `Free plan holds ${FREE_NOTE_LIMIT} notes. Team is $10/mo.`);
      return;
    }
    if (error instanceof WriteRefused) {
      await renderApp(req, res, error.message);
      return;
    }
    throw error;
  }
}

async function accountJson(req: Request, res: Response): Promise<void> {
  const secret = billingLinkSecret();
  const session = secret ? readSession(req, secret) : null;
  if (!session) {
    res.status(401).json({ error: 'sign in' });
    return;
  }
  const account = await getAccount(session.sub);
  const brain = await getBrain(starterBrainId(session.sub));
  const noteCount = brain ? await countClaims(brain.id) : 0;
  res.json({
    plan: account?.plan === 'team' ? 'team' : 'free',
    notes: noteCount,
    limit: account?.plan === 'team' ? null : FREE_NOTE_LIMIT,
    email: session.email,
  });
}

async function beginCheckout(req: Request, res: Response): Promise<void> {
  const session = requireSession(req, res);
  if (!session) return;
  if (!loadBillingConfig()) {
    sendHtml(
      res,
      503,
      simplePage(
        'Team checkout is not configured',
        '<p>The Free plan still works. Checkout needs the Polar sandbox settings.</p><p><a href="/app">Back to your brain</a></p>',
      ),
    );
    return;
  }
  const account = await getAccount(session.sub);
  if (account?.plan === 'team') {
    res.redirect(302, '/app');
    return;
  }
  try {
    const origin = requestOrigin(req);
    const url = await createTeamCheckout({
      userId: session.sub,
      email: session.email,
      successUrl: `${origin}/app?checkout=success`,
      returnUrl: `${origin}/app`,
    });
    res.redirect(302, url);
  } catch (error) {
    if (error instanceof BillingError) {
      sendHtml(res, 502, simplePage('Checkout did not start', `<p>${escape(error.message)}</p><p><a href="/app">Back</a></p>`));
      return;
    }
    throw error;
  }
}

async function beginPortal(req: Request, res: Response): Promise<void> {
  const session = requireSession(req, res);
  if (!session) return;
  const account = await getAccount(session.sub);
  if (!account || account.plan !== 'team') {
    res.redirect(302, '/billing/checkout');
    return;
  }
  try {
    const url = await createPortalUrl(session.sub);
    res.redirect(302, url);
  } catch (error) {
    if (error instanceof BillingError) {
      sendHtml(res, 502, simplePage('The billing portal did not open', `<p>${escape(error.message)}</p><p><a href="/app">Back</a></p>`));
      return;
    }
    throw error;
  }
}

function requireSession(req: Request, res: Response): SessionClaims | null {
  const secret = billingLinkSecret();
  if (!secret) {
    sendHtml(res, 503, simplePage('Signup is not configured', '<p>This server needs BILLING_LINK_SECRET.</p>'));
    return null;
  }
  const session = readSession(req, secret);
  if (!session) {
    res.redirect(302, '/login');
    return null;
  }
  return session;
}

async function loadStarter(session: SessionClaims) {
  const existing = await getBrain(starterBrainId(session.sub));
  if (existing) return existing;
  const provisioned = await provisionAccount({ id: session.sub, email: session.email });
  return provisioned.brain;
}

function requestOrigin(req: Request): string {
  const config = loadConfig();
  const host = req.headers.host ?? '';
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (config.allowedHosts.includes(hostname)) return `${req.protocol}://${host}`;
  return new URL(config.mcpResourceUrl).origin;
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === requestOrigin(req);
}

function queryOne(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fail(res: Response, error: unknown): void {
  console.error(JSON.stringify({ level: 'error', at: 'web', message: String(error) }));
  if (!res.headersSent) sendHtml(res, 500, simplePage('Something went wrong', '<p><a href="/app">Back</a></p>'));
}

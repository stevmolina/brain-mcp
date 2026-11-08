/**
 * The web pages and their JSON API, behind the same AuthKit sign-in as /mcp.
 *
 *   /sessions      search your own chats, filter by brain, tool and date, share
 *   /s/<share id>  a chat someone shared with you, after you sign in as its email
 *
 * Every read goes through src/sessions/store.ts, the same functions the MCP
 * tools use, so the page and an agent see exactly the same things.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { workosProfile } from '../auth/identity.js';
import type { WebConfig } from '../config.js';
import {
  AmbiguousSession,
  createShare,
  describePlan,
  findMyShare,
  listMyShares,
  listSharedWithMe,
  openSession,
  planShare,
  revokeShare,
  searchSessions,
  sessionFacets,
  ShareRefused,
} from '../sessions/store.js';
import { shareLink } from '../tools/sessions.js';
import { mountAuthRoutes, webUser } from './auth.js';

type Handler = (req: express.Request, res: express.Response, userId: string) => Promise<void>;

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const int = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : undefined;
};

export function mountWeb(app: express.Express, web: WebConfig, verifier: OAuthTokenVerifier, siteRoot: string): void {
  mountAuthRoutes(app, web, verifier);

  const appPage = path.join(siteRoot, 'app', 'index.html');
  if (!existsSync(appPage)) throw new Error(`Web app page missing at ${appPage}`);
  // Read once: it is static, and sendFile refuses paths under a dot folder.
  const appHtml = readFileSync(appPage, 'utf8');

  const page = (req: express.Request, res: express.Response) => {
    if (!webUser(req, web)) {
      res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.set('X-Frame-Options', 'DENY');
    res.type('html').send(appHtml);
  };
  app.get('/sessions', page);
  app.get('/s/:share', page);

  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Cookies are SameSite=Lax, and every state change also needs this
    // origin's own Origin header, so a cross-site form cannot post here.
    if (req.method !== 'GET' && req.headers.origin !== web.publicOrigin) {
      res.status(403).json({ error: 'cross-origin request refused' });
      return;
    }
    next();
  });

  const route = (handler: Handler) => async (req: express.Request, res: express.Response) => {
    const userId = webUser(req, web);
    if (!userId) {
      res.status(401).json({ error: 'sign in', login: `/login?next=${encodeURIComponent(str(req.query.next) ?? '/sessions')}` });
      return;
    }
    try {
      await handler(req, res, userId);
    } catch (error) {
      if (error instanceof ShareRefused || error instanceof AmbiguousSession) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error(JSON.stringify({ level: 'error', at: 'web.api', path: req.path, message: String(error) }));
      res.status(500).json({ error: 'something went wrong' });
    }
  };

  const caller = async (userId: string) => {
    const profile = await workosProfile(userId);
    return { userId, email: profile?.verifiedEmail ?? null, name: profile?.name ?? userId };
  };

  api.get('/me', route(async (_req, res, userId) => {
    const me = await caller(userId);
    res.json({ id: me.userId, email: me.email, name: me.name });
  }));

  api.get('/sessions', route(async (req, res, userId) => {
    const sessions = await searchSessions(userId, {
      query: str(req.query.q),
      brain: str(req.query.brain),
      tool: str(req.query.tool),
      since: str(req.query.since),
      until: str(req.query.until),
      limit: int(req.query.limit) ?? 30,
    });
    res.json({ sessions });
  }));

  api.get('/facets', route(async (_req, res, userId) => {
    res.json(await sessionFacets(userId));
  }));

  api.get('/session', route(async (req, res, userId) => {
    const session = str(req.query.session);
    if (!session) {
      res.status(400).json({ error: 'session is required' });
      return;
    }
    const opened = await openSession(await caller(userId), { session, source: str(req.query.source) }, {
      from: int(req.query.from),
      max: int(req.query.max) ?? 60,
    });
    if (!opened) {
      res.status(404).json({ error: 'No such chat is available to you.' });
      return;
    }
    const { ownerId: _owner, ...visible } = opened;
    res.json({ session: visible });
  }));

  /** A share link: the recipient reads it; its creator sees their own chat. */
  api.get('/share/:id', route(async (req, res, userId) => {
    const id = String(req.params.id);
    const mine = await findMyShare(userId, id);
    const me = await caller(userId);
    const opened = mine
      ? await openSession(me, { session: mine.session_id, source: mine.source }, { from: int(req.query.from), max: int(req.query.max) ?? 60 })
      : await openSession(me, { session: id }, { from: int(req.query.from), max: int(req.query.max) ?? 60 });
    if (!opened || (!mine && opened.share?.id !== id)) {
      res.status(404).json({
        error: me.email
          ? `This share is not open to ${me.email}. It may have expired, been revoked, or been sent to another address.`
          : 'Your sign-in has no verified email, so no share can open for it.',
      });
      return;
    }
    const { ownerId, ...visible } = opened;
    const owner = mine ? me.name : ((await workosProfile(ownerId))?.name ?? 'someone');
    res.json({ session: visible, owner, mine: Boolean(mine), share: mine ?? opened.share });
  }));

  const shareInput = (body: Record<string, unknown>) => ({
    session: str(body.session) ?? '',
    source: str(body.source),
    email: str(body.with) ?? '',
    turnFrom: int(body.from_turn),
    turnTo: int(body.to_turn),
    expires: typeof body.expires === 'number' ? body.expires : str(body.expires),
    note: str(body.note),
  });

  api.post('/shares/preview', route(async (req, res, userId) => {
    const plan = await planShare(userId, shareInput(req.body ?? {}));
    res.json({
      preview: describePlan(plan),
      session: plan.session,
      with: plan.email,
      turn_from: plan.turnFrom,
      turn_to: plan.turnTo,
      expires_at: plan.expiresAt?.toISOString() ?? null,
    });
  }));

  api.post('/shares', route(async (req, res, userId) => {
    const plan = await planShare(userId, shareInput(req.body ?? {}));
    const share = await createShare(plan);
    res.status(201).json({ share, link: shareLink(share.id) });
  }));

  api.get('/shares', route(async (_req, res, userId) => {
    const shares = await listMyShares(userId);
    res.json({ shares: shares.map((s) => ({ ...s, link: shareLink(s.id) })) });
  }));

  api.post('/shares/:id/revoke', route(async (req, res, userId) => {
    const done = await revokeShare(userId, String(req.params.id));
    if (!done) {
      res.status(404).json({ error: 'No active share of yours with that id.' });
      return;
    }
    res.json({ revoked: true });
  }));

  api.get('/shared-with-me', route(async (_req, res, userId) => {
    const me = await caller(userId);
    const shares = await listSharedWithMe(me.email);
    res.json({
      email: me.email,
      shares: await Promise.all(
        shares.map(async ({ ownerId, ...s }) => ({ ...s, owner: (await workosProfile(ownerId))?.name ?? 'someone', link: shareLink(s.id) })),
      ),
    });
  }));

  app.use('/api', api);
}

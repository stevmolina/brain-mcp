/**
 * brain-mcp: remote second brains served over MCP.
 *
 *     brain repo (markdown in git)  -- the truth
 *          | push webhook
 *     INDEXER                       -- full rebuild, no incremental diffing
 *          |
 *     NEON                          -- searchable copy; drop it, rebuild it, lose nothing
 *          |
 *     MCP SERVER                    -- reads from Neon, writes to git as a branch + PR
 *
 * Reads come from the copy because it's fast. Writes go to the truth because
 * it's reviewable.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidation,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { loadConfig } from './config.js';
import { authorizationServerMetadata, createTokenVerifier } from './auth/workos.js';
import { Forbidden } from './auth/access.js';
import { handleGithubWebhook } from './github/webhook.js';
import { buildServer } from './tools/index.js';
import { db } from './db/client.js';

const VERSION = '0.1.0';

/**
 * Plain HTML/CSS landing. Dev runs from src/ (../site). The image runs from
 * dist/src (../../site). `pnpm test` and Docker both start with cwd at the
 * package root, which is the last candidate.
 */
function landingRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../site'),
    path.resolve(here, '../../site'),
    path.resolve(process.cwd(), 'site'),
  ];
  const found = candidates.find((dir) => existsSync(path.join(dir, 'index.html')));
  if (!found) throw new Error(`Landing site not found. Looked in ${candidates.join(', ')}`);
  return found;
}

export async function createApp(): Promise<express.Express> {
  const config = loadConfig();
  const resourceUrl = new URL(config.mcpResourceUrl);
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Behind Traefik, but the guard costs nothing and stops a rebinding attempt
  // reaching the app if the box is ever addressed directly.
  app.use(hostHeaderValidation(config.allowedHosts));

  // Registered before the JSON parser: the signature is over the raw body.
  app.post(
    '/webhooks/github',
    express.raw({ type: 'application/json', limit: '10mb' }),
    (req, res) => {
      handleGithubWebhook(req, res).catch((error) => {
        console.error(JSON.stringify({ level: 'error', at: 'webhook', message: String(error) }));
        if (!res.headersSent) res.status(500).json({ error: 'webhook failed' });
      });
    },
  );

  app.use(express.json({ limit: '4mb' }));

  // Liveness only. The container health check calls this every 30s, and a
  // database query here kept Neon's compute from ever suspending, which spent
  // the free plan's monthly compute hours by mid-month.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: VERSION, environment: config.environment });
  });

  // Readiness, for a human or a monitor that can afford to wake the database.
  app.get('/readyz', async (_req, res) => {
    try {
      await db().query('select 1');
      res.json({ ok: true, version: VERSION, environment: config.environment });
    } catch (error) {
      res.status(503).json({ ok: false, error: String(error) });
    }
  });

  // Resource server only. AuthKit is the authorization server; these two
  // documents are how a client discovers it from a 401.
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: await authorizationServerMetadata(),
      resourceServerUrl: resourceUrl,
      resourceName: 'brain-mcp',
      scopesSupported: ['openid', 'profile', 'email', 'offline_access'],
    }),
  );

  const bearer = requireBearerAuth({
    verifier: createTokenVerifier(),
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });

  app.post(resourceUrl.pathname, bearer, async (req, res) => {
    // Stateless: a server and transport per request, so no cross-request state
    // exists that could carry one tenant's scope into another's call.
    const server = buildServer({ version: VERSION });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', at: 'mcp', message: String(error) }));
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  });

  app.get(resourceUrl.pathname, bearer, (_req, res) => {
    res.status(405).json({ error: 'Streamable HTTP: POST to this endpoint' });
  });

  // After every API and discovery route, so a file in site/ cannot shadow
  // /mcp, /healthz, /readyz, /webhooks/github, or the OAuth documents.
  // Unknown paths still fall through to Express's own 404.
  app.get('/index.html', (_req, res) => {
    res.redirect(301, '/');
  });
  app.use(
    express.static(landingRoot(), {
      index: 'index.html',
      fallthrough: true,
      redirect: false,
    }),
  );

  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof Forbidden ? 403 : 500;
    console.error(JSON.stringify({ level: 'error', at: 'express', message: error.message }));
    if (!res.headersSent) res.status(status).json({ error: error.message });
  });

  return app;
}

const startedDirectly = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts');
if (startedDirectly) {
  const config = loadConfig();
  const app = await createApp();
  app.listen(config.port, config.bindHost, () => {
    console.log(
      JSON.stringify({
        level: 'info',
        at: 'boot',
        version: VERSION,
        environment: config.environment,
        listening: `${config.bindHost}:${config.port}`,
        resource: config.mcpResourceUrl,
      }),
    );
  });
}

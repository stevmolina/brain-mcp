import express from 'express';
import { z } from 'zod';
import { bearerAuthChallengeResponse, verifyBearerToken, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/express';
import { Forbidden } from '../auth/access.js';
import { workosUserId } from '../auth/workos.js';
import { loadConfig } from '../config.js';
import { registerOperations } from '../tools/index.js';
import { OperationRegistry, type Operation } from '../tools/registry.js';
import { ToolRefusal } from '../tools/shared.js';
import { brainOverview, readPage } from './brain.js';

/** Brain ids contain a slash, so they are query/body fields rather than URL segments. */
export const endpoints = [
  ['get', '/brains', 'list_brains'],
  ['get', '/search', 'search'],
  ['get', '/claims/get', 'get_claim'],
  ['get', '/claims/explain', 'explain_claim'],
  ['get', '/files', 'list_files'],
  ['get', '/files/get', 'get_file'],
  ['post', '/files', 'add_file'],
  ['post', '/remember', 'remember'],
  ['post', '/update-fact', 'update_fact'],
  ['post', '/forget', 'forget'],
  ['get', '/sessions', 'search_sessions'],
  ['get', '/sessions/show', 'show_session'],
  ['post', '/sessions/save-to-brain', 'save_to_brain'],
  ['post', '/shares', 'share_session'],
  ['get', '/shares', 'list_my_shares'],
  ['get', '/shares/received', 'list_shared_with_me'],
  ['post', '/shares/revoke', 'revoke_share'],
  ['get', '/brains/overview', 'brain_overview'],
  ['get', '/pages/get', 'read_page'],
] as const;

function failure(res: express.Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

function queryInput(req: express.Request, schema: z.ZodObject) {
  const properties = z.toJSONSchema(schema, { io: 'input' }).properties ?? {};
  return Object.fromEntries(Object.entries(req.query).map(([key, value]) => {
    const field = properties[key];
    if (typeof field === 'object' && field.type === 'boolean' && typeof value === 'string') {
      if (value === 'true') return [key, true];
      if (value === 'false') return [key, false];
    }
    if (typeof field === 'object' && (field.type === 'integer' || field.type === 'number') && typeof value === 'string' && value.trim()) {
      return [key, Number(value)];
    }
    return [key, value];
  }));
}

export function restOperations() {
  const registry = new OperationRegistry();
  registerOperations(registry, { version: '0.1.0' });
  registry.registerTool('brain_overview', {
    description: 'List markdown pages and the 20 most recent commits on the default branch. Reads GitHub, which can be ahead of the search index.',
    inputSchema: z.object({ brain: z.string().optional() }),
  }, async (args, ctx) => ({ content: [], structuredContent: await brainOverview(workosUserId(ctx.http?.authInfo), args.brain) }));
  registry.registerTool('read_page', {
    description: 'Read a whole markdown page on the default branch. GitHub contents size limits apply.',
    inputSchema: z.object({ brain: z.string().optional(), path: z.string().min(1).max(1000) }),
  }, async (args, ctx) => ({ content: [], structuredContent: await readPage(workosUserId(ctx.http?.authInfo), args.brain, args.path) }));
  return registry;
}

export function openApi(operations: Map<string, Operation>) {
  const error = { description: 'Request failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, path, name] of endpoints) {
    const operation = operations.get(name);
    if (!operation) continue;
    const schema = z.toJSONSchema(operation.schema, { io: 'input' });
    const properties = schema.properties ?? {};
    const requiredFields = schema.required ?? [];
    const input = method === 'get' ? {
      parameters: Object.entries(properties).map(([name, schema]) => ({
        name, in: 'query', required: requiredFields.includes(name), schema,
      })),
    } : { requestBody: { required: true, content: { 'application/json': { schema } } } };
    paths[path] ??= {};
    paths[path]![method] = {
      operationId: name, description: operation.description, security: [{ bearerAuth: [] }], ...input,
      responses: {
        '200': { description: 'Domain JSON result. Writes include mode, recorded, and commit or pull_request with its URL. Shares preview unless confirm=true.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': error, '401': error, '404': error, '413': error, '422': error, '500': error, '503': error,
      },
    };
  }
  return {
    openapi: '3.1.0', info: { title: 'Agent Brain REST API', version: '1.0.0' },
    servers: [{ url: '/api/v1' }], paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'WorkOS OAuth access token with the /mcp audience' } },
      schemas: { Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } } } } },
    },
  };
}

/** Mounted before the browser /api router. Cookies grant no REST access. */
export function mountRest(app: express.Express, verifier: OAuthTokenVerifier) {
  const router = express.Router();
  const registry = restOperations();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/openapi.json', (_req, res) => { res.json(openApi(registry.operations)); });
  const authOptions = { verifier, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(loadConfig().mcpResourceUrl)) };
  router.use(async (req, res, next) => {
    try {
      req.auth = await verifyBearerToken(req.headers.authorization, authOptions);
      next();
    } catch (error) {
      const challenge = bearerAuthChallengeResponse(error, authOptions);
      const header = challenge.headers.get('WWW-Authenticate');
      if (header) res.set('WWW-Authenticate', header);
      failure(res, challenge.status, challenge.status === 401 ? 'unauthorized' : 'auth_failed', 'A valid WorkOS access token is required.');
    }
  });
  router.use(express.json({ limit: '16mb' }));
  for (const [method, path, name] of endpoints) {
    router[method](path, async (req, res) => {
      const operation = registry.operations.get(name);
      if (!operation) { failure(res, 503, 'not_configured', 'This service is not configured.'); return; }
      const input = method === 'get' ? queryInput(req, operation.schema) : req.body;
      const result = await operation.invoke(input, { http: { authInfo: req.auth } });
      if (result.isError) {
        const message = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        failure(res, 422, 'operation_refused', message);
      } else if (!result.structuredContent) {
        failure(res, 404, 'not_found', 'The requested item is not available.');
      } else res.json(result.structuredContent);
    });
  }
  router.use((_req, res) => { failure(res, 404, 'not_found', 'No such API endpoint.'); });
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof Forbidden) { failure(res, 404, 'not_found', 'The requested brain is not available.'); return; }
    if (error instanceof z.ZodError) { failure(res, 400, 'invalid_request', 'Request fields do not match the API schema.'); return; }
    if (error instanceof ToolRefusal) { failure(res, 422, 'operation_refused', error.message); return; }
    if (error instanceof SyntaxError && 'body' in error) { failure(res, 400, 'invalid_json', 'The body must be valid JSON.'); return; }
    if (typeof error === 'object' && error !== null && 'status' in error) {
      if (error.status === 413) { failure(res, 413, 'body_too_large', 'The body exceeds 16 MB.'); return; }
      if (error.status === 404) { failure(res, 404, 'not_found', 'The requested item is not available.'); return; }
    }
    // Do not log upstream messages, tokens, private paths, or client data.
    console.error(JSON.stringify({ level: 'error', at: 'rest', code: 'internal_error' }));
    failure(res, 500, 'internal_error', 'The request could not be completed.');
  });
  app.use('/api/v1', router);
}

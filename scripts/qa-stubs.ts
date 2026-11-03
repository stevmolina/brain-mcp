/**
 * Local stand-in for WorkOS AuthKit and Polar sandbox.
 *
 * Used when those credentials are not available. It speaks the same HTTP the
 * app already calls: the authorize redirect, the code exchange, product price,
 * checkout, the customer portal, and a signed webhook. It is not imported by
 * the server. Bind it to loopback and point WORKOS_API_BASE and POLAR_API_BASE
 * at it. POLAR_SERVER must stay sandbox; production ignores POLAR_API_BASE.
 *
 *   APP_ORIGIN=http://127.0.0.1:8080 STUB_PORT=8091 \
 *   POLAR_API_KEY=... POLAR_PRO_PRODUCT_ID=... POLAR_ORGANIZATION_ID=... \
 *   POLAR_WEBHOOK_SECRET=... tsx scripts/qa-stubs.ts
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const port = Number(process.env.STUB_PORT ?? '8091');
const appOrigin = (process.env.APP_ORIGIN ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const apiKey = process.env.POLAR_API_KEY ?? '';
const productId = process.env.POLAR_PRO_PRODUCT_ID ?? '';
const organizationId = process.env.POLAR_ORGANIZATION_ID ?? '';
const webhookSecret = process.env.POLAR_WEBHOOK_SECRET ?? '';
const delayMs = Number(process.env.WEBHOOK_DELAY_MS ?? '2000');

interface User {
  id: string;
  email: string;
}
interface Checkout {
  id: string;
  email: string;
  userId: string;
  successUrl: string;
  returnUrl: string;
}

const usersByEmail = new Map<string, User>();
const usersById = new Map<string, User>();
const codes = new Map<string, User>();
const checkouts = new Map<string, Checkout>();
const subscriptions = new Map<string, string>();

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
  body { font-family: Inter, system-ui, sans-serif; margin: 0; background: #fff; color: #111; }
  main { max-width: 440px; margin: 48px auto; padding: 0 18px 48px; }
  h1 { font-size: 32px; letter-spacing: -0.02em; }
  label { display: block; font-weight: 600; margin: 12px 0 6px; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: 12px; border: 2px solid #111; border-radius: 10px; }
  button, .btn { display: inline-block; margin-top: 16px; background: #111; color: #fff; border: 2px solid #111; border-radius: 999px; padding: 12px 18px; font: inherit; font-weight: 700; cursor: pointer; text-decoration: none; }
  .pink { background: #f06bc4; color: #111; }
  .price { font-size: 48px; font-weight: 700; margin: 8px 0; }
  .muted { color: #444; }
  form.stack button { width: 100%; }
</style></head><body><main>${body}</main></body></html>`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

function sendWebhook(type: string, data: Record<string, unknown>): void {
  const body = JSON.stringify({ type, data });
  const id = `evt_${randomBytes(8).toString('hex')}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', webhookSecret).update(`${id}.${timestamp}.${body}`).digest('base64');
  setTimeout(() => {
    fetch(`${appOrigin}/webhooks/polar`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,${signature}`,
      },
      body,
    })
      .then((response) => {
        console.log(JSON.stringify({ at: 'qa-stub.webhook', type, status: response.status }));
      })
      .catch((error) => {
        console.error(JSON.stringify({ at: 'qa-stub.webhook', type, message: String(error) }));
      });
  }, delayMs);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/user_management/authorize') {
    const screen = url.searchParams.get('screen_hint') === 'sign-in' ? 'Sign in' : 'Sign up';
    send(
      res,
      200,
      page(
        screen,
        `<p class="muted">Email</p><h1>${screen} with email</h1>
         <form class="stack" method="post" action="/user_management/authorize">
           <input type="hidden" name="redirect_uri" value="${escapeAttr(url.searchParams.get('redirect_uri') ?? '')}">
           <input type="hidden" name="state" value="${escapeAttr(url.searchParams.get('state') ?? '')}">
           <label for="email">Email</label>
           <input id="email" name="email" type="email" autocomplete="email" required placeholder="you@example.com">
           <button type="submit">Continue</button>
         </form>`,
      ),
    );
    return;
  }

  if (req.method === 'POST' && path === '/user_management/authorize') {
    const form = new URLSearchParams(await readBody(req));
    const email = (form.get('email') ?? '').trim().toLowerCase();
    const redirectUri = form.get('redirect_uri') ?? '';
    const state = form.get('state') ?? '';
    if (!email || !redirectUri.startsWith(appOrigin)) {
      send(res, 400, page('Missing email', '<p>Need an email and a return address.</p>'));
      return;
    }
    let user = usersByEmail.get(email);
    if (!user) {
      user = { id: `user_${randomBytes(8).toString('hex')}`, email };
      usersByEmail.set(email, user);
      usersById.set(user.id, user);
    }
    const code = randomBytes(16).toString('hex');
    codes.set(code, user);
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', state);
    res.writeHead(302, { location: back.toString() });
    res.end();
    return;
  }

  if (req.method === 'POST' && path === '/user_management/authenticate') {
    const body = JSON.parse(await readBody(req)) as { code?: string };
    const user = body.code ? codes.get(body.code) : undefined;
    if (!user) {
      send(res, 401, JSON.stringify({ error: 'invalid code' }), 'application/json');
      return;
    }
    send(res, 200, JSON.stringify({ user: { id: user.id, email: user.email } }), 'application/json');
    return;
  }

  if (!authorized(req)) {
    send(res, 401, JSON.stringify({ error: 'unauthorized' }), 'application/json');
    return;
  }

  const productMatch = path.match(/^\/v1\/products\/([^/]+)$/);
  if (req.method === 'GET' && productMatch) {
    send(
      res,
      200,
      JSON.stringify({
        id: productMatch[1],
        organization_id: organizationId,
        name: 'Team',
        prices: [{ price_amount: 1000, price_currency: 'usd', recurring_interval: 'month' }],
      }),
      'application/json',
    );
    return;
  }

  if (req.method === 'POST' && path === '/v1/checkouts/') {
    const body = JSON.parse(await readBody(req)) as {
      external_customer_id?: string;
      customer_email?: string;
      success_url?: string;
      return_url?: string;
      products?: string[];
    };
    if (!body.products?.includes(productId)) {
      send(res, 400, JSON.stringify({ error: 'unknown product' }), 'application/json');
      return;
    }
    const id = `chk_${randomBytes(6).toString('hex')}`;
    checkouts.set(id, {
      id,
      email: body.customer_email ?? '',
      userId: body.external_customer_id ?? '',
      successUrl: body.success_url ?? `${appOrigin}/app?checkout=success`,
      returnUrl: body.return_url ?? `${appOrigin}/app`,
    });
    send(res, 201, JSON.stringify({ id, url: `http://127.0.0.1:${port}/checkout/${id}` }), 'application/json');
    return;
  }

  const checkoutMatch = path.match(/^\/checkout\/([^/]+)$/);
  if (req.method === 'GET' && checkoutMatch) {
    const checkout = checkouts.get(checkoutMatch[1] ?? '');
    if (!checkout) {
      send(res, 404, page('Checkout missing', '<p>That checkout does not exist.</p>'));
      return;
    }
    send(
      res,
      200,
      page(
        'Team checkout',
        `<p class="muted">Sandbox checkout</p><h1>Team</h1><p class="price">$10<span style="font-size:20px">/mo</span></p>
         <label for="email">Email</label>
         <input id="email" value="${escapeAttr(checkout.email)}" disabled>
         <form method="post" action="/checkout/${checkout.id}/pay"><button class="pink" type="submit">Pay $10</button></form>
         <p><a href="${escapeAttr(checkout.returnUrl)}">Cancel</a></p>`,
      ),
    );
    return;
  }

  const payMatch = path.match(/^\/checkout\/([^/]+)\/pay$/);
  if (req.method === 'POST' && payMatch) {
    const checkout = checkouts.get(payMatch[1] ?? '');
    if (!checkout) {
      send(res, 404, page('Checkout missing', '<p>That checkout does not exist.</p>'));
      return;
    }
    const subId = subscriptions.get(checkout.userId) ?? `sub_${randomBytes(6).toString('hex')}`;
    subscriptions.set(checkout.userId, subId);
    res.writeHead(302, { location: checkout.successUrl });
    res.end();
    sendWebhook('subscription.active', subscription(checkout.userId, subId, 'active'));
    return;
  }

  if (req.method === 'POST' && path === '/v1/customer-sessions/') {
    const body = JSON.parse(await readBody(req)) as { external_customer_id?: string };
    const userId = body.external_customer_id ?? '';
    send(
      res,
      201,
      JSON.stringify({ customer_portal_url: `http://127.0.0.1:${port}/portal/${encodeURIComponent(userId)}` }),
      'application/json',
    );
    return;
  }

  const portalMatch = path.match(/^\/portal\/([^/]+)$/);
  if (req.method === 'GET' && portalMatch) {
    const userId = decodeURIComponent(portalMatch[1] ?? '');
    send(
      res,
      200,
      page(
        'Manage subscription',
        `<p class="muted">Sandbox portal</p><h1>Team</h1><p class="price">$10<span style="font-size:20px">/mo</span></p>
         <p>Status: active</p>
         <form method="post" action="/portal/${encodeURIComponent(userId)}/cancel"><button type="submit">Cancel subscription</button></form>
         <p><a href="${appOrigin}/app">Back to your brain</a></p>`,
      ),
    );
    return;
  }

  const cancelMatch = path.match(/^\/portal\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    const userId = decodeURIComponent(cancelMatch[1] ?? '');
    const subId = subscriptions.get(userId) ?? `sub_${randomBytes(6).toString('hex')}`;
    res.writeHead(302, { location: `${appOrigin}/app?billing=updated` });
    res.end();
    sendWebhook('subscription.revoked', subscription(userId, subId, 'revoked'));
    return;
  }

  send(res, 404, JSON.stringify({ error: 'not found', path }), 'application/json');
});

function subscription(userId: string, subId: string, status: string): Record<string, unknown> {
  return {
    id: subId,
    status,
    product_id: productId,
    customer_id: `cus_${userId}`,
    current_period_end: status === 'active' ? '2026-12-03T00:00:00.000Z' : '2026-11-03T00:00:00.000Z',
    customer: { id: `cus_${userId}`, external_id: userId, email: usersById.get(userId)?.email ?? '' },
  };
}

function authorized(req: IncomingMessage): boolean {
  const path = req.url ?? '';
  if (!path.startsWith('/v1/')) return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${apiKey}`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ at: 'qa-stub', listening: `http://127.0.0.1:${port}`, appOrigin, delayMs }));
});

/**
 * Team checkout and the Polar webhook. No live Polar calls: fetch is stubbed,
 * and the webhook is signed locally. Invented accounts only.
 */
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { polarApiBase, workosApiBase } from '../src/billing/config.js';
import { createTeamCheckout } from '../src/billing/polar.js';
import {
  planForSubscription,
  readProductPrice,
  shouldApplySubscription,
  teamPriceMatches,
  TEAM_PRICE_CENTS,
  type SubscriptionSnapshot,
} from '../src/billing/plans.js';
import { applyPolarEvent, verifyPolarWebhook } from '../src/billing/webhook.js';
import { provisionAccount } from '../src/hosted/brain.js';
import { sealSession } from '../src/auth/session.js';
import { createApp } from '../src/index.js';

const USER = 'user_billing_test_cam';
const SECRET = 'whsec_dGVzdC1zZWNyZXQ=';
const LINK = 'test-link-secret';
const PRODUCT = 'prod_team_test';
const ORG = 'org_sandbox_test';

process.env.BILLING_LINK_SECRET = LINK;
process.env.POLAR_API_KEY ||= 'sandbox_test_key';
process.env.POLAR_ORGANIZATION_ID ||= ORG;
process.env.POLAR_PRO_PRODUCT_ID ||= PRODUCT;
process.env.POLAR_WEBHOOK_SECRET ||= SECRET;
process.env.POLAR_SERVER ||= 'sandbox';

let server: Server | undefined;
let base: string;

beforeAll(async () => {
  await migrate();
  await cleanup();
  const app = await createApp();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  delete process.env.POLAR_API_BASE;
  delete process.env.WORKOS_API_BASE;
  process.env.POLAR_SERVER = 'sandbox';
  if (process.env.DOPPLER_CONFIG === 'prd') delete process.env.DOPPLER_CONFIG;
});

afterAll(async () => {
  if (server) {
    const listening = server;
    await new Promise<void>((resolve, reject) => listening.close((err) => (err ? reject(err) : resolve())));
  }
  await cleanup();
  await closeDb();
});

async function cleanup() {
  await db().query('delete from billing_events where id like $1', ['evt_billing_test%']);
  await db().query('delete from brains where owner_workos_user_id = $1', [USER]);
  await db().query('delete from accounts where workos_user_id = $1', [USER]);
}

function sub(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    id: 'sub_billing_test',
    status: 'active',
    productId: PRODUCT,
    customerId: 'cus_billing_test',
    externalId: USER,
    currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
    ...overrides,
  };
}

function sign(raw: string, id: string, timestamp: string, key: Buffer | string): string {
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest('base64')}`;
}

describe('plan decisions', () => {
  const now = new Date('2026-11-03T00:00:00Z');

  it('treats an active Team subscription as Team and a revoked one as Free', () => {
    expect(planForSubscription(sub(), PRODUCT, now)).toBe('team');
    expect(planForSubscription(sub({ status: 'trialing' }), PRODUCT, now)).toBe('team');
    expect(planForSubscription(sub({ status: 'revoked' }), PRODUCT, now)).toBe('free');
    expect(planForSubscription(sub({ status: 'canceled', currentPeriodEnd: new Date('2026-12-01T00:00:00Z') }), PRODUCT, now)).toBe('team');
    expect(planForSubscription(sub({ status: 'canceled', currentPeriodEnd: new Date('2026-10-01T00:00:00Z') }), PRODUCT, now)).toBe('free');
    expect(planForSubscription(sub({ productId: 'prod_other' }), PRODUCT, now)).toBeNull();
    expect(planForSubscription(sub({ productId: null }), PRODUCT, now)).toBeNull();
  });

  it('does not let an old subscription downgrade a newer one', () => {
    expect(shouldApplySubscription({ plan: 'team', polarSubscriptionId: 'sub_new' }, 'sub_old', 'free')).toBe(false);
    expect(shouldApplySubscription({ plan: 'free', polarSubscriptionId: 'sub_old' }, 'sub_new', 'team')).toBe(true);
    expect(shouldApplySubscription({ plan: 'team', polarSubscriptionId: 'sub_new' }, 'sub_new', 'free')).toBe(true);
  });

  it('accepts only a $10 USD monthly price in the configured organization', () => {
    const price = readProductPrice({
      organization_id: ORG,
      prices: [{ price_amount: TEAM_PRICE_CENTS, price_currency: 'usd', recurring_interval: 'month' }],
    });
    expect(teamPriceMatches(price, ORG)).toBe(true);
    expect(teamPriceMatches({ ...price, amount: 1200 }, ORG)).toBe(false);
    expect(teamPriceMatches({ ...price, currency: 'eur' }, ORG)).toBe(false);
    expect(teamPriceMatches({ ...price, organizationId: 'org_other' }, ORG)).toBe(false);
  });

  it('keeps production off the sandbox override', () => {
    process.env.POLAR_API_BASE = 'http://127.0.0.1:9999';
    process.env.POLAR_SERVER = 'production';
    expect(polarApiBase()).toBe('https://api.polar.sh');
    process.env.POLAR_SERVER = 'sandbox';
    expect(polarApiBase()).toBe('http://127.0.0.1:9999');
    process.env.WORKOS_API_BASE = 'http://127.0.0.1:9999';
    process.env.DOPPLER_CONFIG = 'prd';
    expect(workosApiBase()).toBe('https://api.workos.com');
    process.env.DOPPLER_CONFIG = 'dev';
    expect(workosApiBase()).toBe('http://127.0.0.1:9999');
  });
});

describe('checkout session', () => {
  afterEach(() => {
    // restored by the fetch tests themselves; this clears a leaked stub
  });

  it('posts the Team product and the signed-in user, and returns the checkout url', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('polar.sh') || url.includes('/v1/')) {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.includes('/products/')) {
          return json({
            id: PRODUCT,
            organization_id: ORG,
            prices: [{ price_amount: 1000, price_currency: 'usd', recurring_interval: 'month' }],
          });
        }
        return json({ url: 'https://sandbox.polar.sh/checkout/chk_test' });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const url = await createTeamCheckout({
        userId: USER,
        email: 'cam@example.com',
        successUrl: 'http://127.0.0.1/app?checkout=success',
        returnUrl: 'http://127.0.0.1/app',
      });
      expect(url).toBe('https://sandbox.polar.sh/checkout/chk_test');
      expect(calls[0]?.url).toContain('https://sandbox-api.polar.sh/v1/products/');
      expect(calls[1]?.url).toBe('https://sandbox-api.polar.sh/v1/checkouts/');
      expect(calls[1]?.body).toMatchObject({
        products: [PRODUCT],
        external_customer_id: USER,
        customer_email: 'cam@example.com',
        metadata: { workos_user_id: USER },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('does not open checkout when the product is not $10', async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/products/')) {
        return json({
          organization_id: ORG,
          prices: [{ price_amount: 1200, price_currency: 'usd', recurring_interval: 'month' }],
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await expect(
        createTeamCheckout({
          userId: USER,
          email: 'cam@example.com',
          successUrl: 'http://127.0.0.1/app?checkout=success',
          returnUrl: 'http://127.0.0.1/app',
        }),
      ).rejects.toThrow(/\$10 USD/);
      expect(calls.some((url) => url.includes('/checkouts'))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('webhook', () => {
  it('rejects a bad signature and accepts both Polar key styles', () => {
    const raw = Buffer.from(JSON.stringify({ type: 'subscription.active', data: { id: 'sub_x', status: 'active' } }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(() =>
      verifyPolarWebhook(raw, { id: 'evt_billing_test_bad', timestamp, signature: 'v1,bm90LXNpZ25lZA==' }, SECRET),
    ).toThrow(/bad signature/);

    const utf8 = sign(raw.toString('utf8'), 'evt_billing_test_utf8', timestamp, SECRET);
    expect(verifyPolarWebhook(raw, { id: 'evt_billing_test_utf8', timestamp, signature: utf8 }, SECRET)).toMatchObject({
      type: 'subscription.active',
    });

    const decoded = sign(raw.toString('utf8'), 'evt_billing_test_std', timestamp, Buffer.from('test-secret'));
    expect(
      verifyPolarWebhook(raw, { id: 'evt_billing_test_std', timestamp, signature: decoded }, SECRET),
    ).toMatchObject({ type: 'subscription.active' });
  });

  it('upgrades on active, keeps Team through a cancellation, and downgrades on revoke', async () => {
    await provisionAccount({ id: USER, email: 'cam@example.com' });

    expect(await applyPolarEvent('evt_billing_test_active', event('subscription.active', sub()))).toBe(202);
    expect(await planOf()).toBe('team');

    expect(await applyPolarEvent('evt_billing_test_active', event('subscription.active', sub()))).toBe(202);
    expect(await planOf()).toBe('team');

    expect(
      await applyPolarEvent(
        'evt_billing_test_cancel',
        event('subscription.canceled', sub({ status: 'canceled', currentPeriodEnd: new Date('2026-12-01T00:00:00Z') })),
      ),
    ).toBe(202);
    expect(await planOf()).toBe('team');

    expect(
      await applyPolarEvent('evt_billing_test_revoke', event('subscription.revoked', sub({ status: 'revoked' }))),
    ).toBe(202);
    expect(await planOf()).toBe('free');
  });

  it('ignores a different product and a revoke of an older subscription', async () => {
    await provisionAccount({ id: USER, email: 'cam@example.com' });
    await applyPolarEvent('evt_billing_test_active2', event('subscription.active', sub({ id: 'sub_current' })));
    expect(
      await applyPolarEvent('evt_billing_test_other', event('subscription.active', sub({ id: 'sub_other', productId: 'prod_nope' }))),
    ).toBe(202);
    expect(await planOf()).toBe('team');
    expect(
      await applyPolarEvent(
        'evt_billing_test_old',
        event('subscription.revoked', sub({ id: 'sub_previous', status: 'revoked' })),
      ),
    ).toBe(202);
    expect(await planOf()).toBe('team');
    const { rows } = await db().query<{ polar_subscription_id: string }>('select polar_subscription_id from accounts where workos_user_id = $1', [USER]);
    expect(rows[0]?.polar_subscription_id).toBe('sub_current');
  });

  it('is refused over HTTP when the signature is wrong, and applied when it is right', async () => {
    await provisionAccount({ id: USER, email: 'cam@example.com' });
    const bad = await fetch(`${base}/webhooks/polar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'webhook-id': 'evt_billing_test_http_bad', 'webhook-timestamp': '1', 'webhook-signature': 'v1,bm8=' },
      body: '{}',
    });
    expect(bad.status).toBe(403);

    const payload = JSON.stringify(event('subscription.active', sub({ id: 'sub_http' })));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const id = 'evt_billing_test_http_ok';
    const good = await fetch(`${base}/webhooks/polar`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': sign(payload, id, timestamp, SECRET),
      },
      body: payload,
    });
    expect(good.status).toBe(202);
    expect(await planOf()).toBe('team');

    const cookie = `brain_session=${encodeURIComponent(sealSession({ sub: USER, email: 'cam@example.com' }, LINK))}`;
    const account = await fetch(`${base}/api/account`, { headers: { cookie } });
    expect(await account.json()).toMatchObject({ plan: 'team', email: 'cam@example.com' });
  });
});

function event(type: string, data: SubscriptionSnapshot) {
  return {
    type,
    data: {
      id: data.id,
      status: data.status,
      product_id: data.productId,
      customer_id: data.customerId,
      current_period_end: data.currentPeriodEnd?.toISOString() ?? null,
      customer: { id: data.customerId, external_id: data.externalId },
    },
  };
}

async function planOf(): Promise<string> {
  const { rows } = await db().query<{ plan: string }>('select plan from accounts where workos_user_id = $1', [USER]);
  return rows[0]?.plan ?? '';
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

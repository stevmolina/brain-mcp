/**
 * Polar webhook. Standard Webhooks signature over the raw body. The plan on
 * the account changes here and nowhere else: the browser coming back from
 * checkout is not proof of payment.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { db, withTransaction } from '../db/client.js';
import { loadBillingConfig } from './config.js';
import {
  planForSubscription,
  readSubscription,
  shouldApplySubscription,
  type PlanName,
  type SubscriptionSnapshot,
} from './plans.js';

const MAX_SKEW_SECONDS = 5 * 60;

export class WebhookRejected extends Error {}

export function verifyPolarWebhook(rawBody: Buffer, headers: WebhookHeaders, secret: string, now = Date.now()): unknown {
  const id = headers.id;
  const timestamp = headers.timestamp;
  const signature = headers.signature;
  if (!id || !timestamp || !signature) throw new WebhookRejected('missing signature');

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > MAX_SKEW_SECONDS) {
    throw new WebhookRejected('stale webhook');
  }

  const signed = `${id}.${timestamp}.${rawBody.toString('utf8')}`;
  const expected = webhookKeys(secret).map((key) => createHmac('sha256', key).update(signed).digest('base64'));
  for (const part of signature.split(' ')) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    for (const exp of expected) {
      if (safeEqual(sig, exp)) return JSON.parse(rawBody.toString('utf8')) as unknown;
    }
  }
  throw new WebhookRejected('bad signature');
}

function webhookKeys(secret: string): Buffer[] {
  const keys = [Buffer.from(secret, 'utf8')];
  if (secret.startsWith('whsec_')) {
    const decoded = Buffer.from(secret.slice('whsec_'.length), 'base64');
    if (decoded.length) keys.push(decoded);
  }
  return keys;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface WebhookHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

interface AccountBilling {
  workos_user_id: string;
  plan: PlanName;
  polar_subscription_id: string | null;
}

/**
 * Applies one already-verified event. 202 means Polar should not retry.
 * 500 means the account is not here yet and a retry might find it.
 */
export async function applyPolarEvent(webhookId: string, event: unknown): Promise<number> {
  const config = loadBillingConfig();
  if (!config) return 503;

  const snapshot = readSubscription((event ?? {}) as { type?: unknown; data?: unknown });
  if (!snapshot) return 202;

  const plan = planForSubscription(snapshot, config.productId);
  if (plan === null) return 202;

  const account = await findAccount(snapshot);
  if (!account) return snapshot.externalId ? 500 : 202;

  await withTransaction(async (client) => {
    const locked = await client.query<AccountBilling>(
      'select workos_user_id, plan, polar_subscription_id from accounts where workos_user_id = $1 for update',
      [account.workos_user_id],
    );
    const current = locked.rows[0];
    if (!current) return;

    const inserted = await client.query(
      'insert into billing_events (id, type) values ($1, $2) on conflict do nothing returning id',
      [webhookId, eventType(event)],
    );
    if ((inserted.rowCount ?? 0) === 0) return;
    if (
      !shouldApplySubscription(
        { plan: current.plan, polarSubscriptionId: current.polar_subscription_id },
        snapshot.id,
        plan,
      )
    ) {
      return;
    }
    await client.query(
      `update accounts set
         plan = $2,
         polar_customer_id = coalesce($3, polar_customer_id),
         polar_subscription_id = $4,
         polar_subscription_status = $5,
         current_period_end = $6,
         updated_at = now()
       where workos_user_id = $1`,
      [
        current.workos_user_id,
        plan,
        snapshot.customerId,
        snapshot.id,
        snapshot.status,
        snapshot.currentPeriodEnd,
      ],
    );
  });
  return 202;
}

async function findAccount(snapshot: SubscriptionSnapshot): Promise<AccountBilling | null> {
  if (snapshot.externalId) {
    const { rows } = await db().query<AccountBilling>(
      'select workos_user_id, plan, polar_subscription_id from accounts where workos_user_id = $1',
      [snapshot.externalId],
    );
    if (rows[0]) return rows[0];
  }
  if (snapshot.customerId) {
    const { rows } = await db().query<AccountBilling>(
      'select workos_user_id, plan, polar_subscription_id from accounts where polar_customer_id = $1',
      [snapshot.customerId],
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

function eventType(event: unknown): string {
  const type = (event as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? type : 'unknown';
}

export async function handlePolarWebhook(req: Request, res: Response): Promise<void> {
  const config = loadBillingConfig();
  if (!config) {
    res.status(503).json({ error: 'billing is not configured' });
    return;
  }

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  let event: unknown;
  try {
    event = verifyPolarWebhook(
      raw,
      {
        id: req.header('webhook-id') ?? undefined,
        timestamp: req.header('webhook-timestamp') ?? undefined,
        signature: req.header('webhook-signature') ?? undefined,
      },
      config.webhookSecret,
    );
  } catch (error) {
    if (error instanceof WebhookRejected) {
      res.status(403).json({ error: 'bad signature' });
      return;
    }
    res.status(400).json({ error: 'bad payload' });
    return;
  }

  const webhookId = req.header('webhook-id') ?? '';
  try {
    const status = await applyPolarEvent(webhookId, event);
    if (status === 202) res.status(202).json({ received: true });
    else res.status(status).json({ error: 'not applied' });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', at: 'polar.webhook', message: String(error) }));
    if (!res.headersSent) res.status(500).json({ error: 'webhook failed' });
  }
}

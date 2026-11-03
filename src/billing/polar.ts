/**
 * Polar checkout and the customer portal. Fetch, not an SDK: the rest of this
 * server talks to WorkOS the same way.
 *
 * The plan does not change here. The signed webhook is the only writer.
 */
import { loadBillingConfig, polarApiBase, type BillingConfig } from './config.js';
import { readProductPrice, teamPriceMatches } from './plans.js';

export class BillingError extends Error {}

async function polarFetch(config: BillingConfig, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${polarApiBase()}/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new BillingError(`Polar request failed (${response.status})`);
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

export interface CheckoutInput {
  userId: string;
  email: string;
  successUrl: string;
  returnUrl: string;
}

/** Opens a Team checkout. Refuses when the product is not $10 USD per month. */
export async function createTeamCheckout(input: CheckoutInput): Promise<string> {
  const config = loadBillingConfig();
  if (!config) throw new BillingError('Team checkout is not configured');

  const product = await polarFetch(config, `/products/${encodeURIComponent(config.productId)}`);
  const price = readProductPrice(product);
  if (!teamPriceMatches(price, config.organizationId)) {
    throw new BillingError(
      `Team is $10 USD per month. The configured Polar product is ${price.amount ?? 'unknown'} ${price.currency || 'unknown'} ${price.interval ?? 'one-time'}.`,
    );
  }

  const checkout = (await polarFetch(config, '/checkouts/', {
    method: 'POST',
    body: JSON.stringify({
      products: [config.productId],
      external_customer_id: input.userId,
      customer_email: input.email,
      success_url: input.successUrl,
      return_url: input.returnUrl,
      metadata: { workos_user_id: input.userId },
    }),
  })) as { url?: string };

  if (!checkout.url) throw new BillingError('Polar checkout did not return a url');
  return checkout.url;
}

/** A fresh portal link. Polar sessions are short; this is called on click. */
export async function createPortalUrl(userId: string): Promise<string> {
  const config = loadBillingConfig();
  if (!config) throw new BillingError('Billing is not configured');

  const session = (await polarFetch(config, '/customer-sessions/', {
    method: 'POST',
    body: JSON.stringify({ external_customer_id: userId }),
  })) as { customer_portal_url?: string };

  if (!session.customer_portal_url) throw new BillingError('Polar did not return a portal url');
  return session.customer_portal_url;
}

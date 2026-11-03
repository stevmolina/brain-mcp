/**
 * Free and Team. The marketing site says the same numbers (5 notes, $10/month).
 * Change both together.
 *
 * POLAR_PRO_PRODUCT_ID is the env name computer-mcp uses. Here it is the Team
 * product, and the price is whatever that Polar product is. Checkout refuses
 * to start unless that product is USD 1000 cents per month, so a mis-priced
 * sandbox product cannot charge a different amount than the page says.
 */

export const FREE_NOTE_LIMIT = 5;
export const TEAM_PRICE_CENTS = 1000;
export const TEAM_PRICE_CURRENCY = 'usd';
export const TEAM_PRICE_INTERVAL = 'month';
/** A box-protection cap, not a plan feature. The page says unlimited. */
export const TEAM_SAFETY_CAP = 5000;

export type PlanName = 'free' | 'team';

export interface SubscriptionSnapshot {
  id: string;
  status: string;
  productId: string | null;
  customerId: string | null;
  externalId: string | null;
  currentPeriodEnd: Date | null;
}

export interface StoredSubscription {
  plan: PlanName;
  polarSubscriptionId: string | null;
}

/**
 * What plan this subscription entitles, or null when the event is for a
 * different product and must be ignored.
 *
 * `active` and `trialing` are Team. `canceled` stays Team until the period
 * ends, which is when Polar sends `revoked`. A stale event for some other
 * subscription must not downgrade the one on the account.
 */
export function planForSubscription(
  sub: SubscriptionSnapshot,
  expectedProductId: string,
  now = new Date(),
): PlanName | null {
  if (!sub.productId || sub.productId !== expectedProductId) return null;
  if (sub.status === 'active' || sub.status === 'trialing') return 'team';
  if ((sub.status === 'canceled' || sub.status === 'past_due') && sub.currentPeriodEnd && sub.currentPeriodEnd > now) {
    return 'team';
  }
  return 'free';
}

/** False when this event would clobber a newer subscription with an old one. */
export function shouldApplySubscription(current: StoredSubscription, incomingId: string, incomingPlan: PlanName): boolean {
  if (!current.polarSubscriptionId || current.polarSubscriptionId === incomingId) return true;
  return incomingPlan === 'team';
}

export function readSubscription(event: { type?: unknown; data?: unknown }): SubscriptionSnapshot | null {
  if (typeof event.type !== 'string' || !event.type.startsWith('subscription.')) return null;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const customer = (data.customer ?? {}) as Record<string, unknown>;
  const product = (data.product ?? {}) as Record<string, unknown>;
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  const id = stringOrEmpty(data.id);
  const status = stringOrEmpty(data.status);
  if (!id || !status) return null;
  const period = data.current_period_end;
  const currentPeriodEnd = typeof period === 'string' || typeof period === 'number' ? new Date(period) : null;
  return {
    id,
    status,
    productId: stringOrEmpty(data.product_id) || stringOrEmpty(product.id) || null,
    customerId: stringOrEmpty(data.customer_id) || stringOrEmpty(customer.id) || null,
    externalId: stringOrEmpty(customer.external_id) || stringOrEmpty(metadata.workos_user_id) || null,
    currentPeriodEnd: currentPeriodEnd && !Number.isNaN(currentPeriodEnd.getTime()) ? currentPeriodEnd : null,
  };
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export interface ProductPrice {
  amount: number | null;
  currency: string;
  interval: string | null;
  organizationId: string | null;
}

/** Pulls the first fixed price off a Polar product payload. */
export function readProductPrice(product: unknown): ProductPrice {
  const body = (product ?? {}) as Record<string, unknown>;
  const prices = Array.isArray(body.prices) ? body.prices : [];
  const price = (prices[0] ?? {}) as Record<string, unknown>;
  const amount = price.price_amount ?? price.priceAmount;
  const currency = price.price_currency ?? price.priceCurrency;
  const interval = price.recurring_interval ?? price.recurringInterval;
  const organizationId = body.organization_id ?? body.organizationId;
  return {
    amount: typeof amount === 'number' ? amount : null,
    currency: typeof currency === 'string' ? currency.toLowerCase() : '',
    interval: typeof interval === 'string' ? interval : null,
    organizationId: typeof organizationId === 'string' ? organizationId : null,
  };
}

export function teamPriceMatches(price: ProductPrice, organizationId: string): boolean {
  if (price.organizationId && price.organizationId !== organizationId) return false;
  return (
    price.amount === TEAM_PRICE_CENTS &&
    price.currency === TEAM_PRICE_CURRENCY &&
    (price.interval === null || price.interval === TEAM_PRICE_INTERVAL)
  );
}

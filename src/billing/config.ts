/**
 * Polar, named the same way as computer-mcp.
 *
 * POLAR_SERVER is sandbox unless it is exactly "production", so a typo cannot
 * bill live customers. The API base override is accepted only for a localhost
 * sandbox, which is how tests and the local sandbox stub run. Production
 * ignores it.
 *
 * Checkout and the webhook stay off until every value is set. The server
 * still starts. Signup's session cookie needs only BILLING_LINK_SECRET.
 */

export interface BillingConfig {
  server: 'sandbox' | 'production';
  apiKey: string;
  organizationId: string;
  /** Team product. The env name POLAR_PRO_PRODUCT_ID matches computer-mcp. */
  productId: string;
  webhookSecret: string;
  linkSecret: string;
}

export function billingLinkSecret(): string | null {
  const secret = process.env.BILLING_LINK_SECRET;
  return secret ? secret : null;
}

export function loadBillingConfig(): BillingConfig | null {
  const linkSecret = billingLinkSecret();
  const apiKey = process.env.POLAR_API_KEY;
  const organizationId = process.env.POLAR_ORGANIZATION_ID;
  const productId = process.env.POLAR_PRO_PRODUCT_ID;
  const webhookSecret = process.env.POLAR_WEBHOOK_SECRET;
  if (!linkSecret || !apiKey || !organizationId || !productId || !webhookSecret) return null;
  return {
    server: process.env.POLAR_SERVER === 'production' ? 'production' : 'sandbox',
    apiKey,
    organizationId,
    productId,
    webhookSecret,
    linkSecret,
  };
}

export function polarServer(): 'sandbox' | 'production' {
  return process.env.POLAR_SERVER === 'production' ? 'production' : 'sandbox';
}

/** Localhost only, and never in production. A sandbox mis-set cannot redirect checkout. */
export function polarApiBase(): string {
  if (polarServer() === 'production') return 'https://api.polar.sh';
  const override = (process.env.POLAR_API_BASE ?? '').replace(/\/$/, '');
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(override)) return override;
  return 'https://sandbox-api.polar.sh';
}

/** Localhost only, and never when DOPPLER_CONFIG is prd. */
export function workosApiBase(): string {
  const env = process.env.DOPPLER_CONFIG || 'dev';
  const override = (process.env.WORKOS_API_BASE ?? '').replace(/\/$/, '');
  if (env !== 'prd' && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(override)) return override;
  return 'https://api.workos.com';
}

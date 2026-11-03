/**
 * Browser sign-up through WorkOS AuthKit. This is separate from MCP bearer
 * verification: AuthKit hosts the email screen, and we exchange the code for
 * the user id. We do not mint tokens for MCP clients.
 */
import { loadConfig } from '../config.js';
import { workosApiBase } from '../billing/config.js';

export function authorizationUrl(input: { redirectUri: string; screen: 'sign-up' | 'sign-in'; state: string }): string {
  const { workosClientId } = loadConfig();
  const url = new URL(`${workosApiBase()}/user_management/authorize`);
  url.searchParams.set('client_id', workosClientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('provider', 'authkit');
  url.searchParams.set('screen_hint', input.screen);
  url.searchParams.set('state', input.state);
  return url.toString();
}

export interface AuthKitUser {
  id: string;
  email: string;
}

export async function authenticateCode(
  code: string,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<AuthKitUser> {
  const config = loadConfig();
  const response = await fetch(`${workosApiBase()}/user_management/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.workosClientId,
      client_secret: config.workosApiKey,
      grant_type: 'authorization_code',
      code,
      ...(ip ? { ip_address: ip } : {}),
      ...(userAgent ? { user_agent: userAgent } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`AuthKit code exchange failed (${response.status})`);
  }
  const body = (await response.json()) as { user?: { id?: string; email?: string } };
  const id = body.user?.id;
  const email = body.user?.email;
  if (!id || !email) throw new Error('AuthKit did not return a user id and email');
  return { id, email };
}

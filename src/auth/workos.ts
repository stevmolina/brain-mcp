/**
 * This server is a resource server only.
 *
 * WorkOS AuthKit is the authorization server: it issues the tokens, runs DCR and
 * CIMD, and owns every user-facing screen. Nothing here mints, refreshes or
 * stores a token. We verify the JWT against AuthKit's JWKS and check `iss` and
 * `aud`, and that is the whole of it.
 *
 * The v1 AS helpers (mcpAuthRouter, ProxyOAuthServerProvider) are frozen in
 * @modelcontextprotocol/server-legacy and are deliberately not used.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AuthInfo, OAuthMetadata, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { loadConfig } from '../config.js';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let metadata: OAuthMetadata | undefined;

/** AuthKit's RFC 8414 document, fetched once and passed through verbatim. */
export async function authorizationServerMetadata(): Promise<OAuthMetadata> {
  if (metadata) return metadata;
  const { authkitIssuer } = loadConfig();
  const response = await fetch(`${authkitIssuer}/.well-known/oauth-authorization-server`);
  if (!response.ok) {
    throw new Error(`Could not read AuthKit metadata (${response.status}) from ${authkitIssuer}`);
  }
  metadata = (await response.json()) as OAuthMetadata;
  if (metadata.issuer !== authkitIssuer) {
    throw new Error(`AuthKit issuer mismatch: expected ${authkitIssuer}, got ${metadata.issuer}`);
  }
  return metadata;
}

export interface BrainAuthInfo extends AuthInfo {
  extra: {
    workosUserId: string;
    sessionId?: string;
    organizationId?: string;
  };
}

export function createTokenVerifier(): OAuthTokenVerifier {
  const config = loadConfig();

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (!jwks) {
        const meta = await authorizationServerMetadata();
        jwks = createRemoteJWKSet(new URL(meta.jwks_uri ?? `${config.authkitIssuer}/oauth2/jwks`));
      }

      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.authkitIssuer,
        audience: config.mcpResourceUrl,
      });

      const claims = payload as JWTPayload & {
        sid?: string;
        org_id?: string;
        client_id?: string;
        azp?: string;
        scope?: string;
      };

      if (!claims.sub) throw new Error('Token has no subject');

      const info: BrainAuthInfo = {
        token,
        clientId: claims.client_id ?? claims.azp ?? 'unknown',
        scopes: typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [],
        expiresAt: claims.exp,
        resource: new URL(config.mcpResourceUrl),
        extra: {
          workosUserId: claims.sub,
          sessionId: claims.sid,
          organizationId: claims.org_id,
        },
      };
      return info;
    },
  };
}

export function workosUserId(auth: AuthInfo | undefined): string {
  const id = (auth?.extra as { workosUserId?: string } | undefined)?.workosUserId;
  if (!id) throw new Error('Unauthenticated: no WorkOS user on the request');
  return id;
}

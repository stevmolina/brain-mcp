import { OAuthError } from '@modelcontextprotocol/server';
import { decodeJwt, importSPKI, jwtVerify } from 'jose';

const issuer = 'urn:pokebots:integrations';
export const pokebotsScope = 'integration:use';

export function isPokebotsPrincipal(id: string): boolean {
  return id.startsWith('pokebots:');
}

export function claimsPokebotsIssuer(token: string): boolean {
  try {
    return decodeJwt(token).iss === issuer;
  } catch {
    return false;
  }
}

export function createPokebotsVerifier(publicKeyPem: string | undefined, workosIssuer: string) {
  let key: Awaited<ReturnType<typeof importSPKI>> | undefined;

  return async (token: string): Promise<{ principal: string; expiresAt: number }> => {
    try {
      if (!publicKeyPem) throw new Error();
      key ??= await importSPKI(publicKeyPem.replace(/\\n/g, '\n').trim(), 'RS256');
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['RS256'],
        issuer,
        audience: 'brain',
        requiredClaims: ['sub', 'iat', 'exp', 'scope'],
      });

      const { aud, sub, iat, exp, scope, linked_workos_sub: linked, linked_workos_iss: linkedIssuer } = payload;
      const now = Math.floor(Date.now() / 1000);
      if (
        aud !== 'brain' || scope !== pokebotsScope ||
        typeof sub !== 'string' || !/^pokebots:[A-Za-z0-9_-]{1,128}$(?![\s\S])/.test(sub) ||
        typeof iat !== 'number' || !Number.isSafeInteger(iat) || iat > now ||
        typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= now || exp - iat > 300 ||
        (linked !== undefined && (
          typeof linked !== 'string' || !/^user_[a-zA-Z0-9]+$(?![\s\S])/.test(linked) || linkedIssuer !== workosIssuer
        )) ||
        (linked === undefined && linkedIssuer !== undefined)
      ) {
        throw new Error();
      }

      return { principal: linked ?? sub, expiresAt: exp };
    } catch {
      throw new OAuthError('invalid_token', 'Invalid Pokebots integration token');
    }
  };
}

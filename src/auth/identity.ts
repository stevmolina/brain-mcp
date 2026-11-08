/**
 * Who a WorkOS user is, as far as sharing needs: their verified email and a
 * display name. A share names a person by email, so only an email WorkOS has
 * verified can open one; an unverified address gets nothing.
 */
import { loadConfig } from '../config.js';

export interface WorkosProfile {
  id: string;
  /** Lowercased, and only when WorkOS has verified it. */
  verifiedEmail: string | null;
  name: string;
}

const cache = new Map<string, { value: WorkosProfile | null; expiresAt: number }>();

export async function workosProfile(userId: string): Promise<WorkosProfile | null> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const { workosApiKey } = loadConfig();
  let value: WorkosProfile | null = null;
  try {
    const response = await fetch(`https://api.workos.com/user_management/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${workosApiKey}` },
    });
    if (response.ok) {
      const user = (await response.json()) as {
        id: string;
        email?: string;
        email_verified?: boolean;
        first_name?: string | null;
        last_name?: string | null;
      };
      const email = user.email?.trim().toLowerCase() ?? null;
      value = {
        id: user.id,
        verifiedEmail: email && user.email_verified ? email : null,
        name: [user.first_name, user.last_name].filter(Boolean).join(' ') || email || user.id,
      };
    }
  } catch (error) {
    console.error(JSON.stringify({ level: 'warn', at: 'identity', message: String(error) }));
  }
  // Short on failure so a WorkOS blip heals quickly; longer on success.
  cache.set(userId, { value, expiresAt: Date.now() + (value ? 10 * 60_000 : 30_000) });
  return value;
}

export async function verifiedEmailOf(userId: string): Promise<string | null> {
  return (await workosProfile(userId))?.verifiedEmail ?? null;
}

export function clearIdentityCache(): void {
  cache.clear();
}

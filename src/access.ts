// Cloudflare Access identity for the public deployment. Cloudflare signs every request it lets through with a
// JWT in Cf-Access-Jwt-Assertion; the server verifies it itself, so a request that bypasses Access is refused.
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { User } from './api.d.ts';

export interface AccessConfig {
  host: string;
  team: string;
  audience: string;
  // Lower-case Google email → account. Anyone else is refused even if the Access policy lets them in.
  users: ReadonlyMap<string, User>;
}

export interface AccessIdentity { email: string; user: User; expires: number }

type AccessKey = JsonWebKey & {kid?: string};
export type AccessKeySource = () => Promise<AccessKey[]>;

// A token problem: the request is answered 401. Anything else (e.g. keys unreachable) is an outage, not a denial.
export class AccessDenied extends Error {}

export const accessTeamHost = (team: string) => `${team}.cloudflareaccess.com`;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be set for HOME_CHAT_MODE=access`);
  return value;
}

export function accessConfigFromEnv(env: NodeJS.ProcessEnv): AccessConfig {
  const host = required(env, 'HOME_CHAT_PUBLIC_HOST').toLowerCase();
  const team = required(env, 'HOME_CHAT_ACCESS_TEAM').toLowerCase();
  const audience = required(env, 'HOME_CHAT_ACCESS_AUD');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw new Error('HOME_CHAT_PUBLIC_HOST must be a bare hostname');
  if (!/^[a-z0-9-]+$/.test(team)) throw new Error('HOME_CHAT_ACCESS_TEAM must be the team name only, without .cloudflareaccess.com');
  const users = new Map<string, User>([[required(env, 'HOME_CHAT_OWNER_EMAIL').toLowerCase(), 'owner']]);
  const guest = env.HOME_CHAT_GUEST_EMAIL?.trim().toLowerCase();
  if (guest) {
    if (users.has(guest)) throw new Error('Owner and guest emails must differ');
    users.set(guest, 'guest');
  }
  return {host, team, audience, users};
}

export function fetchAccessKeys(team: string): AccessKeySource {
  return async () => {
    const response = await fetch(`https://${accessTeamHost(team)}/cdn-cgi/access/certs`, {signal: AbortSignal.timeout(10_000)});
    if (!response.ok) throw new Error(`Cloudflare Access keys unavailable (HTTP ${response.status})`);
    const body = await response.json() as {keys?: unknown};
    if (!Array.isArray(body.keys)) throw new Error('Cloudflare Access keys response is malformed');
    return body.keys as AccessKey[];
  };
}

const KEY_MAX_AGE = 60 * 60_000;
const REFRESH_INTERVAL = 60_000;
const CLOCK_SKEW = 30;

function decodePart(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AccessDenied('Malformed Access token');
  return value as Record<string, unknown>;
}

export function createAccessVerifier(config: AccessConfig, source: AccessKeySource = fetchAccessKeys(config.team)) {
  const issuer = `https://${accessTeamHost(config.team)}`;
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;
  let attemptedAt = 0;
  let refreshing: Promise<void> | undefined;

  const refresh = () => refreshing ??= (async () => {
    attemptedAt = Date.now();
    try {
      const next = new Map<string, KeyObject>();
      for (const jwk of await source()) {
        if (typeof jwk.kid === 'string' && jwk.kty === 'RSA') next.set(jwk.kid, createPublicKey({key: jwk, format: 'jwk'}));
      }
      keys = next; fetchedAt = Date.now();
    } finally { refreshing = undefined; }
  })();

  // Keys rotate every six weeks and old ones stay valid for a week, so refresh hourly and on an unseen kid.
  // Attempts, failed ones included, happen at most once a minute, so neither forged kids nor a Cloudflare outage
  // turn into a request flood; during an outage the keys already held keep working.
  async function keyFor(kid: string): Promise<KeyObject> {
    const due = Date.now() - fetchedAt > KEY_MAX_AGE || !keys.has(kid);
    if (due && (refreshing || Date.now() - attemptedAt > REFRESH_INTERVAL)) {
      try { await refresh(); }
      catch (error) { if (!keys.has(kid)) throw error; }
    }
    const key = keys.get(kid);
    if (key) return key;
    if (!fetchedAt) throw new Error('Cloudflare Access keys have not been loaded yet');
    throw new AccessDenied('Access token signed with an unknown key');
  }

  return async function verifyAccess(token: string | undefined): Promise<AccessIdentity> {
    if (!token) throw new AccessDenied('Cloudflare Access sign-in required');
    const parts = token.split('.');
    if (parts.length !== 3) throw new AccessDenied('Malformed Access token');
    const [encodedHeader, encodedPayload, signature] = parts;
    let header, payload;
    try { header = decodePart(encodedHeader); payload = decodePart(encodedPayload); }
    catch { throw new AccessDenied('Malformed Access token'); }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AccessDenied('Unsupported Access token');
    const key = await keyFor(header.kid);
    if (!verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), key, Buffer.from(signature, 'base64url'))) {
      throw new AccessDenied('Invalid Access token signature');
    }
    const now = Date.now() / 1000;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== issuer || !audiences.includes(config.audience)) throw new AccessDenied('Access token is for another application');
    if (typeof payload.exp !== 'number' || payload.exp < now - CLOCK_SKEW) throw new AccessDenied('Access token expired');
    if (typeof payload.nbf === 'number' && payload.nbf > now + CLOCK_SKEW) throw new AccessDenied('Access token not yet valid');
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    const user = config.users.get(email);
    if (!user) throw new AccessDenied('This Google account is not allowed in Home Chat');
    return {email, user, expires: payload.exp * 1000};
  };
}

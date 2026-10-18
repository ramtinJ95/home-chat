import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import type { User } from './api.d.ts';
import { AccessDenied, createAccessVerifier, type AccessConfig, type AccessKeySource } from './access.ts';
import { atomicJson, readJson } from './files.ts';
import { fail, jsonBody, recent } from './http.ts';
import { isUser } from './policy.ts';

// Who a request comes from. Locally, an access code signs a browser in for 8 hours with a cookie, and the sessions are
// kept here; in the public deployment every request carries its own Cloudflare Access identity (src/access.ts).
interface Session { user: User; csrf: string; expires: number }

const digest = (text: string) => createHash('sha256').update(text).digest();

// Only hashes stay in memory; the plaintext codes are scoped to this call.
async function loadAccessHashes(path: string): Promise<[User, Buffer][]> {
  let access = await readJson<Record<string, unknown>>(path);
  if (!access) {
    access = {owner: randomBytes(32).toString('base64url'), guest: randomBytes(32).toString('base64url')};
    await atomicJson(path, access);
  }
  return Object.entries(access).map(([user, token]) => {
    if (!isUser(user) || typeof token !== 'string') throw new Error('Invalid local access file');
    return [user, digest(token)];
  });
}

// `path`: the local access codes, made on first start in either mode.
export async function createSignIn(path: string, access?: AccessConfig, accessKeys?: AccessKeySource) {
  const accessHashes = await loadAccessHashes(path);
  const sessions = new Map<string, Session>();
  const loginAttempts = new Map<string, number[]>();
  const verifyAccess = access && createAccessVerifier(access, accessKeys);
  // Access sessions are stateless: the CSRF token is derived from the verified email, so it survives page reloads.
  const csrfSecret = randomBytes(32);

  return {
    // A local sign-in with an access code. Returns the new session's cookie.
    async login(req: http.IncomingMessage): Promise<string> {
      const ip = req.socket.remoteAddress ?? '';
      const attempts = recent(loginAttempts, ip, 15 * 60_000);
      if (attempts.length >= 5) throw fail(429, 'Too many attempts; wait 15 minutes');
      attempts.push(Date.now());
      const body = await jsonBody(req, 1024);
      if (typeof body.code !== 'string' || body.code.length > 128) throw fail(401, 'Invalid access code');
      const candidate = digest(body.code);
      const user = accessHashes.find(([, expected]) => timingSafeEqual(candidate, expected))?.[0];
      if (!user) throw fail(401, 'Invalid access code');
      loginAttempts.delete(ip);
      // A browser stops sending a cookie once it expires, so an expired session is never presented again to be removed.
      for (const [key, held] of sessions) if (held.expires < Date.now()) sessions.delete(key);
      if (sessions.size >= 16) throw fail(429, 'Too many sessions');
      const token = randomBytes(32).toString('base64url');
      const session = {user, csrf: randomBytes(32).toString('base64url'), expires: Date.now() + 8 * 60 * 60_000};
      sessions.set(digest(token).toString('hex'), session);
      return `home_chat=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`;
    },
    async authenticate(req: http.IncomingMessage): Promise<{session: Session; sessionKey: string}> {
      if (verifyAccess) {
        const header = req.headers['cf-access-jwt-assertion'];
        let identity;
        try { identity = await verifyAccess(typeof header === 'string' ? header : undefined); }
        catch (error) {
          if (error instanceof AccessDenied) throw fail(401, error.message);
          throw fail(503, 'Could not verify the Cloudflare Access sign-in');
        }
        const csrf = createHmac('sha256', csrfSecret).update(identity.email).digest('base64url');
        return {sessionKey: 'access:' + identity.email, session: {user: identity.user, csrf, expires: identity.expires}};
      }
      const cookie = String(req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith('home_chat='))?.slice(10);
      const sessionKey = digest(cookie ?? '').toString('hex');
      const session = sessions.get(sessionKey);
      if (!session || session.expires < Date.now()) { sessions.delete(sessionKey); throw fail(401, 'Sign in required'); }
      return {session, sessionKey};
    },
    // Open streams end when their sign-in does: at logout, or at expiry (the Access token's own expiry under Access).
    live: (sessionKey: string, session: Session) =>
      session.expires >= Date.now() && (verifyAccess !== undefined || sessions.get(sessionKey) === session),
    // Returns the cookie that ends a local sign-in in the browser. Under Access the browser then leaves through
    // Cloudflare's own logout, which ends the real session.
    logout(sessionKey: string): string | undefined {
      sessions.delete(sessionKey);
      return access ? undefined : 'home_chat=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
    },
  };
}

import { createECDH, randomBytes, sign, type KeyObject } from 'node:crypto';

// Sets environment variables for the length of `run`, then puts back what was there.
export async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = {...process.env};
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return await run(); }
  finally { for (const key of Object.keys(env)) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
}

// A token in the shape Cloudflare Access signs, RS256 over the encoded header and claims.
export const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
export function signedToken(privateKey: KeyObject, header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const body = `${encode(header)}.${encode(claims)}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}

// The keys a browser's push subscription carries.
export const pushKeys = () => ({p256dh: createECDH('prime256v1').generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url')});

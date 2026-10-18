import assert from 'node:assert/strict';
import { createECDH, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

// Waits for `check` to pass and fails with `message` once `timeout` ms have gone by. For outcomes that arrive in their own
// time, such as a save on a busy disk, which a fixed wait only guesses at.
export async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 5000) {
  for (const deadline = Date.now() + timeout; !await check(); await delay(10)) {
    if (Date.now() > deadline) assert.fail(message);
  }
}

// A new directory under the system's temporary one, removed when the test ends.
export async function tempDir(t: TestContext, prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

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

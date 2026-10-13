import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { AccessDenied, accessConfigFromEnv, createAccessVerifier, type AccessConfig } from '../src/access.ts';

const config: AccessConfig = {
  host: 'home-chat.example.test',
  team: 'home',
  audience: 'aud-tag',
  users: new Map([['owner@example.test', 'owner'], ['guest@example.test', 'guest']]),
};

function keyPair(kid: string) {
  const {publicKey, privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  return {kid, privateKey, jwk: {...publicKey.export({format: 'jwk'}), kid, alg: 'RS256'}};
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(privateKey: KeyObject, claims: Record<string, unknown>, header: Record<string, unknown>) {
  const body = `${encode(header)}.${encode(claims)}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}

const now = () => Math.floor(Date.now() / 1000);
const validClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: 'https://home.cloudflareaccess.com', aud: ['aud-tag'], email: 'Owner@Example.test', exp: now() + 600, iat: now(), ...overrides,
});

test('valid Cloudflare Access tokens map the verified email to its account', async () => {
  const current = keyPair('k1');
  const verify = createAccessVerifier(config, async () => [current.jwk]);
  const identity = await verify(token(current.privateKey, validClaims(), {alg: 'RS256', kid: 'k1'}));
  assert.equal(identity.user, 'owner');
  assert.equal(identity.email, 'owner@example.test');
  assert.equal((await verify(token(current.privateKey, validClaims({email: 'guest@example.test', aud: 'aud-tag'}), {alg: 'RS256', kid: 'k1'}))).user, 'guest');
});

test('forged, foreign, expired and unlisted Access tokens are denied', async () => {
  const current = keyPair('k1');
  const attacker = keyPair('k1');
  const verify = createAccessVerifier(config, async () => [current.jwk]);
  const header = {alg: 'RS256', kid: 'k1'};
  const denied = [
    undefined,
    'not-a-token',
    token(attacker.privateKey, validClaims(), header),
    token(current.privateKey, validClaims({aud: ['another-app']}), header),
    token(current.privateKey, validClaims({iss: 'https://evil.cloudflareaccess.com'}), header),
    token(current.privateKey, validClaims({exp: now() - 120}), header),
    token(current.privateKey, validClaims({exp: undefined}), header),
    token(current.privateKey, validClaims({nbf: now() + 600}), header),
    token(current.privateKey, validClaims({email: 'stranger@example.test'}), header),
    token(current.privateKey, validClaims(), {alg: 'HS256', kid: 'k1'}),
    token(current.privateKey, validClaims(), {alg: 'none', kid: 'k1'}),
    `${encode({alg: 'RS256', kid: 'k1'})}.${encode(validClaims())}.`,
  ];
  for (const candidate of denied) await assert.rejects(() => verify(candidate), AccessDenied);
});

test('rotated keys are fetched by kid, but unknown kids cannot force constant refetches', async () => {
  const first = keyPair('k1');
  const second = keyPair('k2');
  let published = [first.jwk];
  let fetches = 0;
  const verify = createAccessVerifier(config, async () => { fetches++; return published; });
  await verify(token(first.privateKey, validClaims(), {alg: 'RS256', kid: 'k1'}));
  assert.equal(fetches, 1);
  // Within a minute of the last fetch, an unseen kid is denied without asking Cloudflare again.
  published = [first.jwk, second.jwk];
  await assert.rejects(() => verify(token(second.privateKey, validClaims(), {alg: 'RS256', kid: 'k2'})), AccessDenied);
  await assert.rejects(() => verify(token(second.privateKey, validClaims(), {alg: 'RS256', kid: 'nope'})), AccessDenied);
  assert.equal(fetches, 1);
});

test('Access key outages are errors, not denials, and failed fetches are throttled too', async () => {
  let fetches = 0;
  const verify = createAccessVerifier(config, async () => { fetches++; throw new Error('offline'); });
  const current = keyPair('k1');
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => verify(token(current.privateKey, validClaims(), {alg: 'RS256', kid: 'k1'})), error => !(error instanceof AccessDenied));
  }
  assert.equal(fetches, 1);
});

test('Access configuration is explicit and refuses ambiguous values', () => {
  const env = {
    HOME_CHAT_PUBLIC_HOST: 'Home-Chat.Example.test', HOME_CHAT_ACCESS_TEAM: 'home', HOME_CHAT_ACCESS_AUD: 'aud-tag',
    HOME_CHAT_OWNER_EMAIL: 'Owner@Example.test', HOME_CHAT_GUEST_EMAIL: 'guest@example.test',
  };
  const parsed = accessConfigFromEnv(env);
  assert.equal(parsed.host, 'home-chat.example.test');
  assert.deepEqual([...parsed.users], [['owner@example.test', 'owner'], ['guest@example.test', 'guest']]);
  assert.throws(() => accessConfigFromEnv({...env, HOME_CHAT_ACCESS_AUD: ''}));
  assert.throws(() => accessConfigFromEnv({...env, HOME_CHAT_ACCESS_TEAM: 'home.cloudflareaccess.com'}));
  assert.throws(() => accessConfigFromEnv({...env, HOME_CHAT_PUBLIC_HOST: 'https://home-chat.example.test'}));
  assert.throws(() => accessConfigFromEnv({...env, HOME_CHAT_GUEST_EMAIL: 'owner@example.test'}));
});

test('held keys survive a failed hourly refresh, and unseen kids are retried after a minute', async t => {
  t.mock.timers.enable({apis: ['Date']});
  const first = keyPair('k1');
  const second = keyPair('k2');
  let published: object[] | undefined = [first.jwk];
  let fetches = 0;
  const verify = createAccessVerifier(config, async () => {
    fetches++;
    if (!published) throw new Error('offline');
    return published as never;
  });
  const signed = (pair: ReturnType<typeof keyPair>) => token(pair.privateKey, validClaims(), {alg: 'RS256', kid: pair.kid});
  await verify(signed(first));
  // An hour later Cloudflare is unreachable: the refresh fails, but the key already held still verifies.
  published = undefined;
  t.mock.timers.tick(61 * 60_000);
  assert.equal((await verify(signed(first))).user, 'owner');
  assert.equal(fetches, 2);
  // Cloudflare is back with a rotated key; an unseen kid is fetched once the minute has passed.
  published = [first.jwk, second.jwk];
  await assert.rejects(() => verify(signed(second)), AccessDenied);
  t.mock.timers.tick(61_000);
  assert.equal((await verify(signed(second))).user, 'owner');
  assert.equal(fetches, 3);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { request as httpRequest } from 'node:http';
import type { Question, User } from '../src/api.d.ts';
import type { ChatWorker, WorkerEvents } from '../src/rpc.ts';
import { createApp, type AppOptions } from '../src/server.ts';

class FakePi extends EventEmitter<WorkerEvents> implements ChatWorker {
  busy = false;
  closed = false;
  question: Question | null = null;
  lastText?: string;
  async start() {}
  async prompt(text: string) {
    this.busy = true;
    this.lastText = text;
    const question: Question = this.question = {id: 'question-1', method: 'select', title: 'Choose', message: '', options: ['One', 'Two'], prefill: ''};
    setTimeout(() => { this.emit('delta', 'Hello <script>bad()</script>'); this.emit('question', question); }, 10);
  }
  answer(id: string, value: unknown) {
    if (id !== this.question?.id || !this.question.options.includes(value as string)) throw new Error('Invalid answer');
    this.question = null; this.busy = false; this.emit('settled');
  }
  async abort() { this.busy = false; this.emit('settled'); }
  stop() { this.closed = true; }
}

interface RequestOptions { method?: string; body?: unknown; cookie?: string; csrf?: string; headers?: Record<string, string> }
interface TestResponse { status: number; headers: Headers; json(): Promise<any>; text(): Promise<string> }

async function fixture(ready = true, {access, accessKeys}: Pick<AppOptions, 'access' | 'accessKeys'> = {}) {
  const data = await mkdtemp(join(tmpdir(), 'home-chat-server-'));
  const worker = new FakePi();
  const app = await createApp({data, workerFactory: () => worker, authenticatedProvider: async () => ready, access, accessKeys});
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const host = access?.host ?? '127.0.0.1:8787';
  const origin = (access ? 'https://' : 'http://') + host;
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const request = (path: string, {method = 'GET', body, cookie, csrf, headers = {}}: RequestOptions = {}) => {
    return new Promise<TestResponse>((resolve, reject) => {
      const request = httpRequest(base + path, {method, headers: {Host: host, Origin: origin, ...(body !== undefined ? {'Content-Type': 'application/json'} : {}), ...(cookie ? {Cookie: cookie} : {}), ...(csrf ? {'X-CSRF-Token': csrf} : {}), ...headers}}, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const responseHeaders = new Headers(Object.entries(response.headers).map(([key, value]): [string, string] => [key, Array.isArray(value) ? value.join('; ') : value ?? '']));
          resolve({status: response.statusCode ?? 0, headers: responseHeaders, json: async () => JSON.parse(text), text: async () => text});
        });
      });
      request.on('error', reject);
      request.end(body !== undefined ? JSON.stringify(body) : undefined);
    });
  };
  const codes: Record<User, string> = JSON.parse(await readFile(join(data, 'local-access.json'), 'utf8'));
  const login = async (user: User) => {
    const response = await request('/api/login', {method: 'POST', body: {code: codes[user]}});
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /HttpOnly; SameSite=Strict/);
    const cookie = setCookie.split(';')[0];
    const identity = await (await request('/api/me', {cookie})).json();
    return {cookie, csrf: identity.csrf as string};
  };
  return {request, login, worker, app, data, close: async () => { await app.stop(); await rm(data, {recursive: true}); }};
}

test('HTTP authentication, CSRF, host checks and cross-user conversation/asset protection', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/chats')).status, 401);
    assert.equal((await f.request('/', {headers: {Host: 'home-chat.handmadeoasis.com'}})).status, 421);
    assert.equal((await f.request('/api/login', {method: 'POST', body: {code: 'x'}, headers: {Origin: 'https://evil.test'}})).status, 403);
    const owner = await f.login('owner'); const guest = await f.login('guest');
    assert.equal((await f.request('/api/chats', {method: 'POST', body: {}, cookie: owner.cookie})).status, 403);
    const created = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    assert.equal((await f.request(`/api/chats/${created.id}`, guest)).status, 404);
    assert.equal((await f.request(`/api/chats/${created.id}/events`, guest)).status, 404);
    assert.deepEqual(await (await f.request('/api/chats', guest)).json(), []);
    const bytes = await sharp({create: {width: 2, height: 2, channels: 3, background: 'red'}}).png().toBuffer();
    const uploaded = await f.request(`/api/chats/${created.id}/uploads`, {method: 'POST', body: {mimeType: 'image/png', data: bytes.toString('base64')}, ...owner});
    assert.equal(uploaded.status, 201); const asset = await uploaded.json();
    assert.equal((await f.request(`/api/chats/${created.id}/assets/${asset.id}`, guest)).status, 404);
    assert.equal((await f.request(`/api/chats/${created.id}/assets/${asset.id}`, owner)).status, 200);
    assert.equal((await f.request(`/api/chats/${created.id}/assets/../../profile/auth.json`, owner)).status, 404);
    assert.equal((await f.request(`/api/chats/${created.id}/uploads`, {method: 'POST', body: {mimeType: 'image/png', data: Buffer.from('<svg/>').toString('base64')}, ...owner})).status, 400);
    const page = await f.request('/'); assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    await f.request('/api/logout', {method: 'POST', body: {}, ...owner});
    assert.equal((await f.request('/api/me', owner)).status, 401);
  } finally { await f.close(); }
});

test('mocked Pi streaming and structured questions stay in their conversation', async () => {
  const f = await fixture();
  try {
    const owner = await f.login('owner'); const guest = await f.login('guest');
    const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    assert.equal((await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: '/bash rm -rf /', assets: []}, ...owner})).status, 202);
    await delay(40);
    const state = await (await f.request(`/api/chats/${chat.id}`, owner)).json();
    assert.match(state.messages.at(-1).text, /<script>/);
    assert.equal(state.question.method, 'select');
    assert.equal((await f.request(`/api/chats/${chat.id}/answer`, {method: 'POST', body: {id: 'question-1', value: 'One'}, ...guest})).status, 404);
    assert.equal((await f.request(`/api/chats/${chat.id}/answer`, {method: 'POST', body: {id: 'wrong', value: 'One'}, ...owner})).status, 409);
    assert.equal((await f.request(`/api/chats/${chat.id}/answer`, {method: 'POST', body: {id: 'question-1', value: 'One'}, ...owner})).status, 200);
    await delay(30);
    assert.equal((await (await f.request(`/api/chats/${chat.id}`, owner)).json()).busy, false);
  } finally { await f.close(); }
});
test('owners delete their idle conversations and everything stored with them', async () => {
  const f = await fixture();
  try {
    const owner = await f.login('owner'); const guest = await f.login('guest');
    const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    assert.equal((await f.request(`/api/chats/${chat.id}`, {method: 'DELETE', ...guest})).status, 404);
    assert.equal((await f.request(`/api/chats/${chat.id}`, {method: 'DELETE', cookie: owner.cookie})).status, 403);
    assert.equal((await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'hello', assets: []}, ...owner})).status, 202);
    assert.equal((await f.request(`/api/chats/${chat.id}`, {method: 'DELETE', ...owner})).status, 409);
    await f.request(`/api/chats/${chat.id}/abort`, {method: 'POST', body: {}, ...owner});
    await delay(30);
    assert.equal((await f.request(`/api/chats/${chat.id}`, {method: 'DELETE', ...owner})).status, 200);
    assert.equal(f.worker.closed, true);
    assert.equal((await f.request(`/api/chats/${chat.id}`, owner)).status, 404);
    assert.deepEqual(await (await f.request('/api/chats', owner)).json(), []);
    await assert.rejects(access(join(f.data, 'chats', chat.id)));
    assert.deepEqual(await readdir(join(f.data, 'deleted')), []);
  } finally { await f.close(); }
});
test('unconfigured Codex never falls back to API billing or fabricated replies', async () => {
  const f = await fixture(false);
  try {
    const owner = await f.login('owner');
    const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    const response = await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'hello'}, ...owner});
    assert.equal(response.status, 503); assert.match((await response.json()).error, /not signed in/);
  } finally { await f.close(); }
});
test('local access-code guessing is rate limited', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await f.request('/api/login', {method: 'POST', body: {code: 'wrong'}})).status, 401);
    assert.equal((await f.request('/api/login', {method: 'POST', body: {code: 'wrong'}})).status, 429);
  } finally { await f.close(); }
});

test('Cloudflare Access mode admits only verified, listed Google accounts over the public hostname', async () => {
  const {publicKey, privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const access = {
    host: 'home-chat.example.test', team: 'home', audience: 'aud-tag',
    users: new Map<string, User>([['owner@example.test', 'owner'], ['guest@example.test', 'guest']]),
  };
  const f = await fixture(true, {access, accessKeys: async () => [{...publicKey.export({format: 'jwk'}), kid: 'k1'}]});
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signedIn = (email: string) => {
    const body = `${encode({alg: 'RS256', kid: 'k1'})}.${encode({iss: 'https://home.cloudflareaccess.com', aud: ['aud-tag'], email, exp: Math.floor(Date.now() / 1000) + 600})}`;
    return {'Cf-Access-Jwt-Assertion': `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`};
  };
  try {
    assert.equal((await f.request('/api/me')).status, 401);
    assert.equal((await f.request('/api/me', {headers: {...signedIn('owner@example.test'), Host: '127.0.0.1:8787'}})).status, 421);
    assert.equal((await f.request('/api/me', {headers: signedIn('stranger@example.test')})).status, 401);
    // Access codes are not a way in on the public hostname.
    const codes: Record<User, string> = JSON.parse(await readFile(join(f.data, 'local-access.json'), 'utf8'));
    assert.equal((await f.request('/api/login', {method: 'POST', body: {code: codes.owner}})).status, 401);
    const me = await (await f.request('/api/me', {headers: signedIn('owner@example.test')})).json();
    assert.equal(me.mode, 'access'); assert.equal(me.user, 'owner');
    const owner = {headers: signedIn('owner@example.test'), csrf: me.csrf as string};
    assert.equal((await f.request('/api/chats', {method: 'POST', body: {}, headers: owner.headers})).status, 403);
    assert.equal((await f.request('/api/chats', {method: 'POST', body: {}, ...owner, headers: {...owner.headers, Origin: 'http://home-chat.example.test'}})).status, 403);
    const created = await f.request('/api/chats', {method: 'POST', body: {}, ...owner});
    assert.equal(created.status, 201);
    const {id} = await created.json();
    assert.equal((await f.request(`/api/chats/${id}`, {headers: signedIn('guest@example.test')})).status, 404);
    assert.equal((await f.request(`/api/chats/${id}`, {headers: signedIn('owner@example.test')})).status, 200);
    assert.equal((await f.request('/healthz', {headers: {Host: 'anything'}})).status, 200);
  } finally { await f.close(); }
});

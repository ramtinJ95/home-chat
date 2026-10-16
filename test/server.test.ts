import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createECDH, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { request as httpRequest } from 'node:http';
import type { Question, User } from '../src/api.d.ts';
import type { ChatWorker, WorkerEvents } from '../src/rpc.ts';
import { createApp, type AppOptions } from '../src/server.ts';
import { documentTool } from '../profile/document.ts';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';

class FakePi extends EventEmitter<WorkerEvents> implements ChatWorker {
  busy = false;
  closed = false;
  question: Question | null = null;
  lastText?: string;
  lastDeep?: boolean;
  async start() {}
  async prompt(text: string, _images?: unknown, deep = false) {
    this.busy = true;
    this.lastText = text; this.lastDeep = deep;
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
interface TestResponse { status: number; headers: Headers; json(): Promise<any>; text(): Promise<string>; bytes(): Promise<Buffer> }

// Passing `data` from an earlier fixture starts a second app on the same volume, as a container restart would.
// Push requests the app sends, answered as a push service would (201) unless a test says otherwise.
interface Delivery { endpoint: string; headers: Record<string, string> }
async function fixture(ready = true, {access, accessKeys, data: existing, deepResearch}: Pick<AppOptions, 'access' | 'accessKeys' | 'data' | 'deepResearch'> = {}) {
  const data = existing ?? await mkdtemp(join(tmpdir(), 'home-chat-server-'));
  const worker = new FakePi();
  const deliveries: Delivery[] = [];
  let pushStatus = 201;
  const pushFetch = (async (endpoint: string, init: RequestInit) => {
    deliveries.push({endpoint, headers: init.headers as Record<string, string>});
    return new Response(null, {status: pushStatus});
  }) as typeof fetch;
  const app = await createApp({data, workerFactory: () => worker, authenticatedProvider: async () => ready, access, accessKeys, pushFetch, deepResearch});
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
          const bytes = Buffer.concat(chunks); const text = bytes.toString('utf8');
          const responseHeaders = new Headers(Object.entries(response.headers).map(([key, value]): [string, string] => [key, Array.isArray(value) ? value.join('; ') : value ?? '']));
          resolve({status: response.statusCode ?? 0, headers: responseHeaders, json: async () => JSON.parse(text), text: async () => text, bytes: async () => bytes});
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
  // An open event stream, as a page in view keeps; resolves once the first snapshot has arrived.
  const watch = (path: string, cookie: string) => new Promise<() => void>((resolve, reject) => {
    const request = httpRequest(base + path, {headers: {Host: host, Cookie: cookie}}, response => {
      response.once('data', () => resolve(() => request.destroy()));
    });
    request.on('error', reject);
    request.end();
  });
  return {request, login, watch, worker, app, data, deliveries, setPushStatus: (status: number) => { pushStatus = status; },
    close: async () => { await app.stop(); await rm(data, {recursive: true}); }};
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
test('documents saved during a reply are attached to it, readable, downloadable and revisable', async () => {
  const f = await fixture();
  try {
    const owner = await f.login('owner'); const guest = await f.login('guest');
    const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    const ctx = {cwd: join(f.data, 'chats', chat.id, 'work')} as ExtensionToolContext;
    // One turn: the tool runs while the reply is open, and the reply settles when the question is answered.
    const turn = async (text: string, save: () => Promise<unknown>) => {
      assert.equal((await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text, assets: []}, ...owner})).status, 202);
      await delay(40); await save();
      assert.equal((await f.request(`/api/chats/${chat.id}/answer`, {method: 'POST', body: {id: 'question-1', value: 'One'}, ...owner})).status, 200);
      await delay(40);
      return (await f.request(`/api/chats/${chat.id}`, owner)).json();
    };
    let state = await turn('Plan my weekend', () => documentTool.execute('1', {title: 'Weekend: plan', markdown: '| Day | Plan |\n|---|---|\n| Sat | Market |'}, undefined, undefined, ctx));
    const [card] = state.assets;
    const doc = card.document.doc;
    assert.match(doc, /^doc_[0-9a-f]{32}$/);
    assert.deepEqual(card.document, {doc, title: 'Weekend: plan', version: 1});
    assert.deepEqual(state.messages[1].assets, [card.id]);
    const url = `/api/chats/${chat.id}/assets/${card.id}`;
    assert.deepEqual(await (await f.request(url, owner)).json(), {title: 'Weekend: plan', markdown: '| Day | Plan |\n|---|---|\n| Sat | Market |', version: 1});
    assert.equal((await f.request(url, guest)).status, 404);
    const download = await f.request(url + '?download=1', owner);
    assert.match(download.headers.get('content-type') ?? '', /^text\/markdown/);
    assert.equal(download.headers.get('content-disposition'), `attachment; filename="Weekend-plan.md"; filename*=UTF-8''Weekend%3A%20plan.md`);
    assert.match(await download.text(), /^# Weekend: plan\n\n\| Day/);
    // A document is not a picture the model can be sent.
    assert.equal((await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'x', assets: [card.id]}, ...owner})).status, 400);
    state = await turn('Make Saturday a museum day', () => documentTool.execute('2', {title: 'Weekend plan', markdown: 'Museum', revises: doc}, undefined, undefined, ctx));
    assert.deepEqual(state.assets.map((asset: {document: unknown}) => asset.document), [
      {doc, title: 'Weekend: plan', version: 1}, {doc, title: 'Weekend plan', version: 2}]);
    assert.deepEqual(state.messages[3].assets, [state.assets[1].id]);
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
test('a restart keeps conversations and the streamed part of an unfinished reply', async () => {
  const f = await fixture();
  try {
    const owner = await f.login('owner');
    const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    assert.equal((await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'hello', assets: []}, ...owner})).status, 202);
    await delay(40);
    await f.app.stop();
    const restarted = await fixture(true, {data: f.data});
    try {
      const again = await restarted.login('owner');
      const state = await (await restarted.request(`/api/chats/${chat.id}`, again)).json();
      assert.equal(state.title, 'hello'); assert.equal(state.busy, false); assert.equal(state.question, null);
      assert.equal(state.messages[0].text, 'hello');
      assert.match(state.messages[1].text, /^Hello/);
      assert.match(state.messages[1].error, /restarted before this reply finished/);
      assert.equal((await restarted.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'again', assets: []}, ...again})).status, 202);
    } finally { await restarted.app.stop(); }
  } finally { await rm(f.data, {recursive: true}); }
});
test('a crash mid-reply or mid-creation is recovered when the app comes back', async () => {
  const f = await fixture();
  try {
    const owner = await f.login('owner');
    const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    assert.equal((await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'hello', assets: []}, ...owner})).status, 202);
    await delay(40);
    const unfinished = join(f.data, 'chats', randomUUID());
    await mkdir(join(unfinished, 'work/uploads'), {recursive: true});
    // The first app is never stopped, so the second sees only what was saved when the message was admitted.
    const restarted = await fixture(true, {data: f.data});
    try {
      const again = await restarted.login('owner');
      const state = await (await restarted.request(`/api/chats/${chat.id}`, again)).json();
      assert.equal(state.busy, false);
      assert.equal(state.messages[1].text, '');
      assert.match(state.messages[1].error, /restarted before this reply finished/);
      await assert.rejects(access(unfinished));
      assert.equal((await (await restarted.request('/api/chats', again)).json()).length, 1);
    } finally { await restarted.app.stop(); }
  } finally { await f.close(); }
});
test('the Home Screen manifest and every icon it names are served', async () => {
  const f = await fixture();
  try {
    const manifest = await f.request('/manifest.webmanifest');
    assert.equal(manifest.status, 200); assert.match(manifest.headers.get('content-type') ?? '', /^application\/manifest\+json/);
    const {display, start_url: start, icons} = await manifest.json();
    assert.equal(display, 'standalone'); assert.equal(start, '/');
    assert.ok(icons.some((item: {purpose: string}) => item.purpose === 'maskable'));
    const apple = (await (await f.request('/')).text()).match(/rel="apple-touch-icon" href="([^"]+)"/)?.[1];
    assert.ok(apple);
    for (const {src, sizes} of [...icons, {src: apple, sizes: '180x180'}]) {
      const response = await f.request(src);
      assert.equal(response.status, 200, src); assert.equal(response.headers.get('content-type'), 'image/png');
      const {width, height, format} = await sharp(await response.bytes()).metadata();
      assert.equal(`${width}x${height}`, sizes); assert.equal(format, 'png');
    }
    assert.match((await f.request('/')).headers.get('content-security-policy') ?? '', /manifest-src 'self'/);
  } finally { await f.close(); }
});
test('push notifications reach a device only while nobody is looking', async () => {
  const f = await fixture();
  try {
    const owner = await f.login('owner');
    const {publicKey} = await (await f.request('/api/push', owner)).json();
    assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
    const keys = {p256dh: createECDH('prime256v1').generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url')};
    const device = {endpoint: 'https://web.push.apple.com/device-1', keys};
    assert.equal((await f.request('/api/push/subscriptions', {method: 'POST', body: {...device, endpoint: 'https://evil.test/x'}, ...owner})).status, 400);
    assert.equal((await f.request('/api/push/subscriptions', {method: 'POST', body: device, ...owner})).status, 200);
    // Sending the same subscription again, as every page load does, adds no second confirmation.
    assert.equal((await f.request('/api/push/subscriptions', {method: 'POST', body: device, ...owner})).status, 200);
    await delay(20);
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.deliveries[0].endpoint, device.endpoint);
    assert.equal(f.deliveries[0].headers['Content-Encoding'], 'aes128gcm');
    assert.match(f.deliveries[0].headers.Authorization, /^vapid t=.+, k=/);

    // Nobody watching: the question and the finished reply both notify.
    const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    assert.equal((await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'hello', assets: []}, ...owner})).status, 202);
    await delay(40);
    assert.equal(f.deliveries.length, 2);
    assert.equal((await f.request(`/api/chats/${chat.id}/answer`, {method: 'POST', body: {id: 'question-1', value: 'One'}, ...owner})).status, 200);
    await delay(30);
    assert.equal(f.deliveries.length, 3);

    // Watching: an open stream means the page is in view, so nothing is sent.
    const stop = await f.watch(`/api/chats/${chat.id}/events`, owner.cookie);
    assert.equal((await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'again', assets: []}, ...owner})).status, 202);
    await delay(40);
    await f.request(`/api/chats/${chat.id}/answer`, {method: 'POST', body: {id: 'question-1', value: 'Two'}, ...owner});
    await delay(30);
    assert.equal(f.deliveries.length, 3);
    stop();

    // A push service that says the subscription is gone (410) removes it; later turns send nothing.
    f.setPushStatus(410);
    await delay(20);
    assert.equal((await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'third', assets: []}, ...owner})).status, 202);
    await delay(40);
    assert.equal(f.deliveries.length, 4);
    await f.request(`/api/chats/${chat.id}/answer`, {method: 'POST', body: {id: 'question-1', value: 'One'}, ...owner});
    await delay(30);
    assert.equal(f.deliveries.length, 4);
    assert.deepEqual(JSON.parse(await readFile(join(f.data, 'push/subscriptions.json'), 'utf8')), []);

    // Signing out takes the device's subscription with it.
    f.setPushStatus(201);
    const second = {endpoint: 'https://fcm.googleapis.com/fcm/send/device-2', keys};
    assert.equal((await f.request('/api/push/subscriptions', {method: 'POST', body: second, ...owner})).status, 200);
    assert.equal((await f.request('/api/logout', {method: 'POST', body: {pushEndpoint: second.endpoint}, ...owner})).status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(f.data, 'push/subscriptions.json'), 'utf8')), []);
  } finally { await f.close(); }
});
test('deep research is a per-conversation switch that is kept and reaches every message', async () => {
  const off = await fixture(true, {deepResearch: false});
  try {
    const owner = await off.login('owner');
    assert.equal((await (await off.request('/api/me', owner)).json()).deepResearch, false);
    const chat = await (await off.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    assert.equal(chat.deepResearch, false);
    assert.equal((await off.request(`/api/chats/${chat.id}/research`, {method: 'POST', body: {on: true}, ...owner})).status, 503);
  } finally { await off.close(); }
  const f = await fixture(true, {deepResearch: true});
  try {
    const owner = await f.login('owner'); const guest = await f.login('guest');
    assert.equal((await (await f.request('/api/me', owner)).json()).deepResearch, true);
    const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    const research = (on: unknown, as = owner) => f.request(`/api/chats/${chat.id}/research`, {method: 'POST', body: {on}, ...as});
    assert.equal((await research(true, guest)).status, 404);
    assert.equal((await research('yes')).status, 400);
    assert.equal((await (await research(true)).json()).deepResearch, true);
    assert.equal((await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'Compare heat pumps', assets: []}, ...owner})).status, 202);
    assert.equal(f.worker.lastDeep, true);
    // Mid-reply the switch waits, so the running reply's mode never changes under it.
    assert.equal((await research(false)).status, 409);
    await f.request(`/api/chats/${chat.id}/answer`, {method: 'POST', body: {id: 'question-1', value: 'One'}, ...owner});
    await delay(30);
    await f.app.stop();
    const restarted = await fixture(true, {data: f.data, deepResearch: true});
    try {
      const again = await restarted.login('owner');
      assert.equal((await (await restarted.request(`/api/chats/${chat.id}`, again)).json()).deepResearch, true);
      const switched = await restarted.request(`/api/chats/${chat.id}/research`, {method: 'POST', body: {on: false}, ...again});
      assert.equal((await switched.json()).deepResearch, false);
      assert.equal((await restarted.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'hi', assets: []}, ...again})).status, 202);
      assert.equal(restarted.worker.lastDeep, false);
      await restarted.request(`/api/chats/${chat.id}/answer`, {method: 'POST', body: {id: 'question-1', value: 'One'}, ...again});
      await delay(30);
      assert.equal((await restarted.request(`/api/chats/${chat.id}/research`, {method: 'POST', body: {on: true}, ...again})).status, 200);
    } finally { await restarted.app.stop(); }
    // Without the key the saved switch counts as off, in the app and for new messages.
    const keyless = await fixture(true, {data: f.data, deepResearch: false});
    try {
      const again = await keyless.login('owner');
      assert.equal((await (await keyless.request(`/api/chats/${chat.id}`, again)).json()).deepResearch, false);
      assert.equal((await keyless.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'hi', assets: []}, ...again})).status, 202);
      assert.equal(keyless.worker.lastDeep, false);
    } finally { await keyless.app.stop(); }
  } finally { await rm(f.data, {recursive: true}); }
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

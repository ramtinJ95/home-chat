import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { request as httpRequest } from 'node:http';
import type { Question, User } from '../src/api.d.ts';
import { PiRejected, type ChatWorker, type WorkerEvents } from '../src/rpc.ts';
import type { TurnMode } from '../src/policy.ts';
import { createApp, type AppOptions } from '../src/server.ts';
import { documentTool } from '../profile/document.ts';
import { callServer } from '../profile/internal.ts';
import { memoryTool } from '../profile/memory.ts';
import { routineTool } from '../profile/routine.ts';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { pushKeys, signedToken, withEnv } from './helpers.ts';

class FakePi extends EventEmitter<WorkerEvents> implements ChatWorker {
  closed = false;
  question: Question | null = null;
  // What the server gave Pi for its routine tool.
  env: Record<string, string> = {};
  lastText?: string;
  lastDeep?: boolean;
  lastMode?: TurnMode;
  async start() {}
  // Fails the next prompt: rejected, as Pi does before it records the message, or timed out, when nobody knows.
  failNext?: 'rejected' | 'timeout';
  async prompt(text: string, _images?: unknown, mode: TurnMode = {}) {
    const failure = this.failNext; this.failNext = undefined;
    if (failure) throw failure === 'rejected' ? new PiRejected('rejected') : new Error('Pi command timed out');
    this.lastText = text; this.lastMode = mode; this.lastDeep = mode.deepResearch === true;
    const question: Question = this.question = {id: 'question-1', method: 'select', title: 'Choose', message: '', options: ['One', 'Two'], prefill: ''};
    setTimeout(() => { this.emit('delta', 'Hello <script>bad()</script>'); this.emit('question', question); }, 10);
  }
  answer(id: string, value: unknown) {
    if (id !== this.question?.id || !this.question.options.includes(value as string)) throw new Error('Invalid answer');
    this.question = null; this.emit('settled');
  }
  // The texts regenerate and edit asked Pi to go back over.
  rewound: string[] = [];
  // What Pi reports: whether its last message carried the text.
  rewindMatches = true;
  async rewind(text: string) { this.rewound.push(text); return this.rewindMatches; }
  async abort() { this.emit('settled'); }
  stop() { this.closed = true; }
}

interface RequestOptions { method?: string; body?: unknown; cookie?: string; csrf?: string; headers?: Record<string, string> }
interface TestResponse { status: number; headers: Headers; json(): Promise<any>; text(): Promise<string>; bytes(): Promise<Buffer> }

// Passing `data` from an earlier fixture starts a second app on the same volume, as a container restart would.
// Push requests the app sends, answered as a push service would (201) unless a test says otherwise.
interface Delivery { endpoint: string; headers: Record<string, string> }
// `ready` may be a function, to hold the Codex sign-in check that every turn waits on.
async function fixture(ready: boolean | (() => Promise<boolean>) = true, {access, accessKeys, data: existing, deepResearch}: Pick<AppOptions, 'access' | 'accessKeys' | 'data' | 'deepResearch'> = {}) {
  const data = existing ?? await mkdtemp(join(tmpdir(), 'home-chat-server-'));
  const worker = new FakePi();
  const deliveries: Delivery[] = [];
  let pushStatus = 201;
  const pushFetch = (async (endpoint: string, init: RequestInit) => {
    deliveries.push({endpoint, headers: init.headers as Record<string, string>});
    return new Response(null, {status: pushStatus});
  }) as typeof fetch;
  const app = await createApp({data, workerFactory: (_directory, env) => { worker.env = env; return worker; }, authenticatedProvider: typeof ready === 'function' ? ready : async () => ready, access, accessKeys, pushFetch, deepResearch});
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
    const keys = pushKeys();
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
// Pi's side of the internal socket runs under withEnv, with the socket and token the server gave the worker.
const resultText = (result: {content: unknown[]}) => (result.content[0] as {text: string}).text;
const callRoutine = (env: Record<string, string>, params: Record<string, unknown>) =>
  withEnv(env, async () => resultText(await routineTool.execute('call', params as never, undefined, undefined, {} as ExtensionToolContext)));
// The memory tool, with the user answering its confirmation with `answer`; what it asked is added to `asked`.
const callMemory = (env: Record<string, string>, params: Record<string, unknown>, answer: boolean, asked: string[] = []) =>
  withEnv(env, async () => resultText(await memoryTool.execute('call', params as never, undefined, undefined,
    {ui: {confirm: async (title: string, message: string) => { asked.push(`${title} ${message}`); return answer; }}} as unknown as ExtensionToolContext)));
test('routines are set up by the model, listed and switched in the app, and kept apart per person', async () => {
  const f = await fixture();
  try {
    const owner = await f.login('owner'); const guest = await f.login('guest');
    const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    assert.equal((await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'Brief me every morning', assets: []}, ...owner})).status, 202);
    await delay(40);
    const created = await callRoutine(f.worker.env, {action: 'create', title: 'Morning briefing', prompt: 'Weather and news for Stockholm',
      schedule: {kind: 'daily', time: '07:30'}});
    assert.match(created, /^Saved “Morning briefing”: Every day at 07:30\. Next run: (Today|Tomorrow) 07:30\./);
    await assert.rejects(() => callRoutine({...f.worker.env, HOME_CHAT_INTERNAL_TOKEN: 'forged'}, {action: 'list'}), /cannot reach Home Chat/);
    await assert.rejects(() => callRoutine(f.worker.env, {action: 'create', title: 'Hourly', prompt: 'x', schedule: {kind: 'hourly', time: '07:00'}}), /schedule.kind/);
    const [routine] = await (await f.request('/api/routines', owner)).json();
    assert.equal(routine.title, 'Morning briefing'); assert.equal(routine.schedule, 'Every day at 07:30'); assert.equal(routine.unread, false);
    assert.deepEqual(await (await f.request('/api/routines', guest)).json(), []);
    const listed = await (await f.request('/api/chats', owner)).json();
    assert.deepEqual(listed.find((item: {id: string}) => item.id === routine.chat), {id: routine.chat, title: 'Morning briefing', unread: false, routine: true});
    assert.equal((await (await f.request(`/api/chats/${routine.chat}`, owner)).json()).routine.id, routine.id);
    assert.equal((await f.request(`/api/routines/${routine.id}`, {method: 'POST', body: {enabled: false}, ...guest})).status, 404);
    const paused = await (await f.request(`/api/routines/${routine.id}`, {method: 'POST', body: {enabled: false}, ...owner})).json();
    assert.equal(paused.next, 'Paused');
    assert.match(await callRoutine(f.worker.env, {action: 'list'}), new RegExp(`“Morning briefing” \\(id ${routine.id}\\): Every day at 07:30; Paused`));
    assert.match(await callRoutine(f.worker.env, {action: 'update', id: routine.id, schedule: {kind: 'weekly', time: '08:00', days: ['sat']}}), /Saturdays at 08:00/);
    // The routine's conversation goes only after the routine does, and then like any other.
    assert.equal((await f.request(`/api/chats/${routine.chat}`, {method: 'DELETE', ...owner})).status, 409);
    assert.match(await callRoutine(f.worker.env, {action: 'delete', id: routine.id}), /earlier results stay/);
    assert.deepEqual(await (await f.request('/api/routines', owner)).json(), []);
    assert.equal((await (await f.request(`/api/chats/${routine.chat}`, owner)).json()).routine, null);
    assert.equal((await f.request(`/api/chats/${routine.chat}`, {method: 'DELETE', ...owner})).status, 200);
  } finally { await f.close(); }
});
test('a due routine runs unattended in its own conversation, is marked unread, and a run missed for hours is skipped', async () => {
  const f = await fixture();
  try {
    const owner = await f.login('owner');
    const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'Brief me', assets: []}, ...owner});
    await delay(40);
    await callRoutine(f.worker.env, {action: 'create', title: 'Morning briefing', prompt: 'Weather and news', schedule: {kind: 'daily', time: '07:30'}});
    await f.app.stop();
    // As if the app had been down at 07:30: due a minute ago, so it still runs.
    const path = join(f.data, 'routines.json');
    const due = (ago: number) => readFile(path, 'utf8').then(text => {
      const [routine] = JSON.parse(text); routine.nextRun = new Date(Date.now() - ago).toISOString();
      return writeFile(path, JSON.stringify([routine])).then(() => routine);
    });
    const routine = await due(60_000);
    const restarted = await fixture(true, {data: f.data});
    try {
      await delay(60);
      assert.equal(restarted.worker.lastText, 'Weather and news');
      assert.match(restarted.worker.lastMode?.routineRun ?? '', /^\w+day \d+ \w+, \d{2}:\d{2}$/);
      await assert.rejects(() => callRoutine(restarted.worker.env, {action: 'list'}), /during a routine run/);
      // Nobody can confirm a note during the run, but the run is still told the notes.
      await assert.rejects(() => callMemory(restarted.worker.env, {action: 'remember', text: 'Early riser'}, true), /during a routine run/);
      assert.equal(await withEnv(restarted.worker.env, () => callServer('/memory')), '');
      restarted.worker.answer('question-1', 'One');
      await delay(40);
      const again = await restarted.login('owner');
      const [summary] = await (await restarted.request('/api/routines', again)).json();
      assert.equal(summary.unread, true);
      const state = await (await restarted.request(`/api/chats/${routine.chat}`, again)).json();
      assert.match(state.messages[0].run, /^Morning briefing · /);
      assert.match(state.messages[1].text, /^Hello/);
      assert.equal((await (await restarted.request('/api/routines', again)).json())[0].unread, false);
    } finally { await restarted.app.stop(); }
    await due(5 * 60 * 60_000);
    const late = await fixture(true, {data: f.data});
    try {
      await delay(60);
      const again = await late.login('owner');
      const state = await (await late.request(`/api/chats/${routine.chat}`, again)).json();
      assert.equal(state.messages.length, 3);
      assert.match(state.messages[2].error, /skipped: Home Chat was not running/);
      assert.equal(late.worker.lastText, undefined);
    } finally { await late.app.stop(); }
  } finally { await rm(f.data, {recursive: true}); }
});
test('a routine paused while its run waits in line does not run', async () => {
  const f = await fixture();
  try {
    const owner = await f.login('owner');
    const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'Set up two routines', assets: []}, ...owner});
    await delay(40);
    for (const title of ['First', 'Second']) {
      await callRoutine(f.worker.env, {action: 'create', title, prompt: title + ' task', schedule: {kind: 'daily', time: '07:30'}});
    }
    f.worker.answer('question-1', 'One');
    await delay(30);
    await f.app.stop();
    // Both came due a minute ago; one person runs one reply at a time, so Second waits behind First.
    const path = join(f.data, 'routines.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    for (const routine of saved) routine.nextRun = new Date(Date.now() - 60_000).toISOString();
    await writeFile(path, JSON.stringify(saved));
    const restarted = await fixture(true, {data: f.data});
    try {
      await delay(60);
      assert.equal(restarted.worker.lastText, 'First task');
      const again = await restarted.login('owner');
      const second = saved.find((routine: {title: string}) => routine.title === 'Second');
      assert.equal((await restarted.request(`/api/routines/${second.id}`, {method: 'POST', body: {enabled: false}, ...again})).status, 200);
      restarted.worker.answer('question-1', 'One');
      await delay(60);
      assert.equal(restarted.worker.lastText, 'First task');
      const after = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(after.find((routine: {id: string}) => routine.id === second.id).lastRun.outcome, 'skipped');
    } finally { await restarted.app.stop(); }
  } finally { await rm(f.data, {recursive: true}); }
});
test('the last turn can be regenerated or edited and sent again, and only the last turn', async () => {
  const f = await fixture();
  try {
    const owner = await f.login('owner');
    const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    const send = (body: Record<string, unknown>) => f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {assets: [], ...body}, ...owner});
    assert.equal((await send({text: 'Nothing to redo yet', replace: true})).status, 409);
    assert.equal((await send({text: 'Plan a picnic'})).status, 202);
    await delay(40);
    // Not while the reply runs or waits on its question.
    assert.equal((await send({text: 'Plan a picnic', replace: true})).status, 409);
    f.worker.answer('question-1', 'One');
    await delay(30);
    assert.equal((await send({text: 'Plan a picnic', replace: 'yes'})).status, 400);
    assert.equal((await send({text: 'Plan a picnic for four', replace: true})).status, 202);
    await delay(40);
    // Pi went back over the original message, and the conversation shows only the new turn.
    assert.deepEqual(f.worker.rewound, ['Plan a picnic']);
    assert.equal(f.worker.lastText, 'Plan a picnic for four');
    const state = await (await f.request(`/api/chats/${chat.id}`, owner)).json();
    assert.deepEqual(state.messages.map((message: {role: string; text: string}) => [message.role, message.text.slice(0, 5)]), [['user', 'Plan '], ['assistant', 'Hello']]);
    assert.equal(state.messages[0].text, 'Plan a picnic for four');
    f.worker.answer('question-1', 'One');
    await delay(30);
    // A message Pi rejected never reached it, so redoing it goes back over nothing, even when the text is the same.
    f.worker.failNext = 'rejected';
    assert.equal((await send({text: 'Plan a picnic for four'})).status, 503);
    assert.equal((await send({text: 'Plan a picnic for four', replace: true})).status, 202);
    await delay(40);
    assert.deepEqual(f.worker.rewound, ['Plan a picnic']);
    assert.equal((await (await f.request(`/api/chats/${chat.id}`, owner)).json()).messages.length, 4);
    f.worker.answer('question-1', 'One');
    await delay(30);
    // If Pi's copy does not end with the message, nothing is redone.
    f.worker.rewindMatches = false;
    assert.equal((await send({text: 'Something else', replace: true})).status, 409);
    assert.equal((await (await f.request(`/api/chats/${chat.id}`, owner)).json()).messages.at(-2).text, 'Plan a picnic for four');
    // Whether Pi recorded a message that timed out is unknown, so it cannot be redone.
    f.worker.rewindMatches = true;
    f.worker.failNext = 'timeout';
    assert.equal((await send({text: 'Plan a picnic for four'})).status, 503);
    const response = await send({text: 'Plan a picnic for four', replace: true});
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /cut off before Pi confirmed it/);
  } finally { await f.close(); }
});
test('search covers only the signed-in person\'s own conversations', async () => {
  const f = await fixture();
  try {
    const owner = await f.login('owner'); const guest = await f.login('guest');
    const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'Find the lasagne recipe', assets: []}, ...owner});
    await delay(40);
    const results = await (await f.request('/api/search?q=' + encodeURIComponent('LASAGNE'), owner)).json();
    assert.deepEqual(results, [{chat: chat.id, title: 'Find the lasagne recipe', message: 0, snippet: 'Find the lasagne recipe', marks: [[9, 16]]}]);
    // The reply streamed so far is searchable too, as plain text.
    assert.deepEqual((await (await f.request('/api/search?q=hello', owner)).json()).map((item: {message: number}) => item.message), [1]);
    assert.deepEqual(await (await f.request('/api/search?q=lasagne', guest)).json(), []);
    assert.deepEqual(await (await f.request('/api/search?q=', owner)).json(), []);
    assert.equal((await f.request('/api/search?q=' + 'x'.repeat(201), owner)).status, 400);
    assert.equal((await f.request('/api/search?q=lasagne')).status, 401);
  } finally { await f.close(); }
});
test('the model suggests household notes, saved only after a yes, and About us shows and edits them per person', async () => {
  const f = await fixture();
  try {
    const owner = await f.login('owner'); const guest = await f.login('guest');
    const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
    await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'I am vegetarian, and we live in Stockholm', assets: []}, ...owner});
    await delay(40);
    const asked: string[] = [];
    assert.match(await callMemory(f.worker.env, {action: 'remember', text: 'Vegetarian'}, false, asked), /said no/);
    assert.deepEqual((await (await f.request('/api/memory', owner)).json()).mine, []);
    // A change that cannot be made fails before the user is asked.
    await assert.rejects(() => callMemory(f.worker.env, {action: 'forget', text: 'Never said'}, true, asked), /no such note/);
    assert.match(await callMemory(f.worker.env, {action: 'remember', text: 'Vegetarian'}, true, asked), /Saved under About us/);
    await callMemory(f.worker.env, {action: 'remember', text: 'We live in Stockholm', shared: true}, true, asked);
    assert.deepEqual(asked, ['Remember this about you? Vegetarian', 'Remember this about you? Vegetarian', 'Remember this for the whole household? We live in Stockholm']);
    assert.match(await withEnv(f.worker.env, () => callServer('/memory')), /talking to:\n- Vegetarian\nShared by the household:\n- We live in Stockholm\n$/);
    assert.deepEqual(await (await f.request('/api/memory', guest)).json(), {version: 2, mine: [], shared: ['We live in Stockholm']});
    // The settings page replaces both lists, unless they changed since it loaded them.
    const view = await (await f.request('/api/memory', owner)).json();
    const edited = await f.request('/api/memory', {method: 'PUT', body: {version: view.version, mine: ['Vegan'], shared: view.shared}, ...owner});
    assert.equal(edited.status, 200);
    assert.deepEqual((await edited.json()).mine, ['Vegan']);
    assert.equal((await f.request('/api/memory', {method: 'PUT', body: {version: view.version, mine: [], shared: []}, ...owner})).status, 409);
    assert.equal((await f.request('/api/memory', {method: 'PUT', body: {version: view.version + 1, mine: ['x'.repeat(301)], shared: []}, ...owner})).status, 400);
    assert.equal((await f.request('/api/memory', {method: 'PUT', body: {version: view.version + 1, mine: [], shared: []}, cookie: owner.cookie})).status, 403);
    assert.equal((await f.request('/api/memory', {method: 'PUT', body: {version: view.version + 1, mine: [], shared: []}})).status, 401);
    assert.deepEqual((await (await f.request('/api/memory', guest)).json()).mine, []);
  } finally { await f.close(); }
});
// A routine whose run waits at the next start. The run's Codex sign-in check, the restarted app's first, is held so a
// test can act while the run is being admitted; later checks, such as a log-in's, are not.
async function heldRoutineRun() {
  const f = await fixture();
  const owner = await f.login('owner');
  const chat = await (await f.request('/api/chats', {method: 'POST', body: {}, ...owner})).json();
  await f.request(`/api/chats/${chat.id}/messages`, {method: 'POST', body: {text: 'Set up a routine', assets: []}, ...owner});
  await delay(40);
  await callRoutine(f.worker.env, {action: 'create', title: 'Briefing', prompt: 'News', schedule: {kind: 'daily', time: '07:30'}});
  f.worker.answer('question-1', 'One');
  await delay(30);
  await f.app.stop();
  const path = join(f.data, 'routines.json');
  const [routine] = JSON.parse(await readFile(path, 'utf8'));
  routine.pending = new Date(Date.now() - 60_000).toISOString();
  await writeFile(path, JSON.stringify([routine]));
  let release!: (ready: boolean) => void;
  const held = new Promise<boolean>(resolve => { release = resolve; });
  let checks = 0;
  const app = await fixture(() => checks++ === 0 ? held : Promise.resolve(true), {data: f.data});
  await delay(30);
  return {app, routine, path, release: () => release(true)};
}
test('a routine paused while its run is being admitted does not run', async () => {
  const {app, routine, path, release} = await heldRoutineRun();
  try {
    const owner = await app.login('owner');
    assert.equal((await app.request(`/api/routines/${routine.id}`, {method: 'POST', body: {enabled: false}, ...owner})).status, 200);
    release();
    await delay(60);
    assert.equal(app.worker.lastText, undefined);
    const [after] = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(after.lastRun.outcome, 'skipped');
    assert.equal(after.pending, undefined);
  } finally { await app.close(); }
});
test('a routine run that cannot be recorded as started does not start, so a restart cannot run it twice', async () => {
  const {app, routine, path, release} = await heldRoutineRun();
  try {
    // Every save of routines.json fails from here on.
    await rm(path); await mkdir(path);
    release();
    await delay(60);
    assert.equal(app.worker.lastText, undefined);
    const owner = await app.login('owner');
    const state = await (await app.request(`/api/chats/${routine.chat}`, owner)).json();
    assert.match(state.messages.at(-1).error, /could not save this run, so it did not start/);
    assert.equal(state.busy, false);
  } finally { await app.close(); }
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
  const signedIn = (email: string) => ({'Cf-Access-Jwt-Assertion': signedToken(privateKey, {alg: 'RS256', kid: 'k1'},
    {iss: 'https://home.cloudflareaccess.com', aud: ['aud-tag'], email, exp: Math.floor(Date.now() / 1000) + 600})});
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

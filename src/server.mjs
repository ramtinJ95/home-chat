import http from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat, rename, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PiWorker } from './rpc.mjs';
import { ALLOWED_TOOLS, ID_PATTERN, LOCAL_HOSTS, MAX_UPLOAD, MAX_DATA, allowedImagePath } from './policy.mjs';

const digest = text => createHash('sha256').update(text).digest();
const jsonHeaders = {'Content-Type': 'application/json; charset=utf-8'};
const fail = (status, message) => Object.assign(new Error(message), {status});
const publicRoot = resolve(fileURLToPath(new URL('../public', import.meta.url)));

async function jsonBody(req, maximum = 64_000) {
  if (req.headers['content-type'] !== 'application/json') throw fail(415, 'Use application/json');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw fail(413, 'Request is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'Invalid JSON'); }
}

async function atomicJson(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value), {mode: 0o600});
  await rename(temporary, path);
}

async function diskUsage(directory) {
  let total = 0;
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in application data');
    total += entry.isDirectory() ? await diskUsage(path) : (await stat(path)).size;
  }
  return total;
}

export async function createApp({data = '/data', workerFactory = dir => new PiWorker(dir), authenticatedProvider} = {}) {
  const chatsDirectory = join(data, 'chats');
  await mkdir(chatsDirectory, {recursive: true, mode: 0o700});
  await mkdir(join(data, 'profile'), {recursive: true, mode: 0o700});
  await mkdir(join(data, 'home'), {recursive: true, mode: 0o700});
  const accessPath = join(data, 'local-access.json');
  let access;
  try { access = JSON.parse(await readFile(accessPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    access = {owner: randomBytes(32).toString('base64url'), guest: randomBytes(32).toString('base64url')};
    await atomicJson(accessPath, access);
  }
  const accessHashes = Object.entries(access).map(([user, token]) => [user, digest(token)]);
  access = undefined;
  const sessions = new Map();
  const loginAttempts = new Map();
  const rates = new Map();
  const chats = new Map();
  const workers = new Map();
  const streams = new Map();
  const inflight = new Set();
  for (const id of await readdir(chatsDirectory)) {
    if (!ID_PATTERN.test(id)) throw new Error('Unexpected conversation directory');
    const chat = JSON.parse(await readFile(join(chatsDirectory, id, 'chat.json'), 'utf8'));
    if (chat.id !== id || !['owner', 'guest'].includes(chat.owner)) throw new Error('Invalid conversation record');
    chat.busy = false; chats.set(id, chat);
  }
  const save = chat => atomicJson(join(chatsDirectory, chat.id, 'chat.json'), {...chat, busy: false});
  const snapshot = chat => ({id: chat.id, title: chat.title, messages: chat.messages, assets: chat.assets.map(({id, kind}) => ({id, kind})), busy: chat.busy,
    question: workers.get(chat.id)?.question ?? null});
  const emit = (id, event) => {
    for (const client of streams.get(id) ?? []) {
      if (client.res.writableLength > 1024 * 1024) { client.res.destroy(); continue; }
      client.res.write('data: ' + JSON.stringify(event) + '\n\n');
    }
  };
  const providerReady = authenticatedProvider ?? (async () => {
    try {
      const auth = JSON.parse(await readFile(join(data, 'profile/auth.json'), 'utf8'));
      return auth['openai-codex']?.type === 'oauth';
    } catch { return false; }
  });

  async function collectGenerated(chat) {
    const cwd = join(chatsDirectory, chat.id, 'work');
    const directory = join(cwd, '.pi/openai-codex-images');
    let files;
    try { files = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const file of files) {
      if (!/^ig_[0-9a-f]{32}(?:_\d+)?\.png$/.test(file)) continue;
      const path = join(directory, file);
      if (chat.assets.some(asset => asset.path === path)) continue;
      await allowedImagePath(path, cwd);
      const id = randomUUID();
      chat.assets.push({id, kind: 'generated', path});
      const last = chat.messages.at(-1);
      if (last?.role === 'assistant') last.assets.push(id);
    }
  }

  async function workerFor(chat) {
    if (workers.get(chat.id)?.closed) workers.delete(chat.id);
    if (workers.has(chat.id)) return workers.get(chat.id);
    if (workers.size >= 2) {
      const idle = [...workers].find(([, worker]) => !worker.busy);
      if (!idle) throw fail(429, 'Both chat workers are busy');
      idle[1].stop(); workers.delete(idle[0]);
    }
    const worker = workerFactory(join(chatsDirectory, chat.id));
    const failTurn = async message => {
      const last = chat.messages.at(-1);
      if (last?.role === 'assistant') last.error = message;
      chat.busy = false; worker.busy = false;
      clearTimeout(worker.deadline);
      emit(chat.id, {type: 'error', message});
      await save(chat);
      emit(chat.id, {type: 'snapshot', chat: snapshot(chat)});
    };
    worker.on('failure', message => { void failTurn(message).catch(() => worker.stop()); });
    worker.on('delta', text => {
      const last = chat.messages.at(-1);
      if (last?.role !== 'assistant') return;
      if (last.text.length + text.length > 100_000) { worker.stop(); void failTurn('Response size limit reached'); return; }
      last.text += text; emit(chat.id, {type: 'delta', text});
    });
    worker.on('tool', name => emit(chat.id, {type: 'tool', name}));
    worker.on('question', question => emit(chat.id, {type: 'question', question}));
    worker.on('settled', () => {
      clearTimeout(worker.deadline);
      void (async () => {
        await collectGenerated(chat);
        chat.busy = false;
        await save(chat);
        emit(chat.id, {type: 'snapshot', chat: snapshot(chat)});
      })().catch(() => failTurn('Could not persist the response'));
    });
    workers.set(chat.id, worker);
    try { await worker.start(); }
    catch (error) { workers.delete(chat.id); worker.stop(); throw fail(503, error.message); }
    return worker;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const send = (status, value, headers = jsonHeaders) => res.writeHead(status, headers).end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    try {
      if (!LOCAL_HOSTS.has(req.headers.host)) throw fail(421, 'This prototype accepts localhost only');
      const url = new URL(req.url, 'http://' + req.headers.host);
      const path = url.pathname;
      const mutation = !['GET', 'HEAD'].includes(req.method);
      if (mutation && req.headers.origin !== 'http://' + req.headers.host) throw fail(403, 'Origin rejected');
      if (path === '/' && req.method === 'GET') return send(200, await readFile(join(publicRoot, 'index.html')), {'Content-Type': 'text/html; charset=utf-8'});
      if (['/app.js', '/style.css'].includes(path) && req.method === 'GET') {
        return send(200, await readFile(join(publicRoot, path.slice(1))), {'Content-Type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8'});
      }
      if (path === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        const recent = (loginAttempts.get(ip) ?? []).filter(time => time > Date.now() - 15 * 60_000);
        if (recent.length >= 5) throw fail(429, 'Too many attempts; wait 15 minutes');
        recent.push(Date.now()); loginAttempts.set(ip, recent);
        const body = await jsonBody(req, 1024);
        if (typeof body.code !== 'string' || body.code.length > 128) throw fail(401, 'Invalid access code');
        const candidate = digest(body.code);
        const user = accessHashes.find(([, expected]) => timingSafeEqual(candidate, expected))?.[0];
        if (!user) throw fail(401, 'Invalid access code');
        loginAttempts.delete(ip);
        if (sessions.size >= 16) throw fail(429, 'Too many sessions');
        const token = randomBytes(32).toString('base64url');
        const session = {user, csrf: randomBytes(32).toString('base64url'), expires: Date.now() + 8 * 60 * 60_000};
        sessions.set(digest(token).toString('hex'), session);
        res.setHeader('Set-Cookie', `home_chat=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return send(200, {ok: true});
      }
      const cookie = String(req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith('home_chat='))?.slice(10);
      const sessionKey = digest(cookie ?? '').toString('hex');
      const session = sessions.get(sessionKey);
      if (!session || session.expires < Date.now()) { sessions.delete(sessionKey); throw fail(401, 'Sign in required'); }
      if (mutation && req.headers['x-csrf-token'] !== session.csrf) throw fail(403, 'CSRF check failed');
      if (path === '/api/me' && req.method === 'GET') return send(200, {user: session.user, csrf: session.csrf, codexConfigured: await providerReady(), localOnly: true, tools: ALLOWED_TOOLS});
      if (path === '/api/logout' && req.method === 'POST') {
        sessions.delete(sessionKey);
        for (const clients of streams.values()) for (const client of clients) if (client.sessionKey === sessionKey) client.res.end();
        res.setHeader('Set-Cookie', 'home_chat=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return send(200, {ok: true});
      }
      if (path === '/api/chats' && req.method === 'GET') return send(200, [...chats.values()].filter(chat => chat.owner === session.user).map(({id, title}) => ({id, title})));
      if (path === '/api/chats' && req.method === 'POST') {
        if ([...chats.values()].filter(chat => chat.owner === session.user).length >= 20) throw fail(429, 'Prototype limit: 20 conversations per user');
        const id = randomUUID();
        const chat = {id, owner: session.user, title: 'New conversation', messages: [], assets: [], busy: false};
        await mkdir(join(chatsDirectory, id, 'work/uploads'), {recursive: true, mode: 0o700});
        await save(chat); chats.set(id, chat);
        return send(201, snapshot(chat));
      }
      const parts = path.split('/').filter(Boolean);
      if (parts[0] !== 'api' || parts[1] !== 'chats' || !ID_PATTERN.test(parts[2] ?? '')) throw fail(404, 'Not found');
      const chat = chats.get(parts[2]);
      if (!chat || chat.owner !== session.user) throw fail(404, 'Not found');
      if (parts.length === 3 && req.method === 'GET') return send(200, snapshot(chat));
      if (parts[3] === 'events' && parts.length === 4 && req.method === 'GET') {
        const clients = streams.get(chat.id) ?? new Set();
        if (clients.size >= 4) throw fail(429, 'Too many open chat streams');
        res.writeHead(200, {'Content-Type': 'text/event-stream', 'Connection': 'keep-alive'});
        const client = {res, sessionKey}; clients.add(client); streams.set(chat.id, clients);
        res.write('data: ' + JSON.stringify({type: 'snapshot', chat: snapshot(chat)}) + '\n\n');
        const heartbeat = setInterval(() => {
          if (sessions.get(sessionKey) !== session || session.expires < Date.now()) return res.end();
          res.write(': keepalive\n\n');
        }, 15_000);
        heartbeat.unref();
        res.on('close', () => { clearInterval(heartbeat); clients.delete(client); });
        return;
      }
      if (parts[3] === 'assets' && parts.length === 5 && req.method === 'GET') {
        const asset = chat.assets.find(item => item.id === parts[4]);
        if (!asset) throw fail(404, 'Not found');
        const path = await allowedImagePath(asset.path, join(chatsDirectory, chat.id, 'work'));
        if (url.searchParams.has('download')) res.setHeader('Content-Disposition', `attachment; filename="home-chat-${asset.id}.png"`);
        return send(200, await readFile(path), {'Content-Type': 'image/png'});
      }
      if (parts[3] === 'uploads' && parts.length === 4 && req.method === 'POST') {
        if (chat.busy || inflight.has(chat.id)) throw fail(409, 'Wait for the current message');
        if (chat.assets.length >= 40 || await diskUsage(data) > MAX_DATA - 20 * 1024 * 1024) throw fail(413, 'Prototype storage limit reached');
        const body = await jsonBody(req, Math.ceil(MAX_UPLOAD * 1.4));
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(body.mimeType) || typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw fail(400, 'Use a PNG, JPEG or WebP picture');
        const bytes = Buffer.from(body.data, 'base64');
        if (!bytes.length || bytes.length > MAX_UPLOAD) throw fail(413, 'Pictures must be at most 4 MB');
        let normalized;
        try {
          const image = sharp(bytes, {limitInputPixels: 16_777_216, failOn: 'error'});
          const metadata = await image.metadata();
          if (!['png', 'jpeg', 'webp'].includes(metadata.format)) throw new Error('Unsupported image format');
          normalized = await image.rotate().resize({width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true}).png().toBuffer();
        }
        catch { throw fail(400, 'Invalid or oversized picture'); }
        if (normalized.length > 16 * 1024 * 1024) throw fail(413, 'Decoded picture is too large');
        const id = randomUUID();
        const path = join(chatsDirectory, chat.id, 'work/uploads', id + '.png');
        await writeFile(path, normalized, {mode: 0o600});
        chat.assets.push({id, path, kind: 'upload'}); await save(chat);
        return send(201, {id, kind: 'upload'});
      }
      if (parts[3] === 'messages' && parts.length === 4 && req.method === 'POST') {
        if (chat.busy || inflight.has(chat.id)) throw fail(409, 'A message is already running');
        if ([...chats.values()].some(other => other.owner === chat.owner && (other.busy || inflight.has(other.id)))) throw fail(409, 'One active conversation per user');
        inflight.add(chat.id);
        try {
          if (!await providerReady()) throw fail(503, 'Codex is not signed in to this isolated profile yet');
          if (chat.messages.length >= 200 || await diskUsage(data) > MAX_DATA - 40 * 1024 * 1024) throw fail(413, 'Prototype conversation or storage limit reached');
          const recent = (rates.get(session.user) ?? []).filter(time => time > Date.now() - 60 * 60_000);
          if (recent.length >= 30) throw fail(429, 'Prototype limit: 30 messages per hour');
          const body = await jsonBody(req);
          if (typeof body.text !== 'string' || body.text.length > 12_000 || !Array.isArray(body.assets ?? []) || (body.assets ?? []).length > 4) throw fail(400, 'Invalid message');
          if (!body.text.trim() && !(body.assets?.length)) throw fail(400, 'Write a message or attach a picture');
          const images = []; const selected = [];
          for (const id of body.assets ?? []) {
            const asset = chat.assets.find(item => item.id === id);
            if (!asset) throw fail(400, 'Invalid attachment');
            const path = await allowedImagePath(asset.path, join(chatsDirectory, chat.id, 'work'));
            images.push({type: 'image', mimeType: 'image/png', data: (await readFile(path)).toString('base64')}); selected.push(asset);
          }
          const worker = await workerFor(chat);
          recent.push(Date.now()); rates.set(session.user, recent);
          chat.messages.push({role: 'user', text: body.text, assets: selected.map(item => item.id)}, {role: 'assistant', text: '', assets: []});
          if (chat.title === 'New conversation') chat.title = body.text.slice(0, 55) || 'Picture conversation';
          chat.busy = true; await save(chat);
          emit(chat.id, {type: 'snapshot', chat: snapshot(chat)});
          worker.deadline = setTimeout(() => worker.stop(), 5 * 60_000); worker.deadline.unref();
          try {
            await worker.prompt(body.text + (selected.length ? '\nAttached image paths (this conversation only):\n' + selected.map(item => item.path).join('\n') : ''), images);
          } catch {
            clearTimeout(worker.deadline); worker.stop(); chat.busy = false;
            chat.messages.at(-1).error = 'Pi rejected this message; no reply was completed';
            await save(chat); emit(chat.id, {type: 'snapshot', chat: snapshot(chat)});
            throw fail(503, 'Pi rejected this message; no reply was completed');
          }
          return send(202, {ok: true});
        } finally { inflight.delete(chat.id); }
      }
      if (parts[3] === 'answer' && parts.length === 4 && req.method === 'POST') {
        const body = await jsonBody(req, 16_000);
        const worker = workers.get(chat.id);
        if (!worker || typeof body.id !== 'string' || (typeof body.value === 'string' && body.value.length > 8000)) throw fail(400, 'Invalid question response');
        try { worker.answer(body.id, body.value, body.cancelled === true); }
        catch { throw fail(409, 'Question expired or answer invalid'); }
        return send(200, {ok: true});
      }
      if (parts[3] === 'abort' && parts.length === 4 && req.method === 'POST') {
        await workers.get(chat.id)?.abort(); return send(200, {ok: true});
      }
      throw fail(404, 'Not found');
    } catch (error) {
      if (res.headersSent) return res.end();
      send(error.status ?? 500, {error: error.status ? error.message : 'Request failed; no further action was taken'});
    }
  });
  server.requestTimeout = 45_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000; server.maxConnections = 64;
  return {server, stop: async () => { for (const worker of workers.values()) worker.stop(); for (const clients of streams.values()) for (const client of clients) client.res.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.HOME_CHAT_LOCAL_ONLY !== '1') throw new Error('Only explicitly local deployments are supported');
  await copyFile('/app/profile/pi-codex-conversion.json', '/data/profile/pi-codex-conversion.json');
  const app = await createApp();
  app.server.listen(8080, '0.0.0.0', () => console.log('Home Chat local prototype ready; provider login is checked separately'));
  process.once('SIGTERM', () => { void app.stop(); });
}

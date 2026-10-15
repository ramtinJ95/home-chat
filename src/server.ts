import http from 'node:http';
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat, rename, copyFile, rm, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { AssetKind, AssetRef, ChatSnapshot, ChatSummary, Me, Message, StreamEvent, User } from './api.d.ts';
import { PiWorker, type ChatWorker, type PromptImage } from './rpc.ts';
import { AccessDenied, accessConfigFromEnv, createAccessVerifier, type AccessConfig, type AccessKeySource } from './access.ts';
import { ALLOWED_TOOLS, ID_PATTERN, LOCAL_HOSTS, MAX_UPLOAD, MAX_DATA, allowedImagePath, isUser } from './policy.ts';

interface StoredAsset { id: string; kind: AssetKind; path: string }
// `replying` is saved while a reply streams; finding it at startup means the app stopped before the reply finished.
interface Chat { id: string; owner: User; title: string; messages: Message[]; assets: StoredAsset[]; replying?: true }
interface Session { user: User; csrf: string; expires: number }
interface StreamClient { res: http.ServerResponse; sessionKey: string }

export interface AppOptions {
  data?: string;
  workerFactory?: (directory: string) => ChatWorker;
  authenticatedProvider?: () => Promise<boolean>;
  // Set for the public deployment: Cloudflare Access identities replace the local access codes.
  access?: AccessConfig;
  accessKeys?: AccessKeySource;
}

const digest = (text: string) => createHash('sha256').update(text).digest();
const jsonHeaders = {'Content-Type': 'application/json; charset=utf-8'};
// Thrown for client-visible failures; any other error becomes a generic 500.
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const fail = (status: number, message: string) => new HttpError(status, message);
const sse = (res: http.ServerResponse, event: StreamEvent) => res.write('data: ' + JSON.stringify(event) + '\n\n');
const publicRoot = resolve(fileURLToPath(new URL('../public', import.meta.url)));

async function jsonBody(req: http.IncomingMessage, maximum = 64_000): Promise<Record<string, unknown>> {
  if (req.headers['content-type'] !== 'application/json') throw fail(415, 'Use application/json');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maximum) throw fail(413, 'Request is too large');
    chunks.push(chunk);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'Invalid JSON'); }
  if (typeof body !== 'object' || body === null) throw fail(400, 'Invalid JSON');
  return body as Record<string, unknown>;
}

// Synced around the rename, so a power cut leaves either the old record or the new one, never an empty file.
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } catch (error) { await rm(temporary, {force: true}); throw error; }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function diskUsage(directory: string): Promise<number> {
  const sizes = await Promise.all((await readdir(directory, {withFileTypes: true})).map(async entry => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in application data');
    return entry.isDirectory() ? diskUsage(path) : (await stat(path)).size;
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

// Only hashes stay in memory; the plaintext codes are scoped to this call.
async function loadAccessHashes(path: string): Promise<[User, Buffer][]> {
  let access: Record<string, unknown>;
  try { access = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    access = {owner: randomBytes(32).toString('base64url'), guest: randomBytes(32).toString('base64url')};
    await atomicJson(path, access);
  }
  return Object.entries(access).map(([user, token]) => {
    if (!isUser(user) || typeof token !== 'string') throw new Error('Invalid local access file');
    return [user, digest(token)];
  });
}

async function loadStaticFiles() {
  const files = [['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/theme.js', 'theme.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css']];
  return new Map(await Promise.all(files.map(async ([path, file, type]) =>
    [path, {body: await readFile(join(publicRoot, file)), type: type + '; charset=utf-8'}] as const)));
}

export async function createApp({data = '/data', workerFactory = dir => new PiWorker(dir), authenticatedProvider, access, accessKeys}: AppOptions = {}) {
  const chatsDirectory = join(data, 'chats');
  // Deleted conversations are moved here before removal; anything left from an interrupted removal goes at startup.
  const deletedDirectory = join(data, 'deleted');
  await rm(deletedDirectory, {recursive: true, force: true});
  await mkdir(chatsDirectory, {recursive: true, mode: 0o700});
  await mkdir(deletedDirectory, {mode: 0o700});
  const accessHashes = await loadAccessHashes(join(data, 'local-access.json'));
  const staticFiles = await loadStaticFiles();
  const sessions = new Map<string, Session>();
  const verifyAccess = access && createAccessVerifier(access, accessKeys);
  // Access sessions are stateless: the CSRF token is derived from the verified email, so it survives page reloads.
  const csrfSecret = randomBytes(32);
  const origin = access ? 'https://' + access.host : undefined;
  const loginAttempts = new Map<string, number[]>();
  const rates = new Map<User, number[]>();
  const chats = new Map<string, Chat>();
  const workers = new Map<string, ChatWorker>();
  const streams = new Map<string, Set<StreamClient>>();
  // `running`: a turn is visible to clients, until settle/failure. `inflight`: files are changing outside a visible turn
  // (a message being admitted, a turn's final save, a delete).
  const running = new Set<string>();
  const inflight = new Set<string>();
  const occupied = (id: string) => running.has(id) || inflight.has(id);
  const workDir = (chat: Chat) => join(chatsDirectory, chat.id, 'work');
  // Writes to one conversation run in order, so a slow earlier write never replaces a newer one. Each caller handles its
  // own write's failure, so the next write only waits for it.
  const writes = new Map<string, Promise<void>>();
  const save = (chat: Chat) => {
    const write = (writes.get(chat.id) ?? Promise.resolve()).catch(() => {}).then(() => atomicJson(join(chatsDirectory, chat.id, 'chat.json'), chat));
    writes.set(chat.id, write);
    return write;
  };
  for (const id of await readdir(chatsDirectory)) {
    if (!ID_PATTERN.test(id)) throw new Error('Unexpected conversation directory');
    let record;
    try { record = await readFile(join(chatsDirectory, id, 'chat.json'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A conversation's directory is made before its first save, and it is only shown to anyone after that save, so a
      // directory without a record is a creation the app stopped in the middle of.
      await rm(join(chatsDirectory, id), {recursive: true}); continue;
    }
    const chat: Chat = JSON.parse(record);
    if (chat.id !== id || !isUser(chat.owner)) throw new Error('Invalid conversation record');
    if (chat.replying) {
      delete chat.replying;
      const last = chat.messages.at(-1);
      if (last?.role === 'assistant') last.error = 'Home Chat restarted before this reply finished';
      await save(chat);
    }
    chats.set(id, chat);
  }
  // Set by stop(). From then on no turn ends: stop() saves running replies and the next start marks them interrupted,
  // so Pi exiting or rejecting a prompt under a shutdown is never recorded as the turn's outcome.
  let stopping = false;
  const snapshot = (chat: Chat): ChatSnapshot => ({id: chat.id, title: chat.title, messages: chat.messages, assets: chat.assets.map(({id, kind}) => ({id, kind})), busy: running.has(chat.id),
    question: workers.get(chat.id)?.question ?? null});
  const emit = (id: string, event: StreamEvent) => {
    for (const client of streams.get(id) ?? []) {
      if (client.res.writableLength > 1024 * 1024) { client.res.destroy(); continue; }
      sse(client.res, event);
    }
  };
  const publish = async (chat: Chat) => {
    await save(chat);
    emit(chat.id, {type: 'snapshot', chat: snapshot(chat)});
  };
  const providerReady = authenticatedProvider ?? (async () => {
    try {
      const auth = JSON.parse(await readFile(join(data, 'profile/auth.json'), 'utf8'));
      return auth['openai-codex']?.type === 'oauth';
    } catch { return false; }
  });

  async function endTurn(chat: Chat, worker: ChatWorker, error?: string) {
    if (stopping) return;
    clearTimeout(worker.deadline);
    const last = chat.messages.at(-1);
    if (error && last?.role === 'assistant') last.error = error;
    delete chat.replying;
    // Clients see the turn end now, but the conversation stays in flight until it is saved, so a delete cannot remove the files under the save.
    inflight.add(chat.id);
    running.delete(chat.id); worker.busy = false;
    try { await publish(chat); } finally { inflight.delete(chat.id); }
  }

  async function collectGenerated(chat: Chat) {
    const cwd = workDir(chat);
    const directory = join(cwd, '.pi/openai-codex-images');
    let files;
    try { files = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
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

  async function workerFor(chat: Chat): Promise<ChatWorker> {
    const existing = workers.get(chat.id);
    if (existing && !existing.closed) return existing;
    workers.delete(chat.id);
    if (workers.size >= 2) {
      const idle = [...workers].find(([, worker]) => !worker.busy);
      if (!idle) throw fail(429, 'Both chat workers are busy');
      idle[1].stop(); workers.delete(idle[0]);
    }
    const worker = workerFactory(join(chatsDirectory, chat.id));
    const failTurn = (message: string) => {
      emit(chat.id, {type: 'error', message});
      return endTurn(chat, worker, message);
    };
    worker.on('failure', message => { void failTurn(message).catch(() => worker.stop()); });
    let saveTimer: NodeJS.Timeout | undefined;
    worker.on('delta', text => {
      const last = chat.messages.at(-1);
      if (last?.role !== 'assistant') return;
      if (last.text.length + text.length > 100_000) { worker.stop(); void failTurn('Response size limit reached'); return; }
      last.text += text; emit(chat.id, {type: 'delta', text});
      // Streamed text is saved every few seconds so a crash loses only the last moments of a reply. A failed save here is
      // left to the turn's final save, which reports it.
      saveTimer ??= setTimeout(() => {
        saveTimer = undefined;
        if (running.has(chat.id)) save(chat).catch(() => {});
      }, 2000);
      saveTimer.unref();
    });
    worker.on('tool', name => emit(chat.id, {type: 'tool', name}));
    worker.on('question', question => emit(chat.id, {type: 'question', question}));
    worker.on('settled', () => {
      clearTimeout(worker.deadline);
      void (async () => {
        await collectGenerated(chat);
        await endTurn(chat, worker);
      })().catch(() => failTurn('Could not persist the response'));
    });
    workers.set(chat.id, worker);
    try { await worker.start(); }
    catch (error) { workers.delete(chat.id); worker.stop(); throw fail(503, (error as Error).message); }
    return worker;
  }

  async function authenticate(req: http.IncomingMessage): Promise<{session: Session; sessionKey: string}> {
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
  }
  // Open streams end when their sign-in does: at logout, or at expiry (the Access token's own expiry under Access).
  const live = (sessionKey: string, session: Session) =>
    session.expires >= Date.now() && (verifyAccess !== undefined || sessions.get(sessionKey) === session);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const send = (status: number, value: unknown, headers: http.OutgoingHttpHeaders = jsonHeaders) =>
      res.writeHead(status, headers).end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    try {
      // The container health check, from inside the container only; it reveals nothing.
      if (req.url === '/healthz' && req.method === 'GET' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
        return send(200, {ok: true});
      }
      const host = req.headers.host ?? '';
      if (access ? host !== access.host : !LOCAL_HOSTS.has(host)) throw fail(421, 'Unexpected host');
      const url = new URL(req.url ?? '/', 'http://' + host);
      const path = url.pathname;
      const mutation = !['GET', 'HEAD'].includes(req.method ?? '');
      if (mutation && req.headers.origin !== (origin ?? 'http://' + host)) throw fail(403, 'Origin rejected');
      const file = req.method === 'GET' ? staticFiles.get(path) : undefined;
      if (file) return send(200, file.body, {'Content-Type': file.type});
      if (path === '/api/login' && req.method === 'POST' && !access) {
        const ip = req.socket.remoteAddress ?? '';
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
      const {session, sessionKey} = await authenticate(req);
      if (mutation && req.headers['x-csrf-token'] !== session.csrf) throw fail(403, 'CSRF check failed');
      if (path === '/api/me' && req.method === 'GET') {
        const me: Me = {user: session.user, csrf: session.csrf, codexConfigured: await providerReady(), mode: access ? 'access' : 'local', tools: ALLOWED_TOOLS};
        return send(200, me);
      }
      if (path === '/api/logout' && req.method === 'POST') {
        // Under Access the browser then leaves through Cloudflare's own logout, which ends the real session.
        sessions.delete(sessionKey);
        for (const clients of streams.values()) for (const client of clients) if (client.sessionKey === sessionKey) client.res.end();
        if (!access) res.setHeader('Set-Cookie', 'home_chat=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return send(200, {ok: true});
      }
      if (path === '/api/chats' && req.method === 'GET') {
        const list: ChatSummary[] = [...chats.values()].filter(chat => chat.owner === session.user).map(({id, title}) => ({id, title}));
        return send(200, list);
      }
      if (path === '/api/chats' && req.method === 'POST') {
        if ([...chats.values()].filter(chat => chat.owner === session.user).length >= 20) throw fail(429, 'Prototype limit: 20 conversations per user');
        const chat: Chat = {id: randomUUID(), owner: session.user, title: 'New conversation', messages: [], assets: []};
        await mkdir(join(workDir(chat), 'uploads'), {recursive: true, mode: 0o700});
        await save(chat); chats.set(chat.id, chat);
        return send(201, snapshot(chat));
      }
      const parts = path.split('/').filter(Boolean);
      if (parts[0] !== 'api' || parts[1] !== 'chats' || !ID_PATTERN.test(parts[2] ?? '')) throw fail(404, 'Not found');
      const chat = chats.get(parts[2]);
      if (!chat || chat.owner !== session.user) throw fail(404, 'Not found');
      // Method plus the path below the chat, e.g. 'GET', 'GET events', 'POST messages'.
      const route = [req.method, ...parts.slice(3)].join(' ');
      if (route === 'GET') return send(200, snapshot(chat));
      if (route === 'DELETE') {
        if (occupied(chat.id)) throw fail(409, 'Stop the current reply before deleting this conversation');
        // Held as in flight so no message, upload or second delete starts while the files move.
        inflight.add(chat.id);
        try {
          workers.get(chat.id)?.stop(); workers.delete(chat.id);
          // One rename takes the conversation out of the chats directory, so a failed removal never leaves half of it to load.
          const removed = join(deletedDirectory, chat.id);
          await rename(join(chatsDirectory, chat.id), removed);
          chats.delete(chat.id); writes.delete(chat.id);
          for (const client of streams.get(chat.id) ?? []) client.res.end();
          streams.delete(chat.id);
          await rm(removed, {recursive: true, force: true});
        } finally { inflight.delete(chat.id); }
        return send(200, {ok: true});
      }
      if (route === 'GET events') {
        const clients = streams.get(chat.id) ?? new Set();
        if (clients.size >= 4) throw fail(429, 'Too many open chat streams');
        res.writeHead(200, {'Content-Type': 'text/event-stream', 'Connection': 'keep-alive'});
        const client = {res, sessionKey}; clients.add(client); streams.set(chat.id, clients);
        sse(res, {type: 'snapshot', chat: snapshot(chat)});
        const heartbeat = setInterval(() => {
          if (!live(sessionKey, session)) return res.end();
          res.write(': keepalive\n\n');
        }, 15_000);
        heartbeat.unref();
        res.on('close', () => { clearInterval(heartbeat); clients.delete(client); });
        return;
      }
      if (parts[3] === 'assets' && parts.length === 5 && req.method === 'GET') {
        const asset = chat.assets.find(item => item.id === parts[4]);
        if (!asset) throw fail(404, 'Not found');
        const path = await allowedImagePath(asset.path, workDir(chat));
        if (url.searchParams.has('download')) res.setHeader('Content-Disposition', `attachment; filename="home-chat-${asset.id}.png"`);
        return send(200, await readFile(path), {'Content-Type': 'image/png'});
      }
      if (route === 'POST uploads') {
        if (occupied(chat.id)) throw fail(409, 'Wait for the current message');
        if (chat.assets.length >= 40 || await diskUsage(data) > MAX_DATA - 20 * 1024 * 1024) throw fail(413, 'Prototype storage limit reached');
        const body = await jsonBody(req, Math.ceil(MAX_UPLOAD * 1.4));
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(body.mimeType as string) || typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw fail(400, 'Use a PNG, JPEG or WebP picture');
        const bytes = Buffer.from(body.data, 'base64');
        if (!bytes.length || bytes.length > MAX_UPLOAD) throw fail(413, `Pictures must be at most ${MAX_UPLOAD / 1024 / 1024} MB`);
        let normalized;
        try {
          const image = sharp(bytes, {limitInputPixels: 16_777_216, failOn: 'error'});
          const metadata = await image.metadata();
          if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) throw new Error('Unsupported image format');
          normalized = await image.rotate().resize({width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true}).png().toBuffer();
        }
        catch { throw fail(400, 'Invalid or oversized picture'); }
        if (normalized.length > MAX_UPLOAD) throw fail(413, 'Decoded picture is too large');
        const id = randomUUID();
        const path = join(workDir(chat), 'uploads', id + '.png');
        await writeFile(path, normalized, {mode: 0o600});
        chat.assets.push({id, path, kind: 'upload'}); await save(chat);
        const asset: AssetRef = {id, kind: 'upload'};
        return send(201, asset);
      }
      if (route === 'POST messages') {
        if (occupied(chat.id)) throw fail(409, 'A message is already running');
        if ([...chats.values()].some(other => other.owner === chat.owner && occupied(other.id))) throw fail(409, 'One active conversation per user');
        inflight.add(chat.id);
        try {
          if (!await providerReady()) throw fail(503, 'Codex is not signed in to this isolated profile yet');
          if (chat.messages.length >= 200 || await diskUsage(data) > MAX_DATA - 40 * 1024 * 1024) throw fail(413, 'Prototype conversation or storage limit reached');
          const recent = (rates.get(session.user) ?? []).filter(time => time > Date.now() - 60 * 60_000);
          if (recent.length >= 30) throw fail(429, 'Prototype limit: 30 messages per hour');
          const body = await jsonBody(req);
          const assetIds = body.assets ?? [];
          if (typeof body.text !== 'string' || body.text.length > 12_000 || !Array.isArray(assetIds) || assetIds.length > 4) throw fail(400, 'Invalid message');
          if (!body.text.trim() && !assetIds.length) throw fail(400, 'Write a message or attach a picture');
          const images: PromptImage[] = []; const selected: StoredAsset[] = [];
          for (const id of assetIds) {
            const asset = chat.assets.find(item => item.id === id);
            if (!asset) throw fail(400, 'Invalid attachment');
            const path = await allowedImagePath(asset.path, workDir(chat));
            images.push({type: 'image', mimeType: 'image/png', data: (await readFile(path)).toString('base64')}); selected.push(asset);
          }
          const worker = await workerFor(chat);
          // A worker started while stop() ran would outlive it, so it is stopped here before the message is admitted.
          if (stopping) { worker.stop(); throw fail(503, 'Home Chat is restarting; send the message again in a moment'); }
          recent.push(Date.now()); rates.set(session.user, recent);
          chat.messages.push({role: 'user', text: body.text, assets: selected.map(item => item.id)}, {role: 'assistant', text: '', assets: []});
          if (chat.title === 'New conversation') chat.title = body.text.slice(0, 55) || 'Picture conversation';
          chat.replying = true; running.add(chat.id); await publish(chat);
          worker.deadline = setTimeout(() => worker.stop(), 5 * 60_000); worker.deadline.unref();
          try {
            await worker.prompt(body.text + (selected.length ? '\nAttached image paths (this conversation only):\n' + selected.map(item => item.path).join('\n') : ''), images);
          } catch {
            worker.stop();
            await endTurn(chat, worker, 'Pi rejected this message; no reply was completed');
            throw fail(503, 'Pi rejected this message; no reply was completed');
          }
          return send(202, {ok: true});
        } finally { inflight.delete(chat.id); }
      }
      if (route === 'POST answer') {
        const body = await jsonBody(req, 16_000);
        const worker = workers.get(chat.id);
        if (!worker || typeof body.id !== 'string' || (typeof body.value === 'string' && body.value.length > 8000)) throw fail(400, 'Invalid question response');
        try { worker.answer(body.id, body.value, body.cancelled === true); }
        catch { throw fail(409, 'Question expired or answer invalid'); }
        return send(200, {ok: true});
      }
      if (route === 'POST abort') {
        await workers.get(chat.id)?.abort(); return send(200, {ok: true});
      }
      throw fail(404, 'Not found');
    } catch (error) {
      if (res.headersSent) return res.end();
      if (error instanceof HttpError) send(error.status, {error: error.message});
      else send(500, {error: 'Request failed; no further action was taken'});
    }
  });
  server.requestTimeout = 45_000; server.headersTimeout = 10_000; server.maxConnections = 64;
  // cloudflared reuses idle origin connections for up to 90s; closing them sooner races its reuse and surfaces as 502s.
  server.keepAliveTimeout = access ? 100_000 : 5000;
  const stop = async () => {
    stopping = true;
    // Keep what has streamed so far; if this save fails, the `replying` flag saved with the message still marks it.
    await Promise.allSettled([...running].flatMap(id => chats.get(id) ?? []).map(save));
    for (const worker of workers.values()) worker.stop();
    for (const clients of streams.values()) for (const client of clients) client.res.end();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  return {server, stop};
}

if (import.meta.main) {
  const mode = process.env.HOME_CHAT_MODE;
  if (mode !== 'local' && mode !== 'access') throw new Error('Set HOME_CHAT_MODE to local or access');
  await copyFile('/app/profile/pi-codex-conversion.json', '/data/profile/pi-codex-conversion.json');
  const app = await createApp(mode === 'access' ? {access: accessConfigFromEnv(process.env)} : {});
  app.server.listen(8080, '0.0.0.0', () => console.log(`Home Chat ready in ${mode} mode; provider login is checked separately`));
  process.once('SIGTERM', () => { void app.stop(); });
}

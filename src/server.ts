import http from 'node:http';
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat, rename, copyFile, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { AssetKind, AssetRef, ChatSnapshot, ChatSummary, DocumentContent, DocumentInfo, Me, Message, PushInfo, RoutineSummary, StreamEvent, User } from './api.d.ts';
import { PiWorker, type ChatWorker, type PromptImage } from './rpc.ts';
import { AccessDenied, accessConfigFromEnv, createAccessVerifier, type AccessConfig, type AccessKeySource } from './access.ts';
import { atomicJson } from './files.ts';
import { createPush } from './push.ts';
import { MAX_RUNS_PER_DAY, MISSED_GRACE_MS, RoutineError, createRoutines, describeSchedule, nextLabel, runLabel, type Routine } from './routines.ts';
import { ALLOWED_TOOLS, DOCUMENT_FILE, TURN_LIMITS, ID_PATTERN, LOCAL_HOSTS, MAX_UPLOAD, MAX_DATA, allowedDocumentPath, allowedImagePath, documentInput, isUser, pushSubscription } from './policy.ts';

interface StoredAsset { id: string; kind: AssetKind; path: string; document?: DocumentInfo }
// `replying` is saved while a reply streams; finding it at startup means the app stopped before the reply finished.
// `unread`: a routine run arrived while nobody was looking; cleared when its owner opens the conversation.
interface Chat { id: string; owner: User; title: string; messages: Message[]; assets: StoredAsset[]; replying?: true; deepResearch?: true; unread?: true }
interface RoutineRun { routine: Routine; scheduled: Date }
interface Session { user: User; csrf: string; expires: number }
interface StreamClient { res: http.ServerResponse; sessionKey: string }

export interface AppOptions {
  data?: string;
  // `env` goes to Pi: the internal socket and this worker's token for the routine tool.
  workerFactory?: (directory: string, env: Record<string, string>) => ChatWorker;
  authenticatedProvider?: () => Promise<boolean>;
  // Set for the public deployment: Cloudflare Access identities replace the local access codes.
  access?: AccessConfig;
  accessKeys?: AccessKeySource;
  // Sends push requests; tests replace it so nothing reaches a real push service.
  pushFetch?: typeof fetch;
  // Whether deep research can run; by default, whether the Exa key is set.
  deepResearch?: boolean;
}

const digest = (text: string) => createHash('sha256').update(text).digest();
const jsonHeaders = {'Content-Type': 'application/json; charset=utf-8'};
// Thrown for client-visible failures; any other error becomes a generic 500.
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const fail = (status: number, message: string) => new HttpError(status, message);
// Thrown by startTurn for a routine run that was paused or replaced while its worker started; drainOnce settles it.
class StaleRun extends Error {}
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

async function filesIn(directory: string): Promise<string[]> {
  try { return await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

async function readDocument(path: string, cwd: string) {
  return documentInput(JSON.parse(await readFile(await allowedDocumentPath(path, cwd), 'utf8')));
}

// Download names keep to plain characters for older browsers; filename* carries the full title.
function markdownDisposition(title: string): string {
  const plain = title.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'document';
  const full = encodeURIComponent(title + '.md').replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${plain}.md"; filename*=UTF-8''${full}`;
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
  const files = [['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/theme.js', 'theme.js', 'text/javascript'],
    ['/style.css', 'style.css', 'text/css'], ['/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json'],
    ['/icon.svg', 'icon.svg', 'image/svg+xml'], ['/sw.js', 'sw.js', 'text/javascript']];
  const text = await Promise.all(files.map(async ([path, file, type]) =>
    [path, {body: await readFile(join(publicRoot, file)), type: type + '; charset=utf-8'}] as const));
  // Home Screen icons are drawn from the one SVG at startup. Apple and maskable icons stay full-bleed because the
  // system cuts them to shape; the plain ones get their own rounded corners.
  const svg = await readFile(join(publicRoot, 'icon.svg'));
  const icon = (size: number) => sharp(svg).resize(size, size).png().toBuffer();
  const rounded = async (size: number) => sharp(await icon(size))
    .composite([{input: Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${size * 0.22}"/></svg>`), blend: 'dest-in'}])
    .png().toBuffer();
  const icons = [['/icons/apple-touch-icon.png', icon(180)], ['/icons/maskable-512.png', icon(512)],
    ['/icons/icon-192.png', rounded(192)], ['/icons/icon-512.png', rounded(512)]] as const;
  const images = await Promise.all(icons.map(async ([path, body]) => [path, {body: await body, type: 'image/png'}] as const));
  return new Map([...text, ...images]);
}

export async function createApp({data = '/data', workerFactory = (dir, env) => new PiWorker(dir, env), authenticatedProvider, access, accessKeys, pushFetch,
  deepResearch: researchReady = Boolean(process.env.EXA_API_KEY?.trim())}: AppOptions = {}) {
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
  // Push services want a contact for the sender: the public site, or a placeholder in local mode.
  const push = await createPush(join(data, 'push'), origin ?? 'mailto:home-chat@localhost.invalid', pushFetch);
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
  // The saved switch only counts while Exa is set up, so removing the key turns research off everywhere, visibly.
  const researching = (chat: Chat) => researchReady && chat.deepResearch === true;
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
  // Due runs wait here while their owner has a reply running or both workers are busy (drainRuns).
  const queue: RoutineRun[] = [];
  const dequeue = (run: RoutineRun) => { const index = queue.indexOf(run); if (index !== -1) queue.splice(index, 1); };
  // The routine still exists, and this run is the one it is waiting for rather than one a newer run replaced.
  const current = ({routine, scheduled}: RoutineRun) => routines.get(routine.id) === routine && routine.pending === scheduled.toISOString();
  const routines = await createRoutines(join(data, 'routines.json'), (routine, scheduled, late) => {
    // A newer run of the same routine replaces one still waiting.
    for (const waiting of queue.filter(item => item.routine === routine)) dequeue(waiting);
    if (late) void skipRun({routine, scheduled}, 'Home Chat was not running at the time');
    else { queue.push({routine, scheduled}); void drainRuns(); }
  });
  // The routine run each conversation is replying to, if any; such a turn has nobody watching.
  const routineTurns = new Map<string, RoutineRun>();
  const internalSocket = join(data, 'internal.sock');
  const workerTokens = new Map<string, {chat: string; worker: ChatWorker}>();
  // Routine runs per owner, for the daily budget. Kept in memory: a restart forgets the day's count.
  const runTimes = new Map<User, number[]>();
  const routineSummary = (routine: Routine): RoutineSummary => ({id: routine.id, title: routine.title, chat: routine.chat, enabled: routine.enabled,
    schedule: describeSchedule(routine.schedule), next: nextLabel(routine), unread: chats.get(routine.chat)?.unread === true});
  // Open copies of a routine's conversation show its new state: the switch at the top of the thread.
  const showRoutine = (routine: Routine) => {
    const chat = chats.get(routine.chat);
    if (chat) emit(chat.id, {type: 'snapshot', chat: snapshot(chat)});
  };
  const snapshot = (chat: Chat): ChatSnapshot => {
    const routine = routines.byChat(chat.id);
    return {id: chat.id, title: chat.title, messages: chat.messages, assets: chat.assets.map(({id, kind, document}) => document ? {id, kind, document} : {id, kind}),
      busy: running.has(chat.id), question: workers.get(chat.id)?.question ?? null, deepResearch: researching(chat), routine: routine ? routineSummary(routine) : null};
  };
  // Someone has this conversation open and in view: the app drops its stream while hidden (public/app.ts).
  const watching = (id: string) => (streams.get(id)?.size ?? 0) > 0;
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
    const run = routineTurns.get(chat.id);
    routineTurns.delete(chat.id);
    if (run && !watching(chat.id)) chat.unread = true;
    // Clients see the turn end now, but the conversation stays in flight until it is saved, so a delete cannot remove the files under the save.
    inflight.add(chat.id);
    running.delete(chat.id); worker.busy = false;
    try { await publish(chat); } finally { inflight.delete(chat.id); }
    if (run) await routines.finished(run.routine, run.scheduled, error ? 'failed' : 'done').catch(() => console.warn('Could not save a routine run'));
    if (!watching(chat.id)) {
      push.notify(chat.owner, run
        ? {title: run.routine.title, body: error ? 'This run stopped before it finished.' : 'New results are ready.', chat: chat.id, routine: run.routine.id}
        : {title: chat.title, body: error ? 'The reply stopped before it finished.' : 'Your reply is ready.', chat: chat.id});
    }
    void drainRuns();
  }

  // Admits one turn, for a sent message or a routine run, and hands it to Pi. Throws HttpError if it cannot start.
  async function startTurn(chat: Chat, text: string, {images = [], attached = [], run}: {images?: PromptImage[]; attached?: StoredAsset[]; run?: RoutineRun} = {}) {
    if (occupied(chat.id)) throw fail(409, 'A message is already running');
    if ([...chats.values()].some(other => other.owner === chat.owner && occupied(other.id))) throw fail(409, 'One active conversation per user');
    inflight.add(chat.id);
    // A turn that was admitted and then could not start; it is ended after the reservation is released (below).
    let failed: {worker: ChatWorker; message: string} | undefined;
    try {
      if (!await providerReady()) throw fail(503, 'Codex is not signed in to this isolated profile yet');
      if (chat.messages.length >= 200 || await diskUsage(data) > MAX_DATA - 40 * 1024 * 1024) throw fail(413, 'Prototype conversation or storage limit reached');
      const worker = await workerFor(chat);
      // A worker started while stop() ran would outlive it, so it is stopped here before the message is admitted.
      if (stopping) { worker.stop(); throw fail(503, 'Home Chat is restarting; send the message again in a moment'); }
      // Checked again here, after the waits above and right before the run is admitted.
      if (run && !(current(run) && run.routine.enabled)) throw new StaleRun();
      const deepResearch = run ? run.routine.deepResearch && researchReady : researching(chat);
      const due = run && runLabel(run.scheduled);
      chat.messages.push({role: 'user', text, assets: attached.map(item => item.id), ...(run && {run: `${run.routine.title} · ${due}`})},
        {role: 'assistant', text: '', assets: []});
      if (chat.title === 'New conversation') chat.title = text.slice(0, 55) || 'Picture conversation';
      if (run) routineTurns.set(chat.id, run);
      chat.replying = true; running.add(chat.id); await publish(chat);
      // Recorded before Pi starts, so the run's own end, however quick, comes after it. Unrecorded, a restart would run
      // it again, so it does not start.
      if (run) {
        try { await routines.started(run.routine, run.scheduled); }
        catch { failed = {worker, message: 'Home Chat could not save this run, so it did not start'}; }
      }
      if (!failed) {
        worker.deadline = setTimeout(() => worker.stop(), TURN_LIMITS[deepResearch ? 'deep' : 'normal'].minutes * 60_000); worker.deadline.unref();
        try {
          await worker.prompt(text + (attached.length ? '\nAttached image paths (this conversation only):\n' + attached.map(item => item.path).join('\n') : ''), images,
            {deepResearch, routineRun: due});
        } catch {
          worker.stop();
          failed = {worker, message: 'Pi rejected this message; no reply was completed'};
        }
      }
    } finally { inflight.delete(chat.id); }
    // The turn still counts as running here, so nothing else is admitted in between. endTurn takes its own reservation
    // while it saves, and one taken after it has ended is left alone.
    if (failed) {
      await endTurn(chat, failed.worker, failed.message);
      throw fail(503, failed.message);
    }
  }

  // A run that cannot happen leaves a dated note in its conversation, unless someone is using that conversation right now.
  async function skipRun({routine, scheduled}: RoutineRun, reason: string) {
    const chat = chats.get(routine.chat);
    if (chat && !occupied(chat.id)) {
      chat.messages.push({role: 'assistant', text: '', assets: [], run: `${routine.title} · ${runLabel(scheduled)}`, error: `This run was skipped: ${reason}.`});
      await publish(chat).catch(() => console.warn('Could not save a skipped routine run'));
    }
    await routines.finished(routine, scheduled, 'skipped').catch(() => console.warn('Could not save a routine run'));
  }

  // Starts the queued runs that can start now; the rest wait for the next turn to end. One pass at a time, and a call
  // during a pass makes it go round again, so a run queued meanwhile is not left waiting.
  let draining = false;
  let drainAgain = false;
  async function drainRuns() {
    if (stopping) return;
    if (draining) { drainAgain = true; return; }
    draining = true;
    try {
      do { drainAgain = false; await drainOnce(); } while (drainAgain && !stopping);
    } finally { draining = false; }
  }
  // Takes a run that should no longer happen out of the queue; true if it did.
  async function dropped(run: RoutineRun) {
    if (!chats.has(run.routine.chat) || !current(run)) { dequeue(run); return true; }
    // Paused while it waited: it does not run, and nothing is noted, since the user chose it.
    if (!run.routine.enabled) {
      dequeue(run);
      await routines.finished(run.routine, run.scheduled, 'skipped').catch(() => console.warn('Could not save a routine run'));
      return true;
    }
    return false;
  }
  async function drainOnce() {
    for (const run of [...queue]) {
      // Replaced by a newer run of its routine during this pass.
      if (!queue.includes(run) || await dropped(run)) continue;
      const {routine, scheduled} = run;
      const chat = chats.get(routine.chat)!;
      if (Date.now() - scheduled.getTime() > MISSED_GRACE_MS) {
        dequeue(run); await skipRun(run, 'Home Chat stayed busy for too long'); continue;
      }
      const today = (runTimes.get(routine.owner) ?? []).filter(time => time > Date.now() - 24 * 60 * 60_000);
      if (today.length >= MAX_RUNS_PER_DAY) {
        dequeue(run); await skipRun(run, `routines may run ${MAX_RUNS_PER_DAY} times a day`); continue;
      }
      const before = chat.messages.length;
      try {
        await startTurn(chat, routine.prompt, {run});
        dequeue(run);
        today.push(Date.now()); runTimes.set(routine.owner, today);
      } catch (error) {
        if (error instanceof StaleRun) { await dropped(run); continue; }
        // Busy (a reply is running, or both workers are): it waits. Anything else will not get better by waiting.
        if (error instanceof HttpError && (error.status === 409 || error.status === 429)) continue;
        dequeue(run);
        // A run that was admitted and then failed has already recorded its failure in the thread.
        if (chat.messages.length === before) await skipRun(run, error instanceof HttpError ? error.message : 'it could not start');
      }
    }
  }

  // Pictures and documents the tools wrote during the turn become assets of its reply.
  async function collectGenerated(chat: Chat) {
    const cwd = workDir(chat);
    const found: StoredAsset[] = [];
    const known = (path: string) => chat.assets.some(asset => asset.path === path);
    const images = join(cwd, '.pi/openai-codex-images');
    for (const file of await filesIn(images)) {
      const path = join(images, file);
      if (!/^ig_[0-9a-f]{32}(?:_\d+)?\.png$/.test(file) || known(path)) continue;
      await allowedImagePath(path, cwd);
      found.push({id: randomUUID(), kind: 'generated', path});
    }
    const documents = join(cwd, 'documents');
    for (const file of await filesIn(documents)) {
      const match = DOCUMENT_FILE.exec(file);
      const path = join(documents, file);
      if (!match || known(path)) continue;
      const {title} = await readDocument(path, cwd);
      found.push({id: randomUUID(), kind: 'document', path, document: {doc: match[1], title, version: Number(match[2])}});
    }
    chat.assets.push(...found);
    const last = chat.messages.at(-1);
    if (last?.role === 'assistant') last.assets.push(...found.map(asset => asset.id));
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
    // The token tells the internal socket which conversation a routine call comes from; it is good while this worker is.
    const token = randomBytes(32).toString('base64url');
    const worker = workerFactory(join(chatsDirectory, chat.id), {HOME_CHAT_INTERNAL_SOCKET: internalSocket, HOME_CHAT_ROUTINE_TOKEN: token});
    for (const [old, entry] of workerTokens) if (workers.get(entry.chat) !== entry.worker) workerTokens.delete(old);
    workerTokens.set(token, {chat: chat.id, worker});
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
    worker.on('question', question => {
      emit(chat.id, {type: 'question', question});
      if (!watching(chat.id)) push.notify(chat.owner, {title: chat.title, body: 'Home Chat has a question for you.', chat: chat.id});
    });
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

  // The routine tool's actions, for the owner of the conversation the call comes from. Returns the text the model sees.
  async function routineAction(chat: Chat, body: Record<string, unknown>): Promise<string> {
    const owner = chat.owner;
    const saved = (routine: Routine) => `${describeSchedule(routine.schedule)}. Next run: ${nextLabel(routine)}.`;
    switch (body.action) {
      case 'list': {
        const list = routines.list(owner);
        if (!list.length) return 'There are no routines yet.';
        return list.map(routine => `- “${routine.title}” (id ${routine.id}): ${describeSchedule(routine.schedule)}; ${nextLabel(routine)}`
          + `${routine.deepResearch ? '; deep research' : ''}. Task: ${routine.prompt}`).join('\n');
      }
      case 'create': {
        const prepared = routines.prepare(owner, body);
        if ([...chats.values()].filter(item => item.owner === owner).length >= 20) {
          throw new RoutineError('The user has 20 conversations, the most there can be; they need to delete one first');
        }
        // The routine's own conversation, where its runs arrive. It is only kept if the routine is saved too.
        const home: Chat = {id: randomUUID(), owner, title: prepared.title, messages: [], assets: []};
        await mkdir(join(workDir(home), 'uploads'), {recursive: true, mode: 0o700});
        let routine;
        try { await save(home); chats.set(home.id, home); routine = await routines.create(prepared, home.id); }
        catch (error) { chats.delete(home.id); writes.delete(home.id); await rm(join(chatsDirectory, home.id), {recursive: true, force: true}); throw error; }
        return `Saved “${routine.title}”: ${saved(routine)} Each run arrives in its own conversation, “${routine.title}”, with a notification.`;
      }
      case 'update': {
        const routine = await routines.update(owner, body.id, body);
        showRoutine(routine);
        return `Updated “${routine.title}”: ${saved(routine)}`;
      }
      case 'pause': case 'resume': {
        const routine = await routines.setEnabled(owner, body.id, body.action === 'resume');
        showRoutine(routine);
        return body.action === 'pause' ? `Paused “${routine.title}”. It will not run until resumed.` : `Resumed “${routine.title}”. Next run: ${nextLabel(routine)}.`;
      }
      case 'delete': {
        const routine = await routines.remove(owner, body.id);
        showRoutine(routine);
        return `Deleted “${routine.title}”. Its earlier results stay in the conversation “${routine.title}”, which the user can delete like any other.`;
      }
      default: throw new RoutineError('action must be list, create, update, pause, resume or delete');
    }
  }

  // Only this server's own Pi workers reach this: a Unix socket in the data directory, never a network port.
  const internal = http.createServer(async (req, res) => {
    const send = (status: number, value: unknown) => res.writeHead(status, jsonHeaders).end(JSON.stringify(value));
    try {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const entry = workerTokens.get(token);
      const chat = entry && workers.get(entry.chat) === entry.worker && !entry.worker.closed ? chats.get(entry.chat) : undefined;
      if (!chat) return send(401, {error: 'This session cannot change routines'});
      if (req.url !== '/routine' || req.method !== 'POST') return send(404, {error: 'Not found'});
      if (routineTurns.has(chat.id)) return send(403, {error: 'Routines cannot be changed during a routine run'});
      return send(200, {text: await routineAction(chat, await jsonBody(req, 16_000))});
    } catch (error) {
      if (error instanceof RoutineError) return send(400, {error: error.message});
      if (error instanceof HttpError) return send(error.status, {error: error.message});
      return send(500, {error: 'The routine could not be saved'});
    }
  });
  await rm(internalSocket, {force: true});
  await new Promise<void>((resolve, reject) => { internal.once('error', reject); internal.listen(internalSocket, () => resolve()); });
  await chmod(internalSocket, 0o600);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
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
        const me: Me = {user: session.user, csrf: session.csrf, codexConfigured: await providerReady(), mode: access ? 'access' : 'local', tools: ALLOWED_TOOLS,
          deepResearch: researchReady};
        return send(200, me);
      }
      if (path === '/api/push' && req.method === 'GET') {
        const info: PushInfo = {publicKey: push.publicKey};
        return send(200, info);
      }
      if (path === '/api/push/subscriptions' && (req.method === 'POST' || req.method === 'DELETE')) {
        const body = await jsonBody(req, 8_000);
        let subscription;
        try { subscription = pushSubscription(body); } catch (error) { throw fail(400, (error as Error).message); }
        if (req.method === 'POST') await push.subscribe(session.user, subscription);
        else await push.unsubscribe(session.user, subscription.endpoint);
        return send(200, {ok: true});
      }
      if (path === '/api/logout' && req.method === 'POST') {
        // The device stops receiving this user's notifications in the same step, so a shared phone shows nothing after.
        const body = await jsonBody(req, 4_000);
        if (typeof body.pushEndpoint === 'string') await push.unsubscribe(session.user, body.pushEndpoint);
        // Under Access the browser then leaves through Cloudflare's own logout, which ends the real session.
        sessions.delete(sessionKey);
        for (const clients of streams.values()) for (const client of clients) if (client.sessionKey === sessionKey) client.res.end();
        if (!access) res.setHeader('Set-Cookie', 'home_chat=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return send(200, {ok: true});
      }
      if (path === '/api/chats' && req.method === 'GET') {
        const list: ChatSummary[] = [...chats.values()].filter(chat => chat.owner === session.user)
          .map(({id, title, unread}) => ({id, title, unread: unread === true, routine: routines.byChat(id) !== undefined}));
        return send(200, list);
      }
      if (path === '/api/routines' && req.method === 'GET') {
        const list: RoutineSummary[] = routines.list(session.user).map(routineSummary);
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
      // The app's on/off switch and delete; changing a routine otherwise happens by asking the model.
      if (parts[0] === 'api' && parts[1] === 'routines' && parts.length === 3 && (req.method === 'POST' || req.method === 'DELETE')) {
        const routine = routines.get(parts[2]);
        if (!routine || routine.owner !== session.user) throw fail(404, 'Not found');
        let changed;
        if (req.method === 'POST') {
          const body = await jsonBody(req, 1024);
          if (typeof body.enabled !== 'boolean') throw fail(400, 'Invalid setting');
          try { changed = await routines.setEnabled(session.user, routine.id, body.enabled); }
          catch (error) { if (error instanceof RoutineError) throw fail(409, error.message); throw error; }
        } else changed = await routines.remove(session.user, routine.id);
        showRoutine(changed);
        return send(200, routineSummary(changed));
      }
      if (parts[0] !== 'api' || parts[1] !== 'chats' || !ID_PATTERN.test(parts[2] ?? '')) throw fail(404, 'Not found');
      const chat = chats.get(parts[2]);
      if (!chat || chat.owner !== session.user) throw fail(404, 'Not found');
      // Method plus the path below the chat, e.g. 'GET', 'GET events', 'POST messages'.
      const route = [req.method, ...parts.slice(3)].join(' ');
      // Opening a conversation reads its routine results.
      if ((route === 'GET' || route === 'GET events') && chat.unread) { delete chat.unread; save(chat).catch(() => {}); }
      if (route === 'GET') return send(200, snapshot(chat));
      if (route === 'DELETE') {
        if (occupied(chat.id)) throw fail(409, 'Stop the current reply before deleting this conversation');
        const routine = routines.byChat(chat.id);
        if (routine) throw fail(409, `This conversation belongs to the routine “${routine.title}”; delete the routine first`);
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
        void drainRuns();
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
        if (asset.document) {
          const {title, markdown} = await readDocument(asset.path, workDir(chat));
          if (url.searchParams.has('download')) {
            res.setHeader('Content-Disposition', markdownDisposition(title));
            return send(200, `# ${title}\n\n${markdown}`, {'Content-Type': 'text/markdown; charset=utf-8'});
          }
          const content: DocumentContent = {title, markdown, version: asset.document.version};
          return send(200, content);
        }
        const path = await allowedImagePath(asset.path, workDir(chat));
        if (url.searchParams.has('download')) res.setHeader('Content-Disposition', `attachment; filename="home-chat-${asset.id}.png"`);
        return send(200, await readFile(path), {'Content-Type': 'image/png'});
      }
      if (route === 'POST uploads') {
        if (occupied(chat.id)) throw fail(409, 'Wait for the current message');
        // Documents have their own limit (MAX_DOCUMENT_FILES), so they never use up a conversation's pictures.
        if (chat.assets.filter(asset => !asset.document).length >= 40 || await diskUsage(data) > MAX_DATA - 20 * 1024 * 1024) throw fail(413, 'Prototype storage limit reached');
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
        const recent = (rates.get(session.user) ?? []).filter(time => time > Date.now() - 60 * 60_000);
        if (recent.length >= 30) throw fail(429, 'Prototype limit: 30 messages per hour');
        const body = await jsonBody(req);
        const assetIds = body.assets ?? [];
        if (typeof body.text !== 'string' || body.text.length > 12_000 || !Array.isArray(assetIds) || assetIds.length > 4) throw fail(400, 'Invalid message');
        if (!body.text.trim() && !assetIds.length) throw fail(400, 'Write a message or attach a picture');
        const images: PromptImage[] = []; const attached: StoredAsset[] = [];
        for (const id of assetIds) {
          const asset = chat.assets.find(item => item.id === id);
          if (!asset || asset.document) throw fail(400, 'Invalid attachment');
          const path = await allowedImagePath(asset.path, workDir(chat));
          images.push({type: 'image', mimeType: 'image/png', data: (await readFile(path)).toString('base64')}); attached.push(asset);
        }
        await startTurn(chat, body.text, {images, attached});
        recent.push(Date.now()); rates.set(session.user, recent);
        return send(202, {ok: true});
      }
      if (route === 'POST research') {
        const body = await jsonBody(req, 1024);
        if (typeof body.on !== 'boolean') throw fail(400, 'Invalid setting');
        if (body.on && !researchReady) throw fail(503, 'Deep research is not set up on this Home Chat');
        // It applies from the next message; changing it during a reply would leave that reply's mode unclear.
        if (occupied(chat.id)) throw fail(409, 'Wait for the current reply to finish');
        if (body.on) chat.deepResearch = true; else delete chat.deepResearch;
        await publish(chat);
        return send(200, snapshot(chat));
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
    routines.stop();
    internal.close(); internal.closeAllConnections();
    // Keep what has streamed so far; if this save fails, the `replying` flag saved with the message still marks it.
    await Promise.allSettled([...running].flatMap(id => chats.get(id) ?? []).map(save));
    for (const worker of workers.values()) worker.stop();
    for (const clients of streams.values()) for (const client of clients) client.res.end();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  // Runs that came due while the app was stopped are run or skipped now, and the timer is set for the next one. A run the
  // app stopped in the middle of already says so in its conversation, which is marked unread for its owner.
  for (const routine of routines.start()) {
    const chat = chats.get(routine.chat);
    if (chat && !chat.unread) { chat.unread = true; await save(chat).catch(() => console.warn('Could not save a conversation')); }
  }
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

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { AssetRef, ChatSnapshot, ChatSummary, DocumentContent, DocumentInfo, LibraryContent, Me, MemoryView, Message, PushInfo, RoutineSummary, SearchResult, StreamEvent, TodoList, User } from './api.d.ts';
import { PiRejected, type ChatWorker, type PromptImage } from './chat-worker.ts';
import { createAgent } from './agent/agent.ts';
import { accessConfigFromEnv, type AccessConfig, type AccessKeySource } from './access.ts';
import { readJson, serialSave } from './files.ts';
import { HttpError, fail, jsonBody, recent } from './http.ts';
import { MemoryConflict, MemoryError, createMemory } from './memory.ts';
import { TodoError, TodoMissing, createTodos, todoAction } from './todos.ts';
import { LibraryError, LibraryMissing, createLibrary } from './library.ts';
import { createPush } from './push.ts';
import { createSignIn } from './sign-in.ts';
import { MAX_QUERY, searchChats } from './search.ts';
import { MAX_RUNS_PER_DAY, MISSED_GRACE_MS, RoutineError, createRoutines, describeSchedule, nextLabel, runLabel, whenLabel, type Routine } from './routines.ts';
import { ATTACHED_NOTE, DOCUMENT_FILE, IMAGE_DIRECTORY, IMAGE_FILE, TURN_LIMITS, ID_PATTERN, LOCAL_HOSTS, MAX_UPLOAD, MAX_DATA, USERS, allowedDocumentPath, allowedImagePath, documentInput, isUser, pushSubscription, type ServerCall } from './policy.ts';

interface StoredAsset { id: string; path: string; document?: DocumentInfo }
// `replying` is saved while a reply streams; finding it at startup means the app stopped before the reply finished.
// `shared`: its owner shares it with the household, and both read and write in it. `unread`: who has not seen a routine
// run, or in a shared conversation a reply to the other person, that arrived while they were not looking; each is
// cleared when that person opens the conversation. `starred`: when each person who starred it did so.
interface Chat {
  id: string; owner: User; title: string; messages: Message[]; assets: StoredAsset[]; replying?: true; deepResearch?: true; shared?: true;
  unread?: User[]; starred?: Partial<Record<User, string>>;
}
interface RoutineRun { routine: Routine; scheduled: Date }
// What a conversation is busy with, from a message's admission until its reply's end is saved, or during a delete.
// `by`: who sent the message, or deletes; a routine run is its owner's. `run`: the routine run being answered, with
// nobody watching. `deadline`: the reply's time limit.
interface Turn { by: User; run?: RoutineRun; deadline?: NodeJS.Timeout }
interface StreamClient { res: http.ServerResponse; sessionKey: string; user: User }

export interface AppOptions {
  data?: string;
  // `call` is how the worker's routine, memory and todo tools reach the server. By default, Pi Durable (src/agent/).
  workerFactory?: (directory: string, call: ServerCall) => ChatWorker;
  authenticatedProvider?: () => Promise<boolean>;
  // Set for the public deployment: Cloudflare Access identities replace the local access codes.
  access?: AccessConfig;
  accessKeys?: AccessKeySource;
  // Sends push requests; tests replace it so nothing reaches a real push service.
  pushFetch?: typeof fetch;
  // Whether deep research can run; by default, whether the Exa key is set.
  deepResearch?: boolean;
  // What the app and the model call each person; by default from the environment (namesFromEnv).
  names?: Record<User, string>;
}

// HOME_CHAT_OWNER_NAME and HOME_CHAT_GUEST_NAME, each optional. A set name must be one line of at most 40 characters,
// since the model is told it before every message in a shared conversation.
export function namesFromEnv(env: NodeJS.ProcessEnv): Record<User, string> {
  const name = (key: string, fallback: string) => {
    const value = env[key]?.trim();
    if (!value) return fallback;
    if (value.length > 40 || /\p{Cc}/u.test(value)) throw new Error(`${key} must be one line of at most 40 characters`);
    return value;
  };
  return {owner: name('HOME_CHAT_OWNER_NAME', 'the owner'), guest: name('HOME_CHAT_GUEST_NAME', 'the guest')};
}

const jsonHeaders = {'Content-Type': 'application/json; charset=utf-8'};
// Thrown by startTurn while the conversation, its owner or both workers are busy; a routine run waits and tries again.
class Busy extends HttpError { constructor(message: string, status = 409) { super(status, message); } }
// Thrown by startTurn for a turn that was admitted and then failed; its thread already says so.
class TurnFailed extends HttpError { constructor(message: string) { super(503, message); } }
// Thrown by startTurn for a routine run that was paused or replaced while its worker started; drainOnce settles it.
class StaleRun extends Error {}
// How a reply ends when its end, or what its tools wrote, cannot be saved.
const UNSAVED_REPLY = 'Could not persist the response';
const MAX_CHATS = 20;
const sse = (res: http.ServerResponse, event: StreamEvent) => res.write('data: ' + JSON.stringify(event) + '\n\n');
const publicRoot = resolve(fileURLToPath(new URL('../public', import.meta.url)));

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

export async function createApp({data = '/data', workerFactory, authenticatedProvider, access, accessKeys, pushFetch,
  deepResearch: researchReady = Boolean(process.env.EXA_API_KEY?.trim()), names = namesFromEnv(process.env)}: AppOptions = {}) {
  const chatsDirectory = join(data, 'chats');
  // Deleted conversations are moved here before removal; anything left from an interrupted removal goes at startup.
  const deletedDirectory = join(data, 'deleted');
  await rm(deletedDirectory, {recursive: true, force: true});
  await mkdir(chatsDirectory, {recursive: true, mode: 0o700});
  await mkdir(deletedDirectory, {mode: 0o700});
  const signIn = await createSignIn(join(data, 'local-access.json'), access, accessKeys);
  const agent = workerFactory ? undefined : createAgent({authPath: join(data, 'profile/auth.json'),
    instructions: await readFile(new URL('../profile/instructions.md', import.meta.url), 'utf8')});
  const makeWorker = workerFactory ?? ((directory: string, call: ServerCall) => agent!.worker(directory, call));
  const staticFiles = await loadStaticFiles();
  const origin = access ? 'https://' + access.host : undefined;
  // Push services want a contact for the sender: the public site, or a placeholder in local mode.
  const push = await createPush(join(data, 'push'), origin ?? 'mailto:home-chat@localhost.invalid', pushFetch);
  const rates = new Map<User, number[]>();
  const chats = new Map<string, Chat>();
  const workers = new Map<string, ChatWorker>();
  const streams = new Map<string, Set<StreamClient>>();
  // A conversation in `turns` is occupied. Clients see a reply running while `chat.replying` is set, which is shorter: a
  // message being admitted comes before, and the save of its end after. Each step removes only the entry it set, so
  // it never releases a later one.
  const turns = new Map<string, Turn>();
  const occupied = (id: string) => turns.has(id);
  const release = (id: string, turn: Turn) => { if (turns.get(id) === turn) turns.delete(id); };
  // A person has at most one turn at a time, counting the turns they sent, wherever they are.
  const userBusy = (user: User) => [...turns.values()].some(turn => turn.by === user);
  const ownChats = (user: User) => [...chats.values()].filter(chat => chat.owner === user);
  const canSee = (chat: Chat, user: User) => chat.owner === user || chat.shared === true;
  const visibleChats = (user: User) => [...chats.values()].filter(chat => canSee(chat, user));
  // Who sent a user message; older messages, from before sharing, are the owner's.
  const sender = (chat: Chat, message: Message) => message.by ?? chat.owner;
  const markUnread = (chat: Chat, user: User) => { if (!chat.unread?.includes(user)) (chat.unread ??= []).push(user); };
  // True if it changed, so the conversation needs saving.
  const markRead = (chat: Chat, user: User) => {
    if (!chat.unread?.includes(user)) return false;
    chat.unread = chat.unread.filter(other => other !== user);
    if (!chat.unread.length) delete chat.unread;
    return true;
  };
  const unstar = (chat: Chat, user: User) => {
    if (!chat.starred?.[user]) return;
    delete chat.starred[user];
    if (!Object.keys(chat.starred).length) delete chat.starred;
  };
  // The saved switch only counts while Exa is set up, so removing the key turns research off everywhere, visibly.
  const researching = (chat: Chat) => researchReady && chat.deepResearch === true;
  const workDir = (chat: Chat) => join(chatsDirectory, chat.id, 'work');
  // One saver per conversation, which runs its saves in order (serialSave).
  const savers = new Map<string, () => Promise<void>>();
  const save = (chat: Chat) => {
    let saver = savers.get(chat.id);
    if (!saver) savers.set(chat.id, saver = serialSave(join(chatsDirectory, chat.id, 'chat.json'), () => chat));
    return saver();
  };
  const forget = (chat: Chat) => { chats.delete(chat.id); savers.delete(chat.id); };
  for (const id of await readdir(chatsDirectory)) {
    if (!ID_PATTERN.test(id)) throw new Error('Unexpected conversation directory');
    const chat = await readJson<Chat>(join(chatsDirectory, id, 'chat.json'));
    // A conversation's directory is made before its first save, and it is only shown to anyone after that save, so a
    // directory without a record is a creation the app stopped in the middle of.
    if (chat === undefined) { await rm(join(chatsDirectory, id), {recursive: true}); continue; }
    if (chat.id !== id || !isUser(chat.owner)) throw new Error('Invalid conversation record');
    // Saved before unread was kept per person, when only routine runs, which are the owner's, were marked.
    if ((chat.unread as unknown) === true) chat.unread = [chat.owner];
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
    // A paused routine's run goes in line however late, to be dropped there without a note.
    if (late && routine.enabled) void skipRun({routine, scheduled}, 'Home Chat was not running at the time');
    else { queue.push({routine, scheduled}); void drainRuns(); }
  });
  const memory = await createMemory(join(data, 'memory.json'));
  const todos = await createTodos(join(data, 'todos.json'));
  const library = await createLibrary(data);
  const recordRun = ({routine, scheduled}: RoutineRun, outcome: 'done' | 'failed' | 'skipped') =>
    routines.finished(routine, scheduled, outcome).catch(() => console.warn('Could not save a routine run'));
  const runTag = ({routine, scheduled}: RoutineRun) => `${routine.title} · ${runLabel(scheduled)}`;
  // Routine runs per owner, for the daily budget. Kept in memory: a restart forgets the day's count.
  const runTimes = new Map<User, number[]>();
  const routineSummary = (routine: Routine): RoutineSummary => ({id: routine.id, title: routine.title, chat: routine.chat, enabled: routine.enabled,
    schedule: describeSchedule(routine.schedule), rule: routine.schedule, prompt: routine.prompt, deepResearch: routine.deepResearch,
    next: nextLabel(routine), lastRun: routine.lastRun ? {when: whenLabel(new Date(routine.lastRun.at)), outcome: routine.lastRun.outcome} : null,
    unread: chats.get(routine.chat)?.unread?.includes(routine.owner) === true});
  // Open copies of a routine's conversation show its new state: the switch at the top of the thread.
  const showRoutine = (routine: Routine) => {
    const chat = chats.get(routine.chat);
    if (chat) emit(chat.id, {type: 'snapshot', chat: snapshot(chat)});
  };
  const snapshot = (chat: Chat): ChatSnapshot => {
    const routine = routines.byChat(chat.id);
    const question = workers.get(chat.id)?.question ?? null;
    return {id: chat.id, title: chat.title, owner: chat.owner, shared: chat.shared === true, messages: chat.messages,
      assets: chat.assets.map(({id, document}) => document ? {id, document} : {id}), busy: chat.replying === true, question, redoable: !chat.replying && !question && !notRedoable(chat), deepResearch: researching(chat),
      routine: routine ? routineSummary(routine) : null};
  };
  // This person has the conversation open and in view: the app drops its stream while hidden (public/app.ts).
  const watching = (id: string, user: User) => [...streams.get(id) ?? []].some(client => client.user === user);
  const emit = (id: string, event: StreamEvent) => {
    for (const client of streams.get(id) ?? []) {
      if (client.res.writableLength > 1024 * 1024) { client.res.destroy(); continue; }
      sse(client.res, event);
    }
  };
  // Every page with a conversation open has a stream, so this reaches whoever is looking at the app.
  const emitEverywhere = (event: StreamEvent) => { for (const id of streams.keys()) emit(id, event); };
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

  // A new conversation, shown to anyone only once its record is saved. `full` is the error for an owner at MAX_CHATS.
  async function createChat(owner: User, title: string, full: () => Error): Promise<Chat> {
    if (ownChats(owner).length >= MAX_CHATS) throw full();
    const chat: Chat = {id: randomUUID(), owner, title, messages: [], assets: []};
    await mkdir(join(workDir(chat), 'uploads'), {recursive: true, mode: 0o700});
    try { await save(chat); } catch (error) { await discardChat(chat); throw error; }
    chats.set(chat.id, chat);
    return chat;
  }
  async function discardChat(chat: Chat) {
    forget(chat);
    await rm(join(chatsDirectory, chat.id), {recursive: true, force: true});
  }

  // Ends the conversation's turn, failed with `error` when given. It never rejects, so nothing ends the turn a second
  // time: a reply whose end cannot be saved fails with UNSAVED_REPLY and is saved once more, and if that fails too, the
  // reply is on disk as running, which the next start reports, or not on disk at all.
  async function endTurn(chat: Chat, error?: string) {
    if (stopping) return;
    const turn = turns.get(chat.id);
    const {run, by = chat.owner} = turn ?? {};
    clearTimeout(turn?.deadline);
    const last = chat.messages.at(-1);
    const reply = last?.role === 'assistant' ? last : undefined;
    if (error && reply) reply.error = error;
    delete chat.replying;
    // Who missed the reply: a routine run's owner, and in a shared conversation the person who did not send the message.
    for (const user of USERS) {
      if ((run ? user === by : chat.shared && user !== by) && !watching(chat.id, user)) markUnread(chat, user);
    }
    // Clients see the turn end now, but the conversation stays occupied until it is saved, so a delete cannot remove the files under the save.
    const saving: Turn = {by};
    turns.set(chat.id, saving);
    try { await publish(chat); }
    catch {
      if (!error) {
        error = UNSAVED_REPLY;
        if (reply) reply.error = error;
        emit(chat.id, {type: 'error', message: error});
      }
      await publish(chat).catch(() => console.warn('Could not save a conversation'));
    } finally { release(chat.id, saving); }
    if (run) await recordRun(run, error ? 'failed' : 'done');
    if (!watching(chat.id, by)) {
      push.notify(by, run
        ? {title: run.routine.title, body: error ? 'This run stopped before it finished.' : 'New results are ready.', chat: chat.id, routine: run.routine.id}
        : {title: chat.title, body: error ? 'The reply stopped before it finished.' : 'Your reply is ready.', chat: chat.id});
    }
    void drainRuns();
  }

  // Admits one turn, for a sent message or a routine run, and hands it to Pi. Throws HttpError if it cannot start.
  // `by`: who sends it. `replace`: the message takes the place of the last turn (regenerate, or edit and resend), which
  // Pi forgets first.
  async function startTurn(chat: Chat, text: string, {by, images = [], attached = [], run, replace = false}:
    {by: User; images?: PromptImage[]; attached?: StoredAsset[]; run?: RoutineRun; replace?: boolean}) {
    if (occupied(chat.id)) throw new Busy('A message is already running');
    if (userBusy(by)) throw new Busy('One active conversation per user');
    // Nothing else changes the conversation's messages while it is occupied, so this holds until the turn is admitted.
    const refused = replace && notRedoable(chat, by);
    if (refused) throw fail(409, refused);
    const turn: Turn = {by, run};
    turns.set(chat.id, turn);
    // Why a turn that was admitted could not start; it is ended once admission is over (below).
    let failed: string | undefined;
    try {
      if (!await providerReady()) throw fail(503, 'Codex is not signed in to this isolated profile yet');
      if (chat.messages.length >= 200 || await diskUsage(data) > MAX_DATA - 40 * 1024 * 1024) throw fail(413, 'Prototype conversation or storage limit reached');
      const worker = await workerFor(chat);
      // A worker started while stop() ran would outlive it, so it is stopped here before the message is admitted.
      if (stopping) { worker.stop(); throw fail(503, 'Home Chat is restarting; send the message again in a moment'); }
      // Checked again here, after the waits above and right before the run is admitted.
      if (run && !(current(run) && run.routine.enabled)) throw new StaleRun();
      if (replace) {
        // Every message Pi did not reject is in its copy of the conversation, the last one last, so that is the one it
        // goes back over; one it rejected has nothing to undo.
        const question = chat.messages.at(-2)!;
        let rewound;
        try { rewound = question.delivery === 'rejected' || await worker.rewind(question.text); }
        catch { throw fail(503, 'Pi could not go back to your last message; try again'); }
        if (!rewound) throw fail(409, 'Pi’s copy of this conversation does not match it, so the last turn cannot be redone; send a new message instead');
        chat.messages.splice(-2);
      }
      const deepResearch = run ? run.routine.deepResearch && researchReady : researching(chat);
      const due = run && runLabel(run.scheduled);
      // Saved as unknown before Pi gets it, so a restart before Pi confirms it leaves that on record (Message.delivery).
      const asked: Message = {role: 'user', by, text, assets: attached.map(item => item.id), delivery: 'unknown', ...(run && {run: runTag(run)})};
      chat.messages.push(asked, {role: 'assistant', text: '', assets: []});
      if (chat.title === 'New conversation') chat.title = text.slice(0, 55) || 'Picture conversation';
      chat.replying = true;
      try { await publish(chat); } catch { failed = 'Home Chat could not save this message, so it was not sent'; }
      // Recorded before Pi starts, so the run's own end, however quick, comes after it. Unrecorded, a restart would run
      // it again, so it does not start.
      if (run && !failed) {
        try { await routines.started(run.routine, run.scheduled); }
        catch { failed = 'Home Chat could not save this run, so it did not start'; }
      }
      if (!failed) {
        turn.deadline = setTimeout(() => worker.stop(), TURN_LIMITS[deepResearch ? 'deep' : 'normal'].minutes * 60_000); turn.deadline.unref();
        try {
          await worker.prompt(text + (attached.length ? ATTACHED_NOTE + attached.map(item => item.path).join('\n') : ''), images,
            {deepResearch, routineRun: due, ...(chat.shared && {from: names[by]})});
          delete asked.delivery;
        } catch (error) {
          worker.stop();
          // A timeout or exit leaves it unknown whether Pi recorded the message.
          const rejected = error instanceof PiRejected;
          if (rejected) asked.delivery = 'rejected';
          failed = rejected ? 'Pi rejected this message; no reply was completed' : 'Pi did not confirm this message; no reply was completed';
        }
      }
    } finally {
      // A turn that clients saw stays occupied, so nothing else is admitted before endTurn.
      if (!chat.replying) release(chat.id, turn);
    }
    if (failed) {
      await endTurn(chat, failed);
      throw new TurnFailed(failed);
    }
  }

  // Why the last turn cannot be asked again, as it was or edited; undefined when it can. It can when it is a message the
  // user sent and the reply to it, and Pi confirmed the message. Given `by`, also only when that person sent it; the
  // snapshot leaves that to the app, which knows who is looking.
  function notRedoable(chat: Chat, by?: User): string | undefined {
    const [question, answer] = chat.messages.slice(-2);
    if (!(chat.messages.length >= 2 && question.role === 'user' && !question.run && answer.role === 'assistant' && !answer.run)) {
      return 'Only your last message and its reply can be redone';
    }
    if (by && sender(chat, question) !== by) return 'Only the person who sent the last message can redo it';
    if (question.delivery === 'unknown') return 'This message was cut off before Pi confirmed it, so it cannot be redone; send it again as a new message';
  }

  // A run that cannot happen leaves a dated note in its conversation, unless someone is using that conversation right now.
  async function skipRun({routine, scheduled}: RoutineRun, reason: string) {
    const chat = chats.get(routine.chat);
    if (chat && !occupied(chat.id)) {
      chat.messages.push({role: 'assistant', text: '', assets: [], run: runTag({routine, scheduled}), error: `This run was skipped: ${reason}.`});
      await publish(chat).catch(() => console.warn('Could not save a skipped routine run'));
    }
    await recordRun({routine, scheduled}, 'skipped');
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
      await recordRun(run, 'skipped');
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
      const today = recent(runTimes, routine.owner, 24 * 60 * 60_000);
      if (today.length >= MAX_RUNS_PER_DAY) {
        dequeue(run); await skipRun(run, `routines may run ${MAX_RUNS_PER_DAY} times a day`); continue;
      }
      try {
        await startTurn(chat, routine.prompt, {by: routine.owner, run});
        dequeue(run);
        today.push(Date.now());
      } catch (error) {
        if (error instanceof StaleRun) { await dropped(run); continue; }
        // Busy (a reply is running, or both workers are): it waits. Anything else will not get better by waiting.
        if (error instanceof Busy) continue;
        dequeue(run);
        if (!(error instanceof TurnFailed)) await skipRun(run, error instanceof HttpError ? error.message : 'it could not start');
      }
    }
  }

  // Pictures and documents the tools wrote during the turn become assets of its reply.
  async function collectGenerated(chat: Chat) {
    const cwd = workDir(chat);
    const found: StoredAsset[] = [];
    const known = (path: string) => chat.assets.some(asset => asset.path === path);
    const images = join(cwd, IMAGE_DIRECTORY);
    for (const file of await filesIn(images)) {
      const path = join(images, file);
      if (!IMAGE_FILE.test(file) || known(path)) continue;
      await allowedImagePath(path, cwd);
      found.push({id: randomUUID(), path});
    }
    const documents = join(cwd, 'documents');
    for (const file of await filesIn(documents)) {
      const match = DOCUMENT_FILE.exec(file);
      const path = join(documents, file);
      if (!match || known(path)) continue;
      const {title} = await readDocument(path, cwd);
      found.push({id: randomUUID(), path, document: {doc: match[1], title, version: Number(match[2])}});
    }
    chat.assets.push(...found);
    const last = chat.messages.at(-1);
    if (last?.role === 'assistant') last.assets.push(...found.map(asset => asset.id));
  }

  async function workerFor(chat: Chat): Promise<ChatWorker> {
    // stop() stops the workers it finds; none may start after it.
    if (stopping) throw fail(503, 'Home Chat is restarting; send the message again in a moment');
    const existing = workers.get(chat.id);
    if (existing && !existing.closed) return existing;
    workers.delete(chat.id);
    if (workers.size >= 2) {
      const idle = [...workers.keys()].find(id => !occupied(id));
      if (!idle) throw new Busy('Both chat workers are busy', 429);
      workers.get(idle)!.stop(); workers.delete(idle);
    }
    const worker = makeWorker(join(chatsDirectory, chat.id), (path, body) => serverCall(chat, path, body));
    const failTurn = (message: string) => {
      emit(chat.id, {type: 'error', message});
      return endTurn(chat, message);
    };
    worker.on('failure', message => { void failTurn(message); });
    let saveTimer: NodeJS.Timeout | undefined;
    worker.on('delta', text => {
      const last = chat.messages.at(-1);
      if (last?.role !== 'assistant') return;
      if (last.text.length + text.length > 100_000) { worker.stop('Response size limit reached'); return; }
      last.text += text; emit(chat.id, {type: 'delta', text});
      // Streamed text is saved every few seconds so a crash loses only the last moments of a reply. A failed save here is
      // left to the turn's final save, which reports it.
      saveTimer ??= setTimeout(() => {
        saveTimer = undefined;
        if (chat.replying) save(chat).catch(() => {});
      }, 2000);
      saveTimer.unref();
    });
    worker.on('tool', name => emit(chat.id, {type: 'tool', name}));
    worker.on('question', question => {
      emit(chat.id, {type: 'question', question});
      const by = turns.get(chat.id)?.by ?? chat.owner;
      if (!watching(chat.id, by)) push.notify(by, {title: chat.title, body: 'Home Chat has a question for you.', chat: chat.id});
    });
    worker.on('settled', () => {
      clearTimeout(turns.get(chat.id)?.deadline);
      void collectGenerated(chat).then(() => endTurn(chat), () => failTurn(UNSAVED_REPLY));
    });
    workers.set(chat.id, worker);
    try { await worker.start(); }
    catch (error) { workers.delete(chat.id); worker.stop(); throw fail(503, (error as Error).message); }
    return worker;
  }

  // The routine tool's actions, for the person whose turn the call comes from. Returns the text the model sees.
  async function routineAction(owner: User, body: Record<string, unknown>): Promise<string> {
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
        // The routine's own conversation, where its runs arrive. It is only kept if the routine is saved too.
        const home = await createChat(owner, prepared.title,
          () => new RoutineError(`The user has ${MAX_CHATS} conversations, the most there can be; they need to delete one first`));
        let routine;
        try { routine = await routines.create(prepared, home.id); }
        catch (error) { await discardChat(home); throw error; }
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

  // The Todos page. Every change answers with the list as it is now, and a list this person cannot see is not found.
  async function todoRoute(user: User, req: http.IncomingMessage, [list, kind, item, ...rest]: string[]): Promise<[number, unknown]> {
    const route = [req.method, list && 'list', kind, item && 'item'].filter(Boolean).join(' ');
    if (rest.length) throw fail(404, 'Not found');
    const body = () => jsonBody(req, 4_000);
    const id = Number(item);
    try {
      switch (route) {
        case 'GET': return [200, todos.list(user) satisfies TodoList[]];
        case 'POST': return [201, await todos.create(user, await body())];
        case 'PATCH list': return [200, await todos.update(user, list, await body())];
        case 'DELETE list': return [200, await todos.remove(user, list)];
        case 'POST list items': return [201, (await todos.add(user, list, [(await body()).text])).list];
        case 'POST list clear': return [200, await todos.removeItems(user, list)];
        case 'PATCH list items item': return [200, await todos.edit(user, list, [id], await body())];
        case 'DELETE list items item': return [200, await todos.removeItems(user, list, [id])];
        default: throw fail(404, 'Not found');
      }
    } catch (error) {
      if (error instanceof TodoMissing) throw fail(404, 'This list is gone or no longer shared with you');
      if (error instanceof TodoError) throw fail(400, error.message);
      throw error;
    }
  }

  // What a conversation's tools ask of the server: the household notes for the turn's instructions (routine runs
  // included), changes to routines and notes, and the todo lists, which routine runs may change too. All of them are the
  // turn's sender's. Fails with an HttpError whose message the model is shown.
  async function serverCall(chat: Chat, path: Parameters<ServerCall>[0], body?: unknown): Promise<string> {
    const turn = turns.get(chat.id);
    const user = turn?.by ?? chat.owner;
    if (path === '/memory' && body === undefined) return memory.prompt(user);
    if (path !== '/todo' && turn?.run) throw fail(403, 'Routines and household notes cannot be changed during a routine run');
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw fail(400, 'Invalid request');
    const input = body as Record<string, unknown>;
    try {
      if (path === '/todo') return await todoAction(todos, user, input);
      if (path === '/routine') return await routineAction(user, input);
      // The memory tool checks a change first, then asks the user, then makes it (src/agent/tools/memory.ts).
      if (input.check === true) { memory.check(user, input); return 'OK'; }
      await memory.apply(user, input);
      return input.action === 'forget' ? 'Forgotten.' : 'Saved under About us; you will be told it in every conversation from now on.';
    } catch (error) {
      if (error instanceof RoutineError || error instanceof MemoryError || error instanceof TodoError) throw fail(400, error.message);
      if (error instanceof HttpError) throw error;
      throw fail(500, 'Home Chat could not save that');
    }
  }


  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const send = (status: number, value: unknown, headers: http.OutgoingHttpHeaders = jsonHeaders) =>
      res.writeHead(status, headers).end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    // A picture, or a document as the reader shows it; `download` sends either as a file to save.
    const sendPicture = async (id: string, path: string, download: boolean) => {
      if (download) res.setHeader('Content-Disposition', `attachment; filename="home-chat-${id}.png"`);
      return send(200, await readFile(path), {'Content-Type': 'image/png'});
    };
    const sendDocument = ({title, markdown}: {title: string; markdown: string}, version: number, download: boolean) => {
      if (!download) return send(200, {title, markdown, version} satisfies DocumentContent);
      res.setHeader('Content-Disposition', markdownDisposition(title));
      return send(200, `# ${title}\n\n${markdown}`, {'Content-Type': 'text/markdown; charset=utf-8'});
    };
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
        res.setHeader('Set-Cookie', await signIn.login(req));
        return send(200, {ok: true});
      }
      const {session, sessionKey} = await signIn.authenticate(req);
      if (mutation && req.headers['x-csrf-token'] !== session.csrf) throw fail(403, 'CSRF check failed');
      if (path === '/api/me' && req.method === 'GET') {
        const me: Me = {user: session.user, names, csrf: session.csrf, codexConfigured: await providerReady(), mode: access ? 'access' : 'local',
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
        const cleared = signIn.logout(sessionKey);
        for (const clients of streams.values()) for (const client of clients) if (client.sessionKey === sessionKey) client.res.end();
        if (cleared) res.setHeader('Set-Cookie', cleared);
        return send(200, {ok: true});
      }
      if (path === '/api/chats' && req.method === 'GET') {
        const list: ChatSummary[] = visibleChats(session.user).map(({id, title, owner, shared, unread, starred}) => ({id, title,
          unread: unread?.includes(session.user) === true, routine: routines.byChat(id) !== undefined, shared: shared === true, mine: owner === session.user,
          starred: starred?.[session.user] ?? null}));
        return send(200, list);
      }
      if (path === '/api/search' && req.method === 'GET') {
        const query = url.searchParams.get('q') ?? '';
        if (query.length > MAX_QUERY) throw fail(400, `Search for at most ${MAX_QUERY} characters`);
        // Newest first, as the sidebar lists them. A search the app has replaced (its request closed) stops early.
        const visible = visibleChats(session.user).reverse();
        const asker = new AbortController();
        res.once('close', () => asker.abort());
        let results: SearchResult[];
        try { results = await searchChats(visible, query, asker.signal); }
        catch (error) { if (asker.signal.aborted) return; throw error; }
        // A conversation deleted, or made private, while the search paused is left out.
        return send(200, results.filter(result => { const chat = chats.get(result.chat); return chat && canSee(chat, session.user); }));
      }
      if (path === '/api/memory' && req.method === 'GET') return send(200, memory.view(session.user) satisfies MemoryView);
      if (path === '/api/memory' && req.method === 'PUT') {
        try { await memory.replace(session.user, await jsonBody(req, 64_000)); }
        catch (error) {
          if (error instanceof MemoryError) throw fail(400, error.message);
          if (error instanceof MemoryConflict) throw fail(409, 'These notes were changed meanwhile; open About us again to see the latest');
          throw error;
        }
        return send(200, memory.view(session.user) satisfies MemoryView);
      }
      if (path === '/api/routines' && req.method === 'GET') {
        const list: RoutineSummary[] = routines.list(session.user).map(routineSummary);
        return send(200, list);
      }
      if (path === '/api/chats' && req.method === 'POST') {
        const chat = await createChat(session.user, 'New conversation', () => fail(429, `Prototype limit: ${MAX_CHATS} conversations per user`));
        return send(201, snapshot(chat));
      }
      const parts = path.split('/').filter(Boolean);
      if (parts[0] === 'api' && parts[1] === 'todos') return send(...await todoRoute(session.user, req, parts.slice(2)));
      // The Library page. Both people see every item; only its sharer removes it.
      if (parts[0] === 'api' && parts[1] === 'library' && parts.length <= 3) {
        const route = [req.method, parts[2] === 'seen' ? 'seen' : parts[2] && 'item'].filter(Boolean).join(' ');
        try {
          switch (route) {
            case 'GET': return send(200, library.view(session.user));
            case 'POST seen': return send(200, await library.seen(session.user));
            case 'DELETE item': {
              const left = await library.remove(session.user, parts[2]);
              emitEverywhere({type: 'library'});
              return send(200, left);
            }
            case 'GET item': {
              const {item, path} = library.get(session.user, parts[2]);
              const download = url.searchParams.has('download');
              if (item.kind === 'picture') return await sendPicture(item.id, path, download);
              return sendDocument(JSON.parse(await readFile(path, 'utf8')), item.version, download);
            }
          }
        } catch (error) {
          // Removed meanwhile, between finding the item and reading its copy too.
          if (error instanceof LibraryMissing || (error as NodeJS.ErrnoException).code === 'ENOENT') throw fail(404, 'This was removed from the Library');
          if (error instanceof LibraryError) throw fail(403, error.message);
          throw error;
        }
      }
      // The Routines page: its on/off switch, edits and delete. Creating one happens by asking the model.
      if (parts[0] === 'api' && parts[1] === 'routines' && parts.length === 3 && ['POST', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
        const routine = routines.get(parts[2]);
        if (!routine || routine.owner !== session.user) throw fail(404, 'Not found');
        let changed;
        if (req.method === 'POST') {
          const body = await jsonBody(req, 1024);
          if (typeof body.enabled !== 'boolean') throw fail(400, 'Invalid setting');
          try { changed = await routines.setEnabled(session.user, routine.id, body.enabled); }
          catch (error) { if (error instanceof RoutineError) throw fail(409, error.message); throw error; }
        } else if (req.method === 'PATCH') {
          const body = await jsonBody(req, 32 * 1024);
          const edit = {title: body.title, prompt: body.prompt, schedule: body.rule, deepResearch: body.deepResearch};
          try { changed = await routines.update(session.user, routine.id, edit); }
          catch (error) { if (error instanceof RoutineError) throw fail(400, error.message); throw error; }
        } else changed = await routines.remove(session.user, routine.id);
        showRoutine(changed);
        return send(200, routineSummary(changed));
      }
      if (parts[0] !== 'api' || parts[1] !== 'chats' || !ID_PATTERN.test(parts[2] ?? '')) throw fail(404, 'Not found');
      const chat = chats.get(parts[2]);
      if (!chat || !canSee(chat, session.user)) throw fail(404, 'Not found');
      // Checked again after every wait in a request that changes the conversation: it may have been deleted, or made
      // private to the other person, meanwhile.
      const stillVisible = () => { if (chats.get(chat.id) !== chat || !canSee(chat, session.user)) throw fail(404, 'Not found'); };
      // Method plus the path below the chat, with `asset` for an asset's id, e.g. 'GET', 'GET events', 'GET assets asset'.
      const [kind, assetId, ...rest] = parts.slice(3);
      const route = [req.method, kind, assetId && 'asset', ...rest].filter(Boolean).join(' ');
      // Only its owner deletes it or changes who sees it.
      if ((route === 'DELETE' || route === 'POST share') && chat.owner !== session.user) {
        throw fail(403, 'Only the person who started this conversation can do that');
      }
      // Opening a conversation reads what arrived in it meanwhile.
      if ((route === 'GET' || route === 'GET events') && markRead(chat, session.user)) save(chat).catch(() => {});
      if (route === 'GET') return send(200, snapshot(chat));
      if (route === 'DELETE') {
        if (occupied(chat.id)) throw fail(409, 'Stop the current reply before deleting this conversation');
        const routine = routines.byChat(chat.id);
        if (routine) throw fail(409, `This conversation belongs to the routine “${routine.title}”; delete the routine first`);
        // Occupied so no message, upload or second delete starts while the files move.
        const deleting: Turn = {by: session.user};
        turns.set(chat.id, deleting);
        try {
          // Its model transcript is in the directory, open until the worker has stopped, or one it replaced has.
          await workers.get(chat.id)?.stop(); workers.delete(chat.id);
          await agent?.released(join(chatsDirectory, chat.id));
          // One rename takes the conversation out of the chats directory, so a failed removal never leaves half of it to load.
          const removed = join(deletedDirectory, chat.id);
          await rename(join(chatsDirectory, chat.id), removed);
          forget(chat);
          // Other pages showing it are told why it went; the one deleting it moves on by itself.
          for (const client of streams.get(chat.id) ?? []) {
            if (client.sessionKey !== sessionKey) sse(client.res, {type: 'gone'});
            client.res.end();
          }
          streams.delete(chat.id);
          await rm(removed, {recursive: true, force: true});
        } finally { release(chat.id, deleting); }
        void drainRuns();
        return send(200, {ok: true});
      }
      if (route === 'POST share') {
        const body = await jsonBody(req, 1024);
        if (typeof body.on !== 'boolean') throw fail(400, 'Invalid setting');
        if (routines.byChat(chat.id)) throw fail(409, 'A routine’s conversation stays private');
        // A reply running for the other person would otherwise go on in a conversation they can no longer see.
        if (!body.on && occupied(chat.id)) throw fail(409, 'Wait for the current reply to finish');
        if (body.on) chat.shared = true;
        else {
          delete chat.shared;
          for (const user of USERS) if (user !== chat.owner) { markRead(chat, user); unstar(chat, user); }
          for (const client of streams.get(chat.id) ?? []) {
            if (client.user !== chat.owner) { sse(client.res, {type: 'gone'}); client.res.end(); }
          }
        }
        await publish(chat);
        return send(200, snapshot(chat));
      }
      // Each person's own: it lists the conversation first in their sidebar. Starring it again keeps its place.
      if (route === 'POST star') {
        const body = await jsonBody(req, 1024);
        if (typeof body.on !== 'boolean') throw fail(400, 'Invalid setting');
        stillVisible();
        if (routines.byChat(chat.id)) throw fail(409, 'A routine’s conversation is listed under Routines');
        if (!body.on) unstar(chat, session.user);
        else if (!chat.starred?.[session.user]) (chat.starred ??= {})[session.user] = new Date().toISOString();
        await save(chat);
        return send(200, {ok: true});
      }
      if (route === 'GET events') {
        const clients = streams.get(chat.id) ?? new Set();
        if (clients.size >= 4) throw fail(429, 'Too many open chat streams');
        res.writeHead(200, {'Content-Type': 'text/event-stream', 'Connection': 'keep-alive'});
        const client = {res, sessionKey, user: session.user}; clients.add(client); streams.set(chat.id, clients);
        sse(res, {type: 'snapshot', chat: snapshot(chat)});
        const heartbeat = setInterval(() => {
          if (!signIn.live(sessionKey, session)) return res.end();
          res.write(': keepalive\n\n');
        }, 15_000);
        heartbeat.unref();
        res.on('close', () => { clearInterval(heartbeat); clients.delete(client); });
        return;
      }
      // Copies one document or picture into the Library, for both people, without sharing the conversation.
      if (route === 'POST assets asset share') {
        const asset = chat.assets.find(item => item.id === assetId);
        if (!asset) throw fail(404, 'Not found');
        if (await diskUsage(data) > MAX_DATA - 20 * 1024 * 1024) throw fail(413, 'Prototype storage limit reached');
        let content: LibraryContent; let copy: Buffer | string; let source: string;
        if (asset.document) {
          const {title, markdown} = await readDocument(asset.path, workDir(chat));
          content = {kind: 'document', title, version: asset.document.version};
          copy = JSON.stringify({title, markdown});
          source = `${chat.id}/${asset.document.doc}`;
        } else {
          content = {kind: 'picture'};
          copy = await readFile(await allowedImagePath(asset.path, workDir(chat)));
          source = `${chat.id}/${asset.id}`;
        }
        let item;
        try { item = await library.share(session.user, source, content, copy, stillVisible); }
        catch (error) { if (error instanceof LibraryError) throw fail(409, error.message); throw error; }
        emitEverywhere({type: 'library'});
        return send(201, item);
      }
      if (route === 'GET assets asset') {
        const asset = chat.assets.find(item => item.id === assetId);
        if (!asset) throw fail(404, 'Not found');
        const download = url.searchParams.has('download');
        if (asset.document) return sendDocument(await readDocument(asset.path, workDir(chat)), asset.document.version, download);
        return await sendPicture(asset.id, await allowedImagePath(asset.path, workDir(chat)), download);
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
        stillVisible();
        await writeFile(path, normalized, {mode: 0o600});
        // Deleted or made private while the file was written: the picture does not go in.
        try { stillVisible(); } catch (error) { await rm(path, {force: true}); throw error; }
        chat.assets.push({id, path}); await save(chat);
        const asset: AssetRef = {id};
        return send(201, asset);
      }
      if (route === 'POST messages') {
        const sent = recent(rates, session.user, 60 * 60_000);
        if (sent.length >= 30) throw fail(429, 'Prototype limit: 30 messages per hour');
        const body = await jsonBody(req);
        const assetIds = body.assets ?? [];
        if (typeof body.text !== 'string' || body.text.length > 12_000 || !Array.isArray(assetIds) || assetIds.length > 4) throw fail(400, 'Invalid message');
        if (body.replace !== undefined && typeof body.replace !== 'boolean') throw fail(400, 'Invalid message');
        if (!body.text.trim() && !assetIds.length) throw fail(400, 'Write a message or attach a picture');
        const images: PromptImage[] = []; const attached: StoredAsset[] = [];
        for (const id of assetIds) {
          const asset = chat.assets.find(item => item.id === id);
          if (!asset || asset.document) throw fail(400, 'Invalid attachment');
          const path = await allowedImagePath(asset.path, workDir(chat));
          images.push({type: 'image', mimeType: 'image/png', data: (await readFile(path)).toString('base64')}); attached.push(asset);
        }
        // startTurn occupies the conversation before it waits for anything, and an occupied one cannot be made private.
        stillVisible();
        await startTurn(chat, body.text, {by: session.user, images, attached, replace: body.replace === true});
        sent.push(Date.now());
        return send(202, {ok: true});
      }
      if (route === 'POST research') {
        const body = await jsonBody(req, 1024);
        if (typeof body.on !== 'boolean') throw fail(400, 'Invalid setting');
        stillVisible();
        if (body.on && !researchReady) throw fail(503, 'Deep research is not set up on this Home Chat');
        // It applies from the next message; changing it during a reply would leave that reply's mode unclear.
        if (occupied(chat.id)) throw fail(409, 'Wait for the current reply to finish');
        if (body.on) chat.deepResearch = true; else delete chat.deepResearch;
        await publish(chat);
        // The answer shows the conversation as it is now, which may no longer be this person's to see.
        stillVisible();
        return send(200, snapshot(chat));
      }
      if (route === 'POST answer') {
        const body = await jsonBody(req, 16_000);
        stillVisible();
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
    // Keep what has streamed so far; if this save fails, the `replying` flag saved with the message still marks it.
    await Promise.allSettled([...chats.values()].filter(chat => chat.replying).map(save));
    await Promise.all([...workers.values()].map(worker => worker.stop()));
    await agent?.close();
    for (const clients of streams.values()) for (const client of clients) client.res.end();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  // Runs that came due while the app was stopped are run or skipped now, and the timer is set for the next one. A run the
  // app stopped in the middle of already says so in its conversation, which is marked unread for its owner.
  for (const routine of routines.start()) {
    const chat = chats.get(routine.chat);
    if (chat && !chat.unread?.includes(chat.owner)) {
      markUnread(chat, chat.owner);
      await save(chat).catch(() => console.warn('Could not save a conversation'));
    }
  }
  return {server, stop};
}

if (import.meta.main) {
  const mode = process.env.HOME_CHAT_MODE;
  if (mode !== 'local' && mode !== 'access') throw new Error('Set HOME_CHAT_MODE to local or access');
  const app = await createApp(mode === 'access' ? {access: accessConfigFromEnv(process.env)} : {});
  app.server.listen(8080, '0.0.0.0', () => console.log(`Home Chat ready in ${mode} mode; provider login is checked separately`));
  process.once('SIGTERM', () => { void app.stop(); });
}

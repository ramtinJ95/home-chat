// Pi Durable inside the server process. Each Home Chat conversation keeps its model transcript in its own SQLite file,
// chats/<id>/agent.sqlite, so deleting the conversation's directory deletes the transcript too (Pi Durable itself cannot
// delete a conversation). A file is open only while its conversation has a worker: one Harness per worker.
// Regenerate and edit continue in a fork, which the file's link document points at. Each worker (src/agent/worker.ts)
// is the server's ChatWorker for one conversation.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { MutableModels } from '@earendil-works/pi-ai';
import { closeOpenAICodexWebSocketSessions } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { createRegistry, defineDoc, Harness, ResetEntry, type Conversation, type ConversationId, type EntryId, type Tx } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { Message } from '../api.d.ts';
import type { ServerCall } from '../policy.ts';
import { codexModels } from './codex.ts';
import { homeExtension, type ChatHost } from './extension.ts';
import { DurableWorker } from './worker.ts';

// The durable conversation the Home Chat conversation continues.
const ChatLink = defineDoc<{conversation: number | null}>({kind: 'home-chat.link', version: 1, scope: 'session', initial: () => ({conversation: null})});

// Earlier text of a conversation that predates its durable one, at most this much of the newest.
const MAX_SEED = 60_000;

export interface AgentOptions {
  // Tests pass faux models; by default the Codex login at authPath.
  models?: MutableModels;
  authPath?: string;
  model?: {provider: string; modelId: string};
  instructions: string;
  // Model request retries after a failed attempt.
  maxRetries?: number;
  onReport?: (error: unknown) => void;
}

// One conversation's open file.
export interface ChatStore {
  readonly harness: Harness;
  // The linked conversation, created on first use.
  conversation(): Promise<Conversation>;
  // Links a fork of `from` that ends at `at`, or a new empty conversation when `at` is absent.
  moveTo(from: Conversation, at: EntryId | undefined): Promise<Conversation>;
  // Aborts the work of `running` first, if given.
  close(running?: Conversation): Promise<void>;
}

// Opens a conversation's file. `host` is the worker whose conversation the file holds; its tools and policy work
// through it.
export type OpenStore = (directory: string, host: (conversation: ConversationId) => ChatHost | undefined) => Promise<ChatStore>;

export interface HomeAgent {
  worker(directory: string, call: ServerCall): DurableWorker;
  // Resolves once the directory's file is not being closed, e.g. by a worker that was replaced.
  released(directory: string): Promise<void>;
  // Resolves once every file being closed is closed. For when the process is done with the agent.
  close(): Promise<void>;
}

export function createAgent(options: AgentOptions): HomeAgent {
  const models = options.models ?? codexModels(options.authPath ?? '/data/profile/auth.json');
  const agent = {
    model: options.model ?? {provider: 'openai-codex', modelId: process.env.HOME_CHAT_MODEL ?? 'gpt-6.1-sol'},
    thinkingLevel: 'high' as const,
  };
  // Errors may carry request details, so only their message is logged.
  const onReport = options.onReport ?? (error => console.warn('Agent report:', error instanceof Error ? error.message : 'unknown'));
  // A file is opened only after the previous Harness on it has closed: one process, one owner at a time.
  const closing = new Map<string, Promise<void>>();

  const open: OpenStore = async (directory, host) => {
    await closing.get(directory);
    const registry = createRegistry();
    const home = homeExtension({models, instructions: options.instructions, hostFor: host});
    registry.install(home);
    const harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'agent.sqlite')), {
      models, registry, onReport,
      // Only Home Chat's extension, whatever else may be installed. Compaction only when a request would not fit, as
      // part of the turn: a background one would keep calling the model after the turn ended or was stopped.
      settings: {extensions: [home], retry: {maxRetries: options.maxRetries ?? 2}, compaction: {backgroundTokens: 0}},
    }, context);

    // A reply a restart interrupted is marked as such in chat.json (src/server.ts), so its unfinished work is stopped
    // here rather than resumed behind the conversation's back. Everything is marked before the scheduler starts, so
    // it runs only the abort handlers, and the conversation is idle again before the next message.
    const {tasks, submissions} = await harness.inspect(context);
    for (const submission of submissions) await harness.abortSubmission(submission.id, context);
    for (const task of tasks) await harness.abortTask(task.record.id, context);
    if (tasks.length) await harness.waitForIdle(context);

    const link = async (tx: Tx, conversation: ConversationId) => { (await tx.doc(ChatLink)).conversation = conversation; };
    return {
      harness,
      async conversation() {
        const linked = (await harness.snapshot(ChatLink, context))?.conversation;
        const existing = typeof linked === 'number' && await harness.conversation(linked as ConversationId, context);
        if (existing) return existing;
        // A conversation from before the agent starts from the text of its earlier messages.
        const earlier = await seedText(join(directory, 'chat.json'));
        return harness.createConversation({
          ownership: {kind: 'ownerless'}, agent,
          init: async (tx, id) => {
            await link(tx, id);
            if (earlier) await tx.appendEntry(ResetEntry, id, {head: 'self', model: [{role: 'user', content: earlier, timestamp: Date.now()}]});
          },
        }, context);
      },
      moveTo(from, at) {
        return at === undefined ? harness.createConversation({ownership: {kind: 'ownerless'}, agent, init: link}, context)
          : from.fork(at, {ownership: {kind: 'ownerless'}, init: link}, context);
      },
      close(running) {
        const closed = (async () => {
          await running?.abort(context).catch(onReport);
          await harness.close(context);
        })().catch(onReport);
        closing.set(directory, closed);
        void closed.then(() => { if (closing.get(directory) === closed) closing.delete(directory); });
        return closed;
      },
    };
  };

  return {
    worker: (directory, call) => new DurableWorker(open, directory, call),
    released: async directory => { await closing.get(directory); },
    close: async () => {
      await Promise.all(closing.values());
      // pi-ai keeps each session's Codex WebSocket open for 5 minutes after its last request, which would hold the
      // process past SIGTERM until Docker kills it.
      closeOpenAICodexWebSocketSessions();
    },
  };
}

async function seedText(path: string): Promise<string | undefined> {
  let messages: Message[];
  try { messages = (JSON.parse(await readFile(path, 'utf8')) as {messages?: Message[]}).messages ?? []; }
  catch { return undefined; }
  const lines = messages.filter(message => message.text.trim() && !message.error)
    .map(message => `${message.role === 'user' ? 'User' : 'Home Chat'}: ${message.text.trim()}`);
  let text = '';
  for (const line of lines.reverse()) {
    // The newest message alone may be longer than that; its end is kept.
    const room = MAX_SEED - text.length;
    if (room <= 0) break;
    text = (line.length > room ? '…' + line.slice(-room) : line) + '\n\n' + text;
  }
  return text ? 'The conversation so far, from before Home Chat kept its own transcript (no pictures or tool results):\n\n' + text : undefined;
}

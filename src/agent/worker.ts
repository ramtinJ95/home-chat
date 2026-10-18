// One Home Chat conversation on Pi Durable, behind the ChatWorker interface the server used with the Pi CLI: it turns
// the conversation's events into deltas, tool labels, questions and the turn's end.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BACKGROUND_CONTEXT as context, type Context } from '@earendil-works/chord/context';
import type { AssistantMessage, ImageContent } from '@earendil-works/pi-ai';
import { ConversationBusy, UserEntry, watchEvents, type AgentEvent, type AgentEventStream, type Conversation, type Cursor, type EntryRecord, type SubmissionId, type SubmissionRecord } from '@earendil-works/pi-durable';
import type { Question } from '../api.d.ts';
import { MAX_QUESTION_OPTIONS, carriesText, composePrompt, isAllowedTool, type ServerCall, type TurnMode } from '../policy.ts';
import { PiRejected, type ChatWorker, type PromptImage, type WorkerEvents } from '../chat-worker.ts';
import type { ChatStore, OpenStore } from './agent.ts';
import type { ChatHost } from './extension.ts';

// The question the app shows, and the tool waiting for its answer.
interface Pending { question: Question; resolve: (value: string | boolean | undefined) => void }

export class DurableWorker extends EventEmitter<WorkerEvents> implements ChatWorker, ChatHost {
  readonly directory: string;
  readonly chat: string;
  readonly cwd: string;
  readonly call: ServerCall;
  readonly #open: OpenStore;
  #store?: ChatStore;
  closed = false;
  turn: ChatHost['turn'] = {mode: {}, calls: 0, images: 0};
  #conversation?: Conversation;
  #stream?: AgentEventStream;
  #pending?: Pending;
  #opening?: Promise<ChatStore>;
  #stopped?: Promise<void>;
  // From a prompt until its submission ends; events outside a turn are ignored.
  #active = false;
  #submission?: SubmissionId;
  // Submissions the event stream saw end, in case that happens before submit() returns.
  readonly #ended = new Map<SubmissionId, SubmissionRecord>();
  // The streamed message's text blocks as known so far, and how much of each was sent as deltas.
  #texts = new Map<number, string>();
  #sent = new Map<number, number>();

  constructor(open: OpenStore, directory: string, call: ServerCall) {
    super();
    this.#open = open;
    this.directory = directory;
    this.chat = basename(directory);
    this.cwd = join(directory, 'work');
    this.call = call;
  }

  async start(): Promise<void> {
    // From the first step, so a stop() meanwhile waits for the file and closes it.
    this.#opening = (async () => {
      await mkdir(join(this.cwd, 'uploads'), {recursive: true, mode: 0o700});
      // Its tools reach this worker only for the conversation it is on.
      return this.#open(this.directory, id => !this.closed && id === this.#conversation?.id ? this : undefined);
    })();
    const store = this.#store = await this.#opening;
    // Stopped while the file opened; stop() closes it.
    if (this.closed) throw new Error('The conversation was closed');
    await this.#attach(await store.conversation());
  }

  async #attach(conversation: Conversation) {
    await this.#stream?.stop();
    this.#conversation = conversation;
    const stream = this.#stream = await watchEvents(this.#store!.harness, conversation.id, context);
    stream.start(async events => { for (const event of events) await this.#handle(event); });
    // A storage failure ends the Harness and its event streams without ending the turn's submission.
    void stream.closed.then(end => {
      if (this.#stream !== stream || !this.#active) return;
      this.#endTurn();
      this.emit('failure', end.reason === 'session_failed' ? 'Home Chat could not save the conversation' : 'The reply stopped before it finished');
    });
  }

  async #handle(event: AgentEvent) {
    if (event.type === 'submission' && (event.record.status === 'done' || event.record.status === 'unanswered')) {
      this.#ended.set(event.record.id, event.record);
      if (event.record.id === this.#submission) this.#finish(event.record);
      return;
    }
    // Only after more than 100 batches waiting; the turn's end may be among the ones it replaced.
    if (event.type === 'snapshot' && this.#submission !== undefined) {
      const record = await (await this.#store!.harness.submission(this.#submission, context))?.status(context);
      if (record && (record.status === 'done' || record.status === 'unanswered')) this.#finish(record);
      return;
    }
    if (!this.#active) return;
    if (event.type === 'message_start') {
      this.#texts = new Map(); this.#sent = new Map();
      // The first partial is committed after a pause, so it may already hold text.
      const {message} = event;
      if (message.role === 'assistant') this.#textBlocks(message.content);
    }
    if (event.type === 'message_update') {
      for (const change of event.changes) {
        if (change.type === 'text_delta') this.#text(change.contentIndex, (this.#texts.get(change.contentIndex) ?? '') + change.delta);
        if ((change.type === 'text_start' || change.type === 'block') && change.block.type === 'text') this.#text(change.contentIndex, change.block.text);
        if (change.type === 'message') this.#textBlocks(change.message.content);
      }
    }
    // The finished message has the whole text, including any tail no update carried.
    if (event.type === 'message_end') {
      const message = event.entry.model?.[0];
      if (message?.role === 'assistant') this.#textBlocks(message.content);
    }
    if (event.type === 'tool_execution_start' && event.parentToolCallId === undefined && isAllowedTool(event.toolName)) this.emit('tool', event.toolName);
  }

  #textBlocks(content: AssistantMessage['content']) {
    content.forEach((block, index) => { if (block.type === 'text') this.#text(index, block.text); });
  }

  // Sends what is new in text block `index`.
  #text(index: number, text: string) {
    this.#texts.set(index, text);
    const sent = this.#sent.get(index) ?? 0;
    if (text.length <= sent) return;
    this.#sent.set(index, text.length);
    this.emit('delta', text.slice(sent));
  }

  #finish(record: SubmissionRecord) {
    if (!this.#active || record.id !== this.#submission) return;
    this.#endTurn(); this.#ended.clear();
    // Stopped from the app: the turn ends with what it has, as it did with the Pi CLI.
    if (record.status === 'done' || record.reason === 'aborted') this.emit('settled');
    else if (record.reason === 'model_error') this.emit('failure', providerFailure(record.detail));
    else this.emit('failure', `The reply could not be finished (${record.reason})`);
  }

  #endTurn() {
    this.#active = false; this.#submission = undefined;
    this.#dismiss();
  }

  async prompt(message: string, images: PromptImage[] = [], mode: TurnMode = {}): Promise<void> {
    const conversation = this.#require();
    this.turn = {mode, calls: 0, images: 0};
    this.#texts = new Map(); this.#sent = new Map();
    this.#active = true;
    let submitted;
    try {
      submitted = await conversation.submit({type: 'input', whenBusy: 'reject',
        content: [{type: 'text', text: composePrompt(message, mode)}, ...images]}, context);
    } catch (error) {
      this.#active = false;
      // Busy: nothing was recorded. Anything else (a storage failure) leaves that unknown.
      throw error instanceof ConversationBusy ? new PiRejected('The conversation is still busy') : error;
    }
    this.#submission = submitted.id;
    const ended = this.#ended.get(submitted.id);
    if (ended) this.#finish(ended);
  }

  async rewind(text: string): Promise<boolean> {
    const conversation = this.#require();
    // Newest first: the last message, and the entry before it, after which the fork continues. With none before it,
    // the message was the first.
    let message: EntryRecord | undefined;
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({}, 200, cursor, context);
      for (const entry of page.items) {
        if (message) return this.#rewindTo(conversation, message, entry, text);
        if (UserEntry.is(entry)) message = entry;
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return message ? this.#rewindTo(conversation, message, undefined, text) : false;
  }

  async #rewindTo(conversation: Conversation, message: EntryRecord, before: EntryRecord | undefined, text: string) {
    const content = message.model?.[0]?.content;
    const said = typeof content === 'string' ? content
      : (content ?? []).map(part => part.type === 'text' ? part.text : '').join('');
    if (!carriesText(said, text)) return false;
    await this.#attach(await this.#store!.moveTo(conversation, before?.id));
    return true;
  }

  get question(): Question | null { return this.#pending?.question ?? null; }

  // ChatHost: shows `question` in the app until it is answered, dismissed, or the tool's signal aborts.
  dialog(question: Omit<Question, 'id'>, signal: AbortSignal | undefined): Promise<string | boolean | undefined> {
    if (signal?.aborted || this.closed) return Promise.resolve(undefined);
    this.#dismiss();
    const id = randomUUID();
    const shown: Question = {
      id, method: question.method, title: question.title.slice(0, 2000), message: question.message.slice(0, 4000),
      options: question.options.slice(0, MAX_QUESTION_OPTIONS).map(option => option.slice(0, 1000)), prefill: question.prefill.slice(0, 4000),
    };
    return new Promise(resolve => {
      const pending = this.#pending = {question: shown, resolve};
      signal?.addEventListener('abort', () => { if (this.#pending === pending) this.#dismiss(); }, {once: true});
      this.emit('question', shown);
    });
  }

  answer(id: string, value: unknown, cancelled = false): void {
    const pending = this.#pending;
    if (!pending || pending.question.id !== id) throw new Error('Question expired or belongs to another conversation');
    const {question, resolve} = pending;
    if (!cancelled && question.method === 'select' && !question.options.includes(value as string)) throw new Error('Invalid choice');
    if (!cancelled && typeof value !== 'string' && question.method !== 'confirm') throw new Error('Invalid answer');
    this.#pending = undefined;
    resolve(cancelled ? undefined : question.method === 'confirm' ? value === true : value as string);
  }

  #dismiss() {
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.resolve(undefined);
  }

  // ChatHost: images in the model's context, user uploads and tool results alike, newest last.
  async recentImages(count: number, at: Context): Promise<ImageContent[]> {
    const {messages} = await this.#require().context(at);
    const images: ImageContent[] = [];
    for (const message of messages) {
      if (message.role === 'assistant' || typeof message.content === 'string') continue;
      for (const block of message.content) if (block.type === 'image') images.push(block);
    }
    return images.slice(-count);
  }

  async abort(): Promise<void> {
    this.#dismiss();
    await this.#conversation?.abort(context);
  }

  // Ends this worker: like the Pi CLI process exiting, a running turn fails with `reason` and its work is aborted.
  // Resolves once the conversation's file is closed, so its directory can be removed.
  stop(reason = 'The reply was stopped before it finished'): Promise<void> {
    if (this.closed) return this.#stopped ?? Promise.resolve();
    this.closed = true;
    this.#dismiss();
    void this.#stream?.stop();
    if (this.#active) {
      this.#endTurn();
      this.emit('failure', reason);
    }
    // A file still opening is closed once it is open.
    return this.#stopped = this.#opening?.then(opened => opened.close(this.#conversation), () => {}) ?? Promise.resolve();
  }

  #require(): Conversation {
    if (!this.#conversation || this.closed) throw new Error('The conversation is not open');
    return this.#conversation;
  }
}

function providerFailure(value: unknown): string {
  const text = String(value ?? '');
  const code = text.match(/refresh_token_(?:reused|expired|invalid)|invalid_grant|invalid_token/);
  if (code) return `Subscription login needs refreshing (${code[0]})`;
  if (/\b429\b|quota|rate.limit/i.test(text)) return 'Subscription usage limit reached; try again after the provider limit resets';
  const status = text.match(/\b(?:401|403|502|503)\b/);
  if (status) return `Provider request failed (HTTP ${status[0]})`;
  return 'The model request failed. Check subscription login, quota and provider availability.';
}

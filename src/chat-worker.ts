import type { EventEmitter } from 'node:events';
import type { Question, ToolName } from './api.d.ts';
import type { TurnMode } from './policy.ts';

export interface PromptImage { type: 'image'; mimeType: string; data: string }

export type WorkerEvents = {
  failure: [message: string];
  delta: [text: string];
  tool: [name: ToolName];
  question: [question: Question];
  settled: [];
};

// One conversation's model worker, the surface the server depends on (src/agent/worker.ts); tests substitute a fake.
export interface ChatWorker extends EventEmitter<WorkerEvents> {
  closed?: boolean;
  question?: Question | null;
  start(): Promise<void>;
  prompt(message: string, images?: PromptImage[], mode?: TurnMode): Promise<void>;
  // Takes Pi back to before its last user message, if that message carried `text`; false when there was nothing to undo.
  rewind(text: string): Promise<boolean>;
  answer(id: string, value: unknown, cancelled?: boolean): void;
  abort(): Promise<unknown>;
  // A running turn fails, with `reason` when given. A promise, when the worker's files stay open until it settles.
  stop(reason?: string): void | Promise<void>;
}

export function providerFailure(value: unknown): string {
  const text = String(value ?? '');
  const code = text.match(/refresh_token_(?:reused|expired|invalid)|invalid_grant|invalid_token/);
  if (code) return `Subscription login needs refreshing (${code[0]})`;
  if (/\b429\b|quota|rate.limit/i.test(text)) return 'Subscription usage limit reached; try again after the provider limit resets';
  const status = text.match(/\b(?:401|403|502|503)\b/);
  if (status) return `Provider request failed (HTTP ${status[0]})`;
  return 'The model request failed. Check subscription login, quota and provider availability.';
}

// Pi did not act on the message (it did not record it): the conversation was busy.
export class PiRejected extends Error {}

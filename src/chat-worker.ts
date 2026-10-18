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
  readonly closed: boolean;
  readonly question: Question | null;
  start(): Promise<void>;
  prompt(message: string, images?: PromptImage[], mode?: TurnMode): Promise<void>;
  // Takes the conversation back to before its last user message, if that message carried `text`; false when there was
  // nothing to undo.
  rewind(text: string): Promise<boolean>;
  answer(id: string, value: unknown, cancelled?: boolean): void;
  abort(): Promise<void>;
  // A running turn fails, with `reason` when given. Resolves once the worker's files are closed.
  stop(reason?: string): Promise<void>;
}

// The worker did not act on the message (it did not record it): the conversation was busy.
export class PiRejected extends Error {}

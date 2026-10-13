// HTTP/SSE contract shared by the server (src/server.ts) and the browser (public/app.ts).
// A declaration file, so the browser build imports these types without emitting server code.

export type User = 'owner' | 'guest';
export type ToolName = 'ask' | 'web_run' | 'imagegen';
export type AssetKind = 'upload' | 'generated';
export type QuestionMethod = 'select' | 'input' | 'editor' | 'confirm';

export interface Question {
  id: string;
  method: QuestionMethod;
  title: string;
  message: string;
  options: string[];
  prefill: string;
}

export interface Message {
  role: 'user' | 'assistant';
  text: string;
  assets: string[];
  error?: string;
}

export interface AssetRef { id: string; kind: AssetKind }

export interface ChatSnapshot {
  id: string;
  title: string;
  messages: Message[];
  assets: AssetRef[];
  busy: boolean;
  question: Question | null;
}

export interface ChatSummary { id: string; title: string }

export interface Me {
  user: User;
  csrf: string;
  codexConfigured: boolean;
  // local: access codes on localhost. access: Cloudflare Access (Google sign-in) on the public hostname.
  mode: 'local' | 'access';
  tools: readonly ToolName[];
}

export type StreamEvent =
  | {type: 'snapshot'; chat: ChatSnapshot}
  | {type: 'delta'; text: string}
  | {type: 'tool'; name: ToolName}
  | {type: 'question'; question: Question}
  | {type: 'error'; message: string};

export interface ApiError { error: string }

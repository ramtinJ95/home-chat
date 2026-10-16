// HTTP/SSE contract shared by the server (src/server.ts) and the browser (public/app.ts).
// A declaration file, so the browser build imports these types without emitting server code.

export type User = 'owner' | 'guest';
export type ToolName = 'ask' | 'web_run' | 'imagegen' | 'document' | 'deep_research' | 'routine' | 'memory';
export type AssetKind = 'upload' | 'generated' | 'document';
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
  // On a routine's scheduled message: when it ran, e.g. "Morning briefing · Friday 17 October, 07:30".
  run?: string;
}

// Set on document assets: every version of a document is its own asset, sharing `doc`.
export interface DocumentInfo { doc: string; title: string; version: number }
export interface AssetRef { id: string; kind: AssetKind; document?: DocumentInfo }

// GET /api/chats/<id>/assets/<asset> for a document; with ?download=1 it is a Markdown file instead.
export interface DocumentContent { title: string; markdown: string; version: number }

export interface ChatSnapshot {
  id: string;
  title: string;
  messages: Message[];
  assets: AssetRef[];
  busy: boolean;
  question: Question | null;
  // Switched per conversation (POST /api/chats/<id>/research {on}) and kept until switched off.
  deepResearch: boolean;
  // Set when this conversation is where a routine's runs arrive.
  routine: RoutineSummary | null;
}

// `unread`: a routine run arrived while nobody was looking. Routine conversations are listed under /api/routines.
export interface ChatSummary { id: string; title: string; unread: boolean; routine: boolean }

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
// Times are HH:MM in the household's time zone (src/routines.ts).
export type RoutineSchedule =
  | {kind: 'daily' | 'weekdays'; time: string}
  | {kind: 'weekly'; time: string; days: Weekday[]}
  | {kind: 'monthly'; time: string; day: number}
  | {kind: 'once'; time: string; date: string};

// GET /api/routines; POST /api/routines/<id> {enabled} switches one; DELETE removes it and keeps its conversation.
export interface RoutineSummary {
  id: string;
  title: string;
  chat: string;
  enabled: boolean;
  // "Every day at 07:30"
  schedule: string;
  // "Tomorrow 07:30", "Paused" or "Done"
  next: string;
  unread: boolean;
}

// GET /api/memory: the "About us" notes, one line each. PUT /api/memory {version, mine, shared} replaces both lists, and
// answers 409 if they changed since `version` was read. `shared` is the same for everyone.
export interface MemoryView { version: number; mine: string[]; shared: string[] }

export interface Me {
  user: User;
  csrf: string;
  codexConfigured: boolean;
  // local: access codes on localhost. access: Cloudflare Access (Google sign-in) on the public hostname.
  mode: 'local' | 'access';
  tools: readonly ToolName[];
  // Deep research needs an Exa key on the server; without one the app hides the switch.
  deepResearch: boolean;
}

export type StreamEvent =
  | {type: 'snapshot'; chat: ChatSnapshot}
  | {type: 'delta'; text: string}
  | {type: 'tool'; name: ToolName}
  | {type: 'question'; question: Question}
  | {type: 'error'; message: string};

export interface ApiError { error: string }

// GET /api/push: the key the browser subscribes with.
export interface PushInfo { publicKey: string }

// A notification's payload, encrypted to one device; public/sw.ts shows it and opens `chat` when tapped.
// With `routine`, browsers that support notification buttons offer Pause and Open.
export interface PushMessage { title: string; body: string; chat?: string; routine?: string }

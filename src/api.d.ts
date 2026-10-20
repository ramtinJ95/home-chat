// HTTP/SSE contract shared by the server (src/server.ts) and the browser (public/app.ts).
// A declaration file, so the browser build imports these types without emitting server code.

export type User = 'owner' | 'guest';
export type ToolName = 'ask' | 'web_run' | 'imagegen' | 'document' | 'deep_research' | 'routine' | 'memory' | 'todo';
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
  // Who sent a user message; absent on messages from before conversations could be shared, which are the owner's.
  by?: User;
  text: string;
  assets: string[];
  error?: string;
  // On a routine's scheduled message: when it ran, e.g. "Morning briefing · Friday 17 October, 07:30".
  run?: string;
  // Whether Pi's own copy of the conversation has this message (src/server.ts startTurn): absent when it has, `rejected`
  // when Pi turned it down, `unknown` from sending it until Pi accepts it, and for good if that never got settled (a
  // restart or a timeout in between). A message whose delivery is unknown cannot be redone.
  delivery?: 'rejected' | 'unknown';
}

// Set on document assets: every version of a document is its own asset, sharing `doc`.
export interface DocumentInfo { doc: string; title: string; version: number }
export interface AssetRef { id: string; document?: DocumentInfo }

// GET /api/chats/<id>/assets/<asset> for a document; with ?download=1 it is a Markdown file instead.
export interface DocumentContent { title: string; markdown: string; version: number }

export interface ChatSnapshot {
  id: string;
  title: string;
  // Its owner, who alone deletes it and shares it with the household (POST /api/chats/<id>/share {on}) or stops sharing.
  owner: User;
  shared: boolean;
  messages: Message[];
  assets: AssetRef[];
  busy: boolean;
  question: Question | null;
  // The last message and its reply can be asked again, as it was or edited ({replace: true} on POST messages), by the
  // person who sent that message.
  redoable: boolean;
  // Switched per conversation (POST /api/chats/<id>/research {on}) and kept until switched off.
  deepResearch: boolean;
  // Set when this conversation is where a routine's runs arrive.
  routine: RoutineSummary | null;
}

// `unread`: a routine run, or in a shared conversation a reply to the other person, arrived while this person was not
// looking. Routine conversations are listed under /api/routines. `mine`: this person owns it; the other's are shared.
// `starred`: when the signed-in person starred it (POST /api/chats/<id>/star {on}), or null. The sidebar lists starred
// conversations first, the earliest starred on top.
export interface ChatSummary { id: string; title: string; unread: boolean; routine: boolean; shared: boolean; mine: boolean; starred: string | null }

// GET /api/search?q=<words>: the conversations the user can see whose title or messages contain every word, newest first.
// `message` indexes the conversation's messages, or is null for a match in the title only; `marks` are the [start, end)
// ranges in `snippet` where the words appear.
export interface SearchResult { chat: string; title: string; message: number | null; snippet: string; marks: [number, number][] }

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
// Times are HH:MM in the household's time zone (src/routines.ts).
export type RoutineSchedule =
  | {kind: 'daily' | 'weekdays'; time: string}
  | {kind: 'weekly'; time: string; days: Weekday[]}
  | {kind: 'monthly'; time: string; day: number}
  | {kind: 'once'; time: string; date: string};

// GET /api/routines; POST /api/routines/<id> {enabled} switches one; PATCH edits it with a RoutineEdit; DELETE removes
// it and keeps its conversation.
export interface RoutineSummary {
  id: string;
  title: string;
  chat: string;
  enabled: boolean;
  // "Every day at 07:30"
  schedule: string;
  // The schedule `schedule` describes, for editing.
  rule: RoutineSchedule;
  // What each run is asked to do.
  prompt: string;
  deepResearch: boolean;
  // "Tomorrow 07:30", "Paused" or "Done"
  next: string;
  // The latest run: when it was due ("Today 07:30") and how it went; null before the first.
  lastRun: {when: string; outcome: 'running' | 'done' | 'failed' | 'skipped'} | null;
  unread: boolean;
}

export type RoutineEdit = Partial<Pick<RoutineSummary, 'title' | 'prompt' | 'rule' | 'deepResearch'>>;

// GET /api/memory: the "About us" notes, one line each. PUT /api/memory {version, mine, shared} replaces both lists, and
// answers 409 if they changed since `version` was read. `shared` is the same for everyone.
export interface MemoryView { version: number; mine: string[]; shared: string[] }

// GET /api/todos: the lists this person can see, their own and the shared ones, oldest first. POST /api/todos
// {title, shared} makes one; PATCH /api/todos/<list> {title?, shared?} and DELETE change it (sharing and deleting are for
// its owner, `mine`). POST /api/todos/<list>/items {text} adds an item, PATCH .../items/<id> {done?, text?} and DELETE
// change one, and POST /api/todos/<list>/clear removes the done ones. Each answers with the list as it is now.
export interface TodoItem { id: number; text: string; done: boolean }
// `version` counts the list's changes, so a page can tell an older answer from a newer one.
export interface TodoList { id: string; title: string; shared: boolean; mine: boolean; version: number; items: TodoItem[] }

// The Library: copies of documents and pictures either person shared on their own, newest first. POST
// /api/chats/<id>/assets/<asset>/share copies one in, or replaces the copy of an earlier version of the same document;
// GET /api/library/<item> reads it (a document as DocumentContent, a picture as PNG, ?download for a file); DELETE
// removes the sharer's own. `when` is when it was shared, in words.
export type LibraryContent = {kind: 'picture'} | {kind: 'document'; title: string; version: number};
export type LibraryItem = LibraryContent & {id: string; by: User; mine: boolean; when: string};
// `unseen`: the other person shared something since this person last opened the page (POST /api/library/seen).
export interface Library { items: LibraryItem[]; unseen: boolean }

export interface Me {
  user: User;
  // What the app and the model call each person (HOME_CHAT_OWNER_NAME and HOME_CHAT_GUEST_NAME).
  names: Record<User, string>;
  csrf: string;
  codexConfigured: boolean;
  // local: access codes on localhost. access: Cloudflare Access (Google sign-in) on the public hostname.
  mode: 'local' | 'access';
  // Deep research needs an Exa key on the server; without one the app hides the switch.
  deepResearch: boolean;
}

export type StreamEvent =
  | {type: 'snapshot'; chat: ChatSnapshot}
  | {type: 'delta'; text: string}
  | {type: 'tool'; name: ToolName}
  | {type: 'question'; question: Question}
  | {type: 'error'; message: string}
  // Sent just before the stream ends because the conversation was deleted or is no longer shared with this person.
  | {type: 'gone'}
  // Something was shared to the Library or removed from it; sent on every open stream.
  | {type: 'library'};

export interface ApiError { error: string }

// GET /api/push: the key the browser subscribes with.
export interface PushInfo { publicKey: string }

// A notification's payload, encrypted to one device; public/sw.ts shows it and opens `chat` when tapped.
// With `routine`, browsers that support notification buttons offer Pause and Open.
export interface PushMessage { title: string; body: string; chat?: string; routine?: string }

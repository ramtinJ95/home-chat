import type { ApiError, AssetRef, ChatSnapshot, ChatSummary, DocumentContent, DocumentInfo, Library, LibraryItem, Me, MemoryView, Message, PushInfo, SearchResult, Question, RoutineEdit, RoutineSchedule, RoutineSummary, StreamEvent, TodoList, ToolName, User, Weekday } from '../src/api.d.ts';

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element ${selector}`);
  return node;
}

const ui = {
  login: $('#login'),
  loginForm: $<HTMLFormElement>('#login-form'),
  accessCode: $<HTMLInputElement>('#access-code'),
  workspace: $('#workspace'),
  scrim: $('#scrim'),
  openSidebar: $<HTMLButtonElement>('#open-sidebar'),
  closeSidebar: $<HTMLButtonElement>('#close-sidebar'),
  newChat: $<HTMLButtonElement>('#new-chat'),
  sidebar: $('.sidebar'),
  searchForm: $<HTMLFormElement>('#search-form'),
  search: $<HTMLInputElement>('#search'),
  searchResults: $('#search-results'),
  chatList: $('#chat-list'),
  shared: $('#shared'),
  sharedList: $('#shared-list'),
  routines: $('#routines'),
  routineList: $('#routine-list'),
  routineBar: $('#routine-bar'),
  avatar: $('#avatar'),
  identity: $('#identity'),
  logout: $<HTMLButtonElement>('#logout'),
  title: $('#chat-title'),
  sharedBy: $('#shared-by'),
  share: $<HTMLButtonElement>('#share-chat'),
  shareLabel: $('#share-label'),
  research: $<HTMLButtonElement>('#research'),
  providerWarning: $('#provider-warning'),
  messages: $('#messages'),
  question: $('#question'),
  editing: $('#editing'),
  cancelEdit: $<HTMLButtonElement>('#cancel-edit'),
  composer: $<HTMLFormElement>('#composer'),
  privacy: $('#privacy'),
  draft: $<HTMLTextAreaElement>('#message'),
  attachments: $('#attachments'),
  imageInput: $<HTMLInputElement>('#image-input'),
  dictate: $<HTMLButtonElement>('#dictate'),
  activity: $('#activity'),
  stop: $<HTMLButtonElement>('#stop'),
  send: $<HTMLButtonElement>('#send'),
  install: $('#install'),
  notifications: $('#notifications'),
  toast: $('#error'),
  reader: $('#reader'),
  readerClose: $<HTMLButtonElement>('#reader-close'),
  readerCopy: $<HTMLButtonElement>('#reader-copy'),
  readerShare: $<HTMLButtonElement>('#reader-share'),
  readerLibrary: $<HTMLButtonElement>('#reader-library'),
  readerDownload: $<HTMLAnchorElement>('#reader-download'),
  readerMeta: $('#reader-meta'),
  readerTitle: $('#reader-title'),
  readerContents: $<HTMLDetailsElement>('#reader-contents'),
  readerBody: $('#reader-body'),
  aboutEntry: $('#about-entry'),
  about: $('#about'),
  aboutForm: $<HTMLFormElement>('#about-form'),
  aboutMine: $<HTMLTextAreaElement>('#about-mine'),
  aboutShared: $<HTMLTextAreaElement>('#about-shared'),
  routinesEntry: $('#routines-entry'),
  routinesPage: $('#routines-page'),
  routineCards: $('#routine-cards'),
  todosEntry: $('#todos-entry'),
  libraryEntry: $('#library-entry'),
  libraryPage: $('#library-page'),
  libraryLede: $('#library-lede'),
  libraryCards: $('#library-cards'),
  todosPage: $('#todos-page'),
  todoNew: $<HTMLFormElement>('#todo-new'),
  todoNewTitle: $<HTMLInputElement>('#todo-new-title'),
  todoNewShared: $<HTMLInputElement>('#todo-new-shared'),
  todoCards: $('#todo-cards'),
};

let me: Me | undefined;
// What the app calls a person: "You" for the one signed in, otherwise their name from .env.
const nameOf = (user: User) => user === me?.user ? 'You' : me?.names[user] ?? user;
const otherName = () => me?.names[me.user === 'owner' ? 'guest' : 'owner'] ?? '';

let toastTimer: number | undefined;

// One toast, for failures and, styled as `info`, for confirmations.
function toast(text: string, info: boolean) {
  ui.toast.textContent = text;
  ui.toast.classList.toggle('info', info);
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { ui.toast.hidden = true; }, 8000);
}
const showError = (error: unknown) => toast(error instanceof Error ? error.message : String(error), false);
const showNotice = (text: string) => toast(text, true);

// A request the server answered with an error, which carries its status.
class RequestFailed extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      credentials: 'same-origin',
      headers: method === 'GET' ? {} : {'Content-Type': 'application/json', 'X-CSRF-Token': me?.csrf ?? ''},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // Behind Cloudflare Access an expired sign-in redirects to its login page, which fetch cannot follow.
    throw new Error('Could not reach Home Chat. Reload the page; you may need to sign in again.');
  }
  // Errors from Cloudflare itself (e.g. the home machine is offline) are HTML pages, not our JSON.
  const result: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new RequestFailed(response.status, (result as ApiError | undefined)?.error ?? `Home Chat is unavailable right now (HTTP ${response.status})`);
  return result as T;
}

// Buttons made here do not submit a form unless they are made submit buttons, like a routine form's Save.
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (node instanceof HTMLButtonElement) node.type = 'button';
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: string, className?: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + name);
  svg.append(use);
  return svg;
}

function actionButton(name: string, label: string, run: (button: HTMLButtonElement) => Promise<void>): HTMLButtonElement {
  const button = element('button');
  button.append(icon(name), label);
  button.onclick = () => run(button).catch(showError);
  return button;
}

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); } catch { throw new Error('Could not copy; select the text instead'); }
}

const canShare = 'share' in navigator;
// Shared as text, which every share target takes (Messages, Mail, Notes). Closing the share sheet is no failure.
async function shareText(data: ShareData, failure: string) {
  try { await navigator.share(data); } catch (error) { if ((error as DOMException).name !== 'AbortError') throw new Error(failure); }
}

// Markdown subset rendered with DOM nodes and textContent only; model text never becomes HTML.
const FENCE = '```';
const HEADING = /^(#{1,4})\s+(.*)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const QUOTE = /^>\s?/;
const RULE = /^(?:-{3,}|\*{3,})\s*$/;
// A table is a row of cells over a line such as |---|:---:| (the pipes tell it from a rule); it may follow a paragraph
// without a blank line.
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const tableAt = (lines: string[], i: number) => lines[i].includes('|') && lines[i + 1]?.includes('|') === true && TABLE_RULE.test(lines[i + 1]);
const startsBlock = (lines: string[], i: number) =>
  lines[i].startsWith(FENCE) || [HEADING, LIST_ITEM, QUOTE, RULE].some(pattern => pattern.test(lines[i])) || tableAt(lines, i);
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\s][^*\n]*?)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function renderMarkdown(target: HTMLElement, source: string) {
  const blocks: HTMLElement[] = [];
  const lines = source.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const heading = HEADING.exec(line);
    if (line.startsWith(FENCE)) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith(FENCE); i++) code.push(lines[i]);
      i++;
      const pre = element('pre');
      pre.append(element('code', undefined, code.join('\n')));
      blocks.push(pre);
    } else if (tableAt(lines, i)) {
      const rows: string[][] = [];
      const align = cells(lines[i + 1]).map(cell => cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : '');
      for (rows.push(cells(line)), i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      blocks.push(table(rows, align));
    } else if (heading) {
      const [, hashes, text] = heading;
      blocks.push(inline(element(hashes.length <= 2 ? 'h3' : 'h4'), text));
      i++;
    } else if (LIST_ITEM.test(line)) {
      const list = element(/^\s*\d/.test(line) ? 'ol' : 'ul');
      for (; i < lines.length && LIST_ITEM.test(lines[i]); i++) list.append(inline(element('li'), lines[i].replace(LIST_ITEM, '')));
      blocks.push(list);
    } else if (QUOTE.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) quoted.push(lines[i].replace(QUOTE, ''));
      blocks.push(inline(element('blockquote'), quoted.join('\n')));
    } else if (RULE.test(line)) {
      blocks.push(element('hr'));
      i++;
    } else if (!line.trim()) {
      i++;
    } else {
      const paragraph: string[] = [];
      for (; i < lines.length && lines[i].trim() && (paragraph.length === 0 || !startsBlock(lines, i)); i++) paragraph.push(lines[i]);
      blocks.push(inline(element('p'), paragraph.join('\n')));
    }
  }
  target.replaceChildren(...blocks);
}

// Splits a table row on pipes, keeping escaped \| as text.
function cells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replaceAll('\\|', '|'));
}

// Every row gets the header's number of cells. Wide tables scroll sideways inside their own box on a phone.
function table([header, ...body]: string[][], align: string[]): HTMLElement {
  const row = (values: string[], tag: 'th' | 'td') => {
    const tr = element('tr');
    header.forEach((_, index) => {
      const cell = inline(element(tag), values[index] ?? '');
      if (align[index]) cell.style.textAlign = align[index];
      tr.append(cell);
    });
    return tr;
  };
  const head = element('thead'); head.append(row(header, 'th'));
  const rows = element('tbody'); rows.append(...body.map(values => row(values, 'td')));
  const grid = element('table'); grid.append(head, rows);
  const scroller = element('div', 'table-scroll'); scroller.append(grid);
  return scroller;
}

function inline<T extends HTMLElement>(parent: T, text: string): T {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    parent.append(text.slice(last, match.index));
    const [whole, code, strong, emphasis, label, href, bare] = match;
    if (code !== undefined) parent.append(element('code', undefined, code));
    else if (strong !== undefined) parent.append(inline(element('strong'), strong));
    else if (emphasis !== undefined) parent.append(inline(element('em'), emphasis));
    else parent.append(link(href ?? bare, label));
    last = match.index + whole.length;
  }
  parent.append(text.slice(last));
  // Single newlines inside a paragraph stay visible as line breaks.
  for (const node of [...parent.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.includes('\n')) continue;
    const parts = node.textContent.split('\n');
    node.replaceWith(...parts.flatMap((part, index) => index ? [element('br'), part] : [part]));
  }
  return parent;
}

function link(href: string, label?: string): Node {
  let url: URL;
  try { url = new URL(href); } catch { return document.createTextNode(label ?? href); }
  const anchor = element('a', undefined, label ?? href);
  anchor.href = url.href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  // Labelled links still show where they go.
  if (label && label !== href) anchor.append(element('span', 'host', url.hostname));
  return anchor;
}

// Who sent a user message; older ones, from before sharing, are the owner's.
const senderOf = (snapshot: ChatSnapshot, message: Message) => message.by ?? snapshot.owner;
// The server says whether the last turn can be redone at all; only the person who sent its message may.
const canRedo = (snapshot: ChatSnapshot) => snapshot.redoable && senderOf(snapshot, snapshot.messages.at(-2)!) === me?.user;
let chat: ChatSnapshot | undefined;
// The snapshot last drawn, as JSON, so the same one coming again is not drawn twice (update). Cleared by anything that
// changes the page since: stream events, and a dropped stream, after which the next snapshot is drawn in full.
let shown = '';
// Whether the reader is at the bottom of the thread; new content only scrolls the view while they are.
let following = true;

function setBusy(busy: boolean) {
  ui.send.disabled = busy;
  // The switch applies from the next message, so it waits while a reply runs.
  ui.research.disabled = busy;
  ui.send.hidden = busy;
  ui.stop.hidden = !busy;
  ui.messages.classList.toggle('busy', busy);
  ui.composer.classList.toggle('busy', busy);
  ui.activity.textContent = busy ? 'Thinking…' : '';
}

function scrollToEnd() { ui.messages.scrollTop = ui.messages.scrollHeight; following = true; }
function keepFollowing() { if (following) scrollToEnd(); }
const SUGGESTIONS = [
  {icon: 'compass', title: 'Plan something lovely', prompt: 'Help me plan something lovely for the weekend'},
  {icon: 'spark', title: 'Explain a curiosity', prompt: 'Explain something I’ve always wondered about'},
  {icon: 'brush', title: 'Make a picture', prompt: 'Let’s create an image together'},
];

function renderEmpty(): HTMLElement {
  const empty = element('div', 'empty');
  const suggestions = element('div', 'suggestions');
  for (const {icon: name, title, prompt} of SUGGESTIONS) {
    const button = element('button');
    button.append(icon(name), element('strong', undefined, title), element('span', undefined, prompt));
    button.onclick = () => { cancelDictation(); ui.draft.value = prompt; resizeComposer(); ui.draft.focus(); };
    suggestions.append(button);
  }
  empty.append(
    icon('leaf', 'leaf'),
    element('h2', undefined, 'What shall we explore?'),
    element('p', undefined, 'A question, a picture, a half-formed idea. This is your space to make sense of things.'),
    // Above the suggestions, so a phone shows it without scrolling.
    ...[setupCard()].filter(card => card !== undefined),
    suggestions,
  );
  return empty;
}

// Where a routine run starts in its conversation: its name and when it was due.
function runMark(label: string): HTMLElement {
  const mark = element('p', 'run-mark');
  mark.append(icon('clock'), label);
  return mark;
}

function messageActions(snapshot: ChatSnapshot, message: Message, index: number): HTMLElement | undefined {
  const last = index === snapshot.messages.length - 1;
  const bar = element('div', 'message-actions');
  // A reply still streaming is not finished enough to copy.
  if (message.role === 'assistant' && message.text && !(last && snapshot.busy)) {
    bar.append(actionButton('copy', 'Copy', async button => { await copyText(message.text); button.lastChild!.textContent = 'Copied'; }));
    if (canShare) bar.append(actionButton('share', 'Share', () => shareText({text: message.text}, 'Could not share this reply')));
  }
  if (canRedo(snapshot) && last) bar.append(actionButton('redo', 'Regenerate', regenerate));
  if (canRedo(snapshot) && index === snapshot.messages.length - 2) bar.append(actionButton('pencil', 'Edit', async () => startEditing()));
  return bar.childElementCount ? bar : undefined;
}

function renderMessage(snapshot: ChatSnapshot, message: Message, fresh: boolean, index: number): HTMLElement {
  // A run's scheduled message is the routine's standing task, which the mark stands for.
  if (message.run && message.role === 'user') return runMark(message.run);
  const article = element('article', `message ${message.role}${fresh ? ' fresh' : ''}`);
  const bubble = element('div', 'bubble');
  const content = element('div', 'content');
  const from = message.role === 'user' ? nameOf(senderOf(snapshot, message)) : 'Home Chat';
  bubble.append(element('span', 'sr-only', `${from} said`), content);
  // Names over the messages wherever more than one person writes.
  if (message.role === 'user' && (snapshot.shared || senderOf(snapshot, message) !== snapshot.owner)) {
    article.append(element('p', 'message-from', from));
  }
  if (message.role === 'assistant') {
    renderMarkdown(content, message.text);
    const mark = element('div', 'avatar-mark');
    mark.append(icon('leaf'));
    article.append(mark);
  } else {
    content.textContent = message.text;
  }
  const shown = new Set<string>();
  for (const id of message.assets) {
    const url = `/api/chats/${snapshot.id}/assets/${id}`;
    const info = snapshot.assets.find(asset => asset.id === id)?.document;
    if (info) {
      // A document revised within one reply gets one card.
      if (!shown.has(info.doc)) bubble.append(documentCard(snapshot, info));
      shown.add(info.doc);
      continue;
    }
    const figure = element('figure', 'picture');
    const picture = element('img');
    picture.src = url;
    picture.alt = message.role === 'user' ? 'Your attached picture' : 'Generated picture';
    picture.loading = 'lazy';
    // Images grow the thread after the initial scroll; keep the latest message in view.
    picture.addEventListener('load', keepFollowing, {once: true});
    const download = element('a', 'picture-action');
    download.href = url + '?download=1';
    download.download = 'home-chat.png';
    download.append(icon('download'), 'Download');
    const actions = element('div', 'picture-actions');
    const share = actionButton('people', `Share with ${otherName()}`, () => shareAsset(snapshot.id, id));
    share.className = 'picture-action';
    actions.append(download, share);
    figure.append(picture, actions);
    bubble.append(figure);
  }
  if (message.error) bubble.append(element('p', 'failure', message.error));
  article.append(bubble);
  const actions = messageActions(snapshot, message, index);
  if (actions) (message.role === 'assistant' ? bubble : article).append(actions);
  // A skipped run is a note on its own, with no task message before it.
  if (message.run) { const wrap = element('div', 'run-note'); wrap.append(runMark(message.run), article); return wrap; }
  return article;
}

// The newest version of a document, which every card of that document opens.
function latestVersion(snapshot: ChatSnapshot, doc: string): AssetRef & {document: DocumentInfo} {
  return snapshot.assets.filter((asset): asset is AssetRef & {document: DocumentInfo} => asset.document?.doc === doc)
    .reduce((latest, asset) => asset.document.version > latest.document.version ? asset : latest);
}

function documentCard(snapshot: ChatSnapshot, info: DocumentInfo): HTMLElement {
  const latest = latestVersion(snapshot, info.doc);
  const card = element('button', 'document-card');
  const text = element('span', 'document-text');
  const meta = latest.document.version === 1 ? 'Document'
    : latest.document.version === info.version ? `Version ${info.version}` : `Updated later · version ${latest.document.version}`;
  text.append(element('strong', undefined, latest.document.title), element('span', undefined, meta));
  card.append(icon('document'), text, element('span', 'document-open', 'Open'));
  card.onclick = () => openReader(`/api/chats/${snapshot.id}/assets/${latest.id}`, {share: () => shareAsset(snapshot.id, latest.id)}).catch(showError);
  return card;
}

function renderChat(next: ChatSnapshot) {
  const sameChat = chat?.id === next.id;
  // Another conversation replaces the page, and any page over it. An edit ends with its conversation, or once its turn
  // can no longer be redone.
  if (!sameChat) { if (sheet) sheet.parent = undefined; closeSheet(); }
  if (editing && (!sameChat || !canRedo(next))) stopEditing();
  const previousCount = sameChat && chat ? chat.messages.length : next.messages.length;
  chat = next;
  shown = JSON.stringify(next);
  ui.title.textContent = next.title;
  // The owner shares it or makes it private again; the other person sees whose it is.
  const mine = next.owner === me?.user;
  ui.share.hidden = !mine || next.routine !== null;
  ui.share.setAttribute('aria-pressed', String(next.shared));
  ui.shareLabel.textContent = next.shared ? 'Shared' : 'Share';
  ui.share.title = next.shared ? `Shared with ${otherName()}; tap to make it private` : `Share this conversation with ${otherName()}`;
  ui.sharedBy.hidden = mine;
  ui.sharedBy.textContent = mine ? '' : `Shared by ${nameOf(next.owner)}`;
  ui.privacy.textContent = next.shared ? 'Shared' : 'Private';
  ui.research.hidden = !me?.deepResearch;
  ui.research.setAttribute('aria-pressed', String(next.deepResearch));
  ui.draft.placeholder = next.deepResearch ? 'What should I research?' : 'What’s on your mind?';
  renderRoutineBar(next.routine);
  setBusy(next.busy);
  ui.messages.replaceChildren(...(next.messages.length
    ? next.messages.map((message, index) => renderMessage(next, message, index >= previousCount, index))
    : [renderEmpty()]));
  // Deltas extend the last message, as on the server, which only sends them while that is a reply.
  const last = next.messages.at(-1);
  const content = ui.messages.lastElementChild?.querySelector<HTMLElement>('.content');
  streaming = last?.role === 'assistant' && content ? {node: content, text: last.text} : undefined;
  markFound();
  // The question card shrinks the thread, so place it before scrolling.
  showQuestion(next.question);
  if (sameChat) keepFollowing(); else scrollToEnd();
}

// Draws a snapshot unless it is the one already shown; true if it drew it.
function update(next: ChatSnapshot): boolean {
  if (JSON.stringify(next) === shown) return false;
  renderChat(next);
  return true;
}

ui.messages.addEventListener('scroll', () => {
  following = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 80;
}, {passive: true});
ui.research.onclick = async () => {
  if (!chat) return;
  // The stream may bring the same snapshot first.
  try { update(await api<ChatSnapshot>(`/api/chats/${chat.id}/research`, 'POST', {on: !chat.deepResearch})); }
  catch (error) { showError(error); }
};
ui.share.onclick = async () => {
  if (!chat) return;
  const on = !chat.shared;
  if (!on && !confirm(`Make “${chat.title}” private again? It will no longer be shared with ${otherName()}.`)) return;
  try {
    update(await api<ChatSnapshot>(`/api/chats/${chat.id}/share`, 'POST', {on}));
    await refreshSidebar();
  } catch (error) { showError(error); }
};

let stream: EventSource | undefined;
// The assistant reply currently receiving deltas; re-rendered at most every STREAM_RENDER_MS.
let streaming: {node: HTMLElement; text: string; timer?: number} | undefined;
// Re-parsing markdown on every delta is wasted work; the final snapshot renders the complete reply.
const STREAM_RENDER_MS = 120;

function appendDelta(text: string) {
  const target = streaming;
  if (!target) return;
  target.text += text;
  target.timer ??= window.setTimeout(() => {
    target.timer = undefined;
    renderMarkdown(target.node, target.text);
    keepFollowing();
  }, STREAM_RENDER_MS);
}

const TOOL_ACTIVITY: Record<ToolName, string> = {
  ask: 'Asking you a quick question…',
  web_run: 'Searching the web…',
  imagegen: 'Creating an image…',
  document: 'Writing a document…',
  deep_research: 'Researching… this can take a few minutes',
  routine: 'Updating your routines…',
  memory: 'Updating About us…',
  todo: 'Updating your todos…',
};

async function openChat(id: string) {
  dropAttachments(attachments);
  await connect(id);
}

// Bumped by every connect and by hiding the page, so a connect still waiting for its snapshot never opens a stream
// for a page that has moved on: an open stream tells the server someone is looking. `onScreen` is the conversation
// being shown, or about to be, so coming back to the page can finish a connect that hiding cancelled.
let connection = 0;
let onScreen: string | undefined;
async function connect(id: string) {
  const attempt = ++connection;
  onScreen = id;
  stream?.close(); stream = undefined;
  const snapshot = await api<ChatSnapshot>(`/api/chats/${id}`);
  if (attempt !== connection) return;
  renderChat(snapshot);
  // The sidebar too, which may have changed while this page was elsewhere or hidden.
  const listed = refreshSidebar();
  if (!document.hidden) listen(id);
  await listed;
}

function listen(id: string) {
  const source = stream = new EventSource(`/api/chats/${id}/events`);
  stream.onmessage = message => {
    const event = JSON.parse(message.data) as StreamEvent;
    if (event.type !== 'snapshot' && event.type !== 'library') shown = '';
    switch (event.type) {
      // The stream opens with the snapshot connect just drew, which is not drawn again.
      case 'snapshot': if (update(event.chat)) refreshSidebar().catch(showError); break;
      case 'delta': appendDelta(event.text); break;
      case 'tool': ui.activity.textContent = TOOL_ACTIVITY[event.name]; break;
      case 'question': showQuestion(event.question); keepFollowing(); break;
      case 'error': showError(event.message); setBusy(false); break;
      case 'library': refreshLibrary().catch(showError); break;
      case 'gone': source.close(); stream = undefined; orGone(id, connect(id)).catch(showError); break;
    }
  };
  stream.onerror = () => {
    shown = '';
    // The browser retries a dropped stream by itself, but not one the server refused, such as a fifth open stream on one
    // conversation. If that is because the conversation is gone for this person, say so; otherwise the page stays as it
    // is, without retrying in a loop, and says it is no longer updating.
    const refused = source === stream && source.readyState === EventSource.CLOSED;
    ui.activity.textContent = refused ? 'Disconnected; reopen this conversation' : 'Connection interrupted; reconnecting…';
    if (refused) orGone(id, api(`/api/chats/${id}`)).catch(showError);
  };
}

// Runs `task` for conversation `id`; if it finds the conversation deleted or no longer shared with this person, says so
// and opens another one.
async function orGone(id: string, task: Promise<unknown>) {
  try { await task; }
  catch (error) {
    if (!(error instanceof RequestFailed && error.status === 404) || onScreen !== id) throw error;
    showNotice('That conversation was deleted or is no longer shared with you.');
    await openLatest();
  }
}

async function openLatest(preferred?: string | null) {
  const list = await refreshSidebar();
  const target = list.find(item => item.id === preferred) ?? list[0];
  if (target) await openChat(target.id); else await newChat();
}

// The server only notifies when nobody is looking, which it judges by open streams; so the stream closes while the
// page is hidden and reopens, with a fresh snapshot, when it is back.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { connection++; stream?.close(); stream = undefined; }
  else if (onScreen && !stream) orGone(onScreen, connect(onScreen)).catch(showError);
  // Shared lists may have changed on another phone meanwhile.
  if (!document.hidden && sheet?.node === ui.todosPage) refreshTodos().catch(showError);
});

// Busy from the moment a message goes until the turn's snapshot says otherwise, unless the server refuses it.
async function sendMessage(id: string, body: {text: string; assets: string[]; replace?: boolean}) {
  setBusy(true);
  try { await api(`/api/chats/${id}/messages`, 'POST', body); }
  catch (error) { setBusy(false); throw error; }
}

// Regenerate, and edit and resend: the last message goes again, as it was or as edited, in place of the last turn.
// The same pictures go with it, and any `added` while editing.
async function resend(text: string, added: string[] = []) {
  if (!chat) return;
  await sendMessage(chat.id, {text, assets: [...chat.messages.at(-2)!.assets, ...added], replace: true});
}

async function regenerate() {
  if (!chat || !confirm('Write a new reply in place of this one? This reply will be gone.')) return;
  await resend(chat.messages.at(-2)!.text);
}

function resizeComposer() {
  ui.draft.style.height = 'auto';
  ui.draft.style.height = Math.min(ui.draft.scrollHeight, 220) + 'px';
}

ui.composer.onsubmit = async event => {
  event.preventDefault();
  if (!chat) return;
  // Whatever is shown is what gets sent; late recognition results must not refill the cleared composer.
  cancelDictation();
  const text = ui.draft.value;
  const sent = [...attachments];
  try {
    const edit = editing;
    if (edit) {
      await resend(text, sent.map(item => item.id));
      // The draft from before the edit comes back, unless the new turn's snapshot already ended the edit (renderChat);
      // an edit started since, perhaps in another conversation, is left alone.
      if (editing === edit) stopEditing();
    } else {
      await sendMessage(chat.id, {text, assets: sent.map(item => item.id)});
      // The composer stays editable while a message is accepted; keep anything added since.
      if (ui.draft.value === text) { ui.draft.value = ''; resizeComposer(); }
    }
    dropAttachments(sent);
  } catch (error) { showError(error); }
};
ui.stop.onclick = () => {
  if (chat) api(`/api/chats/${chat.id}/abort`, 'POST', {}).catch(showError);
};
// Typing takes over from dictation, which would otherwise overwrite the edit with its next result.
ui.draft.oninput = () => { cancelDictation(); resizeComposer(); };
// On touch keyboards Enter inserts a newline; the send button sends.
const touchKeyboard = matchMedia('(pointer: coarse)');
ui.draft.onkeydown = event => {
  if (event.key === 'Escape' && editing) { stopEditing(); return; }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || touchKeyboard.matches) return;
  event.preventDefault();
  if (!ui.send.disabled) ui.composer.requestSubmit();
};

// Editing the last message happens in the composer. `draft` is whatever was there before, given back when the edit
// ends: sent or cancelled.
let editing: {draft: string} | undefined;
function startEditing() {
  if (!chat) return;
  editing = {draft: editing?.draft ?? ui.draft.value};
  ui.draft.value = chat.messages.at(-2)!.text;
  ui.editing.hidden = false;
  resizeComposer();
  ui.draft.focus();
}

function stopEditing() {
  if (!editing) return;
  cancelDictation();
  ui.draft.value = editing.draft;
  resizeComposer();
  editing = undefined;
  ui.editing.hidden = true;
}

ui.cancelEdit.onclick = () => stopEditing();

let activeQuestionId: string | undefined;

function showQuestion(question: Question | null) {
  activeQuestionId = question?.id;
  const root = ui.question;
  root.replaceChildren();
  root.hidden = !question;
  if (!question || !chat) return;
  const chatId = chat.id;
  const respond = async (value: string | boolean, cancelled = false) => {
    try {
      await api(`/api/chats/${chatId}/answer`, 'POST', {id: question.id, value, cancelled});
      // A follow-up dialog can arrive on SSE before the POST response completes.
      if (activeQuestionId === question.id) { root.hidden = true; activeQuestionId = undefined; }
    } catch (error) { showError(error); }
  };
  const option = (label: string, value: string | boolean) => {
    const button = element('button', 'option', label);
    button.onclick = () => void respond(value);
    return button;
  };
  root.append(element('h3', undefined, question.title));
  if (question.message) root.append(element('p', undefined, question.message));
  if (question.method === 'select' || question.method === 'confirm') {
    const options = element('div', 'options');
    if (question.method === 'select') options.append(...question.options.map(label => option(label, label)));
    else options.append(option('Yes', true), option('No', false));
    root.append(options);
  } else {
    const input = element('textarea');
    input.value = question.prefill;
    input.maxLength = 8000;
    input.setAttribute('aria-label', question.title);
    const options = element('div', 'options');
    const submit = element('button', 'option', 'Reply');
    submit.onclick = () => void respond(input.value);
    options.append(submit);
    root.append(input, options);
  }
  const skip = element('button', 'ghost', 'Skip');
  skip.onclick = () => void respond('', true);
  root.lastElementChild?.append(skip);
}

interface Attachment { id: string; preview: string }
const MAX_ATTACHMENTS = 4;
// Matches the server's resize; anything bigger is shrunk before upload instead of rejected.
const MAX_PICTURE_SIDE = 2048;
let attachments: Attachment[] = [];

function dropAttachments(dropped: readonly Attachment[]) {
  for (const attachment of dropped) URL.revokeObjectURL(attachment.preview);
  attachments = attachments.filter(item => !dropped.includes(item));
  renderAttachments();
}

function renderAttachments() {
  ui.attachments.replaceChildren(...attachments.map((attachment, index) => {
    const button = element('button');
    button.setAttribute('aria-label', `Remove picture ${index + 1}`);
    const preview = element('img');
    preview.src = attachment.preview;
    preview.alt = '';
    button.append(preview);
    button.onclick = () => dropAttachments([attachment]);
    return button;
  }));
}

// Phone photos are far larger than anything the model sees, so shrink them here; the server still validates and re-encodes.
async function shrinkPicture(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('Could not read this picture'); });
  try {
    const scale = MAX_PICTURE_SIDE / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not shrink this picture');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // JPEG keeps photos small; PNG keeps transparency and crisp screenshot text.
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not shrink this picture')), type, 0.9));
  } finally { bitmap.close(); }
}

function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

ui.imageInput.onchange = async () => {
  const file = ui.imageInput.files?.[0];
  ui.imageInput.value = '';
  if (!file || !chat) return;
  try {
    if (attachments.length >= MAX_ATTACHMENTS) throw new Error('Attach up to four pictures per message');
    const picture = await shrinkPicture(file);
    const data = await readBase64(picture);
    const asset = await api<AssetRef>(`/api/chats/${chat.id}/uploads`, 'POST', {mimeType: picture.type, data});
    attachments.push({id: asset.id, preview: URL.createObjectURL(picture)});
    renderAttachments();
  } catch (error) { showError(error); }
};

// The Web Speech API is not in TypeScript's DOM library; only the members used here.
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: {results: ArrayLike<ArrayLike<{transcript: string}>>}) => void) | null;
  onerror: ((event: {error: string}) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
// Safari and Chrome only (Firefox has none), and the speech is transcribed by the browser's own service, not Home Chat.
const speech = window as unknown as {SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition};
const Recognizer = speech.SpeechRecognition ?? speech.webkitSpeechRecognition;
let dictation: Recognition | undefined;

function setDictation(next: Recognition | undefined) {
  dictation = next;
  ui.dictate.setAttribute('aria-pressed', String(Boolean(next)));
  ui.dictate.title = next ? 'Stop dictating' : 'Dictate';
}

// Stops listening and drops any speech still being recognised; what is already in the composer stays.
function cancelDictation() {
  const active = dictation;
  setDictation(undefined);
  active?.abort();
}

function startDictation(Speech: new () => Recognition) {
  const recognition = new Speech();
  recognition.lang = navigator.language;
  recognition.continuous = true;
  recognition.interimResults = true;
  // Speech continues whatever was already typed.
  const typed = ui.draft.value.trimEnd();
  recognition.onresult = event => {
    if (dictation !== recognition) return;
    const spoken = Array.from(event.results, result => result[0].transcript.trim()).filter(Boolean).join(' ');
    ui.draft.value = [typed, spoken].filter(Boolean).join(' ');
    resizeComposer();
  };
  recognition.onerror = event => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') showError('Allow microphone access for this site to dictate');
    else if (event.error !== 'no-speech' && event.error !== 'aborted') showError(`Dictation stopped (${event.error})`);
  };
  recognition.onend = () => { if (dictation === recognition) setDictation(undefined); };
  recognition.start();
  setDictation(recognition);
}

ui.dictate.hidden = !Recognizer;
ui.dictate.onclick = () => {
  if (dictation) { dictation.stop(); return; }
  try { if (Recognizer) startDictation(Recognizer); } catch (error) { showError(error); }
};

function routineRow(routine: RoutineSummary): HTMLElement {
  const row = element('div', routine.chat === chat?.id ? 'chat-item active' : 'chat-item');
  const open = element('button', 'chat-open routine-open');
  open.append(element('strong', undefined, routine.title), element('span', undefined, routine.next));
  open.onclick = () => { setDrawer(false); openChat(routine.chat).catch(showError); };
  const menu = element('details', 'row-menu');
  const summary = element('summary');
  summary.setAttribute('aria-label', `More for “${routine.title}”`);
  summary.append(icon('more'));
  const remove = element('button', undefined, 'Delete routine');
  remove.onclick = () => { menu.open = false; deleteRoutine(routine).catch(showError); };
  const items = element('div', 'menu'); items.append(remove);
  menu.append(summary, items);
  // Below the button, or above it when the screen ends first; right edges aligned.
  menu.addEventListener('toggle', () => {
    if (!menu.open) return;
    const button = summary.getBoundingClientRect();
    const below = button.bottom + 4 + items.offsetHeight <= innerHeight;
    items.style.top = (below ? button.bottom + 4 : button.top - 4 - items.offsetHeight) + 'px';
    items.style.right = (innerWidth - button.right) + 'px';
  });
  row.append(open, ...(routine.unread ? [unreadDot()] : []), routineSwitch(routine), menu);
  return row;
}

function unreadDot(label = 'New results'): HTMLElement {
  const dot = element('span', 'unread-dot');
  dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', label);
  return dot;
}

async function refreshSidebar(): Promise<ChatSummary[]> {
  const [all, routines] = await Promise.all([api<ChatSummary[]>('/api/chats'), api<RoutineSummary[]>('/api/routines'), refreshLibrary()]);
  ui.routines.hidden = !routines.length;
  ui.routineList.replaceChildren(...routines.map(routineRow));
  if (sheet?.node === ui.routinesPage) renderRoutineCards(routines);
  // The server lists oldest first; everything here wants newest first. Routine conversations sit in their own list, and
  // shared ones in theirs.
  const list = all.reverse();
  const shared = list.filter(item => item.shared);
  ui.shared.hidden = !shared.length;
  ui.sharedList.replaceChildren(...shared.map(chatRow));
  ui.chatList.replaceChildren(...list.filter(item => !item.routine && !item.shared).map(chatRow));
  return list;
}

function chatRow(item: ChatSummary): HTMLElement {
  const row = element('div', item.id === chat?.id ? 'chat-item active' : 'chat-item');
  const open = element('button', 'chat-open', item.title);
  open.onclick = () => { setDrawer(false); openChat(item.id).catch(showError); };
  // Only the owner deletes it; the other person's row has a mark there instead.
  const lead = element(item.mine ? 'button' : 'span', item.mine ? 'chat-delete' : 'chat-delete chat-mark');
  if (item.mine) {
    lead.title = 'Delete conversation';
    lead.setAttribute('aria-label', `Delete “${item.title}”`);
    lead.append(icon('trash'));
    lead.onclick = () => deleteChat(item).catch(showError);
  } else {
    lead.title = `Shared by ${otherName()}`;
    lead.append(icon('people'));
  }
  row.append(lead, open, ...(item.unread ? [unreadDot('New messages')] : []));
  return row;
}

async function deleteChat(item: ChatSummary) {
  const forBoth = item.shared ? `, for ${otherName()} too` : '';
  if (!confirm(`Delete “${item.title}”? Its messages and pictures will be gone for good${forBoth}.`)) return;
  await api(`/api/chats/${item.id}`, 'DELETE');
  if (item.id === chat?.id) await openLatest(); else await refreshSidebar();
}

async function newChat() {
  const created = await api<ChatSnapshot>('/api/chats', 'POST', {});
  setDrawer(false);
  await openChat(created.id);
}

ui.newChat.onclick = () => newChat().catch(showError);

// Search: while the box has words in it, the sidebar shows results instead of its lists. `searchRun` drops the answer
// to a search that newer typing has replaced, and `searching` cancels its request, so the server stops working on it.
let searchRun = 0;
let searchTimer: number | undefined;
let searching: AbortController | undefined;
function runSearch(delay = 250) {
  clearTimeout(searchTimer);
  searching?.abort();
  const query = ui.search.value.trim();
  const run = ++searchRun;
  ui.sidebar.classList.toggle('searching', query !== '');
  ui.searchResults.hidden = query === '';
  if (!query) { ui.searchResults.replaceChildren(); return; }
  searchTimer = window.setTimeout(() => {
    searching = new AbortController();
    api<SearchResult[]>('/api/search?q=' + encodeURIComponent(query), 'GET', undefined, searching.signal).then(results => {
      if (run !== searchRun) return;
      ui.searchResults.replaceChildren(...(results.length
        ? [element('p', 'section-label', 'Results'), ...results.map(searchRow)]
        : [element('p', 'search-empty', `No conversation mentions “${query}”.`)]));
    }, error => { if (run === searchRun) showError(error); });
  }, delay);
}

function searchRow(result: SearchResult): HTMLButtonElement {
  const row = element('button', 'search-result');
  row.append(element('strong', undefined, result.title));
  if (result.snippet) {
    const snippet = element('span', 'search-snippet');
    let at = 0;
    for (const [start, end] of result.marks) { snippet.append(result.snippet.slice(at, start), element('mark', undefined, result.snippet.slice(start, end))); at = end; }
    snippet.append(result.snippet.slice(at));
    row.append(snippet);
  }
  row.onclick = () => { setDrawer(false); openAt(result.chat, result.message).catch(showError); };
  return row;
}

// The message a search result opened, lit up for a moment. The thread is drawn again on every snapshot (one node per
// message), so renderChat lights it up again until the moment is over.
let found: {chat: string; message: number; timer: number} | undefined;
function markFound() {
  ui.messages.querySelector('.found')?.classList.remove('found');
  if (found && found.chat === chat?.id) ui.messages.children[found.message]?.classList.add('found');
}

// Bumped by every result opened, so only the latest one scrolls and lights up.
let jump = 0;
async function openAt(id: string, message: number | null) {
  const attempt = ++jump;
  // Opening it again also replaces any other conversation still loading, even when this one is on screen.
  if (chat?.id !== id || onScreen !== id) await openChat(id);
  // Another result, or another conversation, was chosen while this one loaded.
  if (attempt !== jump || chat?.id !== id || onScreen !== id) return;
  const node = message === null ? undefined : ui.messages.children[message];
  if (message === null || !(node instanceof HTMLElement)) return;
  clearTimeout(found?.timer);
  found = {chat: id, message, timer: window.setTimeout(() => { found = undefined; markFound(); }, 1800)};
  markFound();
  node.scrollIntoView({block: 'center'});
  // Not following the end any more, so a snapshot arriving before the scroll event does not jump back down.
  following = false;
}

ui.search.oninput = () => runSearch();
ui.search.onkeydown = event => { if (event.key === 'Escape' && ui.search.value) { event.stopPropagation(); ui.search.value = ''; runSearch(); } };
// Enter searches at once and puts the phone keyboard away, so the results can be seen.
ui.searchForm.onsubmit = event => { event.preventDefault(); runSearch(0); ui.search.blur(); };

function setDrawer(open: boolean) {
  ui.workspace.classList.toggle('drawer-open', open);
}

ui.openSidebar.onclick = () => setDrawer(true);
ui.closeSidebar.onclick = () => setDrawer(false);
ui.scrim.onclick = () => setDrawer(false);

// Full-screen pages over the conversation: the reader, About us, Routines, Todos and the Library. One shows at a time
// and takes one history entry, so Back, and a phone's back gesture, close it. A page opens with the focus on its Back
// button. `opener` gets the focus back when the last page closes; `from`, what opened a page over its `parent`, when it
// closes back to that one.
let sheet: {node: HTMLElement; opener?: HTMLElement; parent?: HTMLElement; from?: HTMLElement} | undefined;
const sheetInHistory = () => (history.state as {sheet?: boolean} | null)?.sheet === true;
function showSheet(node: HTMLElement, parent?: HTMLElement) {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const opener = sheet?.opener ?? focused;
  if (sheet && sheet.node !== node) sheet.node.hidden = true;
  sheet = {node, opener, parent, from: parent && focused};
  node.hidden = false;
  // The conversation underneath is out of reach until the page closes, for the keyboard and screen readers too.
  ui.workspace.inert = true;
  node.scrollTop = 0;
  if (!sheetInHistory()) history.pushState({sheet: true}, '');
  node.querySelector<HTMLElement>('.page-bar > button')!.focus();
}

function hideSheet() {
  if (!sheet) return;
  sheet.node.hidden = true;
  // A page opened from another page goes back to that one, which takes the history entry again.
  if (sheet.parent) {
    const {from} = sheet;
    sheet = {node: sheet.parent, opener: sheet.opener};
    sheet.node.hidden = false;
    history.pushState({sheet: true}, '');
    if (from?.isConnected) from.focus();
    // It may have changed while the page over it was open.
    if (sheet.node === ui.libraryPage) refreshLibrary().catch(showError);
    return;
  }
  ui.workspace.inert = false;
  if (sheet.opener?.isConnected) sheet.opener.focus();
  sheet = undefined;
}

function closeSheet() {
  if (sheetInHistory()) history.back(); else hideSheet();
}

for (const back of document.querySelectorAll<HTMLButtonElement>('.page-bar > button')) back.onclick = closeSheet;
addEventListener('popstate', () => {
  if (sheetInHistory()) return;
  // Back with unsaved changes asks first; staying puts the page back in the history.
  const unsaved = aboutEdited() ? 'About us' : routineEdited() ? 'this routine' : '';
  if (unsaved && !confirm(`Leave without saving your changes to ${unsaved}?`)) { history.pushState({sheet: true}, ''); return; }
  hideSheet();
});
addEventListener('keydown', event => { if (event.key === 'Escape' && sheet) closeSheet(); });

let readerText = '';
const documentMeta = (version: number) => version > 1 ? `Document · version ${version}` : 'Document';
// `share`: copies it into the Library, offered for a document in a conversation. `parent`: the page it was opened from,
// which closing it goes back to.
async function openReader(url: string, {share, parent}: {share?: () => Promise<void>; parent?: HTMLElement} = {}) {
  const content = await api<DocumentContent>(url);
  readerText = `# ${content.title}\n\n${content.markdown}`;
  ui.readerTitle.textContent = content.title;
  ui.readerMeta.textContent = documentMeta(content.version);
  renderMarkdown(ui.readerBody, content.markdown);
  const headings = [...ui.readerBody.querySelectorAll<HTMLElement>('h3, h4')];
  const list = element('ol');
  list.append(...headings.map(heading => {
    const item = element('li', heading.tagName === 'H4' ? 'sub' : undefined);
    const jump = element('button', undefined, heading.textContent ?? '');
    jump.onclick = () => { ui.readerContents.open = false; heading.scrollIntoView({behavior: 'smooth', block: 'start'}); };
    item.append(jump);
    return item;
  }));
  ui.readerContents.querySelector('ol')?.replaceWith(list);
  ui.readerContents.open = false;
  ui.readerContents.hidden = headings.length < 2;
  // Download gives the .md file.
  ui.readerDownload.href = url + '?download=1';
  ui.readerCopy.textContent = 'Copy';
  ui.readerClose.setAttribute('aria-label', parent === ui.libraryPage ? 'Back to the Library' : 'Back to the conversation');
  ui.readerLibrary.hidden = !share;
  ui.readerLibrary.textContent = `Share with ${otherName()}`;
  ui.readerLibrary.onclick = share ? () => share().catch(showError) : null;
  showSheet(ui.reader, parent);
}

ui.readerCopy.onclick = () => copyText(readerText).then(() => { ui.readerCopy.textContent = 'Copied'; }, showError);
ui.readerShare.hidden = !canShare;
ui.readerShare.onclick = () => shareText({title: ui.readerTitle.textContent ?? '', text: readerText}, 'Could not share this document').catch(showError);

// About us: the household notes, one per line, as the server last saved them (`aboutSaved`).
let aboutVersion = 0;
let aboutSaved = '';
let aboutSaving = false;
const aboutText = () => JSON.stringify([ui.aboutMine.value, ui.aboutShared.value]);
const aboutEdited = () => sheet?.node === ui.about && aboutText() !== aboutSaved;
const noteLines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);
// `keepEdits`: the notes were edited again while a save was on its way, so they stay as typed, and unsaved.
function fillAbout(view: MemoryView, keepEdits = false) {
  aboutVersion = view.version;
  aboutSaved = JSON.stringify([view.mine.join('\n'), view.shared.join('\n')]);
  if (keepEdits) return;
  ui.aboutMine.value = view.mine.join('\n');
  ui.aboutShared.value = view.shared.join('\n');
}

async function openAbout() {
  fillAbout(await api<MemoryView>('/api/memory'));
  setDrawer(false);
  showSheet(ui.about);
}

ui.aboutEntry.replaceChildren(actionButton('people', 'About us', openAbout));
ui.aboutForm.onsubmit = async event => {
  event.preventDefault();
  // A second tap would send the same version again and be refused as a conflict.
  if (aboutSaving) return;
  aboutSaving = true;
  const sent = aboutText();
  try {
    const view = await api<MemoryView>('/api/memory', 'PUT', {version: aboutVersion, mine: noteLines(ui.aboutMine.value), shared: noteLines(ui.aboutShared.value)});
    fillAbout(view, aboutText() !== sent);
    showNotice('Saved. Home Chat keeps this in mind from your next message.');
  } catch (error) { showError(error); }
  finally { aboutSaving = false; }
};

// Routines: every routine as a card, to switch, edit, open or delete. One card at a time turns into its edit form,
// which survives the list being drawn again (`routineEdit`); `saved` is what the form held when it opened.
const REPEATS: [RoutineSchedule['kind'], string][] = [['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'On certain days'],
  ['monthly', 'Once a month'], ['once', 'Once']];
const WEEK: [Weekday, string][] = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const OUTCOMES = {running: 'running now', done: 'done', failed: 'failed', skipped: 'skipped'};
let routineList: RoutineSummary[] = [];
let routineEdit: {id: string; form: HTMLFormElement; read: () => RoutineEdit; saved: string} | undefined;
const routinePath = (id: string) => `/api/routines/${encodeURIComponent(id)}`;
const nextRun = (routine: RoutineSummary) => routine.next === 'Paused' || routine.next === 'Done' ? routine.next : `Next run: ${routine.next}`;
const routineEdited = () => sheet?.node === ui.routinesPage && routineEdit !== undefined && JSON.stringify(routineEdit.read()) !== routineEdit.saved;

async function openRoutines(edit?: string) {
  routineEdit = undefined;
  renderRoutineCards(await api<RoutineSummary[]>('/api/routines'));
  setDrawer(false);
  showSheet(ui.routinesPage);
  const routine = routineList.find(item => item.id === edit);
  if (routine) editRoutine(routine);
}

function renderRoutineCards(list: RoutineSummary[]) {
  routineList = list;
  if (routineEdit && !list.some(item => item.id === routineEdit!.id)) routineEdit = undefined;
  const nodes = list.length ? list.map(item => item.id === routineEdit?.id ? routineEdit.form : routineCard(item))
    : [element('p', 'empty-note', 'No routines yet.')];
  const form = routineEdit?.form.parentNode === ui.routineCards ? routineEdit.form : undefined;
  if (!form) return ui.routineCards.replaceChildren(...nodes);
  // Moving the form would take the focus out of it mid-typing, so the cards are put around it instead.
  for (const child of [...ui.routineCards.children]) if (child !== form) child.remove();
  const at = nodes.indexOf(form);
  form.before(...nodes.slice(0, at)); form.after(...nodes.slice(at + 1));
}

function routineCard(routine: RoutineSummary): HTMLElement {
  const card = element('article', 'card');
  const head = element('div', 'card-head');
  head.append(element('h2', undefined, routine.title), routineSwitch(routine));
  card.append(head, element('p', 'card-detail', routine.schedule), element('p', 'card-note', nextRun(routine)));
  if (routine.lastRun) {
    const {when, outcome} = routine.lastRun;
    card.append(element('p', outcome === 'failed' ? 'card-note failed' : 'card-note', `Last run: ${when}, ${OUTCOMES[outcome]}`));
  }
  card.append(element('p', 'routine-task', routine.prompt));
  if (routine.deepResearch) card.append(element('span', 'pill', 'Deep research'));
  const actions = element('div', 'card-actions');
  const open = element('button', 'ghost', 'Open conversation');
  if (routine.unread) open.append(unreadDot());
  // Opening another conversation closes this page by itself.
  open.onclick = () => { if (chat?.id === routine.chat) closeSheet(); else openChat(routine.chat).catch(showError); };
  const edit = element('button', 'ghost', 'Edit');
  edit.onclick = () => editRoutine(routine);
  const remove = element('button', 'ghost danger', 'Delete');
  remove.onclick = () => deleteRoutine(routine).catch(showError);
  actions.append(open, edit, remove);
  card.append(actions);
  return card;
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const wrap = element('label', 'routine-field');
  wrap.append(element('span', undefined, label), control);
  return wrap;
}

function editRoutine(routine: RoutineSummary) {
  if (routineEdited() && !confirm('Leave without saving your changes to this routine?')) return;
  const rule = routine.rule;
  const form = element('form', 'card routine-form');
  form.setAttribute('aria-label', `Edit “${routine.title}”`);
  const title = element('input');
  title.required = true; title.maxLength = 80; title.value = routine.title;
  const prompt = element('textarea');
  prompt.required = true; prompt.maxLength = 4000; prompt.rows = 5; prompt.value = routine.prompt;
  const repeats = element('select');
  repeats.append(...REPEATS.map(([kind, label]) => { const option = element('option', undefined, label); option.value = kind; return option; }));
  repeats.value = rule.kind;
  const time = element('input');
  time.type = 'time'; time.required = true; time.value = rule.time;
  const days = element('fieldset', 'routine-days');
  days.append(element('legend', undefined, 'On'));
  const dayBoxes = WEEK.map(([day, label]) => {
    const chip = element('label', 'day-chip');
    const box = element('input');
    box.type = 'checkbox'; box.value = day; box.checked = rule.kind === 'weekly' ? rule.days.includes(day) : day === 'mon';
    chip.append(box, element('span', undefined, label));
    days.append(chip);
    return box;
  });
  const dayOfMonth = element('input');
  dayOfMonth.type = 'number'; dayOfMonth.min = '1'; dayOfMonth.max = '28'; dayOfMonth.inputMode = 'numeric';
  dayOfMonth.value = String(rule.kind === 'monthly' ? rule.day : 1);
  const monthly = field('Day of the month (1 to 28)', dayOfMonth);
  const date = element('input');
  // No minimum: the server reads the date in its own time zone and refuses one that has passed.
  date.type = 'date';
  date.value = rule.kind === 'once' ? rule.date : new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const once = field('Date', date);
  const research = element('input');
  research.type = 'checkbox'; research.checked = routine.deepResearch;
  const researchField = element('label', 'check-field');
  researchField.append(research, 'Deep research: a thorough, sourced report each run');
  researchField.hidden = !me?.deepResearch && !routine.deepResearch;
  // Fields for other kinds of schedule are disabled too, so a leftover value in them cannot block Save.
  const showRepeats = () => {
    days.hidden = days.disabled = repeats.value !== 'weekly';
    monthly.hidden = dayOfMonth.disabled = repeats.value !== 'monthly'; dayOfMonth.required = true;
    once.hidden = date.disabled = repeats.value !== 'once'; date.required = true;
  };
  repeats.onchange = showRepeats;
  showRepeats();
  const read = (): RoutineEdit => {
    const kind = repeats.value as RoutineSchedule['kind'];
    const schedule: RoutineSchedule = kind === 'weekly' ? {kind, time: time.value, days: dayBoxes.filter(box => box.checked).map(box => box.value as Weekday)}
      : kind === 'monthly' ? {kind, time: time.value, day: Number(dayOfMonth.value)}
      : kind === 'once' ? {kind, time: time.value, date: date.value}
      : {kind, time: time.value};
    return {title: title.value.trim(), prompt: prompt.value.trim(), rule: schedule, deepResearch: research.checked};
  };
  const cancel = element('button', 'ghost', 'Cancel');
  cancel.onclick = () => { routineEdit = undefined; renderRoutineCards(routineList); };
  const save = element('button', 'primary', 'Save');
  save.type = 'submit';
  const actions = element('div', 'routine-form-actions');
  actions.append(cancel, save);
  form.append(field('Name', title), field('What it does each time', prompt), field('Repeats', repeats), days, monthly, once,
    field('Time', time), researchField, actions);
  form.onsubmit = async event => {
    event.preventDefault();
    if (save.disabled) return;
    const edit = read();
    if (edit.rule?.kind === 'weekly' && !edit.rule.days.length) return showError(new Error('Pick at least one day'));
    save.disabled = true;
    try {
      const changed = await api<RoutineSummary>(routinePath(routine.id), 'PATCH', edit);
      // The form closes, unless another one was opened meanwhile, or this one was changed again while saving: then
      // those changes stay, unsaved.
      if (routineEdit?.form === form) {
        const sent = JSON.stringify(edit);
        if (JSON.stringify(read()) === sent) routineEdit = undefined; else routineEdit.saved = sent;
      }
      if (chat?.routine?.id === changed.id) renderRoutineBar(changed);
      await refreshSidebar();
      showNotice(`Saved “${changed.title}”. ${nextRun(changed)}.`);
    } catch (error) { showError(error); }
    finally { save.disabled = false; }
  };
  routineEdit = {id: routine.id, form, read, saved: JSON.stringify(read())};
  renderRoutineCards(routineList);
  form.scrollIntoView({block: 'nearest'});
  title.focus({preventScroll: true});
}

function routineSwitch(routine: RoutineSummary): HTMLElement {
  const label = element('label', 'switch');
  label.title = routine.enabled ? 'Pause this routine' : 'Turn this routine on';
  const input = element('input');
  input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.checked = routine.enabled;
  input.setAttribute('aria-label', `Run “${routine.title}”`);
  // A one-off that has run cannot be switched back on; asking the model gives it a new date.
  input.disabled = routine.next === 'Done';
  input.onchange = () => setRoutine(routine.id, input.checked).catch(error => { input.checked = !input.checked; showError(error); });
  label.append(input, element('span'));
  return label;
}

async function setRoutine(id: string, enabled: boolean): Promise<RoutineSummary> {
  const changed = await api<RoutineSummary>(routinePath(id), 'POST', {enabled});
  if (chat?.routine?.id === changed.id) renderRoutineBar(changed);
  await refreshSidebar();
  return changed;
}

async function deleteRoutine(routine: RoutineSummary) {
  if (!confirm(`Delete the routine “${routine.title}”? It stops running. Its conversation and past results stay.`)) return;
  await api(routinePath(routine.id), 'DELETE');
  if (chat?.routine?.id === routine.id) renderRoutineBar(null);
  await refreshSidebar();
}

function renderRoutineBar(routine: RoutineSummary | null) {
  ui.routineBar.hidden = !routine;
  if (!routine) return ui.routineBar.replaceChildren();
  const edit = element('button', 'ghost', 'Edit');
  edit.onclick = () => openRoutines(routine.id).catch(showError);
  const remove = element('button', 'ghost danger', 'Delete routine');
  remove.onclick = () => deleteRoutine(routine).catch(showError);
  const text = element('span', 'routine-text', `${routine.schedule} · ${routine.next}`);
  ui.routineBar.replaceChildren(icon('clock'), text, routineSwitch(routine), edit, remove);
}

// The Pause button on a routine's notification.
async function pauseRoutine(id: string) {
  const changed = await setRoutine(id, false);
  showNotice(`Paused “${changed.title}”. Switch it back on in Routines.`);
}

ui.routinesEntry.replaceChildren(actionButton('clock', 'Routines', () => openRoutines()));

// Todos: a card per list. Every change saves at once and answers with the list as it is now, which repaints only that
// list's items and actions, so the add field keeps its focus and text between items.
const todoCards = new Map<string, {card: HTMLElement; fill: (list: TodoList) => void}>();
const todoPath = (list: TodoList) => `/api/todos/${encodeURIComponent(list.id)}`;

async function openTodos() {
  await refreshTodos();
  setDrawer(false);
  showSheet(ui.todosPage);
}

async function refreshTodos() {
  renderTodoCards(await api<TodoList[]>('/api/todos'));
}

function renderTodoCards(lists: TodoList[]) {
  for (const id of todoCards.keys()) if (!lists.some(list => list.id === id)) todoCards.delete(id);
  const cards = lists.map(list => {
    const known = todoCards.get(list.id);
    if (known) { known.fill(list); return known.card; }
    const made = todoCard(list);
    todoCards.set(list.id, made);
    return made.card;
  });
  if (!cards.length) { ui.todoCards.replaceChildren(element('p', 'empty-note', 'No lists yet.')); return; }
  // Cards already in place stay put, so a focused field in one is not taken out of the page and back.
  ui.todoCards.querySelector('.empty-note')?.remove();
  for (const child of [...ui.todoCards.children]) if (!cards.includes(child as HTMLElement)) child.remove();
  cards.forEach((card, index) => { if (ui.todoCards.children[index] !== card) ui.todoCards.insertBefore(card, ui.todoCards.children[index] ?? null); });
}

// A change to one list; a list that is gone or no longer shared takes the whole page back to what the server has.
async function changeTodo(path: string, method: string, body?: unknown): Promise<boolean> {
  try {
    const list = await api<TodoList>(path, method, body);
    todoCards.get(list.id)?.fill(list);
    return true;
  } catch (error) {
    showError(error);
    await refreshTodos().catch(() => {});
    return false;
  }
}

// A todo card's items and actions are drawn again on every change. This notes which control has the focus and returns
// what gives it back once they are: the same one, or for one that went away a neighbouring item's or `fallback`. Never
// the add field, which would open a phone's keyboard.
function keepTodoFocus(card: HTMLElement, input: HTMLInputElement): (fallback: HTMLElement) => void {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !card.contains(focused) || focused === input) return () => {};
  const rows = () => [...card.querySelectorAll<HTMLElement>('.todo-item')];
  const row = focused.closest<HTMLElement>('.todo-item');
  const item = row?.dataset.item;
  const index = row ? rows().indexOf(row) : -1;
  const control = focused.classList.contains('todo-remove') ? '.todo-remove' : 'input';
  const action = focused.dataset.action;
  return fallback => {
    const now = rows();
    const same = item === undefined ? undefined : now.find(each => each.dataset.item === item) ?? now[Math.min(index, now.length - 1)];
    const target = action ? card.querySelector<HTMLElement>(`[data-action="${action}"]`) : same?.querySelector<HTMLElement>(control);
    (target ?? fallback).focus();
  };
}

function todoCard(initial: TodoList): {card: HTMLElement; fill: (list: TodoList) => void} {
  let list = initial;
  const card = element('article', 'card todo-card');
  const head = element('div', 'card-head');
  const title = element('h2');
  const tag = element('span', 'pill', 'Shared');
  head.append(title, tag);
  const items = element('ul', 'todo-items');
  const add = element('form', 'todo-add');
  const input = element('input');
  input.maxLength = 300; input.autocomplete = 'off'; input.enterKeyHint = 'done'; input.required = true;
  const addButton = element('button', 'icon-button');
  addButton.type = 'submit';
  addButton.append(icon('plus'));
  add.append(input, addButton);
  add.onsubmit = event => {
    event.preventDefault();
    // Cleared at once for the next item; a failed add puts its text back unless something new was typed.
    const text = input.value;
    input.value = '';
    void changeTodo(todoPath(list) + '/items', 'POST', {text}).then(added => { if (!added && !input.value) input.value = text; });
  };
  const actions = element('div', 'card-actions');
  card.append(head, items, add, actions);

  const fill = (next: TodoList) => {
    // An answer that left the server before the one already shown would take that one's change back off the page.
    if (next.version < list.version) return;
    list = next;
    const refocus = keepTodoFocus(card, input);
    title.textContent = list.title;
    tag.hidden = !list.shared;
    input.placeholder = `Add to ${list.title}`;
    input.setAttribute('aria-label', `Add an item to ${list.title}`);
    addButton.setAttribute('aria-label', `Add to ${list.title}`);
    // Done items sink below the open ones, each group in the order it was added.
    const ordered = [...list.items.filter(item => !item.done), ...list.items.filter(item => item.done)];
    items.replaceChildren(...ordered.map(item => {
      const row = element('li', item.done ? 'todo-item done' : 'todo-item');
      row.dataset.item = String(item.id);
      const label = element('label');
      const box = element('input');
      box.type = 'checkbox'; box.checked = item.done;
      box.onchange = () => changeTodo(`${todoPath(list)}/items/${item.id}`, 'PATCH', {done: box.checked});
      label.append(box, element('span', undefined, item.text));
      const remove = element('button', 'icon-button todo-remove');
      remove.setAttribute('aria-label', `Remove ${item.text}`);
      remove.append(icon('close'));
      remove.onclick = () => changeTodo(`${todoPath(list)}/items/${item.id}`, 'DELETE');
      row.append(label, remove);
      return row;
    }));
    if (!list.items.length) items.replaceChildren(element('li', 'todo-empty', 'Nothing here yet.'));
    const buttons: HTMLButtonElement[] = [];
    const button = (action: string, label: string, className = 'ghost') => {
      const made = element('button', className, label);
      made.dataset.action = action;
      return made;
    };
    if (list.items.some(item => item.done)) {
      const clear = button('clear', 'Clear done');
      clear.onclick = () => changeTodo(todoPath(list) + '/clear', 'POST', {});
      buttons.push(clear);
    }
    const rename = button('rename', 'Rename');
    rename.onclick = () => {
      const name = prompt('Name of the list', list.title)?.trim();
      if (name && name !== list.title) void changeTodo(todoPath(list), 'PATCH', {title: name});
    };
    buttons.push(rename);
    // Only the list's owner shares, unshares or deletes it.
    if (list.mine) {
      const share = button('share', list.shared ? 'Make private' : 'Share with the household');
      share.onclick = () => changeTodo(todoPath(list), 'PATCH', {shared: !list.shared});
      const remove = button('delete', 'Delete', 'ghost danger');
      remove.onclick = async () => {
        if (!confirm(`Delete the list “${list.title}” and everything on it?`)) return;
        try { await api(todoPath(list), 'DELETE'); } catch (error) { showError(error); }
        await refreshTodos().catch(showError);
      };
      buttons.push(share, remove);
    }
    actions.replaceChildren(...buttons);
    refocus(rename);
  };
  fill(list);
  return {card, fill};
}

ui.todosEntry.replaceChildren(actionButton('check', 'Todos', openTodos));
ui.todoNew.onsubmit = async event => {
  event.preventDefault();
  try {
    await api<TodoList>('/api/todos', 'POST', {title: ui.todoNewTitle.value, shared: ui.todoNewShared.checked});
    ui.todoNewTitle.value = ''; ui.todoNewShared.checked = false;
    await refreshTodos();
  } catch (error) { showError(error); }
};

// The Library: copies of documents and pictures shared on their own, for both people. Opening it marks what the other
// person shared as seen, which clears the dot on its sidebar entry.
async function openLibrary() {
  setDrawer(false);
  showSheet(ui.libraryPage);
  await refreshLibrary();
}

// Drawn into the page if it is open, which counts as seeing it; otherwise the sidebar entry shows whether anything is
// new. `libraryRun` keeps an answer that newer requests overtook from drawing over theirs.
let libraryRun = 0;
async function refreshLibrary() {
  const run = ++libraryRun;
  const open = () => sheet?.node === ui.libraryPage;
  const markSeen = () => api<Library>('/api/library/seen', 'POST', {});
  let library = await (open() ? markSeen() : api<Library>('/api/library'));
  if (run !== libraryRun) return;
  // Opened while the plain read was on its way.
  if (open() && library.unseen) library = await markSeen();
  if (run !== libraryRun) return;
  renderLibraryEntry(library.unseen);
  if (open()) renderLibrary(library);
}

function renderLibraryEntry(unseen: boolean) {
  const open = actionButton('document', 'Library', openLibrary);
  if (unseen) open.append(unreadDot('Newly shared'));
  ui.libraryEntry.replaceChildren(open);
}

function renderLibrary(library: Library) {
  ui.libraryLede.textContent = `Documents and pictures you and ${otherName()} shared from your conversations, newest first. `
    + 'The conversations they came from stay as private as they were.';
  // The cards are drawn again, so a focused button or link gets the focus back on its item's new card, as when the
  // reader closes back to this page.
  const focused = document.activeElement instanceof HTMLElement && ui.libraryCards.contains(document.activeElement) ? document.activeElement : undefined;
  const item = focused?.closest<HTMLElement>('.library-card')?.dataset.item;
  ui.libraryCards.replaceChildren(...(library.items.length ? library.items.map(libraryCard)
    : [element('p', 'empty-note', `Nothing here yet. Tap “Share with ${otherName()}” on a picture or in a document.`)]));
  if (item) [...ui.libraryCards.querySelectorAll<HTMLElement>(`[data-item="${item}"] .ghost`)].find(control => control.textContent === focused?.textContent)?.focus();
}

function libraryCard(item: LibraryItem): HTMLElement {
  const url = `/api/library/${item.id}`;
  const card = element('article', 'card library-card');
  card.dataset.item = item.id;
  const name = item.kind === 'picture' ? 'this picture' : `“${item.title}”`;
  if (item.kind === 'picture') {
    const picture = element('img');
    picture.src = url; picture.loading = 'lazy';
    picture.alt = item.mine ? 'A picture you shared' : `A picture ${nameOf(item.by)} shared`;
    card.append(picture);
  } else {
    card.append(element('h2', undefined, item.title), element('p', 'card-detail', documentMeta(item.version)));
  }
  card.append(element('p', 'card-note', item.mine ? `You shared it · ${item.when}` : `From ${nameOf(item.by)} · ${item.when}`));
  const actions = element('div', 'card-actions');
  if (item.kind === 'document') {
    const open = element('button', 'ghost', 'Open');
    open.onclick = () => openReader(url, {parent: ui.libraryPage}).catch(showError);
    actions.append(open);
  }
  const download = element('a', 'ghost', 'Download');
  download.href = url + '?download=1'; download.download = item.kind === 'picture' ? 'home-chat.png' : '';
  actions.append(download);
  if (item.mine) {
    const remove = element('button', 'ghost danger', 'Stop sharing');
    remove.onclick = async () => {
      if (!confirm(`Stop sharing ${name}? It will be gone from the Library for both of you.`)) return;
      try { await api(url, 'DELETE'); await refreshLibrary(); } catch (error) { showError(error); }
    };
    actions.append(remove);
  }
  card.append(actions);
  return card;
}

async function shareAsset(chatId: string, assetId: string) {
  await api(`/api/chats/${chatId}/assets/${assetId}/share`, 'POST', {});
  showNotice(`Shared with ${otherName()}. It’s in the Library.`);
}

renderLibraryEntry(false);

// Adding to the Home Screen: Chromium browsers (Edge, Chrome, Android) hand over a prompt the page can show; iPhone and
// iPad only install through the browser's Share sheet, so they get instructions instead. Neither is in TypeScript's DOM.
interface InstallPrompt extends Event { prompt(): Promise<void> }
const INSTALL_DISMISSED = 'home-chat-install-dismissed';
const appleDevice = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const installed = () => matchMedia('(display-mode: standalone)').matches || (navigator as {standalone?: boolean}).standalone === true;
let installPrompt: InstallPrompt | undefined;
const installable = () => !installed() && (appleDevice || installPrompt !== undefined);

// Push notifications. iPhone and iPad only offer them inside the installed app, so a Safari tab reports no support.
type PushState = 'unsupported' | 'blocked' | 'off' | 'on';
const NOTIFY_DISMISSED = 'home-chat-notify-dismissed';
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let pushState: PushState = 'unsupported';

const APPLE_INSTALL_STEPS = 'Tap Share in your browser (in Safari it can be under ···), then Add to Home Screen.';

// The welcome screen shows one setup step at a time: install, then notifications. "Not now" hides a step for good;
// the sidebar keeps a quieter way to each.
function setupCard(): HTMLElement | undefined {
  if (installable() && !localStorage.getItem(INSTALL_DISMISSED)) {
    return stepCard('home', 'Keep Home Chat on your Home Screen',
      installPrompt ? 'It opens like an app, full screen and one tap away.' : APPLE_INSTALL_STEPS,
      INSTALL_DISMISSED, installPrompt ? ['Install', install] : undefined);
  }
  if (pushState === 'off' && !localStorage.getItem(NOTIFY_DISMISSED)) {
    return stepCard('bell', 'Know when a reply is ready', 'Get a notification when Home Chat has finished, even with the app closed.',
      NOTIFY_DISMISSED, ['Turn on', enableNotifications]);
  }
}

function stepCard(name: string, title: string, text: string, dismissKey: string, action?: [string, () => Promise<void>]): HTMLElement {
  const card = element('div', 'setup-card');
  const copy = element('div', 'setup-text');
  copy.append(element('strong', undefined, title), element('span', undefined, text));
  const actions = element('div', 'setup-actions');
  if (action) {
    const run = element('button', 'primary', action[0]);
    run.onclick = () => action[1]().catch(showError);
    actions.append(run);
  }
  const later = element('button', 'ghost', 'Not now');
  later.onclick = () => { localStorage.setItem(dismissKey, '1'); renderSetup(); };
  actions.append(later);
  card.append(icon(name), copy, actions);
  return card;
}

function renderSetup() {
  ui.install.hidden = !installable();
  if (installPrompt) ui.install.replaceChildren(actionButton('home', 'Install Home Chat', install));
  else {
    const help = element('details');
    const summary = element('summary');
    summary.append(icon('home'), 'Add to Home Screen');
    help.append(summary, element('p', undefined, APPLE_INSTALL_STEPS));
    ui.install.replaceChildren(help);
  }
  ui.notifications.hidden = pushState === 'unsupported';
  ui.notifications.replaceChildren(
    pushState === 'on' ? actionButton('bell', 'Notifications on · Turn off', disableNotifications)
    : pushState === 'off' ? actionButton('bell', 'Turn on notifications', enableNotifications)
    : element('p', undefined, 'Notifications are blocked. Allow them for this site in your browser settings.'));
  const empty = document.querySelector('.empty');
  if (!empty) return;
  empty.querySelector('.setup-card')?.remove();
  const card = setupCard();
  if (card) empty.querySelector('.suggestions')?.before(card);
}

async function install() {
  const prompt = installPrompt;
  if (!prompt) return;
  // A prompt can be shown once; Chromium offers a new one later if it was declined.
  installPrompt = undefined;
  await prompt.prompt();
  renderSetup();
}

const base64UrlBytes = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
const sameBytes = (a: ArrayBuffer | null, b: Uint8Array) => a !== null && a.byteLength === b.length && new Uint8Array(a).every((byte, i) => byte === b[i]);
// What subscribing needs: the server's key and this device's service worker.
const pushSetup = () => Promise.all([api<PushInfo>('/api/push'), navigator.serviceWorker.ready]);

async function dropSubscription(subscription: PushSubscription) {
  await api('/api/push/subscriptions', 'DELETE', subscription.toJSON());
  await subscription.unsubscribe();
}

// Brings the server in line with this device on every load: it may have dropped the subscription, or made new keys.
async function syncPush() {
  if (!pushSupported) return;
  if (Notification.permission === 'denied') { pushState = 'blocked'; return renderSetup(); }
  const [{publicKey}, registration] = await pushSetup();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameBytes(subscription.options.applicationServerKey, base64UrlBytes(publicKey))) await dropSubscription(subscription);
  else if (subscription && Notification.permission === 'granted') {
    await api('/api/push/subscriptions', 'POST', subscription.toJSON());
    pushState = 'on'; return renderSetup();
  }
  pushState = 'off'; renderSetup();
}

async function enableNotifications() {
  // Asked first, while the tap still counts as a user gesture: Safari only prompts from one.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { pushState = permission === 'denied' ? 'blocked' : 'off'; return renderSetup(); }
  const [{publicKey}, registration] = await pushSetup();
  const subscription = await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: base64UrlBytes(publicKey)});
  await api('/api/push/subscriptions', 'POST', subscription.toJSON());
  pushState = 'on'; renderSetup();
}

async function disableNotifications() {
  const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (subscription) await dropSubscription(subscription);
  pushState = 'off'; renderSetup();
}

addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event as InstallPrompt; renderSetup(); });
addEventListener('appinstalled', () => { installPrompt = undefined; renderSetup(); });
renderSetup();
// A notification tapped while the app is open: the service worker asks this window to show that conversation.
navigator.serviceWorker?.addEventListener('message', event => {
  const data = event.data as {type?: unknown; chat?: unknown; pause?: unknown} | null;
  if (data?.type !== 'open-chat' || typeof data.chat !== 'string') return;
  const pause = typeof data.pause === 'string' ? data.pause : undefined;
  setDrawer(false);
  (data.chat === chat?.id ? Promise.resolve() : openChat(data.chat))
    .then(() => pause ? pauseRoutine(pause) : undefined).catch(showError);
});

async function enter() {
  me = await api<Me>('/api/me');
  ui.login.hidden = true;
  ui.workspace.hidden = false;
  ui.identity.textContent = me.user === 'owner' ? 'Your space' : 'Guest space';
  ui.avatar.textContent = me.user === 'owner' ? 'Y' : 'G';
  ui.providerWarning.hidden = me.codexConfigured;
  // A tapped notification opens /?chat=<id>, with &pause=<routine> from its Pause button; the address goes back to /
  // so a reload starts as usual.
  const query = new URLSearchParams(location.search);
  const requested = query.get('chat'); const pause = query.get('pause');
  if (requested || pause) history.replaceState(null, '', '/');
  await openLatest(requested);
  if (pause) await pauseRoutine(pause).catch(showError);
  if (pushSupported) {
    // If the worker cannot be registered (an expired sign-in, for one), notifications stay hidden until the next load.
    navigator.serviceWorker.register('/sw.js').then(() => syncPush().catch(showError), () => {});
  }
}

ui.loginForm.onsubmit = async event => {
  event.preventDefault();
  try {
    await api('/api/login', 'POST', {code: ui.accessCode.value});
    ui.accessCode.value = '';
    await enter();
  } catch (error) { showError(error); }
};
ui.logout.onclick = async () => {
  try {
    // Asked of the browser, not pushState, which is only known once the load's sync has finished.
    const subscription = pushSupported ? await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription() ?? null : null;
    await api('/api/logout', 'POST', {pushEndpoint: subscription?.endpoint});
    await subscription?.unsubscribe();
    stream?.close();
    // Under Cloudflare Access the real session is Cloudflare's; end it there.
    if (me?.mode === 'access') location.assign('/cdn-cgi/access/logout'); else location.reload();
  } catch (error) { showError(error); }
};

// The access-code form is only for local mode; under Cloudflare Access the user is already signed in.
enter().catch(error => {
  if ((error as Error).message === 'Sign in required') ui.login.hidden = false;
  else showError(error);
});

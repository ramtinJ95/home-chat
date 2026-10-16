import type { ApiError, AssetRef, ChatSnapshot, ChatSummary, DocumentContent, DocumentInfo, Me, MemoryView, Message, PushInfo, SearchResult, Question, RoutineSummary, StreamEvent, ToolName } from '../src/api.d.ts';

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
  routines: $('#routines'),
  routineList: $('#routine-list'),
  routineBar: $('#routine-bar'),
  avatar: $('#avatar'),
  identity: $('#identity'),
  logout: $<HTMLButtonElement>('#logout'),
  modeBadge: $('#mode-badge'),
  title: $('#chat-title'),
  research: $<HTMLButtonElement>('#research'),
  providerWarning: $('#provider-warning'),
  messages: $('#messages'),
  question: $('#question'),
  composer: $<HTMLFormElement>('#composer'),
  message: $<HTMLTextAreaElement>('#message'),
  attachments: $('#attachments'),
  imageInput: $<HTMLInputElement>('#image-input'),
  dictate: $<HTMLButtonElement>('#dictate'),
  activity: $('#activity'),
  stop: $<HTMLButtonElement>('#stop'),
  send: $<HTMLButtonElement>('#send'),
  install: $('#install'),
  notifications: $('#notifications'),
  error: $('#error'),
  reader: $('#reader'),
  readerClose: $<HTMLButtonElement>('#reader-close'),
  readerCopy: $<HTMLButtonElement>('#reader-copy'),
  readerShare: $<HTMLButtonElement>('#reader-share'),
  readerDownload: $<HTMLAnchorElement>('#reader-download'),
  readerMeta: $('#reader-meta'),
  readerTitle: $('#reader-title'),
  readerContents: $<HTMLDetailsElement>('#reader-contents'),
  readerBody: $('#reader-body'),
  aboutEntry: $('#about-entry'),
  about: $('#about'),
  aboutClose: $<HTMLButtonElement>('#about-close'),
  aboutForm: $<HTMLFormElement>('#about-form'),
  aboutMine: $<HTMLTextAreaElement>('#about-mine'),
  aboutShared: $<HTMLTextAreaElement>('#about-shared'),
};

const TOOL_ACTIVITY: Record<ToolName, string> = {
  ask: 'Asking you a quick question…',
  web_run: 'Searching the web…',
  imagegen: 'Creating an image…',
  document: 'Writing a document…',
  deep_research: 'Researching… this can take a few minutes',
  routine: 'Updating your routines…',
  memory: 'Updating About us…',
};
const SUGGESTIONS = [
  {icon: 'compass', title: 'Plan something lovely', prompt: 'Help me plan something lovely for the weekend'},
  {icon: 'spark', title: 'Explain a curiosity', prompt: 'Explain something I’ve always wondered about'},
  {icon: 'brush', title: 'Make a picture', prompt: 'Let’s create an image together'},
];
const MAX_ATTACHMENTS = 4;
// Matches the server's resize; anything bigger is shrunk before upload instead of rejected.
const MAX_PICTURE_SIDE = 2048;
// Re-parsing markdown on every delta is wasted work; the final snapshot renders the complete reply.
const STREAM_RENDER_MS = 120;

interface Attachment { id: string; preview: string }

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

let me: Me | undefined;
let chat: ChatSnapshot | undefined;
let stream: EventSource | undefined;
let attachments: Attachment[] = [];
// The assistant reply currently receiving deltas; re-rendered at most every STREAM_RENDER_MS.
let streaming: {node: HTMLElement; text: string; timer?: number} | undefined;
let activeQuestionId: string | undefined;
let errorTimer: number | undefined;
let dictation: Recognition | undefined;
// Whether the reader is at the bottom of the thread; new content only scrolls the view while they are.
let following = true;

function showError(error: unknown) {
  ui.error.textContent = error instanceof Error ? error.message : String(error);
  ui.error.classList.remove('info');
  ui.error.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => { ui.error.hidden = true; }, 8000);
}

// The same toast, for confirmations rather than failures.
function showNotice(text: string) {
  ui.error.textContent = text;
  ui.error.classList.add('info');
  ui.error.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => { ui.error.hidden = true; }, 8000);
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
  if (!response.ok) throw new Error((result as ApiError | undefined)?.error ?? `Home Chat is unavailable right now (HTTP ${response.status})`);
  return result as T;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
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

function setBusy(busy: boolean) {
  ui.send.disabled = busy;
  // The switch applies from the next message, so it waits while a reply runs.
  ui.research.disabled = busy;
  ui.send.hidden = busy;
  ui.stop.hidden = !busy;
  ui.messages.classList.toggle('busy', busy);
  ui.activity.textContent = busy ? 'Thinking…' : '';
}

function scrollToEnd() { ui.messages.scrollTop = ui.messages.scrollHeight; following = true; }
function keepFollowing() { if (following) scrollToEnd(); }

function renderEmpty(): HTMLElement {
  const empty = element('div', 'empty');
  const suggestions = element('div', 'suggestions');
  for (const {icon: name, title, prompt} of SUGGESTIONS) {
    const button = element('button');
    button.type = 'button';
    button.append(icon(name), element('strong', undefined, title), element('span', undefined, prompt));
    button.onclick = () => { cancelDictation(); ui.message.value = prompt; resizeComposer(); ui.message.focus(); };
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
    run.type = 'button'; run.onclick = () => action[1]().catch(showError);
    actions.append(run);
  }
  const later = element('button', 'ghost', 'Not now');
  later.type = 'button';
  later.onclick = () => { localStorage.setItem(dismissKey, '1'); renderSetup(); };
  actions.append(later);
  card.append(icon(name), copy, actions);
  return card;
}

function sidebarButton(name: string, label: string, run: () => Promise<void>): HTMLButtonElement {
  const button = element('button');
  button.type = 'button'; button.append(icon(name), label);
  button.onclick = () => run().catch(showError);
  return button;
}

function renderSetup() {
  ui.install.hidden = !installable();
  if (installPrompt) ui.install.replaceChildren(sidebarButton('home', 'Install Home Chat', install));
  else {
    const help = element('details');
    const summary = element('summary');
    summary.append(icon('home'), 'Add to Home Screen');
    help.append(summary, element('p', undefined, APPLE_INSTALL_STEPS));
    ui.install.replaceChildren(help);
  }
  ui.notifications.hidden = pushState === 'unsupported';
  ui.notifications.replaceChildren(
    pushState === 'on' ? sidebarButton('bell', 'Notifications on · Turn off', disableNotifications)
    : pushState === 'off' ? sidebarButton('bell', 'Turn on notifications', enableNotifications)
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

// Brings the server in line with this device on every load: it may have dropped the subscription, or made new keys.
async function syncPush() {
  if (!pushSupported) return;
  if (Notification.permission === 'denied') { pushState = 'blocked'; return renderSetup(); }
  const [{publicKey}, registration] = await Promise.all([api<PushInfo>('/api/push'), navigator.serviceWorker.ready]);
  const subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameBytes(subscription.options.applicationServerKey, base64UrlBytes(publicKey))) {
    await api('/api/push/subscriptions', 'DELETE', subscription.toJSON());
    await subscription.unsubscribe();
  }
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
  const [{publicKey}, registration] = await Promise.all([api<PushInfo>('/api/push'), navigator.serviceWorker.ready]);
  const subscription = await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: base64UrlBytes(publicKey)});
  await api('/api/push/subscriptions', 'POST', subscription.toJSON());
  pushState = 'on'; renderSetup();
}

async function disableNotifications() {
  const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (subscription) {
    await api('/api/push/subscriptions', 'DELETE', subscription.toJSON());
    await subscription.unsubscribe();
  }
  pushState = 'off'; renderSetup();
}

// Where a routine run starts in its conversation: its name and when it was due.
function runMark(label: string): HTMLElement {
  const mark = element('p', 'run-mark');
  mark.append(icon('clock'), label);
  return mark;
}

function renderMessage(snapshot: ChatSnapshot, message: Message, fresh: boolean): HTMLElement {
  // A run's scheduled message is the routine's standing task, which the mark stands for.
  if (message.run && message.role === 'user') return runMark(message.run);
  const article = element('article', `message ${message.role}${fresh ? ' fresh' : ''}`);
  const bubble = element('div', 'bubble');
  const content = element('div', 'content');
  bubble.append(element('span', 'sr-only', message.role === 'user' ? 'You said' : 'Home Chat said'), content);
  if (message.role === 'assistant') {
    renderMarkdown(content, message.text);
    streaming = {node: content, text: message.text};
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
    const download = element('a', 'download');
    download.href = url + '?download=1';
    download.download = 'home-chat.png';
    download.append(icon('download'), 'Download');
    figure.append(picture, download);
    bubble.append(figure);
  }
  if (message.error) bubble.append(element('p', 'failure', message.error));
  article.append(bubble);
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
  card.type = 'button';
  const text = element('span', 'document-text');
  const meta = latest.document.version === 1 ? 'Document'
    : latest.document.version === info.version ? `Version ${info.version}` : `Updated later · version ${latest.document.version}`;
  text.append(element('strong', undefined, latest.document.title), element('span', undefined, meta));
  card.append(icon('document'), text, element('span', 'document-open', 'Open'));
  card.onclick = () => openReader(snapshot.id, latest).catch(showError);
  return card;
}

// The reader covers the conversation and takes one history entry, so a phone's back gesture closes it.
// Full-screen pages over the conversation: the reader and About us. One shows at a time, and Back closes it like a page.
let sheet: {node: HTMLElement; opener?: HTMLElement} | undefined;
const sheetInHistory = () => (history.state as {sheet?: boolean} | null)?.sheet === true;
function showSheet(node: HTMLElement, focus: HTMLElement) {
  const opener = sheet?.opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  if (sheet && sheet.node !== node) sheet.node.hidden = true;
  sheet = {node, opener};
  node.hidden = false;
  // The conversation underneath is out of reach until the page closes, for the keyboard and screen readers too.
  ui.workspace.inert = true;
  node.scrollTop = 0;
  if (!sheetInHistory()) history.pushState({sheet: true}, '');
  focus.focus();
}

function hideSheet() {
  if (!sheet) return;
  sheet.node.hidden = true;
  ui.workspace.inert = false;
  if (sheet.opener?.isConnected) sheet.opener.focus();
  sheet = undefined;
}

function closeSheet() {
  if (sheetInHistory()) history.back(); else hideSheet();
}

let readerText = '';
async function openReader(chatId: string, asset: AssetRef & {document: DocumentInfo}) {
  const url = `/api/chats/${chatId}/assets/${asset.id}`;
  const content = await api<DocumentContent>(url);
  readerText = `# ${content.title}\n\n${content.markdown}`;
  ui.readerTitle.textContent = content.title;
  ui.readerMeta.textContent = content.version > 1 ? `Document · version ${content.version}` : 'Document';
  renderMarkdown(ui.readerBody, content.markdown);
  const headings = [...ui.readerBody.querySelectorAll<HTMLElement>('h3, h4')];
  const list = element('ol');
  list.append(...headings.map(heading => {
    const item = element('li', heading.tagName === 'H4' ? 'sub' : undefined);
    const jump = element('button', undefined, heading.textContent ?? '');
    jump.type = 'button';
    jump.onclick = () => { ui.readerContents.open = false; heading.scrollIntoView({behavior: 'smooth', block: 'start'}); };
    item.append(jump);
    return item;
  }));
  ui.readerContents.querySelector('ol')?.replaceWith(list);
  ui.readerContents.open = false;
  ui.readerContents.hidden = headings.length < 2;
  ui.readerDownload.href = url + '?download=1';
  ui.readerCopy.textContent = 'Copy';
  showSheet(ui.reader, ui.readerClose);
}

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
  showSheet(ui.about, ui.aboutClose);
}

function renderChat(next: ChatSnapshot) {
  // Another conversation replaces the page, and any page over it.
  if (chat?.id !== next.id) closeSheet();
  const sameChat = chat?.id === next.id;
  const previousCount = sameChat && chat ? chat.messages.length : next.messages.length;
  chat = next;
  ui.title.textContent = next.title;
  ui.research.hidden = !me?.deepResearch;
  ui.research.setAttribute('aria-pressed', String(next.deepResearch));
  ui.message.placeholder = next.deepResearch ? 'What should I research?' : 'What’s on your mind?';
  renderRoutineBar(next.routine);
  setBusy(next.busy);
  streaming = undefined;
  ui.messages.replaceChildren(...(next.messages.length
    ? next.messages.map((message, index) => renderMessage(next, message, index >= previousCount))
    : [renderEmpty()]));
  markFound();
  // The question card shrinks the thread, so place it before scrolling.
  showQuestion(next.question);
  if (sameChat) keepFollowing(); else scrollToEnd();
}

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

function setDrawer(open: boolean) {
  ui.workspace.classList.toggle('drawer-open', open);
}

function routineSwitch(routine: RoutineSummary): HTMLElement {
  const label = element('label', 'switch');
  label.title = routine.enabled ? 'Pause this routine' : 'Turn this routine on';
  const input = element('input');
  input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.checked = routine.enabled;
  input.setAttribute('aria-label', `Run “${routine.title}”`);
  // A one-off that has run cannot be switched back on; asking the model gives it a new date.
  input.disabled = routine.next === 'Done';
  input.onchange = () => setRoutine(routine, input.checked).catch(error => { input.checked = !input.checked; showError(error); });
  label.append(input, element('span'));
  return label;
}

async function setRoutine(routine: RoutineSummary, enabled: boolean) {
  const changed = await api<RoutineSummary>(`/api/routines/${routine.id}`, 'POST', {enabled});
  if (chat?.routine?.id === changed.id) renderRoutineBar(changed);
  await refreshList();
}

async function deleteRoutine(routine: RoutineSummary) {
  if (!confirm(`Delete the routine “${routine.title}”? It stops running. Its conversation and past results stay.`)) return;
  await api(`/api/routines/${routine.id}`, 'DELETE');
  if (chat?.routine?.id === routine.id) renderRoutineBar(null);
  await refreshList();
}

function renderRoutineBar(routine: RoutineSummary | null) {
  ui.routineBar.hidden = !routine;
  if (!routine) return ui.routineBar.replaceChildren();
  const remove = element('button', 'ghost', 'Delete routine');
  remove.type = 'button';
  remove.onclick = () => deleteRoutine(routine).catch(showError);
  const text = element('span', 'routine-text', `${routine.schedule} · ${routine.enabled || routine.next === 'Done' ? routine.next : 'Paused'}`);
  ui.routineBar.replaceChildren(icon('clock'), text, routineSwitch(routine), remove);
}

function routineRow(routine: RoutineSummary): HTMLElement {
  const row = element('div', routine.chat === chat?.id ? 'chat-item active' : 'chat-item');
  const open = element('button', 'chat-open routine-open');
  open.type = 'button';
  open.append(element('strong', undefined, routine.title), element('span', undefined, routine.next));
  open.onclick = () => { setDrawer(false); openChat(routine.chat).catch(showError); };
  const menu = element('details', 'row-menu');
  const summary = element('summary');
  summary.setAttribute('aria-label', `More for “${routine.title}”`);
  summary.append(icon('more'));
  const remove = element('button', undefined, 'Delete routine');
  remove.type = 'button';
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

function unreadDot(): HTMLElement {
  const dot = element('span', 'unread-dot');
  dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', 'New results');
  return dot;
}

async function refreshList(): Promise<ChatSummary[]> {
  const [all, routines] = await Promise.all([api<ChatSummary[]>('/api/chats'), api<RoutineSummary[]>('/api/routines')]);
  ui.routines.hidden = !routines.length;
  ui.routineList.replaceChildren(...routines.map(routineRow));
  // The server lists oldest first; everything here wants newest first. Routine conversations sit in their own list.
  const list = all.reverse();
  ui.chatList.replaceChildren(...list.filter(item => !item.routine).map(item => {
    const row = element('div', item.id === chat?.id ? 'chat-item active' : 'chat-item');
    const open = element('button', 'chat-open', item.title);
    open.type = 'button';
    open.onclick = () => { setDrawer(false); openChat(item.id).catch(showError); };
    const remove = element('button', 'chat-delete');
    remove.type = 'button';
    remove.title = 'Delete conversation';
    remove.setAttribute('aria-label', `Delete “${item.title}”`);
    remove.append(icon('trash'));
    remove.onclick = () => deleteChat(item).catch(showError);
    row.append(open, ...(item.unread ? [unreadDot()] : []), remove);
    return row;
  }));
  return list;
}

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
  row.type = 'button';
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

async function deleteChat(item: ChatSummary) {
  if (!confirm(`Delete “${item.title}”? Its messages and pictures will be gone for good.`)) return;
  await api(`/api/chats/${item.id}`, 'DELETE');
  if (item.id === chat?.id) await openLatest(); else await refreshList();
}

async function openChat(id: string) {
  dropAttachments(attachments);
  await connect(id);
  await refreshList();
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
  if (document.hidden) return;
  stream = new EventSource(`/api/chats/${id}/events`);
  stream.onmessage = message => {
    const event = JSON.parse(message.data) as StreamEvent;
    switch (event.type) {
      case 'snapshot': renderChat(event.chat); refreshList().catch(showError); break;
      case 'delta': appendDelta(event.text); break;
      case 'tool': ui.activity.textContent = TOOL_ACTIVITY[event.name]; break;
      case 'question': showQuestion(event.question); keepFollowing(); break;
      case 'error': showError(event.message); setBusy(false); break;
    }
  };
  stream.onerror = () => { ui.activity.textContent = 'Connection interrupted; reconnecting…'; };
}

async function newChat() {
  const created = await api<ChatSnapshot>('/api/chats', 'POST', {});
  setDrawer(false);
  await openChat(created.id);
}

// The Pause button on a routine's notification.
async function pauseRoutine(id: string) {
  const changed = await api<RoutineSummary>(`/api/routines/${encodeURIComponent(id)}`, 'POST', {enabled: false});
  if (chat?.routine?.id === changed.id) renderRoutineBar(changed);
  await refreshList();
  showNotice(`Paused “${changed.title}”. Switch it back on in Routines.`);
}

async function openLatest(preferred?: string | null) {
  const list = await refreshList();
  const target = list.find(item => item.id === preferred) ?? list[0];
  if (target) await openChat(target.id); else await newChat();
}

async function enter() {
  me = await api<Me>('/api/me');
  ui.login.hidden = true;
  ui.workspace.hidden = false;
  ui.identity.textContent = me.user === 'owner' ? 'Your space' : 'Guest space';
  ui.modeBadge.textContent = me.mode === 'access' ? 'Private' : 'Local only';
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

function dropAttachments(dropped: readonly Attachment[]) {
  for (const attachment of dropped) URL.revokeObjectURL(attachment.preview);
  attachments = attachments.filter(item => !dropped.includes(item));
  renderAttachments();
}

function renderAttachments() {
  ui.attachments.replaceChildren(...attachments.map((attachment, index) => {
    const button = element('button');
    button.type = 'button';
    button.setAttribute('aria-label', `Remove picture ${index + 1}`);
    const preview = element('img');
    preview.src = attachment.preview;
    preview.alt = '';
    button.append(preview);
    button.onclick = () => dropAttachments([attachment]);
    return button;
  }));
}

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
    button.type = 'button';
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
    submit.type = 'button';
    submit.onclick = () => void respond(input.value);
    options.append(submit);
    root.append(input, options);
  }
  const skip = element('button', 'ghost', 'Skip');
  skip.type = 'button';
  skip.onclick = () => void respond('', true);
  root.lastElementChild?.append(skip);
}

function resizeComposer() {
  ui.message.style.height = 'auto';
  ui.message.style.height = Math.min(ui.message.scrollHeight, 220) + 'px';
}

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
  const typed = ui.message.value.trimEnd();
  recognition.onresult = event => {
    if (dictation !== recognition) return;
    const spoken = Array.from(event.results, result => result[0].transcript.trim()).filter(Boolean).join(' ');
    ui.message.value = [typed, spoken].filter(Boolean).join(' ');
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

ui.loginForm.onsubmit = async event => {
  event.preventDefault();
  try {
    await api('/api/login', 'POST', {code: ui.accessCode.value});
    ui.accessCode.value = '';
    await enter();
  } catch (error) { showError(error); }
};
ui.newChat.onclick = () => newChat().catch(showError);
ui.search.oninput = () => runSearch();
ui.search.onkeydown = event => { if (event.key === 'Escape' && ui.search.value) { event.stopPropagation(); ui.search.value = ''; runSearch(); } };
// Enter searches at once and puts the phone keyboard away, so the results can be seen.
ui.searchForm.onsubmit = event => { event.preventDefault(); runSearch(0); ui.search.blur(); };
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
// The server only notifies when nobody is looking, which it judges by open streams; so the stream closes while the
// page is hidden and reopens, with a fresh snapshot, when it is back.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { connection++; stream?.close(); stream = undefined; }
  else if (onScreen && !stream) connect(onScreen).catch(showError);
});
ui.openSidebar.onclick = () => setDrawer(true);
ui.closeSidebar.onclick = () => setDrawer(false);
ui.scrim.onclick = () => setDrawer(false);
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
ui.composer.onsubmit = async event => {
  event.preventDefault();
  if (!chat) return;
  // Whatever is shown is what gets sent; late recognition results must not refill the cleared composer.
  cancelDictation();
  const text = ui.message.value;
  const sent = [...attachments];
  try {
    setBusy(true);
    await api(`/api/chats/${chat.id}/messages`, 'POST', {text, assets: sent.map(item => item.id)});
    // The composer stays editable while a message is accepted; keep anything added since.
    if (ui.message.value === text) { ui.message.value = ''; resizeComposer(); }
    dropAttachments(sent);
  } catch (error) { setBusy(false); showError(error); }
};
ui.research.onclick = async () => {
  if (!chat) return;
  try { renderChat(await api<ChatSnapshot>(`/api/chats/${chat.id}/research`, 'POST', {on: !chat.deepResearch})); }
  catch (error) { showError(error); }
};
ui.stop.onclick = () => {
  if (chat) api(`/api/chats/${chat.id}/abort`, 'POST', {}).catch(showError);
};
// Typing takes over from dictation, which would otherwise overwrite the edit with its next result.
ui.message.oninput = () => { cancelDictation(); resizeComposer(); };
ui.dictate.hidden = !Recognizer;
ui.dictate.onclick = () => {
  if (dictation) { dictation.stop(); return; }
  try { if (Recognizer) startDictation(Recognizer); } catch (error) { showError(error); }
};
ui.messages.addEventListener('scroll', () => {
  following = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 80;
}, {passive: true});
// On touch keyboards Enter inserts a newline; the send button sends.
const touchKeyboard = matchMedia('(pointer: coarse)');
ui.message.onkeydown = event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || touchKeyboard.matches) return;
  event.preventDefault();
  if (!ui.send.disabled) ui.composer.requestSubmit();
};
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

ui.readerClose.onclick = closeSheet;
ui.aboutClose.onclick = closeSheet;
addEventListener('popstate', () => {
  if (sheetInHistory()) return;
  // Back with unsaved notes asks first; staying puts the page back in the history.
  if (aboutEdited() && !confirm('Leave without saving your changes to About us?')) { history.pushState({sheet: true}, ''); return; }
  hideSheet();
});
addEventListener('keydown', event => { if (event.key === 'Escape' && sheet) closeSheet(); });
ui.aboutEntry.replaceChildren(sidebarButton('people', 'About us', openAbout));
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
ui.readerCopy.onclick = async () => {
  try {
    await navigator.clipboard.writeText(readerText);
    ui.readerCopy.textContent = 'Copied';
  } catch { showError('Could not copy; select the text instead'); }
};
// Shared as text, which every share target takes (Messages, Mail, Notes); download gives the .md file.
ui.readerShare.hidden = !navigator.share;
ui.readerShare.onclick = () => {
  navigator.share({title: ui.readerTitle.textContent ?? '', text: readerText}).catch(error => {
    if ((error as DOMException).name !== 'AbortError') showError('Could not share this document');
  });
};

// The access-code form is only for local mode; under Cloudflare Access the user is already signed in.
enter().catch(error => {
  if ((error as Error).message === 'Sign in required') ui.login.hidden = false;
  else showError(error);
});

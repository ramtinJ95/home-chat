import type { ApiError, AssetRef, ChatSnapshot, ChatSummary, Me, Message, Question, StreamEvent, ToolName } from '../src/api.d.ts';

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
  chatList: $('#chat-list'),
  avatar: $('#avatar'),
  identity: $('#identity'),
  logout: $<HTMLButtonElement>('#logout'),
  modeBadge: $('#mode-badge'),
  title: $('#chat-title'),
  providerWarning: $('#provider-warning'),
  messages: $('#messages'),
  question: $('#question'),
  composer: $<HTMLFormElement>('#composer'),
  message: $<HTMLTextAreaElement>('#message'),
  attachments: $('#attachments'),
  imageInput: $<HTMLInputElement>('#image-input'),
  activity: $('#activity'),
  stop: $<HTMLButtonElement>('#stop'),
  send: $<HTMLButtonElement>('#send'),
  error: $('#error'),
};

const TOOL_ACTIVITY: Record<ToolName, string> = {
  ask: 'Asking you a quick question…',
  web_run: 'Searching the web…',
  imagegen: 'Creating an image…',
};
const SUGGESTIONS = [
  {icon: 'compass', title: 'Plan something lovely', prompt: 'Help me plan something lovely for the weekend'},
  {icon: 'spark', title: 'Explain a curiosity', prompt: 'Explain something I’ve always wondered about'},
  {icon: 'brush', title: 'Make a picture', prompt: 'Let’s create an image together'},
];
const MAX_ATTACHMENTS = 4;
const MAX_PICTURE_BYTES = 4 * 1024 * 1024;
// Re-parsing markdown on every delta is wasted work; the final snapshot renders the complete reply.
const STREAM_RENDER_MS = 120;

interface Attachment { id: string; preview: string }

let me: Me | undefined;
let chat: ChatSnapshot | undefined;
let stream: EventSource | undefined;
let attachments: Attachment[] = [];
// The assistant reply currently receiving deltas; re-rendered at most every STREAM_RENDER_MS.
let streaming: {node: HTMLElement; text: string; timer?: number} | undefined;
let activeQuestionId: string | undefined;
let errorTimer: number | undefined;
// Whether the reader is at the bottom of the thread; new content only scrolls the view while they are.
let following = true;

function showError(error: unknown) {
  ui.error.textContent = error instanceof Error ? error.message : String(error);
  ui.error.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => { ui.error.hidden = true; }, 8000);
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
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
const startsBlock = (line: string) => line.startsWith(FENCE) || [HEADING, LIST_ITEM, QUOTE, RULE].some(pattern => pattern.test(line));
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
      for (; i < lines.length && lines[i].trim() && (paragraph.length === 0 || !startsBlock(lines[i])); i++) paragraph.push(lines[i]);
      blocks.push(inline(element('p'), paragraph.join('\n')));
    }
  }
  target.replaceChildren(...blocks);
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
    button.onclick = () => { ui.message.value = prompt; resizeComposer(); ui.message.focus(); };
    suggestions.append(button);
  }
  empty.append(
    icon('leaf', 'leaf'),
    element('h2', undefined, 'What shall we explore?'),
    element('p', undefined, 'A question, a picture, a half-formed idea. This is your space to make sense of things.'),
    suggestions,
  );
  return empty;
}

function renderMessage(snapshot: ChatSnapshot, message: Message, fresh: boolean): HTMLElement {
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
  for (const id of message.assets) {
    const url = `/api/chats/${snapshot.id}/assets/${id}`;
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
  return article;
}

function renderChat(next: ChatSnapshot) {
  const sameChat = chat?.id === next.id;
  const previousCount = sameChat && chat ? chat.messages.length : next.messages.length;
  chat = next;
  ui.title.textContent = next.title;
  setBusy(next.busy);
  streaming = undefined;
  ui.messages.replaceChildren(...(next.messages.length
    ? next.messages.map((message, index) => renderMessage(next, message, index >= previousCount))
    : [renderEmpty()]));
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

async function refreshList(): Promise<ChatSummary[]> {
  // The server lists oldest first; everything here wants newest first.
  const list = (await api<ChatSummary[]>('/api/chats')).reverse();
  ui.chatList.replaceChildren(...list.map(item => {
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
    row.append(open, remove);
    return row;
  }));
  return list;
}

async function deleteChat(item: ChatSummary) {
  if (!confirm(`Delete “${item.title}”? Its messages and pictures will be gone for good.`)) return;
  await api(`/api/chats/${item.id}`, 'DELETE');
  if (item.id === chat?.id) await openLatest(); else await refreshList();
}

async function openChat(id: string) {
  stream?.close();
  dropAttachments(attachments);
  renderChat(await api<ChatSnapshot>(`/api/chats/${id}`));
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
  await refreshList();
}

async function newChat() {
  const created = await api<ChatSnapshot>('/api/chats', 'POST', {});
  setDrawer(false);
  await openChat(created.id);
}

async function openLatest() {
  const list = await refreshList();
  if (list.length) await openChat(list[0].id); else await newChat();
}

async function enter() {
  me = await api<Me>('/api/me');
  ui.login.hidden = true;
  ui.workspace.hidden = false;
  ui.identity.textContent = me.user === 'owner' ? 'Your space' : 'Guest space';
  ui.modeBadge.textContent = me.mode === 'access' ? 'Private' : 'Local only';
  ui.avatar.textContent = me.user === 'owner' ? 'Y' : 'G';
  ui.providerWarning.hidden = me.codexConfigured;
  await openLatest();
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

function readBase64(file: File): Promise<string> {
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
ui.openSidebar.onclick = () => setDrawer(true);
ui.closeSidebar.onclick = () => setDrawer(false);
ui.scrim.onclick = () => setDrawer(false);
ui.logout.onclick = async () => {
  try {
    await api('/api/logout', 'POST', {});
    stream?.close();
    // Under Cloudflare Access the real session is Cloudflare's; end it there.
    if (me?.mode === 'access') location.assign('/cdn-cgi/access/logout'); else location.reload();
  } catch (error) { showError(error); }
};
ui.composer.onsubmit = async event => {
  event.preventDefault();
  if (!chat) return;
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
ui.stop.onclick = () => {
  if (chat) api(`/api/chats/${chat.id}/abort`, 'POST', {}).catch(showError);
};
ui.message.oninput = resizeComposer;
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
    if (file.size > MAX_PICTURE_BYTES) throw new Error('Pictures must be 4 MB or smaller');
    const data = await readBase64(file);
    const asset = await api<AssetRef>(`/api/chats/${chat.id}/uploads`, 'POST', {mimeType: file.type, data});
    attachments.push({id: asset.id, preview: URL.createObjectURL(file)});
    renderAttachments();
  } catch (error) { showError(error); }
};

// The access-code form is only for local mode; under Cloudflare Access the user is already signed in.
enter().catch(error => {
  if ((error as Error).message === 'Sign in required') ui.login.hidden = false;
  else showError(error);
});

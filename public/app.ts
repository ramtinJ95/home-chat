import type { ApiError, ChatSnapshot, ChatSummary, Me, Message, Question, StreamEvent } from '../src/api.d.ts';

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

const TOOL_ACTIVITY: Record<string, string> = {
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

interface Attachment { id: string; preview: string }

let me: Me | undefined;
let chat: ChatSnapshot | undefined;
let stream: EventSource | undefined;
let attachments: Attachment[] = [];
// The assistant reply currently receiving deltas; re-rendered at most once per frame.
let streaming: {node: HTMLElement; text: string; frame?: number} | undefined;
let activeQuestionId: string | undefined;
let errorTimer: number | undefined;

function showError(error: unknown) {
  ui.error.textContent = error instanceof Error ? error.message : String(error);
  ui.error.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => { ui.error.hidden = true; }, 8000);
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : {'Content-Type': 'application/json', 'X-CSRF-Token': me?.csrf ?? ''},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error((result as ApiError).error ?? 'Request failed');
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
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const BLOCK_START = /^(?:```|#{1,4}\s|>\s?|\s*(?:[-*+]|\d+[.)])\s+|(?:-{3,}|\*{3,})\s*$)/;
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\s][^*\n]*?)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function renderMarkdown(target: HTMLElement, source: string) {
  const blocks: HTMLElement[] = [];
  const lines = source.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      i++;
      const pre = element('pre');
      pre.append(element('code', undefined, code.join('\n')));
      blocks.push(pre);
    } else if (/^#{1,4}\s/.test(line)) {
      const [, hashes, text] = line.match(/^(#{1,4})\s+(.*)$/) ?? ['', '#', line];
      blocks.push(inline(element(hashes.length <= 2 ? 'h3' : 'h4'), text));
      i++;
    } else if (LIST_ITEM.test(line)) {
      const list = element(/^\s*\d/.test(line) ? 'ol' : 'ul');
      for (; i < lines.length && LIST_ITEM.test(lines[i]); i++) list.append(inline(element('li'), lines[i].replace(LIST_ITEM, '')));
      blocks.push(list);
    } else if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) quoted.push(lines[i].replace(/^>\s?/, ''));
      blocks.push(inline(element('blockquote'), quoted.join('\n')));
    } else if (/^(?:-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(element('hr'));
      i++;
    } else if (!line.trim()) {
      i++;
    } else {
      const paragraph: string[] = [];
      for (; i < lines.length && lines[i].trim() && (paragraph.length === 0 || !BLOCK_START.test(lines[i])); i++) paragraph.push(lines[i]);
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

function link(href: string, label?: string): HTMLAnchorElement {
  const anchor = element('a', undefined, label ?? href);
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  // Labelled links still show where they go.
  if (label && label !== href) anchor.append(element('span', 'host', new URL(href).hostname));
  return anchor;
}

function setBusy(busy: boolean) {
  ui.send.disabled = busy;
  ui.send.hidden = busy;
  ui.stop.hidden = !busy;
  ui.messages.classList.toggle('busy', busy);
  ui.activity.textContent = busy ? 'Thinking…' : '';
}

function scrollToEnd() { ui.messages.scrollTop = ui.messages.scrollHeight; }

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
  const previousCount = chat?.id === next.id ? chat.messages.length : next.messages.length;
  chat = next;
  ui.title.textContent = next.title;
  setBusy(next.busy);
  streaming = undefined;
  ui.messages.replaceChildren(...(next.messages.length
    ? next.messages.map((message, index) => renderMessage(next, message, index >= previousCount))
    : [renderEmpty()]));
  scrollToEnd();
  showQuestion(next.question);
}

function appendDelta(text: string) {
  const target = streaming;
  if (!target) return;
  target.text += text;
  target.frame ??= requestAnimationFrame(() => {
    target.frame = undefined;
    renderMarkdown(target.node, target.text);
    scrollToEnd();
  });
}

function setDrawer(open: boolean) {
  ui.workspace.classList.toggle('drawer-open', open);
  ui.scrim.hidden = !open;
}

async function refreshList(): Promise<ChatSummary[]> {
  const list = await api<ChatSummary[]>('/api/chats');
  ui.chatList.replaceChildren(...[...list].reverse().map(item => {
    const button = element('button', item.id === chat?.id ? 'active' : '', item.title);
    button.type = 'button';
    button.onclick = () => { setDrawer(false); openChat(item.id).catch(showError); };
    return button;
  }));
  return list;
}

async function openChat(id: string) {
  stream?.close();
  clearAttachments();
  renderChat(await api<ChatSnapshot>(`/api/chats/${id}`));
  stream = new EventSource(`/api/chats/${id}/events`);
  stream.onmessage = message => {
    const event = JSON.parse(message.data) as StreamEvent;
    switch (event.type) {
      case 'snapshot': renderChat(event.chat); refreshList().catch(showError); break;
      case 'delta': appendDelta(event.text); break;
      case 'tool': ui.activity.textContent = TOOL_ACTIVITY[event.name] ?? 'Working…'; break;
      case 'question': showQuestion(event.question); break;
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

async function enter() {
  me = await api<Me>('/api/me');
  ui.login.hidden = true;
  ui.workspace.hidden = false;
  ui.identity.textContent = me.user === 'owner' ? 'Your space' : 'Guest space';
  ui.avatar.textContent = me.user === 'owner' ? 'Y' : 'G';
  ui.providerWarning.hidden = me.codexConfigured;
  const list = await refreshList();
  if (list.length) await openChat(list[0].id); else await newChat();
}

function clearAttachments() {
  for (const attachment of attachments) URL.revokeObjectURL(attachment.preview);
  attachments = [];
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
    button.onclick = () => {
      URL.revokeObjectURL(attachment.preview);
      attachments = attachments.filter(item => item !== attachment);
      renderAttachments();
    };
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
    location.reload();
  } catch (error) { showError(error); }
};
ui.composer.onsubmit = async event => {
  event.preventDefault();
  if (!chat) return;
  try {
    setBusy(true);
    await api(`/api/chats/${chat.id}/messages`, 'POST', {text: ui.message.value, assets: attachments.map(item => item.id)});
    ui.message.value = '';
    resizeComposer();
    clearAttachments();
  } catch (error) { setBusy(false); showError(error); }
};
ui.stop.onclick = () => {
  if (chat) api(`/api/chats/${chat.id}/abort`, 'POST', {}).catch(showError);
};
ui.message.oninput = resizeComposer;
ui.message.onkeydown = event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
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
    const asset = await api<{id: string}>(`/api/chats/${chat.id}/uploads`, 'POST', {mimeType: file.type, data});
    attachments.push({id: asset.id, preview: URL.createObjectURL(file)});
    renderAttachments();
  } catch (error) { showError(error); }
};

enter().catch(error => { if ((error as Error).message !== 'Sign in required') showError(error); });

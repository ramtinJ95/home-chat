const $ = selector => document.querySelector(selector);
let me, chat, stream;
let attachments = [];
let renderedMessage;
let activeQuestionId;

function showError(error) {
  $('#error').textContent = error.message ?? String(error); $('#error').hidden = false;
  clearTimeout(showError.timer); showError.timer = setTimeout(() => { $('#error').hidden = true; }, 8000);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {method, credentials: 'same-origin', headers: {
    ...(method !== 'GET' ? {'Content-Type': 'application/json', 'X-CSRF-Token': me?.csrf ?? ''} : {}),
  }, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Request failed');
  return result;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function busy(value) {
  $('#send').disabled = value; $('#stop').hidden = !value;
  $('#message').disabled = value;
  $('#activity').textContent = value ? 'Thinking…' : '';
}
function renderChat(next) {
  chat = next; $('#chat-title').textContent = chat.title; busy(chat.busy);
  const root = $('#messages'); root.replaceChildren(); renderedMessage = null;
  if (!chat.messages.length) {
    const empty = element('div', undefined, 'empty');
    empty.append(element('h2', 'What shall we explore?'), element('p', 'A question, a picture, a half-formed idea. This is your space to make sense of things.'));
    const suggestions = element('div', undefined, 'suggestions');
    for (const text of ['Help me plan something lovely for the weekend', 'Explain something I’ve always wondered about', 'Let’s create an image together']) {
      const button = element('button', text); button.onclick = () => { $('#message').value = text; $('#message').focus(); }; suggestions.append(button);
    }
    empty.append(suggestions); root.append(empty);
  }
  for (const message of chat.messages) {
    const article = element('article', undefined, 'message ' + message.role);
    article.append(element('span', message.role === 'user' ? 'YOU' : 'HOME CHAT', 'role'));
    const text = element('div', message.text); article.append(text);
    if (message.role === 'assistant') renderedMessage = text;
    for (const id of message.assets) {
      const url = `/api/chats/${chat.id}/assets/${id}`;
      const picture = element('img'); picture.src = url; picture.alt = message.role === 'user' ? 'Your attached picture' : 'Generated picture'; picture.loading = 'lazy'; article.append(picture);
      const download = element('a', 'Download picture', 'download'); download.href = url + '?download=1'; download.download = 'home-chat.png'; article.append(download);
    }
    if (message.error) article.append(element('p', message.error, 'failure'));
    root.append(article);
  }
  root.scrollTop = root.scrollHeight;
  showQuestion(chat.question);
}
async function refreshList() {
  const list = await api('/api/chats');
  $('#chat-list').replaceChildren();
  for (const item of list.reverse()) {
    const button = element('button', item.title, item.id === chat?.id ? 'active' : '');
    button.onclick = () => openChat(item.id).catch(showError); $('#chat-list').append(button);
  }
  return list;
}
async function openChat(id) {
  stream?.close(); attachments = []; renderAttachments();
  renderChat(await api(`/api/chats/${id}`));
  stream = new EventSource(`/api/chats/${id}/events`);
  stream.onmessage = event => {
    const value = JSON.parse(event.data);
    if (value.type === 'snapshot') { renderChat(value.chat); refreshList().catch(showError); }
    if (value.type === 'delta' && renderedMessage) {
      renderedMessage.textContent += value.text; $('#messages').scrollTop = $('#messages').scrollHeight;
    }
    if (value.type === 'tool') $('#activity').textContent = {ask: 'A quick question…', web_run: 'Searching the web…', imagegen: 'Creating an image…'}[value.name];
    if (value.type === 'question') showQuestion(value.question);
    if (value.type === 'error') { showError(value.message); busy(false); }
  };
  stream.onerror = () => { $('#activity').textContent = 'Connection interrupted; reconnecting…'; };
  await refreshList();
}
async function newChat() { const created = await api('/api/chats', 'POST', {}); await openChat(created.id); }
async function enter() {
  me = await api('/api/me');
  $('#login').hidden = true; $('#workspace').hidden = false;
  $('#identity').textContent = me.user === 'owner' ? 'Your space' : 'Guest space';
  $('#provider-warning').hidden = me.codexConfigured;
  const list = await refreshList();
  if (list.length) await openChat(list[0].id); else await newChat();
}
function renderAttachments() {
  $('#attachments').replaceChildren();
  attachments.forEach((asset, index) => {
    const button = element('button', `Picture ${index + 1} ×`);
    button.onclick = () => { attachments = attachments.filter(item => item.id !== asset.id); renderAttachments(); };
    $('#attachments').append(button);
  });
}
function showQuestion(question) {
  activeQuestionId = question?.id;
  const root = $('#question'); root.replaceChildren(); root.hidden = !question;
  if (!question) return;
  root.append(element('h3', question.title));
  if (question.message) root.append(element('p', question.message));
  const respond = async (value, cancelled = false) => {
    try {
      await api(`/api/chats/${chat.id}/answer`, 'POST', {id: question.id, value, cancelled});
      // A follow-up dialog can arrive on SSE before the POST response completes.
      if (activeQuestionId === question.id) { root.hidden = true; activeQuestionId = undefined; }
    }
    catch (error) { showError(error); }
  };
  if (question.method === 'select') {
    for (const option of question.options) { const button = element('button', option); button.onclick = () => respond(option); root.append(button); }
  } else if (question.method === 'confirm') {
    for (const value of [true, false]) { const button = element('button', value ? 'Yes' : 'No'); button.onclick = () => respond(value); root.append(button); }
  } else {
    const input = element('textarea'); input.value = question.prefill; input.maxLength = 8000; input.setAttribute('aria-label', question.title);
    const submit = element('button', 'Reply'); submit.onclick = () => respond(input.value); root.append(input, submit);
  }
  const cancel = element('button', 'Skip', 'quiet'); cancel.onclick = () => respond('', true); root.append(cancel);
}
$('#login-form').onsubmit = async event => {
  event.preventDefault();
  try { await api('/api/login', 'POST', {code: $('#access-code').value}); $('#access-code').value = ''; await enter(); }
  catch (error) { showError(error); }
};
$('#new-chat').onclick = () => newChat().catch(showError);
$('#logout').onclick = async () => { try { await api('/api/logout', 'POST', {}); stream?.close(); location.reload(); } catch (error) { showError(error); } };
$('#composer').onsubmit = async event => {
  event.preventDefault();
  try {
    const text = $('#message').value;
    busy(true);
    await api(`/api/chats/${chat.id}/messages`, 'POST', {text, assets: attachments.map(item => item.id)});
    $('#message').value = ''; attachments = []; renderAttachments();
  } catch (error) { busy(false); showError(error); }
};
$('#stop').onclick = () => api(`/api/chats/${chat.id}/abort`, 'POST', {}).catch(showError);
$('#message').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('#send').disabled) $('#composer').requestSubmit(); } };
$('#image-input').onchange = async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file) return;
  try {
    if (attachments.length >= 4) throw new Error('Attach up to four pictures per message');
    if (file.size > 4 * 1024 * 1024) throw new Error('Pictures must be 4 MB or smaller');
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
    const asset = await api(`/api/chats/${chat.id}/uploads`, 'POST', {mimeType: file.type, data}); attachments.push(asset); renderAttachments();
  } catch (error) { showError(error); }
};
enter().catch(error => { if (error.message !== 'Sign in required') showError(error); });

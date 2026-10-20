import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type AssistantMessage, type Message, type SystemMessage } from '@earendil-works/pi-ai';
import type { Question } from '../src/api.d.ts';
import { createAgent } from '../src/agent/agent.ts';
import type { DurableWorker } from '../src/agent/worker.ts';
import { ALLOWED_TOOLS, type ServerCall, type TurnMode } from '../src/policy.ts';
import { until, withEnv } from './helpers.ts';

type Reply = AssistantMessage | ((messages: Message[]) => AssistantMessage);

// An agent on faux models in a fresh data directory, or in `data`. `replies` answer the model requests in order; `call`
// stands in for the server's routines and household notes. It closes when the test ends, and then removes a fresh directory.
async function fixture(t: TestContext, call: ServerCall = async () => '', data?: string, tokensPerSecond?: number) {
  const root = data ?? await mkdtemp(join(tmpdir(), 'home-chat-agent-'));
  const faux = fauxProvider({provider: 'faux', models: [{id: 'faux-1', input: ['text', 'image']}], tokensPerSecond});
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = createAgent({models, model: {provider: 'faux', modelId: 'faux-1'},
    instructions: 'You are Home Chat (test instructions).', maxRetries: 0, onReport: () => {}});
  const requests: Message[][] = [];
  const reply = (replies: Reply[]) => faux.setResponses(replies.map(item => (context: {messages: Message[]}) => {
    requests.push(context.messages);
    return typeof item === 'function' ? item(context.messages) : item;
  }));
  const workers: DurableWorker[] = [];
  const worker = async (chat = 'chat-1') => {
    const directory = join(root, 'chats', chat);
    await mkdir(directory, {recursive: true});
    const started = agent.worker(directory, call);
    workers.push(started);
    await started.start();
    return started;
  };
  // As the server stops: every worker, then the files. Only once, however often it is asked.
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { await Promise.all(workers.map(each => each.stop())); await agent.close(); })();
  t.after(async () => { await close().catch(() => {}); if (!data) await rm(root, {recursive: true, force: true}); });
  return {root, agent, reply, requests, worker, close};
}

// Sends `text` and resolves with the streamed reply once the turn settles, or rejects with its failure.
async function turn(worker: DurableWorker, text: string, mode?: TurnMode, answer?: (question: Question) => unknown) {
  let streamed = '';
  const onDelta = (delta: string) => { streamed += delta; };
  const onQuestion = (question: Question) => { setImmediate(() => worker.answer(question.id, answer!(question))); };
  worker.on('delta', onDelta);
  if (answer) worker.on('question', onQuestion);
  const ended = Promise.race([once(worker, 'settled').then(() => streamed), once(worker, 'failure').then(([message]) => { throw new Error(message); })]);
  try { await worker.prompt(text, [], mode); return await ended; }
  finally { worker.off('delta', onDelta); worker.off('question', onQuestion); }
}

const toolResults = (messages: Message[]) => messages.flatMap(message => message.role === 'toolResult'
  ? [message.content.map(block => block.type === 'text' ? block.text : '').join('')] : []);
const userTexts = (messages: Message[]) => messages.flatMap(message => message.role !== 'user' ? []
  : [typeof message.content === 'string' ? message.content : message.content.map(block => block.type === 'text' ? block.text : '').join('')]);
const system = (messages: Message[]) => messages.filter((message): message is SystemMessage => message.role === 'system');

test('a reply streams as deltas, and the model gets the instructions, the household notes and only the chat tools', async t => {
  // Slow enough that the reply is committed in several partials, the first of them already holding text.
  const f = await fixture(t, async (path, body) => path === '/memory' && body === undefined ? 'Notes about the person: vegetarian\n' : '', undefined, 60);
  const worker = await f.worker();
  f.reply([fauxAssistantMessage('Hello there, this is a longer reply so it streams in pieces.')]);
  const tools: string[] = [];
  worker.on('tool', name => tools.push(name));
  let deltas = 0;
  worker.on('delta', () => deltas++);
  assert.equal(await turn(worker, 'Hi'), 'Hello there, this is a longer reply so it streams in pieces.');
  assert.ok(deltas > 1);
  const [request] = f.requests;
  const prompt = system(request!).map(message => JSON.stringify(message.content) + JSON.stringify(message.sections ?? {})).join('\n');
  assert.match(prompt, /test instructions/);
  assert.match(prompt, /vegetarian/);
  const offered = system(request!).flatMap(message => message.toolsAdded ?? []).map(tool => tool.name).sort();
  assert.deepEqual(offered, [...ALLOWED_TOOLS].sort());
  assert.deepEqual(userTexts(request!), ['Message from the user:\nHi']);
  assert.deepEqual(tools, []);
});

test('ask shows the app its questions and gives the model the answers', async t => {
  const f = await fixture(t);
  const worker = await f.worker();
  f.reply([
    fauxAssistantMessage([fauxToolCall('ask', {prompts: [{title: 'Tea or coffee?', choices: [{label: 'Tea'}, {label: 'Coffee'}]}]})], {stopReason: 'toolUse'}),
    fauxAssistantMessage('Tea it is.'),
  ]);
  const asked: Question[] = [];
  const tools: string[] = [];
  worker.on('tool', name => tools.push(name));
  await turn(worker, 'Make me a drink', {}, question => {
    asked.push(question);
    return question.method === 'select' ? 'Tea' : 'No milk';
  });
  assert.deepEqual(asked.map(({method, title, options}) => ({method, title, options})), [
    {method: 'select', title: 'Tea or coffee?', options: ['Tea', 'Coffee', 'Other/rephrase']},
    {method: 'input', title: 'Tea or coffee? — comment', options: []},
  ]);
  assert.deepEqual(toolResults(f.requests[1]!), ['Tea or coffee?: Tea\n  Comment: No milk']);
  assert.deepEqual(tools, ['ask']);
  assert.equal(worker.question, null);
});

test('ask keeps Other/rephrase and Finish selection on screen: more choices than fit go back to the model', async t => {
  const f = await fixture(t);
  const worker = await f.worker();
  const choices = (count: number) => Array.from({length: count}, (_, index) => ({label: `Choice ${index + 1}`}));
  const pick = (count: number) => fauxToolCall('ask', {prompts: [{title: 'Pick', multiple: true, choices: choices(count)}]});
  f.reply([
    fauxAssistantMessage([pick(19)], {stopReason: 'toolUse'}),
    fauxAssistantMessage([pick(18)], {stopReason: 'toolUse'}),
    fauxAssistantMessage('Done.'),
  ]);
  const asked: Question[] = [];
  await turn(worker, 'Help me choose', {}, question => {
    asked.push(question);
    return question.method === 'input' ? '' : question.options.includes('Choice 1') ? 'Choice 1' : 'Finish selection';
  });
  assert.deepEqual(asked[0]!.options, [...choices(18).map(choice => choice.label), 'Other/rephrase', 'Finish selection']);
  assert.match(toolResults(f.requests[1]!)[0]!, /prompts\.0\.choices/);
  assert.equal(toolResults(f.requests[2]!).at(-1), 'Pick: Choice 1');
});

test('a routine run cannot ask, deep research needs its mode, and a message has a tool-call limit', async t => {
  const f = await fixture(t);
  const worker = await f.worker();
  f.reply([
    fauxAssistantMessage([fauxToolCall('ask', {prompts: [{title: 'Which city?'}]}), fauxToolCall('deep_research', {query: 'x'})], {stopReason: 'toolUse'}),
    fauxAssistantMessage('Done.'),
  ]);
  await turn(worker, 'Morning briefing', {routineRun: 'Friday 17 October, 07:30'});
  const [ask, research] = toolResults(f.requests[1]!);
  assert.match(ask!, /Nobody is watching this routine run/);
  assert.match(research!, /Deep research is off/);
  assert.match(userTexts(f.requests[0]!)[0]!, /scheduled routine run/);

  const save = (index: number) => fauxToolCall('document', {title: `Note ${index}`, markdown: 'Text'});
  f.reply([fauxAssistantMessage(Array.from({length: 13}, (_, index) => save(index)), {stopReason: 'toolUse'}), fauxAssistantMessage('Saved.')]);
  await turn(worker, 'Save thirteen notes');
  const results = toolResults(f.requests.at(-1)!);
  assert.equal(results.filter(text => text.startsWith('Saved “')).length, 12);
  assert.equal(results.filter(text => text.includes('Tool-call limit reached')).length, 1);
  assert.equal((await readdir(join(f.root, 'chats/chat-1/work/documents'))).length, 12);
});

test('memory saves only after the user confirms, through the server', async t => {
  // The server checks a change first, then makes it; it has no note "Never said" to forget.
  const calls: unknown[] = [];
  const f = await fixture(t, async (path, body) => {
    if (path !== '/memory' || body === undefined) return '';
    calls.push(body);
    const {check, text} = body as {check?: boolean; text: string};
    if (check && text === 'Never said') throw new Error('There is no such note; copy it exactly as written');
    return check ? 'OK' : 'Saved under About us.';
  });
  const worker = await f.worker();
  const vegetarian = {action: 'remember', text: 'Vegetarian'};
  const suggest = (change = vegetarian) =>
    f.reply([fauxAssistantMessage([fauxToolCall('memory', change)], {stopReason: 'toolUse'}), fauxAssistantMessage('Noted.')]);
  const asked: Question[] = [];
  // A change that cannot be made fails before the user is asked.
  suggest({action: 'forget', text: 'Never said'});
  await turn(worker, 'Forget what I never said', {}, question => { asked.push(question); return true; });
  assert.match(toolResults(f.requests.at(-1)!).at(-1)!, /no such note/);
  assert.equal(asked.length, 0);
  assert.deepEqual(calls.splice(0), [{action: 'forget', text: 'Never said', check: true}]);
  suggest();
  await turn(worker, 'I am vegetarian', {}, question => { asked.push(question); return false; });
  assert.match(toolResults(f.requests.at(-1)!).at(-1)!, /said no, so nothing changed/);
  assert.deepEqual(calls.splice(0), [{...vegetarian, check: true}]);
  suggest();
  await turn(worker, 'Really, I am vegetarian', {}, question => { asked.push(question); return true; });
  assert.deepEqual(asked.map(({method, title}) => [method, title]), [['confirm', 'Remember this about you?'], ['confirm', 'Remember this about you?']]);
  assert.equal(toolResults(f.requests.at(-1)!).at(-1), 'Saved under About us.');
  assert.deepEqual(calls, [{...vegetarian, check: true}, vegetarian]);
});

test('regenerate forks before the last message, and the fork is what continues after a restart', async t => {
  const f = await fixture(t);
  let worker = await f.worker();
  f.reply([fauxAssistantMessage('One.'), fauxAssistantMessage('Two.')]);
  await turn(worker, 'first');
  await turn(worker, 'second');
  assert.equal(await worker.rewind('something else'), false);
  assert.equal(await worker.rewind('second'), true);
  await f.close();

  const g = await fixture(t, undefined, f.root);
  worker = await g.worker();
  g.reply([fauxAssistantMessage('Second, again.')]);
  await turn(worker, 'second, edited');
  assert.deepEqual(userTexts(g.requests[0]!), ['Message from the user:\nfirst', 'Message from the user:\nsecond, edited']);
  // Going back over the only message leaves an empty conversation.
  assert.equal(await worker.rewind('second, edited'), true);
  assert.equal(await worker.rewind('first'), true);
  g.reply([fauxAssistantMessage('Fresh.')]);
  await turn(worker, 'again');
  assert.deepEqual(userTexts(g.requests[1]!), ['Message from the user:\nagain']);
  // Closed here, before f's teardown removes the files under it.
  await g.close();
});

test('a conversation from before the agent starts from its earlier text', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'chats/old'), {recursive: true});
  await writeFile(join(f.root, 'chats/old/chat.json'), JSON.stringify({messages: [
    {role: 'user', text: 'Plan a trip to Gothenburg', assets: []},
    {role: 'assistant', text: 'Here is a plan.', assets: []},
    {role: 'assistant', text: 'Cut off', assets: [], error: 'Home Chat restarted before this reply finished'},
  ]}));
  const worker = await f.worker('old');
  f.reply([fauxAssistantMessage('Sure.')]);
  await turn(worker, 'Add a museum');
  const [earlier, now] = userTexts(f.requests[0]!);
  assert.match(earlier!, /^The conversation so far/);
  assert.match(earlier!, /User: Plan a trip to Gothenburg\n\nHome Chat: Here is a plan\./);
  assert.doesNotMatch(earlier!, /Cut off/);
  assert.equal(now, 'Message from the user:\nAdd a museum');
});

test('a stopped reply settles, a provider failure fails the turn, and a stopped worker hands over cleanly', async t => {
  const f = await fixture(t);
  const worker = await f.worker();
  f.reply([fauxAssistantMessage([fauxToolCall('ask', {prompts: [{title: 'Wait here'}]})], {stopReason: 'toolUse'})]);
  worker.once('question', () => { void worker.abort(); });
  await turn(worker, 'Ask me something');
  assert.equal(worker.question, null);

  f.reply([fauxAssistantMessage('', {stopReason: 'error', errorMessage: 'Too Many Requests\n429'})]);
  await assert.rejects(() => turn(worker, 'Hello'), /usage limit reached/);

  f.reply([fauxAssistantMessage([fauxToolCall('ask', {prompts: [{title: 'Still there?'}]})], {stopReason: 'toolUse'})]);
  const failed = once(worker, 'failure');
  worker.once('question', () => worker.stop());
  await worker.prompt('Ask again');
  assert.deepEqual(await failed, ['The reply was stopped before it finished']);
  const next = await f.worker();
  f.reply([fauxAssistantMessage('Back.')]);
  assert.equal(await turn(next, 'Hello again'), 'Back.');
});

test('a reply stopped from a delta, as the response size limit does, sends no text after it fails', async t => {
  const f = await fixture(t);
  const worker = await f.worker();
  f.reply([fauxAssistantMessage([fauxText('First block.'), fauxText('Second block.')])]);
  const events: string[] = [];
  worker.on('delta', text => { events.push(`delta ${text}`); void worker.stop('Response size limit reached'); });
  worker.on('failure', message => events.push(`failure ${message}`));
  await worker.prompt('Write a lot');
  await until(() => events.some(event => event.startsWith('failure')), 'the turn failed');
  assert.deepEqual(events, ['delta First block.', 'failure Response size limit reached']);
});

test('each conversation has its own file, and removing its directory after stop removes its transcript', async t => {
  const f = await fixture(t);
  const [one, two] = [await f.worker('one'), await f.worker('two')];
  f.reply([fauxAssistantMessage('First.'), fauxAssistantMessage('Second.')]);
  await turn(one, 'secret plans');
  await turn(two, 'something else');
  // Both files start their conversation ids from the same number; each keeps to its own.
  assert.deepEqual(userTexts(f.requests[1]!), ['Message from the user:\nsomething else']);
  assert.ok((await readdir(join(f.root, 'chats/one'))).includes('agent.sqlite'));

  await one.stop();
  await rm(join(f.root, 'chats/one'), {recursive: true});
  const again = await f.worker('one');
  f.reply([fauxAssistantMessage('New.')]);
  await turn(again, 'hello');
  assert.deepEqual(userTexts(f.requests[2]!), ['Message from the user:\nhello']);
});

test('after a crash, the interrupted turn is stopped and the next message works', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-agent.ts'), f.root], {stdio: 'ignore'});
  const [, signal] = await once(child, 'exit');
  assert.equal(signal, 'SIGKILL');
  const worker = await f.worker();
  f.reply([fauxAssistantMessage('Yes, I am here.')]);
  assert.equal(await turn(worker, 'Hello?'), 'Yes, I am here.');
  // The question was never answered; the model sees it interrupted, and only one model request was made here.
  assert.equal(f.requests.length, 1);
  assert.deepEqual(userTexts(f.requests[0]!), ['Message from the user:\nAsk me something', 'Message from the user:\nHello?']);
});

test('tool input is checked before it runs: no private web hosts, no images from outside the conversation', async t => {
  const f = await fixture(t);
  const worker = await f.worker();
  await writeFile(join(f.root, 'chats/chat-1/outside.png'), 'not really a png');
  f.reply([
    fauxAssistantMessage([
      fauxToolCall('web_run', {open: [{ref_id: 'http://192.168.1.10/admin'}]}),
      fauxToolCall('web_run', {open: [{ref_id: 'http://printer.local/'}]}),
      fauxToolCall('imagegen', {prompt: 'Make it blue', referenced_image_paths: ['../outside.png']}),
    ], {stopReason: 'toolUse'}),
    fauxAssistantMessage('I cannot do that.'),
  ]);
  await turn(worker, 'Look at my router');
  assert.deepEqual(toolResults(f.requests[1]!).map(result => result.match(/Private web destination denied|Image must belong to this conversation/)?.[0]),
    ['Private web destination denied', 'Private web destination denied', 'Image must belong to this conversation']);
});

test('an uploaded image reaches the model with its message', async t => {
  const f = await fixture(t);
  const worker = await f.worker();
  f.reply([fauxAssistantMessage('A cat.')]);
  const data = Buffer.from('fake png bytes').toString('base64');
  const ended = once(worker, 'settled');
  await worker.prompt('What is this?', [{type: 'image', mimeType: 'image/png', data}]);
  await ended;
  const user = f.requests[0]!.find(message => message.role === 'user')!;
  assert.ok(Array.isArray(user.content));
  assert.deepEqual(user.content.filter(block => block.type === 'image'), [{type: 'image', mimeType: 'image/png', data}]);
});

test('deep research calls Exa in its mode and gives the model the grounded result', async t => {
  const f = await fixture(t);
  const {fetch: realFetch} = globalThis;
  const sent: {url: string; body: Record<string, unknown>; key: string | null; signal: boolean}[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://api.exa.ai/')) return realFetch(input, init);
    sent.push({url, body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('x-api-key'), signal: init?.signal instanceof AbortSignal});
    return Response.json({requestId: 'req-1', results: [{title: 'Heat pumps', url: 'https://example.org/heat', highlights: ['Efficient in cold climates']}],
      output: {content: 'Heat pumps work well in Sweden.', grounding: [{field: 'content', confidence: 'high', citations: [{url: 'https://example.org/heat', title: 'Heat pumps'}]}]}});
  });
  await withEnv({EXA_API_KEY: 'exa-test-key'}, async () => {
    const worker = await f.worker();
    f.reply([fauxAssistantMessage([fauxToolCall('deep_research', {query: 'Heat pumps in Sweden'})], {stopReason: 'toolUse'}), fauxAssistantMessage('Summary.')]);
    await turn(worker, 'Research heat pumps', {deepResearch: true});
    assert.deepEqual(sent.map(({url, body, key, signal}) => ({url, query: body.query, type: body.type, key, signal})),
      [{url: 'https://api.exa.ai/search', query: 'Heat pumps in Sweden', type: 'deep', key: 'exa-test-key', signal: true}]);
    const result = JSON.parse(toolResults(f.requests[1]!)[0]!);
    assert.equal(result.synthesizedOutput, 'Heat pumps work well in Sweden.');
    assert.equal(result.sources[0].url, 'https://example.org/heat');
  });
});

test('todo goes to the server, also in a routine run', async t => {
  const calls: [string, unknown][] = [];
  const f = await fixture(t, async (path, body) => { if (body !== undefined) calls.push([path, body]); return body === undefined ? '' : 'Added to “Groceries”.'; });
  const worker = await f.worker();
  f.reply([fauxAssistantMessage([fauxToolCall('todo', {action: 'add', list: 'Groceries', items: ['Milk']})], {stopReason: 'toolUse'}), fauxAssistantMessage('Added.')]);
  const tools: string[] = [];
  worker.on('tool', name => tools.push(name));
  await turn(worker, 'Weekly shopping', {routineRun: 'Sunday 19 October, 09:00'});
  assert.deepEqual(calls, [['/todo', {action: 'add', list: 'Groceries', items: ['Milk']}]]);
  assert.deepEqual(toolResults(f.requests[1]!), ['Added to “Groceries”.']);
  assert.deepEqual(tools, ['todo']);
});

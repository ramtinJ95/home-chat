import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../src/api.d.ts';
import { MAX_RESULTS, searchChats } from '../src/search.ts';

const said = (role: Message['role'], text: string): Message => ({role, text, assets: []});
const one = (text: string) => [{id: 'a', title: 'x', messages: [said('user', text)]}];
const shown = (result: {snippet: string; marks: [number, number][]}) => result.marks.map(([start, end]) => result.snippet.slice(start, end));

test('search finds every word in a message, ignoring case, accents and Markdown, newest conversations first', async () => {
  const chats = [
    {id: 'new', title: 'Weekend', messages: [said('user', 'Any café near Södermalm?'), said('assistant', 'Try **Café Pascal** on [Södermalm](https://example.com/sodermalm).')]},
    {id: 'old', title: 'Recipes', messages: [said('user', 'A vegetarian lasagne, please'), said('assistant', '')]},
  ];
  const results = await searchChats(chats, 'CAFE sodermalm');
  assert.deepEqual(results.map(result => [result.chat, result.message]), [['new', 1], ['new', 0]]);
  assert.equal(results[0].snippet, 'Try Café Pascal on Södermalm.');
  assert.deepEqual(shown(results[0]), ['Café', 'Södermalm']);
  // Link targets are not text, and every word must be there, however many there are.
  assert.deepEqual(await searchChats(chats, 'example'), []);
  assert.deepEqual(await searchChats(one(`[a link](https://example.com/${'x'.repeat(2000)}) and [not a link](has space) done`), 'example'), []);
  assert.deepEqual(shown((await searchChats(one('[not a link](has space) done'), 'space'))[0]), ['space']);
  assert.deepEqual(await searchChats(chats, 'cafe lasagne'), []);
  assert.deepEqual(await searchChats(one('one two three four five six seven eight'), 'one two three four five six seven eight absent'), []);
  // A title alone still finds its conversation.
  assert.deepEqual(await searchChats(chats, 'recipes'), [{chat: 'old', title: 'Recipes', message: null, snippet: '', marks: []}]);
  assert.deepEqual(await searchChats(chats, '   '), []);
});

test('snippets and highlights hold up with Greek, ligatures and emoji', async () => {
  // Final sigma: lower-cased as a whole word it is ς, one letter at a time σ.
  assert.deepEqual(shown((await searchChats(one('ΟΣ'), 'ος'))[0]), ['ΟΣ']);
  // Part of a ligature marks the whole ligature.
  assert.deepEqual(shown((await searchChats(one('The ﬃ ligature'), 'ff'))[0]), ['ﬃ']);
  const [cut] = await searchChats(one('needle' + 'a'.repeat(153) + '😀' + 'a'.repeat(10)), 'needle');
  assert.ok(cut.snippet.isWellFormed(), cut.snippet);
  assert.deepEqual(shown(cut), ['needle']);
});

test('long messages give a snippet around the match, cut at spaces, and results are capped', async () => {
  const long = 'word '.repeat(60) + 'the needle is here ' + 'tail '.repeat(60);
  const [result] = await searchChats([{id: 'a', title: 'Long', messages: [said('assistant', long)]}], 'needle');
  assert.ok(result.snippet.startsWith('…word') && result.snippet.endsWith('tail…'), result.snippet);
  assert.ok(result.snippet.length <= 165);
  assert.deepEqual(shown(result), ['needle']);
  // Overlapping words highlight once.
  assert.deepEqual(shown((await searchChats(one('banana'), 'nan ana'))[0]), ['anana']);
  const many = Array.from({length: 20}, (_, i) => ({id: `c${i}`, title: 'x', messages: Array.from({length: 10}, () => said('user', 'tea time'))}));
  const capped = await searchChats(many, 'tea');
  assert.equal(capped.length, MAX_RESULTS);
  // At most five per conversation, from the latest message back.
  assert.deepEqual(capped.slice(0, 6).map(item => [item.chat, item.message]), [['c0', 9], ['c0', 8], ['c0', 7], ['c0', 6], ['c0', 5], ['c1', 9]]);
});

test('a long search lets other work in, stops when asked, and malformed Markdown stays cheap', async () => {
  // An unclosed "](" again and again once took seconds to strip.
  const started = performance.now();
  assert.deepEqual(await searchChats([{id: 'a', title: 'x', messages: [said('assistant', '](' .repeat(50_000))]}], 'missing'), []);
  assert.ok(performance.now() - started < 500, `took ${performance.now() - started} ms`);
  const corpus = () => Array.from({length: 20}, (_, i) => ({id: `c${i}`, title: 'x', messages: Array.from({length: 100}, (_, k) => said('assistant', `reply ${k} `.repeat(2000)))}));
  const big = corpus();
  let longest = 0; let last = performance.now();
  const ticker = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 1);
  await searchChats(big, 'missing');
  clearInterval(ticker);
  assert.ok(longest < 100, `the event loop waited ${longest} ms`);
  const asker = new AbortController();
  // A fresh corpus, since folded text is kept and searching `big` again would finish before its first pause.
  const search = searchChats(corpus(), 'other words', asker.signal);
  asker.abort();
  await assert.rejects(search, {name: 'AbortError'});
});

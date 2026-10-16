import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Message, SearchResult } from './api.d.ts';

// Search over one person's conversations: a message matches when its text has every word of the query, ignoring case
// and accents ("cafe" finds "Café"). A title that matches when no message does still finds its conversation.
export const MAX_QUERY = 200;
export const MAX_RESULTS = 40;
const PER_CHAT = 5;
const SNIPPET = 160;
// The longest stretch one search works without letting other requests in.
const TURN_MS = 10;

interface Searchable { id: string; title: string; messages: Message[] }

// Decomposed, accents dropped, lower case. Lower-casing a whole string differs from lower-casing it a character at a
// time only for Greek final sigma, which is made an ordinary sigma, so both ways give the same text and snippets can
// map the folded text back character by character.
const foldText = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replaceAll('ς', 'σ');

// One character folded; ASCII, most of any text, without the general path.
const foldCharacter = (character: string) => character.length === 1 && character < '\x80' ? character.toLowerCase() : foldText(character);

// The folded text with, for each of its characters, the stretch of `text` it came from; one character can fold to
// several ("ﬃ" to "ffi"), or to none (a lone accent).
function foldMapped(text: string): {folded: string; start: number[]; end: number[]} {
  let folded = '';
  const start: number[] = []; const end: number[] = [];
  for (let i = 0; i < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(i)!);
    const piece = foldCharacter(character);
    for (let k = 0; k < piece.length; k++) { start.push(i); end.push(i + character.length); }
    folded += piece;
    i += character.length;
  }
  return {folded, start, end};
}

// Where in `text` the character is that position `index` of its folded text came from.
function sourceAt(text: string, index: number): number {
  let length = 0;
  for (let i = 0; i < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(i)!);
    length += foldCharacter(character).length;
    if (length > index) return i;
    i += character.length;
  }
  return text.length;
}

// Drops the targets of Markdown links, "](...)" up to a ")" with no space before it. In one pass: the next ")" and the
// next space are looked up only when a "](" is past them, so a long run of unclosed "](" cannot make it rescan the text.
function withoutLinkTargets(text: string): string {
  let kept = ''; let at = 0; let close = -1; let space = -1;
  const spaces = /\s/g;
  for (let open = text.indexOf('](', at); open !== -1; open = text.indexOf('](', at)) {
    const from = open + 2;
    if (close < from) close = text.indexOf(')', from);
    if (close === -1) break;
    if (space < from) { spaces.lastIndex = from; space = spaces.exec(text)?.index ?? text.length; }
    if (space > close) { kept += text.slice(at, open + 1); at = close + 1; } else { kept += text.slice(at, from); at = from; }
  }
  return kept + text.slice(at);
}

// Message text as read, without Markdown's markers and link targets, on one line.
const plain = (text: string) =>
  withoutLinkTargets(text).replace(/[*`#>[\]_~]+/g, '').replace(/\s+|\|/g, ' ').replace(/ {2,}/g, ' ').trim();

// Folded plain text, kept per message until its text changes (a streaming reply grows).
const folds = new WeakMap<Message, {source: string; folded: string}>();
function foldedMessage(message: Message): string {
  const cached = folds.get(message);
  if (cached?.source === message.text) return cached.folded;
  const folded = foldText(plain(message.text));
  folds.set(message, {source: message.text, folded});
  return folded;
}

const queryWords = (query: string): string[] => [...new Set(foldText(query).split(/\s+/).filter(Boolean))];

// Moves an index off the second half of a surrogate pair, so a snippet never splits an emoji.
const whole = (text: string, index: number) => (index > 0 && index < text.length && /[\uDC00-\uDFFF]/.test(text[index]) ? index - 1 : index);

// A stretch of `text` around the first word, cut at spaces, and where each word appears in it. `folded` is
// foldText(text), so only the stretch shown is mapped character by character.
function snippet(text: string, folded: string, words: string[]): Pick<SearchResult, 'snippet' | 'marks'> {
  const first = sourceAt(text, Math.min(...words.map(word => folded.indexOf(word))));
  let start = Math.max(0, first - 50);
  let end = Math.min(text.length, start + SNIPPET);
  if (start > 0) { const space = text.indexOf(' ', start); if (space !== -1 && space < first) start = space + 1; }
  if (end < text.length) { const space = text.lastIndexOf(' ', end); if (space > first) end = space; }
  start = whole(text, start); end = whole(text, end);
  const shown = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  const inShown = foldMapped(shown);
  const marks: [number, number][] = [];
  for (const word of words) {
    for (let at = inShown.folded.indexOf(word); at !== -1; at = inShown.folded.indexOf(word, at + 1)) {
      // Part of a character that folds to several still marks the whole character.
      marks.push([inShown.start[at], inShown.end[at + word.length - 1]]);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  // Overlapping marks ("ab" and "b") become one.
  const merged = marks.reduce<[number, number][]>((list, mark) => {
    const last = list.at(-1);
    if (last && mark[0] <= last[1]) last[1] = Math.max(last[1], mark[1]); else list.push([...mark]);
    return list;
  }, []);
  return {snippet: shown, marks: merged};
}

// `chats` newest first; results keep that order, and within a conversation go from its latest message back. Long
// searches pause every TURN_MS so the server keeps answering, and stop once `signal` says the asker has gone.
export async function searchChats(chats: Iterable<Searchable>, query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const words = queryWords(query);
  if (!words.length) return [];
  const results: SearchResult[] = [];
  let turn = performance.now();
  for (const chat of chats) {
    const found: SearchResult[] = [];
    for (let index = chat.messages.length - 1; index >= 0 && found.length < PER_CHAT; index--) {
      if (performance.now() - turn > TURN_MS) { await nextTurn(); signal?.throwIfAborted(); turn = performance.now(); }
      const message = chat.messages[index];
      const folded = foldedMessage(message);
      if (folded && words.every(word => folded.includes(word))) found.push({chat: chat.id, title: chat.title, message: index, ...snippet(plain(message.text), folded, words)});
    }
    if (!found.length && words.every(word => foldText(chat.title).includes(word))) found.push({chat: chat.id, title: chat.title, message: null, snippet: '', marks: []});
    results.push(...found);
    if (results.length >= MAX_RESULTS) return results.slice(0, MAX_RESULTS);
  }
  return results;
}

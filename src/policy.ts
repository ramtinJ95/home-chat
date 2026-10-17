import { realpath, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import ipaddr from 'ipaddr.js';
import type { ToolName, User, Weekday } from './api.d.ts';

export const ALLOWED_TOOLS = Object.freeze(['ask', 'web_run', 'imagegen', 'document', 'deep_research', 'routine', 'memory', 'todo'] as const satisfies readonly ToolName[]);
export const USERS: readonly User[] = Object.freeze(['owner', 'guest']);
// OpenAI for the model, and Exa for deep_research (src/agent/tools/deep-research.ts).
export const PROVIDER_HOSTS = new Set(['chatgpt.com', 'api.openai.com', 'auth.openai.com', 'api.exa.ai']);
// Browser push services: Apple (Safari), Google (Chrome, Android), Mozilla (Firefox), and Microsoft (Edge), whose
// endpoints are numbered hosts such as wns2-par02p.notify.windows.com. Only the server sends to them, never the model.
const PUSH_HOSTS = new Set(['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com']);
export const pushServiceHost = (host: string) => PUSH_HOSTS.has(host) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
// A memory backstop, not a user-facing limit: the browser shrinks pictures to 2048 px first, and even an
// incompressible 2048 px PNG, uploaded or re-encoded, stays under this.
export const MAX_UPLOAD = 20 * 1024 * 1024;
export const MAX_DATA = 512 * 1024 * 1024;
export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const LOCAL_HOSTS = new Set(['127.0.0.1:8787', 'localhost:8787']);
// Documents the `document` tool saves (src/agent/tools/document.ts): one file per version in the conversation's `documents/`.
export const DOCUMENT_ID = /^doc_[0-9a-f]{32}$/;
export const DOCUMENT_FILE = /^(doc_[0-9a-f]{32})_v([1-9][0-9]*)\.json$/;
export const MAX_DOCUMENT_TITLE = 200;
export const MAX_DOCUMENT_TEXT = 256 * 1024;
export const MAX_DOCUMENT_FILES = 100;
// Routines (src/routines.ts), here so the routine tool's schema (src/agent/tools/routine.ts) states the same limits.
export const WEEKDAYS: readonly Weekday[] = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
export const MAX_ROUTINE_TITLE = 80;
export const MAX_ROUTINE_PROMPT = 4000;
// What the server tells the model about a turn. Its notes open the prompt, ahead of USER_PREFIX; the user's text only
// ever follows it, so it cannot add or imitate a note. The tools and limits follow the turn's TurnMode, not the text.
const USER_PREFIX = 'Message from the user:\n';
export const DEEP_RESEARCH_NOTE = 'Deep research mode is on for this message.';
const DEEP_RESEARCH_INSTRUCTIONS = DEEP_RESEARCH_NOTE + ` If the message needs research, use deep_research heavily:
several calls covering different angles, with mode deep-reasoning for ambiguous, conflicting or judgment-heavy questions.
Then save one consolidated report with document, sources included, and reply with a short summary. Answer ordinary chat
normally, without research.`;
export const ROUTINE_NOTE = 'This is a scheduled routine run, and nobody is watching.';
// `routineRun`: when the run was due, in words, e.g. "Friday 17 October, 07:30". `from`: in a shared conversation, the
// name of the person who sent the message.
export interface TurnMode { deepResearch?: boolean; routineRun?: string; from?: string }
export const SHARED_NOTE = 'This conversation is shared by the household, so more than one person writes in it.';

export function composePrompt(message: string, {deepResearch, routineRun, from}: TurnMode = {}): string {
  const notes = [
    routineRun && `${ROUTINE_NOTE} It was due ${routineRun} (Stockholm time). The message is the routine's standing task: do it and
reply with the result. You cannot ask questions, change routines or change the household notes during this run.`,
    from && `${SHARED_NOTE} This message is from ${from}; the household notes, todo lists and routines you use for it are theirs.`,
    deepResearch && DEEP_RESEARCH_INSTRUCTIONS,
  ].filter(note => typeof note === 'string');
  return notes.map(note => note + '\n').join('') + USER_PREFIX + message;
}

// Follows the user's text when pictures came with it, listing their paths for imagegen.
export const ATTACHED_NOTE = '\nAttached image paths (this conversation only):\n';

// Whether `prompt`, as Pi received it, carried the user's `text`.
export function carriesText(prompt: string, text: string): boolean {
  const start = prompt.indexOf(USER_PREFIX);
  if (start === -1) return false;
  const body = prompt.slice(start + USER_PREFIX.length);
  return body === text || body.startsWith(text + ATTACHED_NOTE);
}

// Research costs money per call, so it needs the conversation's switch; an unattended run has nobody to answer a
// question or confirm a note, and routines never make routines.
export function refusedInTurn(tool: string, mode: {deepResearch: boolean; routineRun: boolean}): string | undefined {
  if (tool === 'deep_research' && !mode.deepResearch) return 'Deep research is off for this conversation; the user can switch it on';
  if (mode.routineRun && (tool === 'ask' || tool === 'routine' || tool === 'memory')) {
    return 'Nobody is watching this routine run, so it cannot ask questions, change routines or change the household notes';
  }
}
export const TURN_LIMITS = Object.freeze({
  normal: {toolCalls: 12, minutes: 5},
  deep: {toolCalls: 30, minutes: 20},
});
// How a tool reaches the server for routines, the household notes and the todo lists, in the server's own process (src/server.ts
// serverCall). Reads the notes when `body` is absent.
export type ServerCall = (path: '/routine' | '/memory' | '/todo', body?: unknown) => Promise<string>;

export function isAllowedTool(name: string): name is ToolName {
  return (ALLOWED_TOOLS as readonly string[]).includes(name);
}

export function isUser(value: unknown): value is User {
  return USERS.includes(value as User);
}

export function publicAddress(value: string): boolean {
  if (!ipaddr.isValid(value)) return false;
  const parsed = ipaddr.process(value);
  return parsed.range() === 'unicast' && (parsed.kind() !== 'ipv6' || parsed.match(ipaddr.parse('2000::'), 3));
}

export function allowedDestination(authority: string, allowed: (host: string) => boolean = host => PROVIDER_HOSTS.has(host)): string {
  if (!/^[a-z0-9.-]+:443$/.test(authority)) throw new Error('Destination denied');
  const host = authority.slice(0, -4);
  if (!allowed(host)) throw new Error('Destination denied');
  return host;
}

// A browser's push subscription. The endpoint comes from the browser, so it must point at a known push service: the
// server would otherwise send requests wherever a tampered client told it to.
export interface PushSubscriptionInput { endpoint: string; keys: {p256dh: string; auth: string} }
export function pushSubscription(value: unknown): PushSubscriptionInput {
  const input = value as {endpoint?: unknown; keys?: {p256dh?: unknown; auth?: unknown}} | null;
  const key = (text: unknown, bytes: number) =>
    typeof text === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(text) && Buffer.from(text, 'base64url').length === bytes;
  if (typeof input?.endpoint !== 'string' || input.endpoint.length > 2048) throw new Error('Invalid push subscription');
  let url: URL;
  try { url = new URL(input.endpoint); } catch { throw new Error('Invalid push subscription'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !pushServiceHost(url.hostname)) {
    throw new Error('Unknown push service');
  }
  if (!key(input.keys?.p256dh, 65) || !key(input.keys?.auth, 16)) throw new Error('Invalid push subscription');
  return {endpoint: url.href, keys: {p256dh: input.keys!.p256dh as string, auth: input.keys!.auth as string}};
}

export function requireAllowedTool(name: string): asserts name is ToolName {
  if (!isAllowedTool(name)) throw new Error('Tool is not available in Home Chat');
}

export async function allowedImagePath(path: unknown, cwd: string): Promise<string> {
  if (typeof path !== 'string') throw new Error('Invalid image reference');
  const full = await realpath(resolve(cwd, path));
  const roots = [resolve(cwd, 'uploads'), resolve(cwd, '.pi/openai-codex-images')];
  if (!roots.some(root => full.startsWith(root + sep)) || !full.endsWith('.png')) {
    throw new Error('Image must belong to this conversation');
  }
  const info = await stat(full);
  if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error('Invalid image file');
  return full;
}

// A stored file holds {title, markdown}; JSON escaping can grow the text, so the file may be larger than the text limit.
export async function allowedDocumentPath(path: string, cwd: string): Promise<string> {
  const full = await realpath(resolve(cwd, path));
  if (!full.startsWith(resolve(cwd, 'documents') + sep) || !DOCUMENT_FILE.test(basename(full))) {
    throw new Error('Document must belong to this conversation');
  }
  const info = await stat(full);
  if (!info.isFile() || info.size > 8 * MAX_DOCUMENT_TEXT) throw new Error('Invalid document file');
  return full;
}

interface DocumentInput { title: string; markdown: string; revises?: string }
// Checks the tool's input and, without `revises`, a stored document read back by the server.
export function documentInput(value: unknown): DocumentInput {
  const title = field(value, 'title'); const markdown = field(value, 'markdown'); const revises = field(value, 'revises');
  if (typeof title !== 'string' || !title.trim() || title.length > MAX_DOCUMENT_TITLE) {
    throw new Error(`A document needs a title of at most ${MAX_DOCUMENT_TITLE} characters`);
  }
  if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > MAX_DOCUMENT_TEXT) {
    throw new Error(`A document needs Markdown text of at most ${MAX_DOCUMENT_TEXT / 1024} K characters`);
  }
  if (revises !== undefined && (typeof revises !== 'string' || !DOCUMENT_ID.test(revises))) throw new Error('Invalid document reference');
  // The title is one line: it labels a card, a reader page and a file name.
  return {title: title.replace(/\s+/g, ' ').trim(), markdown, ...(revises === undefined ? {} : {revises})};
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
// Absent or null lists are fine (imagegen's schema allows null); anything else that is not a list is rejected, not skipped.
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Invalid tool input');
  return value;
}

export async function validateToolInput(name: string, args: unknown, cwd: string): Promise<void> {
  requireAllowedTool(name);
  if (typeof args !== 'object' || args === null) throw new Error('Invalid tool input');
  if (name === 'document') documentInput(args);
  if (name === 'imagegen') {
    for (const path of asArray(field(args, 'referenced_image_paths'))) await allowedImagePath(path, cwd);
  }
  if (name === 'web_run') {
    for (const item of ['open', 'click', 'find'].flatMap(key => asArray(field(args, key)))) {
      const ref = field(item, 'ref_id');
      if (typeof ref !== 'string') throw new Error('Invalid web reference');
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
        const url = new URL(ref);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Web URL denied');
        const host = url.hostname.replace(/^\[|\]$/g, '');
        if (ipaddr.isValid(host) ? !publicAddress(host) : !host.includes('.') || /\.(local|internal|localhost|ts\.net)$/i.test(host)) {
          throw new Error('Private web destination denied');
        }
      }
    }
  }
}

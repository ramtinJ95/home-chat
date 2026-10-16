import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import ipaddr from 'ipaddr.js';
import type { ToolName, User } from './api.d.ts';

export const ALLOWED_TOOLS = Object.freeze(['ask', 'web_run', 'imagegen'] as const satisfies readonly ToolName[]);
export const USERS: readonly User[] = Object.freeze(['owner', 'guest']);
export const PROVIDER_HOSTS = new Set(['chatgpt.com', 'api.openai.com', 'auth.openai.com']);
// Browser push services: Apple (Safari), Google (Chrome, Android), Mozilla (Firefox), and Microsoft (Edge), whose
// endpoints are numbered hosts such as wns2-par02p.notify.windows.com. Only the server sends to them, never the model.
export const PUSH_HOSTS = new Set(['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com']);
export const pushServiceHost = (host: string) => PUSH_HOSTS.has(host) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
// A memory backstop, not a user-facing limit: the browser shrinks pictures to 2048 px first, and even an
// incompressible 2048 px PNG, uploaded or re-encoded, stays under this.
export const MAX_UPLOAD = 20 * 1024 * 1024;
export const MAX_DATA = 512 * 1024 * 1024;
export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const LOCAL_HOSTS = new Set(['127.0.0.1:8787', 'localhost:8787']);
// profile/extension.ts reports the tools Pi registered as a notify message with this prefix; src/rpc.ts checks it.
export const POLICY_PREFIX = 'HOME_CHAT_POLICY:';

export interface ToolPolicy { registered: string[]; active: string[] }

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

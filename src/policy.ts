import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import ipaddr from 'ipaddr.js';
import type { ToolName, User } from './api.d.ts';

export const ALLOWED_TOOLS = Object.freeze(['ask', 'web_run', 'imagegen'] as const satisfies readonly ToolName[]);
export const USERS: readonly User[] = Object.freeze(['owner', 'guest']);
export const PROVIDER_HOSTS = new Set(['chatgpt.com', 'api.openai.com', 'auth.openai.com']);
export const MAX_UPLOAD = 4 * 1024 * 1024;
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

export function allowedDestination(authority: string): string {
  if (!/^[a-z0-9.-]+:443$/.test(authority)) throw new Error('Destination denied');
  const host = authority.slice(0, -4);
  if (!PROVIDER_HOSTS.has(host)) throw new Error('Destination denied');
  return host;
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
// Absent lists are fine; anything else that is not a list is rejected rather than skipped.
function asArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid tool input');
  return value;
}

export async function validateToolInput(name: string, args: unknown, cwd: string): Promise<void> {
  requireAllowedTool(name);
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

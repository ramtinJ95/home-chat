import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import ipaddr from 'ipaddr.js';

export const ALLOWED_TOOLS = Object.freeze(['ask', 'web_run', 'imagegen']);
export const PROVIDER_HOSTS = new Set(['chatgpt.com', 'api.openai.com', 'auth.openai.com']);
export const MAX_UPLOAD = 4 * 1024 * 1024;
export const MAX_DATA = 512 * 1024 * 1024;
export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const LOCAL_HOSTS = new Set(['127.0.0.1:8787', 'localhost:8787']);

export function publicAddress(value) {
  if (!ipaddr.isValid(value)) return false;
  const parsed = ipaddr.process(value);
  return parsed.range() === 'unicast' && (parsed.kind() !== 'ipv6' || parsed.match(ipaddr.parse('2000::'), 3));
}

export function allowedDestination(authority) {
  if (!/^[a-z0-9.-]+:443$/.test(authority)) throw new Error('Destination denied');
  const host = authority.slice(0, -4);
  if (!PROVIDER_HOSTS.has(host)) throw new Error('Destination denied');
  return host;
}

export function requireAllowedTool(name) {
  if (!ALLOWED_TOOLS.includes(name)) throw new Error('Tool is not available in Home Chat');
}

export async function allowedImagePath(path, cwd) {
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

export async function validateToolInput(name, args, cwd) {
  requireAllowedTool(name);
  if (name === 'imagegen') {
    for (const path of args.referenced_image_paths ?? []) await allowedImagePath(path, cwd);
  }
  if (name === 'web_run') {
    for (const item of [...(args.open ?? []), ...(args.click ?? []), ...(args.find ?? [])]) {
      const ref = item.ref_id;
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

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ALLOWED_TOOLS } from './policy.mjs';

const sameTools = names => JSON.stringify([...names].sort()) === JSON.stringify([...ALLOWED_TOOLS].sort());

export function providerFailure(value) {
  const text = String(value ?? '');
  const code = text.match(/refresh_token_(?:reused|expired|invalid)|invalid_grant|invalid_token/);
  if (code) return `Subscription login needs refreshing (${code[0]})`;
  if (/already processing/i.test(text)) return 'Pi is already processing a message';
  if (/\b429\b|quota|rate.limit/i.test(text)) return 'Subscription usage limit reached; try again after the provider limit resets';
  const status = text.match(/\b(?:401|403|502|503)\b/);
  if (status) return `Provider request failed (HTTP ${status[0]})`;
  return 'The model request failed. Check subscription login, quota and provider availability.';
}

export class PiWorker extends EventEmitter {
  constructor(directory) {
    super();
    this.directory = directory;
    this.pending = new Map();
    this.busy = false;
  }

  async start() {
    const cwd = join(this.directory, 'work');
    await mkdir(join(cwd, 'uploads'), {recursive: true, mode: 0o700});
    const args = ['/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
      '--mode', 'rpc', '--no-builtin-tools', '--no-extensions', '--no-skills', '--no-prompt-templates',
      '--no-themes', '--no-context-files', '--no-approve', '--offline',
      '--extension', '/app/profile/extension.ts', '--tools', ALLOWED_TOOLS.join(','),
      '--system-prompt', '/app/profile/instructions.md', '--provider', 'openai-codex',
      '--model', process.env.HOME_CHAT_MODEL ?? 'gpt-6-sol', '--thinking', 'high',
      '--session', join(this.directory, 'pi-session.jsonl')];
    // Provider errors may include headers or payloads, so raw stderr is discarded, never forwarded or logged.
    this.child = spawn(process.execPath, args, {cwd, stdio: ['pipe', 'pipe', 'ignore']});
    this.child.stdin.on('error', () => {});
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) return this.stop();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { this.handle(JSON.parse(line)); } catch { this.emit('failure', 'Invalid Pi protocol response'); }
      }
    });
    this.child.on('error', () => this.emit('failure', 'Could not start Pi'));
    this.child.on('exit', code => {
      this.closed = true;
      for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(new Error('Pi process exited')); }
      this.pending.clear();
      if (this.busy) this.emit('failure', `Pi exited during the request (code ${code})`);
      this.busy = false;
    });
    this.policy = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.stop(); reject(new Error('Pi did not confirm its restricted tool policy')); }, 30_000);
      this.once('policy', policy => { clearTimeout(timer); resolve(policy); });
      this.child.once('exit', () => { clearTimeout(timer); reject(new Error('Pi exited before tool-policy confirmation')); });
    });
    return this;
  }

  handle(event) {
    if (event.type === 'response' && this.pending.has(event.id)) {
      const pending = this.pending.get(event.id); this.pending.delete(event.id); clearTimeout(pending.timer);
      event.success ? pending.resolve(event.data) : pending.reject(new Error(providerFailure(event.error)));
      return;
    }
    if (event.type === 'extension_ui_request') {
      if (event.method === 'notify' && event.message?.startsWith('HOME_CHAT_POLICY:')) {
        const policy = JSON.parse(event.message.slice('HOME_CHAT_POLICY:'.length));
        if (!sameTools(policy.registered) || !sameTools(policy.active)) {
          this.stop(); this.emit('failure', 'Pi tool policy mismatch'); return;
        }
        this.emit('policy', policy); return;
      }
      if (['select', 'input', 'editor', 'confirm'].includes(event.method)) {
        this.question = {
          id: event.id, method: event.method,
          title: String(event.title ?? '').slice(0, 2000),
          message: String(event.message ?? event.placeholder ?? '').slice(0, 4000),
          options: Array.isArray(event.options) ? event.options.slice(0, 20).map(x => String(x).slice(0, 1000)) : [],
          prefill: String(event.prefill ?? '').slice(0, 4000),
        };
        this.emit('question', this.question);
      }
      return;
    }
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      this.emit('delta', String(event.assistantMessageEvent.delta));
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      if (event.message.stopReason === 'error') this.emit('failure', providerFailure(event.message.errorMessage));
    }
    if (event.type === 'tool_execution_start' && ALLOWED_TOOLS.includes(event.toolName)) this.emit('tool', event.toolName);
    if (event.type === 'agent_settled') {
      this.busy = false; this.question = null; this.emit('settled');
    }
  }

  request(type, fields = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Pi command timed out')); }, 30_000);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(JSON.stringify({id, type, ...fields}) + '\n');
    });
  }

  async prompt(message, images = []) {
    this.busy = true;
    try {
      // Never interpret browser text as a Pi slash command or shell shortcut.
      await this.request('prompt', {message: 'Message from the user:\n' + message, images});
    } catch (error) { this.busy = false; throw error; }
  }

  answer(id, value, cancelled = false) {
    const question = this.question;
    if (!question || question.id !== id) throw new Error('Question expired or belongs to another conversation');
    if (!cancelled && question.method === 'select' && !question.options.includes(value)) throw new Error('Invalid choice');
    if (!cancelled && typeof value !== 'string' && question.method !== 'confirm') throw new Error('Invalid answer');
    this.child.stdin.write(JSON.stringify({type: 'extension_ui_response', id, cancelled,
      ...(question.method === 'confirm' ? {confirmed: value === true} : {value})}) + '\n');
    this.question = null;
  }

  async abort() { this.question = null; return this.request('abort'); }
  stop() { if (this.child && !this.closed) this.child.kill('SIGTERM'); }
}

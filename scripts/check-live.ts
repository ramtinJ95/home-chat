import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createAgent} from '../src/agent/agent.ts';
const directory = await mkdtemp('/tmp/home-chat-live-');
// Shares the server's Codex login. Near the token's expiry both may refresh it at once and one of them fail, so run
// this when the token is fresh or the server is idle.
const agent = createAgent({instructions: await readFile(new URL('../profile/instructions.md', import.meta.url), 'utf8')});
const worker = agent.worker(join(directory, 'chats/live'), async () => '');
const deadline = setTimeout(() => { void worker.abort(); console.error('Live inference exceeded 120 seconds'); process.exitCode = 1; }, 120_000);
let text = '';
const tools: string[] = [];
worker.on('delta', delta => { text += delta; });
worker.on('tool', name => tools.push(name));
try {
  await worker.start();
  const settled = new Promise<void>((resolve, reject) => {
    worker.once('settled', resolve);
    worker.once('failure', message => reject(new Error(message)));
  });
  await Promise.all([worker.prompt('Reply with exactly HOME_CHAT_READY. Do not use any tools.'), settled]);
  assert.deepEqual(tools, []);
  assert.equal(text.trim(), 'HOME_CHAT_READY');
  console.log('PASS live Codex subscription inference through Pi Durable and the egress proxy');
} finally {
  clearTimeout(deadline);
  await worker.stop();
  await agent.close();
  await rm(directory, {recursive: true});
}

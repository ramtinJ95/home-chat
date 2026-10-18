import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createAgent} from '../src/agent/agent.ts';
import {FileCredentialStore} from '../src/agent/codex.ts';
// On the data volume, where conversations keep their SQLite files, but outside chats/ so the server never sees it.
const directory = await mkdtemp('/data/home/home-chat-runtime-');
const agent = createAgent({instructions: await readFile(new URL('../profile/instructions.md', import.meta.url), 'utf8')});
const worker = agent.worker(join(directory, 'chats/runtime'), async () => '');
try {
  const status = await readFile('/proc/self/status', 'utf8');
  assert.match(status, /CapEff:\s+0000000000000000/);
  await worker.start();
  assert.ok((await readdir(join(directory, 'chats/runtime'))).includes('agent.sqlite'));
  // Only reads the stored login: refreshing it here could race the running server's own refresh of the same token.
  assert.equal((await new FileCredentialStore('/data/profile/auth.json').read('openai-codex'))?.type, 'oauth', 'Codex is not signed in');
  console.log(JSON.stringify({provider: 'openai-codex', model: process.env.HOME_CHAT_MODEL, login: 'ok'}));
} finally {
  await worker.stop();
  await agent.close();
  await rm(directory, {recursive: true});
}

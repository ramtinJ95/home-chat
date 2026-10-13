import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {PiWorker} from '../src/rpc.mjs';
const directory = await mkdtemp('/tmp/home-chat-runtime-');
const worker = new PiWorker(directory);
try {
  const status = await readFile('/proc/self/status', 'utf8');
  assert.match(status, /CapEff:\s+0000000000000000/);
  await worker.start();
  console.log(JSON.stringify({toolPolicy: worker.policy}));
  const state = await worker.request('get_state');
  console.log(JSON.stringify({model: state.model?.id, provider: state.model?.provider}));
  assert.equal(state.model?.provider, 'openai-codex');
} finally {
  worker.stop();
  await delay(250);
  await rm(directory, {recursive: true});
}

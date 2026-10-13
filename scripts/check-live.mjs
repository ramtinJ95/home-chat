import {PiWorker} from '../src/rpc.mjs';
import {mkdtemp, rm} from 'node:fs/promises';
import assert from 'node:assert/strict';
const directory = await mkdtemp('/tmp/home-chat-live-');
const worker = new PiWorker(directory);
const deadline = setTimeout(() => { worker.stop(); console.error('Live inference exceeded 120 seconds'); process.exitCode = 1; }, 120_000);
let text = '';
worker.on('delta', delta => { text += delta; });
worker.on('failure', message => console.error(message));
try {
  await worker.start();
  const initial = await worker.request('get_state');
  assert.equal(initial.isStreaming, false, 'Pi must not start unsolicited model turns');
  const settled = new Promise((resolve, reject) => {
    worker.once('settled', resolve);
    worker.once('failure', message => reject(new Error(message)));
    worker.child.once('exit', (code, signal) => reject(new Error(`Worker exited before settling: code=${code}, signal=${signal}`)));
  });
  await Promise.all([worker.prompt('Reply with exactly HOME_CHAT_READY. Do not use any tools.'), settled]);
  assert.equal(text.trim(), 'HOME_CHAT_READY');
  console.log('PASS live Codex subscription inference through restricted Pi and egress proxy');
} finally {
  clearTimeout(deadline); worker.stop();
  await new Promise(resolve => setTimeout(resolve, 300));
  await rm(directory, {recursive: true});
}

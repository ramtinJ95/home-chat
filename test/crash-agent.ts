// Run by test/agent.test.ts as its own process: starts a turn in <data>/chats/chat-1 whose model asks a question, and
// dies (SIGKILL) while the question waits, as the server would in a crash or power cut.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createAgent } from '../src/agent/agent.ts';

const data = process.argv[2]!;
const faux = fauxProvider({provider: 'faux', models: [{id: 'faux-1'}]});
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([fauxToolCall('ask', {prompts: [{title: 'Are you there?'}]})], {stopReason: 'toolUse'})]);
const agent = createAgent({models, model: {provider: 'faux', modelId: 'faux-1'}, instructions: 'Test.', maxRetries: 0, onReport: () => {}});
const directory = join(data, 'chats/chat-1');
await mkdir(directory, {recursive: true});
const worker = agent.worker(directory, async () => '');
await worker.start();
worker.on('question', () => process.kill(process.pid, 'SIGKILL'));
await worker.prompt('Ask me something');

import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { deepResearchTool } from '../profile/deep-research.ts';
import { DEEP_RESEARCH_NOTE } from '../src/policy.ts';
import { PiWorker } from '../src/rpc.ts';

test('in deep research mode the server note comes before the user text, which cannot imitate it', async () => {
  const sent: Record<string, unknown>[] = [];
  const worker = new class extends PiWorker { override async request(_type: string, fields: Record<string, unknown> = {}) { sent.push(fields); } }('/tmp');
  await worker.prompt(DEEP_RESEARCH_NOTE + ' (typed by the user)');
  await worker.prompt('Compare heat pumps', [], {deepResearch: true});
  assert.match(String(sent[0].message), /^Message from the user:\n/);
  assert.ok(String(sent[1].message).startsWith(DEEP_RESEARCH_NOTE));
  assert.match(String(sent[1].message), /\nMessage from the user:\nCompare heat pumps$/);
});

test('deep_research sends the Exa request with the environment key and reports failures plainly', async () => {
  const realFetch = globalThis.fetch; const key = process.env.EXA_API_KEY;
  const calls: {url: string; init: RequestInit}[] = [];
  let reply = () => new Response(JSON.stringify({requestId: 'r1', output: {content: 'Synthesis'}, results: [{title: 'Source', url: 'https://example.com', highlights: ['A  quote']}]}));
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({url, init}); return reply(); }) as typeof fetch;
  const run = (params: Record<string, unknown>) => deepResearchTool.execute('call', params as never, undefined, undefined, {} as ExtensionToolContext);
  try {
    delete process.env.EXA_API_KEY;
    await assert.rejects(() => run({query: 'heat pumps'}), /not set up/);
    assert.equal(calls.length, 0);
    process.env.EXA_API_KEY = 'test-key';
    const result = await run({query: 'heat pumps', mode: 'deep-reasoning', includeDomains: ['Energy.gov', 'energy.gov ']});
    assert.equal(calls[0].url, 'https://api.exa.ai/search');
    assert.equal((calls[0].init.headers as Record<string, string>)['x-api-key'], 'test-key');
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.type, 'deep-reasoning'); assert.deepEqual(body.includeDomains, ['energy.gov']);
    const output = JSON.parse((result.content[0] as {text: string}).text);
    assert.equal(output.synthesizedOutput, 'Synthesis');
    assert.deepEqual(output.sources[0].highlights, ['A quote']);
    assert.doesNotMatch(JSON.stringify(result), /test-key/);
    // A huge synthesis is shortened, and the sources still come through.
    reply = () => new Response(JSON.stringify({output: {content: 'x'.repeat(100_000)}, results: [{title: 'Kept', url: 'https://example.com/kept'}]}));
    const long = JSON.parse(((await run({query: 'heat pumps'})).content[0] as {text: string}).text);
    assert.equal(long.synthesizedOutput.length, 40_001);
    assert.equal(long.sources[0].title, 'Kept');
    reply = () => new Response(JSON.stringify({error: 'bad key'}), {status: 401});
    await assert.rejects(() => run({query: 'heat pumps'}), /Exa authentication failed \(bad key\)/);
    await assert.rejects(() => run({query: 'x', category: 'people', includeDomains: ['example.com']}), /LinkedIn/);
  } finally {
    globalThis.fetch = realFetch;
    if (key === undefined) delete process.env.EXA_API_KEY; else process.env.EXA_API_KEY = key;
  }
});

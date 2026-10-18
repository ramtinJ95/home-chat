import test from 'node:test';
import assert from 'node:assert/strict';
import { research } from '../src/agent/tools/deep-research.ts';
import { DEEP_RESEARCH_NOTE, composePrompt } from '../src/policy.ts';
import { withEnv } from './helpers.ts';

test('in deep research mode the server note comes before the user text, which cannot imitate it', async () => {
  assert.match(composePrompt(DEEP_RESEARCH_NOTE + ' (typed by the user)'), /^Message from the user:\n/);
  const sent = composePrompt('Compare heat pumps', {deepResearch: true});
  assert.ok(sent.startsWith(DEEP_RESEARCH_NOTE));
  assert.match(sent, /\nMessage from the user:\nCompare heat pumps$/);
});

test('deep_research sends the Exa request with the environment key and reports failures plainly', async t => {
  const calls: {url: string; init: RequestInit}[] = [];
  let reply = () => new Response(JSON.stringify({requestId: 'r1', output: {content: 'Synthesis'}, results: [{title: 'Source', url: 'https://example.com', highlights: ['A  quote']}]}));
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => { calls.push({url, init}); return reply(); });
  const run = (params: Record<string, unknown>) => research(params as never);
  // The key changes during the test; withEnv puts back whatever was set before.
  await withEnv({EXA_API_KEY: undefined}, async () => {
    await assert.rejects(() => run({query: 'heat pumps'}), /not set up/);
    assert.equal(calls.length, 0);
    process.env.EXA_API_KEY = 'test-key';
    const result = await run({query: 'heat pumps', mode: 'deep-reasoning', includeDomains: ['Energy.gov', 'energy.gov ']});
    assert.equal(calls[0].url, 'https://api.exa.ai/search');
    assert.equal((calls[0].init.headers as Record<string, string>)['x-api-key'], 'test-key');
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.type, 'deep-reasoning'); assert.deepEqual(body.includeDomains, ['energy.gov']);
    const output = JSON.parse((result.output[0] as {text: string}).text);
    assert.equal(output.synthesizedOutput, 'Synthesis');
    assert.deepEqual(output.sources[0].highlights, ['A quote']);
    assert.doesNotMatch(JSON.stringify(result), /test-key/);
    // A huge synthesis is shortened, and the sources still come through.
    reply = () => new Response(JSON.stringify({output: {content: 'x'.repeat(100_000)}, results: [{title: 'Kept', url: 'https://example.com/kept'}]}));
    const long = JSON.parse(((await run({query: 'heat pumps'})).output[0] as {text: string}).text);
    assert.equal(long.synthesizedOutput.length, 40_001);
    assert.equal(long.sources[0].title, 'Kept');
    reply = () => new Response(JSON.stringify({error: 'bad key'}), {status: 401});
    await assert.rejects(() => run({query: 'heat pumps'}), /Exa authentication failed \(bad key\)/);
    await assert.rejects(() => run({query: 'x', category: 'people', includeDomains: ['example.com']}), /LinkedIn/);
  });
});

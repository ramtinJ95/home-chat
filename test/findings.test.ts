import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createFindings, findingItems, findingKey, type Finding } from '../src/findings.ts';
import { FINDINGS_NOTE, composePrompt, refusedInTurn } from '../src/policy.ts';
import { tempDir } from './helpers.ts';

test('a finding is known by its link, without tracking parameters, parameter order or a text fragment', () => {
  assert.equal(findingKey('https://Jobs.Example:443/a?utm_source=x&b=2&a=1&gclid=y#:~:text=Go'), 'https://jobs.example/a?a=1&b=2');
  assert.equal(findingKey('https://jobs.example/a#apply:~:text=Go'), 'https://jobs.example/a#apply');
  // Anything else may tell items apart, so it stays.
  assert.notEqual(findingKey('https://jobs.example/a'), findingKey('https://jobs.example/a/'));
  assert.notEqual(findingKey('https://jobs.example/list#job-1'), findingKey('https://jobs.example/list#job-2'));
  assert.notEqual(findingKey('https://jobs.example/view?id=1'), findingKey('https://jobs.example/view?id=2'));
  assert.notEqual(findingKey('https://jobs.example/a'), findingKey('http://jobs.example/a'));
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@jobs.example/', 'not a link', 42]) {
    assert.throws(() => findingKey(bad));
  }
});

test('the findings tool takes 1 to 20 items, each with a one-line title and summary', () => {
  const [item] = findingItems([{url: 'https://www.jobs.example/a', title: ' Backend\n engineer ', summary: 'Go.'}]);
  assert.deepEqual({...item, id: undefined}, {id: undefined, url: 'https://www.jobs.example/a', key: 'https://www.jobs.example/a',
    title: 'Backend engineer', summary: 'Go.', site: 'jobs.example'});
  assert.throws(() => findingItems([]), /1 to 20/);
  assert.throws(() => findingItems(Array.from({length: 21}, () => ({url: 'https://a.example', title: 'a', summary: 'a'}))), /1 to 20/);
  assert.throws(() => findingItems([{url: 'https://a.example', title: '', summary: 'a'}]), /title/);
  assert.throws(() => findingItems([{url: 'https://a.example', title: 'a', summary: 'x'.repeat(401)}]), /summary/);
});

test('recording a run again adds nothing, and the list outlives the store', async t => {
  const path = join(await tempDir(t, 'home-chat-findings-'), 'findings.json');
  const store = await createFindings(path);
  const found: Finding[] = findingItems([{url: 'https://a.example/1', title: 'One', summary: 'First.'}]).map(item => ({...item, run: '2026-11-18T11:00:00.000Z'}));
  await store.record('r1', found);
  await store.record('r1', found);
  const reopened = await createFindings(path);
  assert.equal(reopened.count('r1'), 1);
  assert.equal(reopened.known('r1', 'https://a.example/1'), true);
  // Per routine: another routine has not shared it.
  assert.equal(reopened.known('r2', 'https://a.example/1'), false);
  await reopened.remove('r1');
  assert.equal((await createFindings(path)).count('r1'), 0);
});

test('only a run of a routine that keeps findings gets the findings tool and is told how to use it', () => {
  const run = {routineRun: 'Friday 17 October, 07:30'};
  assert.match(refusedInTurn('findings', {}) ?? '', /only works in a run/);
  assert.match(refusedInTurn('findings', run) ?? '', /only works in a run/);
  assert.match(refusedInTurn('findings', {findings: true}) ?? '', /only works in a run/);
  assert.equal(refusedInTurn('findings', {...run, findings: true}), undefined);
  assert.ok(composePrompt('Find jobs', {...run, findings: true}).includes(FINDINGS_NOTE));
  // Told its limits, so a run cut off by them has handed over what it found by then.
  assert.match(composePrompt('Find jobs', {...run, findings: true}), /may make 12 tool calls in\n5 minutes/);
  assert.match(composePrompt('Find jobs', {...run, findings: true, deepResearch: true}), /may make 30 tool calls in\n20 minutes/);
  assert.ok(!composePrompt('Find jobs', run).includes(FINDINGS_NOTE));
  assert.ok(!composePrompt('Find jobs', {findings: true}).includes(FINDINGS_NOTE));
});

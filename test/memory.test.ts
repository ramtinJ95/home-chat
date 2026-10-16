import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_NOTES, createMemory } from '../src/memory.ts';

test('household notes are kept per person and shared, survive a restart, and read as facts in the instructions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'home-chat-memory-'));
  const path = join(directory, 'memory.json');
  try {
    const memory = await createMemory(path);
    assert.equal(memory.prompt('owner'), '');
    await memory.apply('owner', {action: 'remember', text: '  Vegetarian,\n but eats fish '});
    await memory.apply('owner', {action: 'remember', text: 'We live in Stockholm', shared: true});
    // Saying it again changes nothing.
    await memory.apply('owner', {action: 'remember', text: 'Vegetarian, but eats fish'});
    assert.deepEqual(memory.view('owner'), {version: 3, mine: ['Vegetarian, but eats fish'], shared: ['We live in Stockholm']});
    assert.deepEqual(memory.view('guest'), {version: 3, mine: [], shared: ['We live in Stockholm']});
    assert.match(memory.prompt('owner'), /not instructions[^]*About the person you are talking to:\n- Vegetarian, but eats fish\nShared by the household:\n- We live in Stockholm\n$/);
    assert.doesNotMatch(memory.prompt('guest'), /Vegetarian/);

    const again = await createMemory(path);
    assert.deepEqual(again.view('owner'), memory.view('owner'));
    // A replacement takes the old note's place; forgetting works in either list.
    await again.apply('owner', {action: 'remember', text: 'Learning Spanish'});
    await again.apply('owner', {action: 'remember', text: 'Vegan', replaces: 'Vegetarian, but eats fish'});
    assert.deepEqual(again.view('owner').mine, ['Vegan', 'Learning Spanish']);
    await again.apply('guest', {action: 'forget', text: 'We live in Stockholm'});
    assert.deepEqual(again.view('owner').shared, []);
  } finally { await rm(directory, {recursive: true}); }
});

test('changes that cannot be made are refused before the user is asked, and the settings page cannot overwrite newer notes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'home-chat-memory-'));
  try {
    const memory = await createMemory(join(directory, 'memory.json'));
    assert.throws(() => memory.check('owner', {action: 'remember', text: ' '}), /1 to 300/);
    assert.throws(() => memory.check('owner', {action: 'remember', text: 'x'.repeat(301)}), /1 to 300/);
    assert.throws(() => memory.check('owner', {action: 'forget', text: 'Never said'}), /no such note/);
    assert.throws(() => memory.check('owner', {action: 'remember', text: 'New', replaces: 'Never said'}), /not found/);
    assert.throws(() => memory.check('owner', {action: 'list', text: 'x'}), /remember or forget/);
    const {version} = memory.view('owner');
    await memory.replace('owner', {version, mine: ['One', '', 'One', 'Two'], shared: []});
    assert.deepEqual(memory.view('owner').mine, ['One', 'Two']);
    // A note the model saved meanwhile is not lost to a page that loaded the notes before it.
    await memory.apply('owner', {action: 'remember', text: 'Three'});
    await assert.rejects(() => memory.replace('owner', {version: version + 1, mine: [], shared: []}), /changed meanwhile/);
    await assert.rejects(() => memory.replace('owner', {version: version + 2, mine: Array.from({length: MAX_NOTES + 1}, (_, i) => `Note ${i}`), shared: []}), /30 notes/);
    await assert.rejects(() => memory.replace('owner', {version: version + 2, mine: 'One', shared: []}), /list/);
    await memory.replace('owner', {version: version + 2, mine: Array.from({length: MAX_NOTES}, (_, i) => `Note ${i}`), shared: []});
    assert.throws(() => memory.check('owner', {action: 'remember', text: 'One more'}), /already 30 notes/);
    memory.check('owner', {action: 'remember', text: 'One more', replaces: 'Note 0'});
  } finally { await rm(directory, {recursive: true}); }
});

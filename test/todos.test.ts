import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TodoMissing, createTodos, todoAction } from '../src/todos.ts';

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'home-chat-todos-'));
  const path = join(directory, 'todos.json');
  return {path, todos: await createTodos(path), cleanup: () => rm(directory, {recursive: true})};
}

test('private lists are their owner’s, shared ones everyone’s, and only the owner shares or deletes', async () => {
  const {path, todos, cleanup} = await store();
  try {
    const mine = await todos.create('owner', {title: '  Errands ', shared: false});
    const groceries = await todos.create('owner', {title: 'Groceries', shared: true});
    assert.equal(mine.title, 'Errands');
    assert.deepEqual(todos.list('guest').map(list => [list.title, list.mine]), [['Groceries', false]]);
    assert.throws(() => todos.get('guest', mine.id), TodoMissing);
    // The guest can add to and rename a shared list, but not unshare or delete it.
    await todos.add('guest', groceries.id, ['Milk']);
    assert.equal((await todos.update('guest', groceries.id, {title: 'Food'})).title, 'Food');
    await assert.rejects(() => todos.update('guest', groceries.id, {shared: false}), /Only the person who made this list/);
    await assert.rejects(() => todos.remove('guest', groceries.id), /Only the person who made this list/);
    await todos.update('owner', groceries.id, {shared: false});
    assert.deepEqual(todos.list('guest'), []);
    // Saved, and read back after a restart.
    const again = await createTodos(path);
    assert.deepEqual(again.list('owner').map(list => [list.title, list.shared, list.items.map(item => item.text)]),
      [['Errands', false, []], ['Food', false, ['Milk']]]);
  } finally { await cleanup(); }
});

test('items are numbered for good, ticked off, put back, rewritten, removed and cleared', async () => {
  const {todos, cleanup} = await store();
  try {
    const list = await todos.create('owner', {title: 'Groceries', shared: true});
    const {list: after, added} = await todos.add('owner', list.id, ['Milk', 'Eggs', 'Bread']);
    // Every change counts up the list's version, so a page can drop an older answer.
    assert.deepEqual([list.version, after.version], [1, 2]);
    assert.deepEqual(added.map(item => item.id), [1, 2, 3]);
    await todos.edit('guest', list.id, [1, 2], {done: true});
    await todos.edit('owner', list.id, [2], {done: false, text: 'Six eggs'});
    await todos.removeItems('owner', list.id);
    assert.deepEqual(todos.get('owner', list.id).items, [{id: 2, text: 'Six eggs', done: false}, {id: 3, text: 'Bread', done: false}]);
    await todos.removeItems('owner', list.id, [3]);
    // A removed number is not given out again.
    assert.deepEqual((await todos.add('owner', list.id, ['Butter'])).added, [{id: 4, text: 'Butter', done: false}]);
    await assert.rejects(() => todos.edit('owner', list.id, [3], {done: true}), /There is no item 3/);
    await assert.rejects(() => todos.add('owner', list.id, ['  ']), /An item must be 1 to 300 characters/);
    await assert.rejects(() => todos.add('owner', list.id, Array.from({length: 199}, (_, n) => `Item ${n}`)), /at most 200 items/);
  } finally { await cleanup(); }
});

test('the todo tool finds lists by name and answers in plain text', async () => {
  const {todos, cleanup} = await store();
  try {
    const run = (input: Record<string, unknown>, user: 'owner' | 'guest' = 'owner') => todoAction(todos, user, input);
    assert.equal(await run({action: 'lists'}), 'There are no lists yet.');
    assert.match(await run({action: 'create', title: 'Groceries', shared: true}), /^Made the list “Groceries” \(shared with the household\)\.$/);
    // The guest's own private list of the same name comes first for the guest.
    await run({action: 'create', title: 'groceries'}, 'guest');
    assert.match(await run({action: 'add', list: 'GROCERIES', items: ['Oat milk']}, 'guest'), /“groceries” \(private\): 1\. Oat milk/);
    assert.match(await run({action: 'add', list: 'Groceries', items: ['Milk', 'Eggs']}), /^Added to “Groceries” \(shared with the household\): 1\. Milk; 2\. Eggs\.$/);
    const shown = await run({action: 'complete', list: 'groceries', items: ['1']});
    assert.match(shown, /To do:\n2\. Eggs\nDone:\n1\. Milk\n$/);
    assert.match(await run({action: 'lists'}, 'guest'), /“Groceries” \(shared with the household\), id list_[0-9a-f]{16}: 1 to do, 1 done/);
    await assert.rejects(() => run({action: 'remove', list: 'Groceries', items: []}), /items must list the item numbers/);
    await assert.rejects(() => run({action: 'show', list: 'Holiday'}), /There is no such list/);
    await assert.rejects(() => run({action: 'delete', list: 'Groceries'}), /action must be/);
  } finally { await cleanup(); }
});

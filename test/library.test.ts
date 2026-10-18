import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LibraryError, createLibrary } from '../src/library.ts';
import { tempDir } from './helpers.ts';

const document = (title: string, version: number) => ({kind: 'document' as const, title, version});
const anyone = () => {};

test('a share the check refuses copies nothing, even after its file was written', async t => {
  const data = await tempDir(t, 'home-chat-library-');
  const library = await createLibrary(data);
  const gone = new Error('Not found');
  await assert.rejects(library.share('guest', 'chat/doc', document('Plan', 1), '{}', () => { throw gone; }), gone);
  assert.deepEqual(library.view('guest').items, []);
  assert.deepEqual(await readdir(join(data, 'library')), []);
});

test('each person replaces only their own copy of a source, and only the sharer removes it', async t => {
  const data = await tempDir(t, 'home-chat-library-');
  const library = await createLibrary(data);
  const first = await library.share('owner', 'chat/doc', document('Plan', 1), '{"v":1}', anyone);
  const again = await library.share('owner', 'chat/doc', document('Plan', 2), '{"v":2}', anyone);
  assert.equal(again.id, first.id);
  const theirs = await library.share('guest', 'chat/doc', document('Plan', 3), '{"v":3}', anyone);
  assert.deepEqual(library.view('owner').items.map(item => [item.id, item.by, item.kind === 'document' && item.version]),
    [[theirs.id, 'guest', 3], [first.id, 'owner', 2]]);
  assert.equal((await readdir(join(data, 'library'))).length, 2, 'the replaced copy is deleted');
  await assert.rejects(library.remove('guest', first.id), LibraryError);
  assert.equal(library.view('owner').unseen, true);
  assert.equal((await library.seen('owner')).unseen, false);
  assert.deepEqual((await library.remove('owner', first.id)).items.map(item => item.id), [theirs.id]);
  const restarted = await createLibrary(data);
  assert.deepEqual(restarted.view('guest').items.map(item => item.id), [theirs.id]);
  assert.equal((await readdir(join(data, 'library'))).length, 1);
});

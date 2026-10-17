import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDocument } from '../src/agent/tools/document.ts';

test('the document tool saves each revision as a new version and refuses unknown documents', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'home-chat-document-'));
  const save = (params: {title: string; markdown: string; revises?: string}) => saveDocument(params, cwd);
  try {
    const first = await save({title: 'Weekend plan', markdown: '## Saturday\nMarket'});
    const {doc, version} = first;
    assert.match(doc, /^doc_[0-9a-f]{32}$/);
    assert.equal(version, 1);
    const second = await save({title: 'Weekend plan', markdown: '## Saturday\nMuseum', revises: doc});
    assert.deepEqual([second.doc, second.version], [doc, 2]);
    assert.deepEqual((await readdir(join(cwd, 'documents'))).sort(), [`${doc}_v1.json`, `${doc}_v2.json`]);
    assert.deepEqual(JSON.parse(await readFile(join(cwd, 'documents', `${doc}_v1.json`), 'utf8')), {title: 'Weekend plan', markdown: '## Saturday\nMarket'});
    await assert.rejects(() => save({title: 'Other', markdown: 'x', revises: 'doc_' + '0'.repeat(32)}), /No document with that id/);
    // A message's tool calls run in parallel; each revision still gets its own version.
    const parallel = await Promise.all([1, 2, 3].map(n => save({title: 'Weekend plan', markdown: 'Take ' + n, revises: doc})));
    assert.deepEqual(parallel.map(result => result.version).sort(), [3, 4, 5]);
  } finally { await rm(cwd, {recursive: true}); }
});

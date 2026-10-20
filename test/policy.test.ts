import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ALLOWED_TOOLS, ATTACHED_NOTE, allowedDestination, carriesText, composePrompt, publicAddress, pushServiceHost, pushSubscription, requireAllowedTool, allowedDocumentPath, allowedImagePath, documentInput, validateToolInput } from '../src/policy.ts';
import { pushKeys, tempDir } from './helpers.ts';

test('the rewind recognises the message Pi was given, notes and picture paths included, and nothing else', () => {
  const sent = composePrompt('What is this?' + ATTACHED_NOTE + '/work/uploads/a.png', {deepResearch: true});
  assert.equal(carriesText(sent, 'What is this?'), true);
  assert.equal(carriesText(composePrompt('Hello'), 'Hello'), true);
  assert.equal(carriesText(composePrompt('Hello there'), 'Hello'), false);
  assert.equal(carriesText(composePrompt('Hello'), 'Hello there'), false);
  assert.equal(carriesText('Hello', 'Hello'), false);
  // In a shared conversation the note names the sender ahead of the user's text, which cannot pose as it.
  const shared = composePrompt('Add milk', {from: 'Sara'});
  assert.match(shared, /^This conversation is shared by the household.* This message is from Sara;/);
  assert.equal(carriesText(shared, 'Add milk'), true);
  assert.doesNotMatch(composePrompt('Add milk'), /shared/);
});

test('egress accepts only exact provider hosts on TLS port', () => {
  assert.equal(allowedDestination('chatgpt.com:443'), 'chatgpt.com');
  assert.equal(allowedDestination('api.exa.ai:443'), 'api.exa.ai');
  for (const host of ['127.0.0.1:443', '100.64.0.1:443', '[::1]:443', 'host.docker.internal:443', 'chatgpt.com.evil.test:443', 'chatgpt.com:80', 'chatgpt.com.:443', 'CHATGPT.COM:443', 'user@chatgpt.com:443']) {
    assert.throws(() => allowedDestination(host));
  }
});
test('push goes only to the known browser push services', () => {
  for (const host of ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com', 'wns2-par02p.notify.windows.com']) {
    assert.equal(pushServiceHost(host), true, host);
  }
  for (const host of ['notify.windows.com', 'a.b.notify.windows.com', 'evil.test', 'web.push.apple.com.evil.test', 'xnotify.windows.com']) {
    assert.equal(pushServiceHost(host), false, host);
  }
  assert.equal(allowedDestination('web.push.apple.com:443', pushServiceHost), 'web.push.apple.com');
  assert.throws(() => allowedDestination('web.push.apple.com:443'));
  const keys = pushKeys();
  assert.equal(pushSubscription({endpoint: 'https://web.push.apple.com/QH4', keys}).endpoint, 'https://web.push.apple.com/QH4');
  for (const endpoint of ['http://web.push.apple.com/x', 'https://web.push.apple.com:8443/x', 'https://user@web.push.apple.com/x', 'https://evil.test/x', 'https://127.0.0.1/x', 'not a url']) {
    assert.throws(() => pushSubscription({endpoint, keys}), endpoint);
  }
  assert.throws(() => pushSubscription({endpoint: 'https://fcm.googleapis.com/x', keys: {...keys, auth: 'short'}}));
  assert.throws(() => pushSubscription({endpoint: 'https://fcm.googleapis.com/x'}));
});
test('all private, mapped, reserved, metadata and tailnet addresses are denied', () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.30.91.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.254', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:100.100.100.100']) {
    assert.equal(publicAddress(address), false, address);
  }
  assert.equal(publicAddress('1.1.1.1'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});
test('execution tools are never allowlisted', () => {
  for (const name of ['exec', 'exec_command', 'write_stdin', 'bash', 'read', 'write', 'edit', 'apply_patch', 'view_image', 'browser', 'spawn_agent', 'notebook', 'ask; bash']) assert.throws(() => requireAllowedTool(name));
  for (const name of ALLOWED_TOOLS) assert.doesNotThrow(() => requireAllowedTool(name));
});
test('image references reject traversal, secrets, sibling conversations and symlinks', async t => {
  const root = await tempDir(t, 'home-chat-policy-');
  const cwd = join(root, 'work'); await mkdir(join(cwd, 'uploads'), {recursive: true});
  await writeFile(join(cwd, 'uploads/ok.png'), 'image'); await writeFile(join(root, 'secret.png'), 'secret');
  await symlink(join(root, 'secret.png'), join(cwd, 'uploads/link.png'));
  assert.equal(await allowedImagePath('uploads/ok.png', cwd), join(cwd, 'uploads/ok.png'));
  for (const path of ['../secret.png', 'uploads/../../secret.png', 'uploads/link.png', '/data/profile/auth.json']) await assert.rejects(() => allowedImagePath(path, cwd));
  await assert.rejects(() => validateToolInput('imagegen', {referenced_image_paths: ['../secret.png']}, cwd));
});
test('web tool rejects local URLs and non-HTTP schemes', async () => {
  for (const url of ['file:///data/profile/auth.json', 'http://localhost', 'https://host.docker.internal', 'http://100.64.0.1', 'http://[::1]', 'https://example.tailnet-example.ts.net', 'http://user:pass@example.com']) {
    await assert.rejects(() => validateToolInput('web_run', {open: [{ref_id: url}]}, '/tmp'));
  }
  await validateToolInput('web_run', {open: [{ref_id: 'https://example.com/article'}]}, '/tmp');
  await validateToolInput('web_run', {}, '/tmp');
});

test('tool input lists that are not lists are rejected, not skipped', async () => {
  await assert.rejects(() => validateToolInput('web_run', {open: 'http://localhost'}, '/tmp'));
  await assert.rejects(() => validateToolInput('web_run', {find: {ref_id: 'http://localhost'}}, '/tmp'));
  await assert.rejects(() => validateToolInput('imagegen', {referenced_image_paths: '/data/profile/auth.json'}, '/tmp'));
  await assert.rejects(() => validateToolInput('web_run', null, '/tmp'));
  // imagegen's schema allows null for "no reference images".
  await validateToolInput('imagegen', {prompt: 'A landscape', referenced_image_paths: null}, '/tmp');
});

test('documents need a one-line title, bounded text and a well-formed revision id', async () => {
  assert.deepEqual(documentInput({title: '  Trip\n plan ', markdown: '## Day 1'}), {title: 'Trip plan', markdown: '## Day 1'});
  const revises = 'doc_' + 'a'.repeat(32);
  assert.equal(documentInput({title: 'Plan', markdown: 'x', revises}).revises, revises);
  for (const input of [{title: ' ', markdown: 'x'}, {title: 'x'.repeat(201), markdown: 'x'}, {title: 'Plan', markdown: ''},
    {title: 'Plan', markdown: 'x'.repeat(256 * 1024 + 1)}, {title: 'Plan', markdown: 'x', revises: '../doc'}, {title: 'Plan', markdown: 'x', revises: null}]) {
    await assert.rejects(() => validateToolInput('document', input, '/tmp'), JSON.stringify(input).slice(0, 80));
  }
});
test('document reads stay inside the conversation documents directory', async t => {
  const root = await tempDir(t, 'home-chat-policy-');
  const cwd = join(root, 'work'); await mkdir(join(cwd, 'documents'), {recursive: true});
  const name = `doc_${'b'.repeat(32)}_v1.json`;
  await writeFile(join(cwd, 'documents', name), '{}'); await writeFile(join(cwd, 'documents/notes.json'), '{}');
  await writeFile(join(root, name), '{}');
  await symlink(join(root, name), join(cwd, 'documents', `doc_${'c'.repeat(32)}_v1.json`));
  assert.equal(await allowedDocumentPath('documents/' + name, cwd), join(cwd, 'documents', name));
  for (const path of ['documents/notes.json', '../' + name, `documents/doc_${'c'.repeat(32)}_v1.json`, 'uploads/x.png']) {
    await assert.rejects(() => allowedDocumentPath(path, cwd), path);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedDestination, publicAddress, requireAllowedTool, allowedImagePath, validateToolInput } from '../src/policy.ts';

test('egress accepts only exact provider hosts on TLS port', () => {
  assert.equal(allowedDestination('chatgpt.com:443'), 'chatgpt.com');
  for (const host of ['127.0.0.1:443', '100.64.0.1:443', '[::1]:443', 'host.docker.internal:443', 'chatgpt.com.evil.test:443', 'chatgpt.com:80', 'chatgpt.com.:443', 'CHATGPT.COM:443', 'user@chatgpt.com:443']) {
    assert.throws(() => allowedDestination(host));
  }
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
  for (const name of ['ask', 'web_run', 'imagegen']) assert.doesNotThrow(() => requireAllowedTool(name));
});
test('image references reject traversal, secrets, sibling conversations and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'home-chat-policy-'));
  try {
    const cwd = join(root, 'work'); await mkdir(join(cwd, 'uploads'), {recursive: true});
    await writeFile(join(cwd, 'uploads/ok.png'), 'image'); await writeFile(join(root, 'secret.png'), 'secret');
    await symlink(join(root, 'secret.png'), join(cwd, 'uploads/link.png'));
    assert.equal(await allowedImagePath('uploads/ok.png', cwd), join(cwd, 'uploads/ok.png'));
    for (const path of ['../secret.png', 'uploads/../../secret.png', 'uploads/link.png', '/data/profile/auth.json']) await assert.rejects(() => allowedImagePath(path, cwd));
    await assert.rejects(() => validateToolInput('imagegen', {referenced_image_paths: ['../secret.png']}, cwd));
  } finally { await rm(root, {recursive: true}); }
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

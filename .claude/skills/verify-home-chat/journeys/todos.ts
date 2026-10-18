#!/usr/bin/env node
/// <reference lib="dom" />
// The Todos journey on phones: the owner makes a shared list, the guest sees and changes it, the owner clears done
// items and deletes the list. Each step is checked on screen and in todos.json. No model inference.
// Run from the repo root: .claude/skills/verify-home-chat/stack.sh run node .claude/skills/verify-home-chat/journeys/todos.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright-core';
import { openSignedIn } from '../../../../scripts/browser-session.ts';

assert.equal(process.env.COMPOSE_PROJECT_NAME, 'home-chat-verify', 'Run through stack.sh run, so docker compose targets the verification stack');
const out = `.local/verify/todos-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, {recursive: true});
const title = `Groceries ${Date.now().toString(36)}`;
const passed: string[] = [];
const pass = (step: string) => { passed.push(step); console.log('PASS ' + step); };

type Stored = {lists: {title: string; owner: string; shared: boolean; items: {text: string; done: boolean}[]}[]};
const stored = () => (JSON.parse(execFileSync('docker', ['compose', 'exec', '-T', '--user', '10001:10001', 'app', 'cat', '/data/todos.json'], {encoding: 'utf8'})) as Stored)
  .lists.find(list => list.title === title);

const openTodos = async (phone: Page) => {
  await phone.locator('#open-sidebar').click();
  await phone.locator('#todos-entry button').click();
  await phone.locator('#todos-page').waitFor({state: 'visible'});
};
const card = (phone: Page) => phone.locator('.todo-card', {has: phone.getByRole('heading', {name: title})});
const item = (phone: Page, text: string) => card(phone).locator('.todo-item', {hasText: text});
const add = async (phone: Page, text: string) => {
  await card(phone).getByRole('textbox', {name: `Add an item to ${title}`}).fill(text);
  await card(phone).getByRole('button', {name: `Add to ${title}`}).click();
  await item(phone, text).waitFor({state: 'visible'});
};
const capture = async (phone: Page, name: string) => {
  await phone.screenshot({path: `${out}/${name}.png`, fullPage: true});
  await writeFile(`${out}/${name}.aria.yml`, await phone.locator('#todos-page').ariaSnapshot());
};

let owner: Awaited<ReturnType<typeof openSignedIn>> | undefined;
let guest: typeof owner;
let current: Page | undefined;
try {
  owner = await openSignedIn('owner');
  guest = await openSignedIn('guest');
  const phone = current = await owner.openPhone();
  await openTodos(phone);
  assert.equal(await card(phone).count(), 0);
  await capture(phone, '01-owner-opened');

  await phone.locator('#todo-new-title').fill(title);
  await phone.locator('#todo-new-shared').check();
  await phone.getByRole('button', {name: 'Make list'}).click();
  await card(phone).waitFor({state: 'visible'});
  assert.equal(await card(phone).locator('.pill').isVisible(), true, 'The new list is not marked Shared');
  await add(phone, 'Milk');
  await add(phone, 'Eggs');
  await card(phone).getByRole('checkbox', {name: 'Milk'}).check();
  await card(phone).locator('.todo-item.done', {hasText: 'Milk'}).waitFor({state: 'visible'});
  await capture(phone, '02-owner-made-list');
  const made = stored();
  assert.deepEqual(made && {owner: made.owner, shared: made.shared, items: made.items.map(({text, done}) => ({text, done}))},
    {owner: 'owner', shared: true, items: [{text: 'Milk', done: true}, {text: 'Eggs', done: false}]});
  pass('owner makes a shared list, adds Milk and Eggs, ticks Milk; todos.json agrees');

  const guestPhone = current = await guest.openPhone();
  await openTodos(guestPhone);
  await card(guestPhone).waitFor({state: 'visible'});
  assert.equal(await item(guestPhone, 'Milk').getAttribute('class'), 'todo-item done');
  assert.equal(await card(guestPhone).getByRole('button', {name: 'Delete', exact: true}).count(), 0, 'The guest can delete the owner’s list');
  await add(guestPhone, 'Bread');
  await capture(guestPhone, '03-guest-added-bread');
  assert.deepEqual(stored()?.items.map(each => each.text), ['Milk', 'Eggs', 'Bread']);
  pass('guest sees the shared list without Delete and adds Bread; todos.json agrees');

  current = phone;
  await phone.locator('#todos-close').click();
  await openTodos(phone);
  await item(phone, 'Bread').waitFor({state: 'visible'});
  await card(phone).getByRole('button', {name: 'Clear done'}).click();
  await item(phone, 'Milk').waitFor({state: 'detached'});
  await capture(phone, '04-owner-sees-bread-cleared-milk');
  assert.deepEqual(stored()?.items.map(each => each.text), ['Eggs', 'Bread']);
  pass('owner reopens Todos, sees Bread, clears done items; todos.json agrees');

  phone.once('dialog', dialog => dialog.accept());
  await card(phone).getByRole('button', {name: 'Delete', exact: true}).click();
  await card(phone).waitFor({state: 'detached'});
  await capture(phone, '05-owner-deleted-list');
  assert.equal(stored(), undefined);
  pass('owner deletes the list; it is gone from the page and todos.json');

  assert.deepEqual([...owner.errors, ...guest.errors], []);
  pass('no JavaScript errors on either phone');
  for (const session of [owner, guest]) {
    await session.page.locator('#logout').click();
    await session.page.locator('#login').waitFor({state: 'visible'});
  }
} catch (error) {
  await current?.screenshot({path: `${out}/failure.png`, fullPage: true}).catch(() => {});
  throw error;
} finally {
  await writeFile(`${out}/results.json`, JSON.stringify({list: title, passed}, null, 2) + '\n');
  console.log(`Evidence in ${out}`);
  await owner?.browser.close();
  await guest?.browser.close();
}

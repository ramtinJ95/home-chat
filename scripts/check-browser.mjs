import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';

await mkdir('.local', {recursive: true, mode: 0o700});
// Keep the local preview code in process memory only; never log or persist it.
let code = execFileSync('docker', ['compose', 'exec', '-T', '--user', '10001:10001', 'app', 'node', 'scripts/show-access.mjs', 'owner'], {encoding: 'utf8'}).trim();
const browser = await chromium.launch({executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
const errors = [];
try {
  const context = await browser.newContext({viewport: {width: 1360, height: 950}});
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8787');
  await page.locator('#access-code').fill(code); code = '';
  await page.locator('#login-form button').click();
  await page.locator('#workspace').waitFor({state: 'visible'});
  assert.equal(await page.locator('#access-code').inputValue(), '');
  await page.screenshot({path: '.local/desktop.png', fullPage: true});
  const picture = await sharp({create: {width: 32, height: 32, channels: 3, background: '#365c4a'}}).png().toBuffer();
  await page.locator('#image-input').setInputFiles({name: 'smoke-test.png', mimeType: 'image/png', buffer: picture});
  await page.locator('#attachments button').waitFor({state: 'visible'});
  await page.locator('#attachments button').click();
  assert.equal(await page.locator('#attachments button').count(), 0);
  const mobile = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, storageState: await context.storageState()});
  const phone = await mobile.newPage(); phone.on('pageerror', error => errors.push(error.message));
  await phone.goto('http://127.0.0.1:8787');
  await phone.locator('#workspace').waitFor({state: 'visible'});
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.screenshot({path: '.local/mobile.png', fullPage: true});
  assert.deepEqual(errors, []);
  await page.locator('#logout').click();
  await page.locator('#login').waitFor({state: 'visible'});
  console.log('PASS real Chromium: local login, upload/removal, logout, desktop/mobile layout; no JavaScript errors. No model inference performed.');
} finally { code = ''; await browser.close(); }

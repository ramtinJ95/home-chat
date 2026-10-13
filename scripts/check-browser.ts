/// <reference lib="dom" />
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { origin, openSignedIn } from './browser-session.ts';

const {browser, context, page, errors} = await openSignedIn();
try {
  assert.equal(await page.locator('#access-code').inputValue(), '');
  await page.screenshot({path: '.local/desktop.png', fullPage: true});
  const picture = await sharp({create: {width: 32, height: 32, channels: 3, background: '#365c4a'}}).png().toBuffer();
  await page.locator('#image-input').setInputFiles({name: 'smoke-test.png', mimeType: 'image/png', buffer: picture});
  await page.locator('#attachments button').waitFor({state: 'visible'});
  await page.locator('#attachments button').click();
  assert.equal(await page.locator('#attachments button').count(), 0);
  const mobile = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, storageState: await context.storageState()});
  const phone = await mobile.newPage(); phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(origin);
  await phone.locator('#workspace').waitFor({state: 'visible'});
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.screenshot({path: '.local/mobile.png', fullPage: true});
  assert.deepEqual(errors, []);
  await page.locator('#logout').click();
  await page.locator('#login').waitFor({state: 'visible'});
  console.log('PASS real Chromium: local login, upload/removal, logout, desktop/mobile layout; no JavaScript errors. No model inference performed.');
} finally { await browser.close(); }

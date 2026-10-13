/// <reference lib="dom" />
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { origin, openSignedIn } from './browser-session.ts';

if (process.argv[2] !== '--confirm-subscription-usage') throw new Error('This live test uses subscription quota, including one generated image. Pass --confirm-subscription-usage to run.');
const {browser, context, page, errors, openPhone} = await openSignedIn();
try {
  assert.equal(await page.locator('#provider-warning').isVisible(), false);
  if (await page.locator('#stop').isVisible() && (await page.locator('#chat-title').innerText()).startsWith('Reply exactly: Home Chat')) {
    await page.locator('#stop').click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#send')!.disabled, undefined, {timeout: 15_000});
  }
  await page.locator('#new-chat').click();
  await page.locator('.empty').waitFor({state: 'visible'});

  const begin = async (text: string) => {
    await page.locator('#message').fill(text);
    const response = page.waitForResponse(response => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.locator('#send').click();
    const accepted = await response;
    assert.equal(accepted.status(), 202, `Message rejected: ${await accepted.text()}`);
  };
  const finish = async () => {
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#send')!.disabled, undefined, {timeout: 240_000});
    const failure = page.locator('.message.assistant').last().locator('.failure');
    assert.equal(await failure.count(), 0, await failure.count() ? await failure.textContent() ?? '' : '');
    return await page.locator('.message.assistant').last().innerText();
  };
  await begin('Reply exactly: Home Chat is ready. Do not use tools.');
  assert.match(await finish(), /Home Chat is ready\./);
  console.log('PASS live browser: streamed subscription reply and turn completion');

  await begin('Use the ask tool to ask me to choose between Tea and Coffee, then briefly acknowledge my answer.');
  await page.locator('#question').waitFor({state: 'visible', timeout: 60_000});
  for (let i = 0; i < 6; i++) {
    if (!await page.locator('#question').isVisible()) {
      await page.waitForTimeout(300);
      if (!await page.locator('#send').isDisabled()) break;
      continue;
    }
    await page.locator('#question button').first().click();
    await page.waitForTimeout(500);
  }
  await finish();
  console.log('PASS live browser: actual ask tool, rendered choices and replies');

  await begin('Use web_run to find the official Cloudflare Tunnel documentation. Reply with the page title and its official URL.');
  assert.match(await finish(), /developers\.cloudflare\.com/);
  console.log('PASS live browser: web search returned official source URL');

  const red = await sharp({create: {width: 64, height: 64, channels: 3, background: '#ff0000'}}).png().toBuffer();
  await page.locator('#image-input').setInputFiles({name: 'red-square.png', mimeType: 'image/png', buffer: red});
  await page.locator('#attachments button').waitFor({state: 'visible'});
  await begin('What is the dominant color in the attached picture? Answer in one word. Do not use tools.');
  assert.match(await finish(), /red/i);
  console.log('PASS live browser: upload and real image understanding');

  await begin('Use imagegen to create one square flat illustration: a small green leaf centered on a cream background, simple shapes, no text, standard quality.');
  await finish();
  const generated = page.locator('.message.assistant').last().locator('img');
  assert.equal(await generated.count(), 1, 'Expected one generated image rendered in the chat');
  await generated.waitFor({state: 'visible'});
  const download = await page.locator('.message.assistant').last().locator('a.download').getAttribute('href');
  const response = await context.request.get(origin + download);
  assert.equal(response.status(), 200); assert.equal(response.headers()['content-type'], 'image/png');
  assert.ok((await response.body()).length > 1000);
  console.log('PASS live browser: image generation, private rendering and authenticated download');
  await page.screenshot({path: '.local/live-desktop.png', fullPage: true});

  const phone = await openPhone();
  await phone.locator('.message.assistant img').last().waitFor({state: 'visible'});
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.screenshot({path: '.local/live-mobile.png', fullPage: true});
  assert.deepEqual(errors, []);
  await page.locator('#logout').click();
  console.log('PASS live desktop/mobile browser checks; all five requested capabilities exercised');
} finally { await browser.close(); }

import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import type { User } from '../src/api.d.ts';

export const origin = 'http://127.0.0.1:8787';

// Signs in as owner, or as `user`. The access code is read from the container and never logged or persisted.
export async function openSignedIn(user: User = 'owner') {
  await mkdir('.local', {recursive: true, mode: 0o700});
  const code = execFileSync('docker', ['compose', 'exec', '-T', '--user', '10001:10001', 'app', 'node', 'scripts/show-access.ts', user], {encoding: 'utf8'}).trim();
  const browser = await chromium.launch({executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
  const errors: string[] = [];
  try {
    const context = await browser.newContext({viewport: {width: 1360, height: 950}});
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#access-code').fill(code);
    await page.locator('#login-form button').click();
    await page.locator('#workspace').waitFor({state: 'visible'});
    // The same signed-in session at phone size; its JavaScript errors land in `errors` too.
    const openPhone = async () => {
      const mobile = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, storageState: await context.storageState()});
      const phone = await mobile.newPage(); phone.on('pageerror', error => errors.push(error.message));
      await phone.goto(origin);
      await phone.locator('#workspace').waitFor({state: 'visible'});
      return phone;
    };
    return {browser, context, page, errors, openPhone};
  } catch (error) { await browser.close(); throw error; }
}

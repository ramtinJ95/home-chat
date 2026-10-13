import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.argv[2] !== '--i-accept-shared-refresh-session') throw new Error('Explicit acknowledgement required; copied OAuth refresh sessions can conflict with the original login.');
let credential;
try {
  const source = JSON.parse(await readFile(join(homedir(), '.codex/auth.json'), 'utf8'));
  const tokens = source.tokens;
  if (typeof tokens?.access_token !== 'string' || typeof tokens?.refresh_token !== 'string') throw new Error();
  const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString('utf8'));
  const accountId = tokens.account_id ?? claims['https://api.openai.com/auth']?.chatgpt_account_id;
  if (!Number.isFinite(claims.exp) || typeof accountId !== 'string') throw new Error();
  credential = {type: 'oauth', access: tokens.access_token, refresh: tokens.refresh_token, expires: claims.exp * 1000, accountId};
} catch { throw new Error('The Codex CLI profile has no readable subscription OAuth credential'); }
const result = spawnSync('docker', ['compose', 'exec', '-T', '--user', '10001:10001', 'app', 'node', 'scripts/accept-auth.mjs', '--replace-codex'], {
  input: JSON.stringify({'openai-codex': credential}), encoding: 'utf8', timeout: 15_000,
});
credential = undefined;
if (result.status !== 0) {
  let reason = 'Credential provisioning subprocess failed';
  try { reason = JSON.parse(result.stderr.trim()).message; } catch {}
  throw new Error(reason);
}
console.log('Copied only Codex OAuth into the isolated profile. Original file left unchanged.');

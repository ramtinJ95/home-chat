import { writeFile, mkdir, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
try {
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 64_000) throw new Error('Credential input too large');
}
let parsed;
try { parsed = JSON.parse(input); } catch { throw new Error('Invalid credential envelope'); }
const credential = parsed['openai-codex'];
if (Object.keys(parsed).length !== 1 || credential?.type !== 'oauth' || typeof credential.access !== 'string' || typeof credential.refresh !== 'string') {
  throw new Error('Expected exactly one Codex OAuth credential');
}
await mkdir('/data/profile', {recursive: true, mode: 0o700});
let existing;
try { existing = JSON.parse(await readFile('/data/profile/auth.json', 'utf8')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Existing credential file is not valid JSON; refusing overwrite'); }
if (existing && Object.keys(existing).some(key => key !== 'openai-codex')) throw new Error('Unexpected provider in isolated profile; refusing overwrite');
if (existing && Object.keys(existing).length && process.argv[2] !== '--replace-codex') throw new Error('Credentials already exist in the isolated profile; explicit replacement required');
const temporary = '/data/profile/auth.json.new-' + randomUUID();
await writeFile(temporary, JSON.stringify({'openai-codex': credential}), {mode: 0o600, flag: 'wx'});
await rename(temporary, '/data/profile/auth.json');
console.log('Dedicated Codex credential provisioned; no other provider settings copied.');
} catch (caught) {
  const error = caught as NodeJS.ErrnoException;
  console.error(JSON.stringify({code: error.code ?? 'PROVISIONING_REJECTED', message: error.message}));
  process.exitCode = 1;
}

import {readFile} from 'node:fs/promises';
const user = process.argv[2];
if (!['owner', 'guest'].includes(user)) throw new Error('Choose owner or guest');
const access = JSON.parse(await readFile('/data/local-access.json', 'utf8'));
process.stdout.write(access[user] + '\n');

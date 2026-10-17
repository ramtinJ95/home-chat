import { randomBytes } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { atomicJson } from '../../files.ts';
import { DOCUMENT_FILE, DOCUMENT_ID, MAX_DOCUMENT_FILES, MAX_DOCUMENT_TEXT, MAX_DOCUMENT_TITLE, documentInput } from '../../policy.ts';

export const description = 'Save a titled Markdown document to this conversation. The user sees a card that opens it in a full-screen '
  + 'reader with a contents list built from its headings, and can copy, share or download it. To change a document, call '
  + 'this again with `revises` set to its id; that saves a new version, and the newest version is the one shown.';

export const parameters = Type.Object({
  title: Type.String({maxLength: MAX_DOCUMENT_TITLE, description: 'Shown above the document; not repeated as a heading inside it'}),
  markdown: Type.String({maxLength: MAX_DOCUMENT_TEXT, description: 'The whole document, with ## headings for its sections'}),
  revises: Type.Optional(Type.String({pattern: DOCUMENT_ID.source, description: 'Id of an earlier document in this conversation'})),
});

// Each call writes a new file, documents/<doc>_v<n>.json, and never changes an earlier one. The server attaches new files
// to the reply when the turn ends (src/server.ts), and the app shows the newest version of each document.
// A message's tool calls run in parallel, so saves to one conversation take turns: two never pick the same version or
// pass the limit together.
const saving = new Map<string, Promise<unknown>>();
export function saveDocument(params: unknown, cwd: string): Promise<{text: string; doc: string; version: number}> {
  const run = (saving.get(cwd) ?? Promise.resolve()).then(() => save(params, cwd));
  const settled = run.then(() => {}, () => {});
  saving.set(cwd, settled);
  void settled.then(() => { if (saving.get(cwd) === settled) saving.delete(cwd); });
  return run;
}

async function save(params: unknown, cwd: string) {
  const {title, markdown, revises} = documentInput(params);
  const directory = join(cwd, 'documents');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const saved = (await readdir(directory)).map(file => DOCUMENT_FILE.exec(file)).filter(match => match !== null);
  if (saved.length >= MAX_DOCUMENT_FILES) throw new Error('This conversation has reached its document limit; start a new conversation');
  const doc = revises ?? 'doc_' + randomBytes(16).toString('hex');
  const versions = saved.filter(match => match[1] === doc).map(match => Number(match[2]));
  if (revises && !versions.length) throw new Error('No document with that id in this conversation');
  const version = Math.max(0, ...versions) + 1;
  await atomicJson(join(directory, `${doc}_v${version}.json`), {title, markdown});
  return {text: `Saved “${title}” as document ${doc}, version ${version}. The user can open it from the reply.`, doc, version};
}

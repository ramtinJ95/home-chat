import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

// A new file, on disk before this returns. Its directory is synced too, so the file's name survives a power cut.
export async function syncedFile(path: string, data: string | Buffer): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string) {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

// Synced around the rename, so a power cut leaves either the old record or the new one, never an empty file.
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await syncedFile(temporary, JSON.stringify(value));
    await rename(temporary, path);
  } catch (error) { await rm(temporary, {force: true}); throw error; }
  await syncDirectory(dirname(path));
}

// Undefined when the file does not exist yet.
export async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

// Saves of one file run one at a time, so a slow earlier save never replaces a newer one. A save asked for while another
// is still waiting joins it, since that one writes `value()` as it is when its turn comes; callers that joined share
// its outcome, failure included. A failed save only fails its own callers: the next one still runs.
export function serialSave(path: string, value: () => unknown): () => Promise<void> {
  let last = Promise.resolve();
  let waiting: Promise<void> | undefined;
  return () => {
    waiting ??= last = last.catch(() => {}).then(() => { waiting = undefined; return atomicJson(path, value()); });
    return waiting;
  };
}

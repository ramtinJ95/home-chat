import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

// Synced around the rename, so a power cut leaves either the old record or the new one, never an empty file.
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } catch (error) { await rm(temporary, {force: true}); throw error; }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

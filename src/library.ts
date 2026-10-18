import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Library, LibraryContent, LibraryItem, User } from './api.d.ts';
import { jsonStore, syncedFile } from './files.ts';
import { whenLabel } from './routines.ts';

// The Library, in library.json with the copies under library/. Every item is a copy, so it outlives the conversation
// it came from, and both people see every item; only the person who shared one removes it.
const MAX_SHARED = 100;

// `source`: the conversation and the document or picture in it, so a later version of the same document replaces its
// copy. `file`: the copy, named afresh by every share and written before the list points at it.
type StoredItem = LibraryContent & {id: string; owner: User; at: string; source: string; file: string};
interface Saved { items: StoredItem[]; seen: Partial<Record<User, string>> }

export class LibraryError extends Error {}
export class LibraryMissing extends LibraryError {}

export async function createLibrary(data: string) {
  const path = join(data, 'library.json');
  const files = join(data, 'library');
  await mkdir(files, {recursive: true, mode: 0o700});
  const {saved, change} = await jsonStore<Saved>(path, {items: [], seen: {}});
  // Left by a share or removal the app stopped in the middle of.
  const named = new Set(saved().items.map(item => item.file));
  for (const file of await readdir(files)) if (!named.has(file)) await rm(join(files, file), {force: true});
  // A copy the list no longer names: the change is saved, and a file left behind goes at the next start.
  const discard = (file: string) => rm(join(files, file), {force: true}).catch(() => console.warn('Could not remove a Library file'));
  const view = ({owner, at, source: _source, file: _file, ...item}: StoredItem, user: User): LibraryItem =>
    ({...item, by: owner, mine: owner === user, when: whenLabel(new Date(at))});
  const find = (state: Saved, id: string) => {
    const item = state.items.find(entry => entry.id === id);
    if (!item) throw new LibraryMissing('This was removed from the Library');
    return item;
  };

  const library = (user: User): Library => {
    const {items, seen} = saved();
    return {items: items.map(item => view(item, user)), unseen: items.some(item => item.owner !== user && item.at > (seen[user] ?? ''))};
  };

  return {
    view: library,
    // Answers with the page as it is at that moment, so what it marks seen is what the person is shown.
    seen: async (user: User): Promise<Library> => {
      await change(state => { state.seen[user] = new Date().toISOString(); });
      return library(user);
    },
    // The copy's file and how it shows on the page.
    get: (user: User, id: string) => { const item = find(saved(), id); return {item: view(item, user), path: join(files, item.file)}; },
    // Shared again by the same person from the same source, the item moves to the top with the new copy. `allowed`
    // throws if the sharer may no longer share it; it runs in the change itself, after every wait.
    async share(user: User, source: string, content: LibraryContent, bytes: Buffer | string, allowed: () => void): Promise<LibraryItem> {
      const file = randomBytes(16).toString('hex') + (content.kind === 'picture' ? '.png' : '.json');
      await syncedFile(join(files, file), bytes);
      let replaced: string | undefined;
      let item: StoredItem;
      // Whether the list was being saved: a save that failed may still have reached the disk, naming the new copy, so
      // the copy stays and the next start removes it if the list does not name it.
      let saving = false;
      try {
        item = await change(state => {
          allowed();
          const earlier = state.items.findIndex(entry => entry.owner === user && entry.source === source);
          if (earlier === -1 && state.items.filter(entry => entry.owner === user).length >= MAX_SHARED) {
            throw new LibraryError(`Keep it to ${MAX_SHARED} shared items; stop sharing one first`);
          }
          const id = earlier === -1 ? 'item_' + randomBytes(8).toString('hex') : state.items[earlier].id;
          if (earlier !== -1) replaced = state.items.splice(earlier, 1)[0].file;
          const added: StoredItem = {...content, id, owner: user, at: new Date().toISOString(), source, file};
          state.items.unshift(added);
          saving = true;
          return added;
        });
      } catch (error) { if (!saving) await rm(join(files, file), {force: true}); throw error; }
      if (replaced) await discard(replaced);
      return view(item, user);
    },
    async remove(user: User, id: string): Promise<Library> {
      const file = await change(state => {
        const item = find(state, id);
        if (item.owner !== user) throw new LibraryError('Only the person who shared this can stop sharing it');
        state.items.splice(state.items.indexOf(item), 1);
        return item.file;
      });
      await discard(file);
      return library(user);
    },
  };
}

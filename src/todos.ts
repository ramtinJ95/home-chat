import { randomBytes } from 'node:crypto';
import type { TodoList, User } from './api.d.ts';
import { atomicJson, readJson } from './files.ts';

// Todo lists, in todos.json. A list belongs to the person who made it and is private unless shared, in which case
// everyone in the household can see it and change its items. Only its owner can share, unshare or delete it.
const MAX_LISTS = 30;
const MAX_ITEMS = 200;
export const MAX_TODO_TEXT = 300;
export const MAX_LIST_TITLE = 80;

// Item ids count up per list and are never reused, so a number the model or a page holds never means another item.
interface StoredList { id: string; owner: User; title: string; shared: boolean; version: number; next: number; items: {id: number; text: string; done: boolean}[] }
interface Saved { lists: StoredList[] }

// Thrown for a change that cannot be made as asked; the message goes back to the model or the Todos page.
export class TodoError extends Error {}
// No list with that id or title that this person can see.
export class TodoMissing extends TodoError {}

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();
function text(value: unknown, maximum: number, what: string): string {
  if (typeof value !== 'string' || !oneLine(value) || oneLine(value).length > maximum) throw new TodoError(`${what} must be 1 to ${maximum} characters`);
  return oneLine(value);
}

export async function createTodos(path: string) {
  let saved = await readJson<Saved>(path) ?? {lists: []};
  // Changes run one at a time, each on the state the one before it left; a change counts once it is saved.
  let changing: Promise<unknown> = Promise.resolve();
  const change = <T>(apply: (next: Saved) => T): Promise<T> => {
    const run = changing.catch(() => {}).then(async () => {
      const next: Saved = structuredClone(saved);
      const result = apply(next);
      await atomicJson(path, next);
      saved = next;
      return result;
    });
    changing = run;
    return run;
  };
  const visible = (list: StoredList, user: User) => list.shared || list.owner === user;
  // By id, or for the model also by title, ignoring case; its own list first when two have the same title.
  const find = (state: Saved, user: User, ref: unknown): StoredList => {
    const lists = state.lists.filter(list => visible(list, user));
    const wanted = typeof ref === 'string' ? oneLine(ref).toLowerCase() : undefined;
    const list = lists.find(item => item.id === ref)
      ?? lists.filter(item => item.title.toLowerCase() === wanted).sort((a, b) => Number(b.owner === user) - Number(a.owner === user))[0];
    if (!list) throw new TodoMissing('There is no such list');
    return list;
  };
  // A change to an existing list, which counts up its version.
  const edited = (state: Saved, user: User, ref: unknown) => { const list = find(state, user, ref); list.version++; return list; };
  const owned = (list: StoredList, user: User) => {
    if (list.owner !== user) throw new TodoError('Only the person who made this list can share, unshare or delete it');
  };
  const item = (list: StoredList, id: unknown) => {
    const found = list.items.find(entry => entry.id === id);
    if (!found) throw new TodoError(`There is no item ${String(id)} in “${list.title}”`);
    return found;
  };
  const view = (list: StoredList, user: User): TodoList =>
    ({id: list.id, title: list.title, shared: list.shared, mine: list.owner === user, version: list.version, items: list.items.map(entry => ({...entry}))});

  return {
    list: (user: User): TodoList[] => saved.lists.filter(list => visible(list, user)).map(list => view(list, user)),
    get: (user: User, ref: unknown): TodoList => view(find(saved, user, ref), user),
    create: (user: User, input: {title?: unknown; shared?: unknown}) => change(state => {
      const title = text(input.title, MAX_LIST_TITLE, 'A list name');
      if (state.lists.filter(list => list.owner === user).length >= MAX_LISTS) throw new TodoError(`Keep it to ${MAX_LISTS} lists; delete one first`);
      const list: StoredList = {id: 'list_' + randomBytes(8).toString('hex'), owner: user, title, shared: input.shared === true, version: 1, next: 1, items: []};
      state.lists.push(list);
      return view(list, user);
    }),
    // Anyone who sees a list can rename it; sharing is its owner's choice.
    update: (user: User, ref: unknown, input: {title?: unknown; shared?: unknown}) => change(state => {
      const list = edited(state, user, ref);
      if (input.title !== undefined) list.title = text(input.title, MAX_LIST_TITLE, 'A list name');
      if (input.shared !== undefined) {
        if (typeof input.shared !== 'boolean') throw new TodoError('shared must be true or false');
        owned(list, user);
        list.shared = input.shared;
      }
      return view(list, user);
    }),
    remove: (user: User, ref: unknown) => change(state => {
      const list = edited(state, user, ref);
      owned(list, user);
      state.lists = state.lists.filter(other => other !== list);
      return view(list, user);
    }),
    add: (user: User, ref: unknown, texts: unknown[]) => change(state => {
      const list = edited(state, user, ref);
      const added = texts.map(value => text(value, MAX_TODO_TEXT, 'An item'));
      if (!added.length) throw new TodoError('Nothing to add');
      if (list.items.length + added.length > MAX_ITEMS) throw new TodoError(`A list holds at most ${MAX_ITEMS} items; clear the done ones first`);
      const items = added.map(entry => ({id: list.next++, text: entry, done: false}));
      list.items.push(...items);
      return {list: view(list, user), added: items.map(entry => ({...entry}))};
    }),
    // `done` ticks the items off or puts them back; `text` rewrites one.
    edit: (user: User, ref: unknown, ids: unknown[], input: {done?: unknown; text?: unknown}) => change(state => {
      const list = edited(state, user, ref);
      const items = ids.map(id => item(list, id));
      if (input.done !== undefined && typeof input.done !== 'boolean') throw new TodoError('done must be true or false');
      const rewritten = input.text === undefined ? undefined : text(input.text, MAX_TODO_TEXT, 'An item');
      for (const entry of items) {
        if (typeof input.done === 'boolean') entry.done = input.done;
        if (rewritten !== undefined) entry.text = rewritten;
      }
      return view(list, user);
    }),
    // The given items, or with `ids` absent every item that is done.
    removeItems: (user: User, ref: unknown, ids?: unknown[]) => change(state => {
      const list = edited(state, user, ref);
      const gone = new Set(ids ? ids.map(id => item(list, id)) : list.items.filter(entry => entry.done));
      list.items = list.items.filter(entry => !gone.has(entry));
      return view(list, user);
    }),
  };
}

export type Todos = Awaited<ReturnType<typeof createTodos>>;

// The todo tool's actions (src/agent/tools/todo.ts) for `user`, answered with the text the model sees.
export async function todoAction(todos: Todos, user: User, input: Record<string, unknown>): Promise<string> {
  const ids = (): unknown[] => {
    if (!Array.isArray(input.items) || !input.items.length) throw new TodoError('items must list the item numbers, from show');
    // Numbers the model wrote as text still count.
    return input.items.map(id => typeof id === 'string' && /^\d+$/.test(id.trim()) ? Number(id) : id);
  };
  const where = (list: TodoList) => `“${list.title}” (${list.shared ? 'shared with the household' : 'private'})`;
  const show = (list: TodoList) => {
    const open = list.items.filter(entry => !entry.done);
    const done = list.items.filter(entry => entry.done);
    const lines = (entries: TodoList['items']) => entries.map(entry => `${entry.id}. ${entry.text}`).join('\n');
    return `${where(list)}, id ${list.id}:\n`
      + (open.length ? `To do:\n${lines(open)}\n` : 'Nothing left to do.\n')
      + (done.length ? `Done:\n${lines(done)}\n` : '');
  };
  switch (input.action) {
    case 'lists': {
      const lists = todos.list(user);
      if (!lists.length) return 'There are no lists yet.';
      return lists.map(list => {
        const open = list.items.filter(entry => !entry.done).length;
        return `- ${where(list)}, id ${list.id}: ${open} to do, ${list.items.length - open} done`;
      }).join('\n');
    }
    case 'show': return show(todos.get(user, input.list));
    case 'create': return `Made the list ${where(await todos.create(user, {title: input.title, shared: input.shared}))}.`;
    case 'add': {
      if (!Array.isArray(input.items)) throw new TodoError('items must list the texts to add');
      const {list, added} = await todos.add(user, input.list, input.items);
      return `Added to ${where(list)}: ${added.map(entry => `${entry.id}. ${entry.text}`).join('; ')}.`;
    }
    case 'complete': case 'reopen': return show(await todos.edit(user, input.list, ids(), {done: input.action === 'complete'}));
    case 'remove': return show(await todos.removeItems(user, input.list, ids()));
    default: throw new TodoError('action must be lists, show, create, add, complete, reopen or remove');
  }
}

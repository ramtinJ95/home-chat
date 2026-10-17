# Household features

Planned 2026-10-17, after the move to Pi Durable (`docs/durable-migration.md`). Built on `feat/household-sharing`,
which starts from `feat/pi-durable`. Calendar and email come after these and block nothing here.

From the request: "separate and shared conversations between wife and i all shared in the app itself so we can share
conversations or artifacts easily in app if we choose to", and "in app todos for different things which we can add to
from shared or separate conversations".

## Order

1. **Todos.** Named lists, each private or shared, kept on a Todos page and through a `todo` tool.
2. **Shared conversations.** A conversation is private until its owner shares it; then both read and write in it.
3. **Shared library.** A single document or picture shared without its conversation, on one page for both.

Each is its own PR, in this order.

## Decisions

| Decision | Outcome |
| --- | --- |
| Shared conversations | Both people read and write; the model is told who is speaking, and a memory change applies to the sender's notes (chosen 2026-10-17) |
| Sharing one artifact | A "Shared" library page listing what either person shared, newest first; unsharing removes it there (chosen 2026-10-17) |
| Order | Todos first (chosen 2026-10-17) |
| Who may share, unshare and delete | The owner of the list or conversation; the other person can change a shared list's items and name |
| Todo tool | No confirmation: items are visible and easy to undo. It cannot delete or unshare a list; the page does that. Routine runs may use it |
| Names | Each person's display name comes from optional `.env` settings, falling back to owner and guest (from step 2) |
| Routine conversations | Stay private |

## 1. Todos

- `todos.json` on the data volume, saved like the household notes: changes run one at a time, each saved atomically.
  A list has an owner, a name, a shared flag and items. Item numbers count up per list and are never reused, so a
  number the model or a page holds never means another item.
- Limits: 30 lists per person, 200 items per list, 300 characters per item, 80 per list name.
- The `todo` tool lists, shows, creates and adds to lists, and ticks items off, puts them back or removes them. It
  finds a list by id or by name, the person's own list first when two share a name. The server answers in plain text.
- The Todos page: a card per list with its items (open ones first), an add field, Clear done, Rename, and for its owner
  Share or Make private and Delete. Every change saves at once. The page reloads the lists when it comes back into view,
  which is how it catches changes made on the other phone; there is no live stream for lists.

## 2. Shared conversations

To be planned in detail once todos are merged: sharing in the conversation's menu, a Shared section in the sidebar,
who-said-what on messages and in the prompt, which notes a turn uses, push to the other person, search, and delete.

## 3. Shared library

To be planned after step 2.

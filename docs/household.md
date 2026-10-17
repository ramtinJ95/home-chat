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

- **Sharing.** A conversation has an owner and is private until the owner shares it from the conversation's header,
  and private again the same way. Routine conversations can't be shared. Making one private again closes the other
  person's open view of it at once; it waits while a reply is running.
- **Who sees what.** A shared conversation is listed for both under Shared in the sidebar, above Recent, and both can
  open it, send, attach pictures, answer the model's questions, stop a reply and switch deep research. Only the owner
  deletes it or changes its sharing. Its documents and pictures follow the conversation. Search covers it for both.
- **Who is speaking.** Every message records its sender (`by`). In a shared conversation the server's note before the
  message tells the model who wrote it, by name. The user's text still follows the fixed prefix, so it can't pose as
  that note. The app shows the sender's name on messages in a shared conversation.
- **Whose things a turn changes.** The turn's sender: their household notes go into the instructions (with the shared
  ones), and `memory`, `todo` and `routine` act for them. A turn records its sender for this. Only the sender of the
  last message can regenerate or edit it.
- **One reply at a time per person.** The rule that a person has at most one reply running counts the turns they sent,
  so one person's reply in a shared conversation doesn't block the other person elsewhere.
- **Names.** `HOME_CHAT_OWNER_NAME` and `HOME_CHAT_GUEST_NAME` in `.env`, optional; without them the app and the model
  say "the owner" and "the guest". `GET /api/me` returns both names.
- **Notifications.** As now, a finished reply or a waiting question notifies its sender when they are not looking. The
  other person gets an unread dot on the conversation, not a push: a push for every message in a busy shared
  conversation would be noise. Unread is kept per person.

## 3. Shared library

- **What.** A document or picture from any conversation either person can see, shared on its own: the conversation
  stays as private as it was. Shared items are listed on one Library page for both, newest first.
- **A copy, not a link.** Sharing copies the document or picture into the library, so the other person sees exactly
  what was shared. Deleting the conversation it came from keeps the copy. Sharing the same document again, after the
  model revised it, replaces your earlier copy instead of adding a second one. In a shared conversation each person's
  copy is their own, so stopping sharing yours never removes the other person's.
- **Sharing.** "Share with <name>" on a picture in the thread and in the document reader. Only the person who shared an
  item can stop sharing it, which removes the copy. The other person can open, copy and download it.
- **Noticing.** The Library entry in the sidebar gets an unread dot when the other person shared something since this
  person last opened the page; an open app hears of it at once over its conversation stream, and an open Library page
  redraws. No push, as for conversations.
- **Storage.** `library.json` lists the items; each copy is a file under `library/` named by a fresh id, synced to disk
  before the list points at it. A file the list does not name, left by an interrupted share or removal, is deleted at startup.
  At most 100 items per person, and the copies count towards the app's storage limit like uploads.

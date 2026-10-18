# Todos

The Todos page holds lists, each private to the person who made it or shared with the household. Either person can add,
tick, remove and clear items on a shared list and rename it. Only its maker can make it private or delete it.

## Sub-features

- `todos-create`: make a list, private or shared ("Share with the household").
- `todos-items`: add, tick, untick and remove items. Done items move below the open ones.
- `todos-clear`: "Clear done" removes the ticked items.
- `todos-rename`: "Rename" through a `prompt()` dialog.
- `todos-share`: "Share with the household" and "Make private", for the maker only.
- `todos-delete`: "Delete" after a `confirm()` dialog, for the maker only.
- `todos-household`: the other person sees a shared list, can change it, and has no Delete or share buttons.

## How to get to it (user POV)

- Sidebar → "Todos" (on phones, open the drawer first). The page is `#todos-page`, and its back button is `#todos-close`.
- Asking in a conversation ("add milk to groceries") uses the model's `todo` tool. That path needs Codex, so treat it
  as part of [Conversations](./conversations.md).

## Driving it with browser-session.ts

Preconditions:

- `stack.sh doctor` prints `OK`. Codex isn't needed.

The journey script covers `todos-create` (shared), `todos-items` (add and tick), `todos-clear`, `todos-delete` and
`todos-household`:

```sh
.claude/skills/verify-home-chat/stack.sh run node .claude/skills/verify-home-chat/journeys/todos.ts
```

- **Open.** On the owner's phone, tap `#open-sidebar`, then `#todos-entry button`. `#todos-page` is visible.
- **Create.** Fill `#todo-new-title`, check `#todo-new-shared`, then tap the "Make list" button. A `.todo-card` with that
  heading appears and its "Shared" tag (`.pill`) shows.
- **Items.** In the card, fill the textbox "Add an item to <title>" and tap "Add to <title>". A `.todo-item` with the text
  appears. Ticking the checkbox named after the item gives the row the class `todo-item done`.
- **Stored.** `stack.sh data todos.json` lists the title with `owner: "owner"`, `shared: true` and the items with their
  `done` flags.
- **Household.** Sign in as guest on a phone and open Todos. The same card is there without "Delete", and an item the
  guest adds is in `todos.json` too.
- **Owner catches up.** Tap `#todos-close` and reopen Todos. The guest's item is shown.
- **Clear and delete.** "Clear done" removes the ticked rows. Accept the `confirm()` and tap "Delete", and the card
  goes away and the list is gone from `todos.json`.
- **Not in the script yet.** `todos-rename` (accept the `prompt()` with a new name; the heading changes) and
  `todos-share` ("Make private"; the guest's card disappears after the guest reopens Todos), and a pass at 1360x950
  on `page`.
- **Proof.** `.local/verify/todos-<time>/` holds screenshots and ARIA snapshots `01` to `05` and `results.json`.

## Gotchas

- `todos.json` doesn't exist until the first list is made, so `stack.sh data todos.json` fails on a fresh volume.
- The page reloads lists only when it opens or comes back into view. To see the other person's change, close and reopen
  Todos rather than waiting.
- Lists are capped at 30 per person and items at 200 per list. Journeys delete what they make so reruns stay below that.

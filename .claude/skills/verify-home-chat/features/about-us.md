# About us

About us holds short notes that the model is told in every conversation. Each person has their own notes, which only
they see, and there are shared household notes that both can read and change. The page won't overwrite notes that
changed after it opened.

## Sub-features

- `about-edit`: edit "About you" (`#about-mine`) and "Shared with the household" (`#about-shared`), one note per line,
  then Save.
- `about-scope`: the other person sees the shared notes but not your own notes.
- `about-conflict`: saving over notes that changed since the page opened is refused.
- `about-model`: the model suggests a note and saves it after the user answers Yes. Needs Codex; see
  [Conversations](./conversations.md).

## How to get to it (user POV)

- Sidebar → "About us". The page is `#about`, its form is `#about-form`, the Save button is in the header, and the back
  button is `#about-close`.

## Driving it with browser-session.ts

Preconditions:

- `stack.sh doctor` prints `OK`. Codex isn't needed. The notes start empty, and `memory.json` doesn't exist until the
  first save, so `stack.sh data memory.json` fails until then.

- **Open.** On the owner's phone, tap `#open-sidebar`, then `#about-entry button`. `#about` is visible, both
  textareas are empty, the drawer has closed, `.workspace` is `inert`, and focus is on `#about-close`.
- **Save.** Fill `#about-mine` with `Vegetarian, but eats fish` and `#about-shared` with `We live in Stockholm`, then
  tap the "Save" button. `#error.info` reads "Saved. Home Chat keeps this in mind from your next message."
- **Stored.** `stack.sh data memory.json` reads
  `{"version":1,"people":{"owner":["Vegetarian, but eats fish"]},"shared":["We live in Stockholm"]}`. The version goes
  up with each save, and `people.guest` appears once the guest saves.
- **Scope.** Sign in as guest and open About us. `#about-shared` shows `We live in Stockholm`, and `#about-mine` is
  empty.
- **Conflict.** With About us open on the owner's phone, change and save the shared notes as the guest. Then save on
  the owner's phone: `#error` (without `.info`) reads "These notes were changed meanwhile; open About us again to see
  the latest".
- **Cleanup.** Tap `#about-close` and open About us again first: after a refused save the page still holds the old
  version, so saving from it is refused again. Closing with unsaved edits asks "Leave without saving your changes to
  About us?", so accept that dialog. Then empty both textareas and save, so `memory.json` has empty lists.

## Gotchas

- Lines are trimmed, runs of spaces inside them collapse to one, and duplicates are removed. A line over 300
  characters is refused with "A note must be 1 to 300 characters", and more than 30 notes with "Keep it to 30 notes".
  Assert on the stored lines, not on the text that was typed.
- The toast `#error` serves both errors and confirmations. A confirmation has the class `info`, so check the class as
  well as the text.

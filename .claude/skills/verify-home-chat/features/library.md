# Library

The Library is one page of documents and pictures that either person shared from a conversation. Sharing makes a copy,
so the item stays after its conversation is deleted, and the conversation itself stays private. Both people see every
item, newest first, and only the person who shared one can take it back out.

## Sub-features

- `library-share`: "Share with <other>" under a picture in a conversation, or `#reader-library` in an open document,
  copies it into the Library and shows "Shared with <other>. It’s in the Library." Needs Codex, since only a model
  reply makes a picture or document.
- `library-page`: the page lists `.library-card` items with "You shared it · <when>" or "From <name> · <when>". A
  document card has "Open", which opens `#reader`, and every card has "Download".
- `library-remove`: the sharer's "Stop sharing" asks "Stop sharing <name>? It will be gone from the Library for both of
  you." and removes it for both people.
- `library-new`: the sidebar entry has a dot named "Newly shared" while the other person has shared something this
  person hasn't seen. Opening the Library clears it.

## How to get to it (user POV)

- Sidebar → "Library" (`#library-entry button`, after `#open-sidebar` on phones). The page is `#library-page`, its
  intro is `#library-lede`, the cards are in `#library-cards`, and the back button is `#library-close`.

## Driving it with browser-session.ts

Preconditions:

- The empty page needs no model. Drive it for owner and guest on phones, then on desktop.
- Everything else needs a picture or document from a model reply, so `stack.sh doctor` must print
  `Codex signed in: true`. Without that, report `NOT RUN: Codex is not signed in` for the rest.

- **Empty.** Open the Library. `#library-lede` reads "Documents and pictures you and the guest shared from your
  conversations, newest first. The conversations they came from stay as private as they were." `#library-cards` reads
  "Nothing here yet. Tap “Share with the guest” on a picture or in a document." The guest sees the same with "the
  owner". `#library-close` returns to the conversation.
- **Share.** In a conversation with a generated picture, tap "Share with the guest" under it. The notice reads "Shared
  with the guest. It’s in the Library." `stack.sh data library.json` has the item in `items`.
- **New dot.** Sign in as guest. The Library entry has the "Newly shared" dot. Open the Library: the card reads "From
  the owner · <when>" and has no "Stop sharing". Close it, and the dot is gone. `library.json` has `seen.guest` set.
- **Remove.** As owner, tap "Stop sharing" on the card and accept the dialog. The card is gone for both people, and
  so is the item in `library.json`.

## Gotchas

- `library.json` doesn't exist on a fresh volume. Opening the Library writes it, with `seen` set for that person and no
  items, so check `items` rather than whether the file exists. The copies are under `library/` on the volume.

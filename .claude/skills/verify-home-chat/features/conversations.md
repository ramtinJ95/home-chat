# Conversations

A conversation is where the user asks and the model replies, with streamed text, questions it asks back, pictures,
document cards and web results. A conversation can be starred to keep it at the top of the sidebar, and shared with the
household. Search finds earlier conversations. Replies come from the real Codex model, so sending and everything that
follows a reply need Codex signed in and use quota. Making, starring, sharing, searching by title and deleting
conversations need no model.

## Sub-features

- `chat-send`: send a message and get a streamed reply. `#stop` stops it. Needs Codex.
- `chat-ask`: the model's `ask` tool shows choices in `#question`, and tapping one continues the reply. Needs Codex.
- `chat-picture`: attach a picture (`#image-input`), which the model can see. Attaching and removing it before sending
  needs no model. `imagegen` renders an image with a "Download" link (`a.picture-action`) and "Share with <other>",
  which puts it in the [Library](./library.md). Needs Codex.
- `chat-document`: a longer result arrives as a document card. Open shows `#reader` with `#reader-copy`,
  `#reader-download` (`?download=1`), `#reader-library` ("Share with <other>"), `#reader-share` (only where the
  browser has `navigator.share`) and `#reader-close`. Needs Codex.
- `chat-actions`: Copy and Share a finished reply (Share only where the browser has `navigator.share`), Regenerate the
  last reply, Edit the last message. Needs Codex.
- `chat-star`: each person stars conversations for themselves. `#star-chat` in the header and the row's `.chat-star`
  ("Star “<title>”") toggle it, with `aria-pressed`. Starred conversations sit in `#starred-list`, oldest star first, and
  leave Shared and Recent. Routine conversations have no star.
- `chat-share`: `#share-chat` lists the conversation under Shared for both people, and both can write in it.
- `chat-search`: `#search` finds conversations by title and message words and opens the matching message.
- `chat-delete`: the owner deletes a conversation from its sidebar row. This is refused while a reply is running.
- `chat-sidebar`: from the top, the sidebar shows `#search-results`, Starred (`#starred`), Routines (`#routines`),
  Shared (`#shared`) and Recent (`#recent-label`, `#chat-list`). The first four hide when they are empty, and while
  searching only the results show. A row with replies the person hasn't seen has a dot named "New messages". Needs
  Codex for the dot.

## How to get to it (user POV)

- Sidebar → "New conversation" (`#new-chat`), type in `#message` and tap Send (`#send`).
- Tap a row in the sidebar lists above.
- Opening a link `/?chat=<id>` from a notification.

## Driving it with browser-session.ts

Preconditions for the parts that need no model:

- `stack.sh doctor` prints `OK`. Each person starts with one empty "New conversation". Tap `#new-chat` for a second.

- **Star.** Tap a row's `.chat-star`, then `#star-chat` on another conversation. Both are in `#starred-list` in the
  order they were starred, both buttons have `aria-pressed="true"`, and `stack.sh data chats/<id>/chat.json` has
  `starred.owner` set to the time. Unstarring moves a row back to Shared or Recent.
- **Share.** As owner, tap `#share-chat`. `#share-label` and `#privacy` read "Shared", and `chat.json` has
  `shared: true`. Sign in as guest: the conversation is in `#shared-list`, `#shared-by` reads "Shared by the owner",
  `#share-chat` is hidden, and the row has a `.chat-mark` where the owner's has Delete. The owner's private
  conversations are absent. The guest can star it for themselves, which sets only `starred.guest`.
- **Unshare.** Tap `#share-chat` again and accept "Make “<title>” private again? It will no longer be shared with the
  guest." The guest's next refresh shows "That conversation was deleted or is no longer shared with you." and the
  guest's star is dropped.
- **Title search.** Fill `#search` with a word from a title. `.search-result` rows appear in `#search-results`,
  without a snippet or `<mark>`, and tapping one opens it. A word nothing contains shows "No conversation mentions
  “<word>”."
- **Delete.** Tap the row's button "Delete “<title>”" and accept "Delete “<title>”? Its messages and pictures will be
  gone for good." (with ", for the guest too" when shared). `chat.json` is gone. Deleting the open one opens the newest
  left, or a new empty one when none is.
- **Which conversation is open.** The URL stays `/`. Read the id from `.chat-item.active[data-chat]`.

Preconditions for the rest:

- `stack.sh doctor` prints `Codex signed in: true`. Otherwise report `NOT RUN: Codex is not signed in` for those
  sub-features. The user decides whether to sign in (see SKILL.md, Launch).
- The user has agreed to spend quota on this run.

- **Existing live journey.** `stack.sh run node scripts/check-browser-live.ts --confirm-subscription-usage` covers
  `chat-send`, `chat-ask` (including the `web_run` tool), `chat-picture` (upload and `imagegen`), and the image download
  on desktop. It generates one image.
- **Send.** Fill `#message` and tap `#send`. The POST `/messages` answers 202. When `#send` is enabled again the reply
  is in `.message.assistant`, and that message has no `.failure`.
- **Actions.** On the last `.message.assistant`, the buttons "Copy" and "Regenerate" are shown. Regenerate asks "Write
  a new reply in place of this one? This reply will be gone." On the last user message, "Edit" fills `#message`, and
  `#editing` shows "Cancel" (`#cancel-edit`). Only the person who sent the last message gets Regenerate and Edit.
- **Message search.** Fill `#search` with a word from a sent message. Its `.search-result` has the word in a `<mark>`,
  and tapping it opens the conversation at that message.
- **Stored.** `stack.sh data chats/<id>/chat.json` holds the messages.

## Gotchas

- Without Codex, `POST /messages` answers 503 "Codex is not signed in to this isolated profile yet", nothing is
  stored, and `#provider-warning` is visible. This means the precondition is unmet, not that the app failed.
- Each person can have at most 20 conversations (429 after that) and send at most 30 messages an hour, so repeated runs
  can hit 429.
- Unsharing or deleting while a reply runs is refused with 409.
- A reply may take minutes. `check-browser-live.ts` waits up to 240 s for each turn.
- `#research` (Deep research) only appears when `EXA_API_KEY` is set. The verification stack sets it only if the shell
  or `.env` does.
- Headless Chrome has `navigator.share`, so the Share buttons show there. The branch without it can't be seen in this
  harness without mocking.

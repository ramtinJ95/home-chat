# Conversations

A conversation is where the user asks and the model replies, with streamed text, questions it asks back, pictures,
document cards and web results. A conversation can be shared with the household. Search finds earlier conversations.
Every reply comes from the real Codex model, so this whole feature needs Codex signed in and uses quota.

## Sub-features

- `chat-send`: send a message and get a streamed reply. `#stop` stops it.
- `chat-ask`: the model's `ask` tool shows choices in `#question`, and tapping one continues the reply.
- `chat-picture`: attach a picture (`#image-input`), which the model can see. `imagegen` renders an image with a download
  link.
- `chat-document`: a longer result arrives as a document card. Open shows `#reader` with Copy, Share and Download.
- `chat-actions`: Copy and Share a finished reply, Regenerate the last reply, Edit the last message.
- `chat-share`: `#share-chat` lists the conversation under Shared for both people, and both can write in it.
- `chat-search`: `#search` finds conversations by title and message words and opens the matching message.
- `chat-delete`: delete a conversation from the sidebar. This is refused while a reply is running.

## How to get to it (user POV)

- Sidebar → "New conversation" (`#new-chat`), type in `#message` and tap Send (`#send`).
- Sidebar lists: Recent (`#chat-list`), Shared (`#shared-list`) and search results (`#search-results`).
- Opening a link `/?chat=<id>` from a notification.

## Driving it with browser-session.ts

Preconditions:

- `stack.sh doctor` prints `Codex signed in: true`. Otherwise report `NOT RUN: Codex is not signed in` for every
  sub-feature here. The user decides whether to sign in (see SKILL.md, Launch).
- The user has agreed to spend quota on this run.

- **Existing live journey.** `stack.sh run node scripts/check-browser-live.ts --confirm-subscription-usage` covers
  `chat-send`, `chat-ask`, `chat-picture` (upload and `imagegen`), and the image download at both sizes. It generates one
  image.
- **Send.** Tap `#new-chat`, fill `#message`, tap `#send`. The POST `/messages` answers 202. When `#send` is enabled
  again the reply is in `.message.assistant`, and that message has no `.failure`.
- **Actions.** On the last `.message.assistant`, the buttons "Copy" and "Regenerate" are shown. On the last user
  message, "Edit" fills `#message`, and `#editing` shows "Cancel" (`#cancel-edit`).
- **Share.** As owner, tap `#share-chat`, and its `aria-pressed` becomes `true`. Sign in as guest: the conversation is
  listed in `#shared-list`, and `#shared-by` names the owner.
- **Search.** Fill `#search` with a word from a sent message. A `.search-result` appears in `#search-results` with the
  word in a `<mark>`. Tapping it opens the conversation.
- **Stored.** `stack.sh data chats/<id>/chat.json` (the id is in the page URL or in the response to `GET /api/chats`)
  holds the messages.

## Gotchas

- Without Codex, `POST /messages` answers 503 "Codex is not signed in to this isolated profile yet" and
  `#provider-warning` is visible. This means the precondition is unmet, not that the app failed.
- Each person can send at most 30 messages an hour, so repeated runs can hit 429.
- A reply may take minutes. `check-browser-live.ts` waits up to 240 s for each turn.
- `#research` (Deep research) only appears when `EXA_API_KEY` is set. The verification stack sets it only if the shell
  or `.env` does.

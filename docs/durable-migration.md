# Moving Home Chat to Pi Durable

Started 2026-10-17 on `feat/pi-durable`. The spike on `spike/pi-durable` (74b1b38) showed the four unknowns work:
Codex login through pi-ai, `web_run` and `imagegen` against the Codex endpoints, `ask` waiting on a person, and a
transcript that survives a crash.

## Order of work

1. **Parity.** Pi Durable replaces the Pi CLI worker. Every feature in the checklist below behaves as it does today,
   tested, before anything new is built on it.
2. **Household features.** Todos, and conversations that are either private or shared between the two of us, including
   sharing a conversation or an artifact from the app.
3. **Calendar and email, last.** The providers aren't chosen yet. This phase blocks nothing before it.

Main is deployed throughout. The branch replaces the worker only once the checklist passes.

## Phase 1 decisions

- **In-process harness, one file per conversation.** Each conversation keeps its model transcript in its own SQLite
  file, `chats/<id>/agent.sqlite`, opened by a `Harness` in the server process while the conversation has a worker.
  Pi Durable can't delete a conversation, so a shared file would keep deleted transcripts; with one file per
  conversation, deleting its directory deletes the transcript, as it did Pi's session file (chosen 2026-10-17). No
  more child process per conversation, internal Unix socket or per-worker token.
- **Same seam.** A `DurableWorker` implements the existing `ChatWorker` interface (`src/rpc.ts`), so `server.ts`
  changes as little as possible in phase 1. A link document in the conversation's file names the durable conversation
  it continues.
- **Tools call the server directly.** `routine`, `memory` and `document` become `defineTool` tools that call server
  functions in-process instead of going through `callServer` (`profile/internal.ts`).
- **Mode per turn is passed, not parsed.** Today `profile/extension.ts` reads the turn's notes back out of the prompt
  to decide which tools are refused. Now the server passes `TurnMode` to the tools directly. The note text stays in the
  prompt because the model needs it, but enforcement stops depending on it.
- **Regenerate and edit fork.** Instead of tree navigation in the same session file, the conversation forks at the
  entry before the last user message, and the chat's mapping moves to the fork.
- **Old conversations load on first use.** A chat with no durable id gets a new conversation, seeded from the text
  messages in its `chat.json`. Tool calls and images from the old Pi sessions aren't carried over.
- **Restart behaves as it does today.** A reply cut off by a restart is marked interrupted, as now. Real resume
  (`harness.resume()`) comes after parity. Until then, an assistant entry with `stopReason: 'aborted'` is never shown
  as a reply.
- **Codex login stays in `auth.json`.** It keeps today's shape (one credential per provider id), read by the spike's
  `FileCredentialStore`. `scripts/login-codex.ts` moves from pi-coding-agent's `ModelRuntime` to pi-ai's login.

## Parity checklist

Each item gets a test with pi-ai's faux provider unless marked live.

Turns:

- [x] Streaming text reaches the client as deltas and is saved every 2 s, including text already in the first partial
      and the final tail that only arrives in `message_end` (the spike missed it).
- [x] Tool status labels: `tool` events for all seven tools in `ALLOWED_TOOLS`, no others.
- [x] Abort from the app stops the model call and any running tool.
- [x] Turn limits from `TURN_LIMITS`: 5 minutes and 12 tool calls, or 20 minutes and 30 in deep research; 2 generated
      images per message.
- [x] `validateToolInput`: `web_run` refuses private hosts, `imagegen` paths stay within uploads and generated images.
- [x] Provider failures map to the same messages as `providerFailure` (login refresh, usage limit, HTTP status).
- [x] At most 2 conversations run at once, and a busy server answers 429 as now.
- [x] Response size limit (100 000 characters) still ends the turn.

Tools:

- [x] `ask`: select, input and confirm (nothing asked `editor`), "Other/rephrase" with free text, multiple choice with
      "Finish selection", the comment after each prompt, answer and cancel from the app, push when nobody is watching.
      Left out: pi-ask's `delivery: "steer"` (nothing can take an answer after the turn moves on), `handoff` and `help`.
- [ ] `web_run`: search, open and find (live).
- [ ] `imagegen`: generation and edits from attached or earlier images, saved where `collectGenerated` finds them (live).
- [x] `document`: create and revise, versions kept, cards and reader unchanged.
- [x] `deep_research`: Exa calls in deep research mode, with the stop signal and the 90 s timeout, report saved through
      `document`. Tested against a stubbed Exa; the timeout itself is not exercised.
- [x] `routine`: all actions, scoped to the owner. Routine runs have neither `ask` nor `routine`.
- [x] `memory`: confirm before saving. The household notes join the system prompt before every request.
- [x] No other tools exist: no read, write, edit or bash, whatever Pi Durable ships.

Conversations:

- [x] Uploaded images reach the model with the message.
- [x] Regenerate and edit replace the last turn, and survive a restart. Exception: regenerating the first turn after
      the move, for a conversation from before it, answers the existing 409 ("send a new message instead").
- [x] Existing conversations continue with their earlier text as context.
- [x] Deleting a conversation removes its transcript with its directory, after its worker has closed the file.
- [ ] Restart mid-reply and mid-question: the reply shows as interrupted and the next message works. The agent half is
      tested (a process killed while `ask` waits; the next message works); the whole app still needs a live restart.

Deploy:

- [ ] Dockerfile and compose: SQLite on `/data` with the root filesystem read-only, egress through the proxy, pids and
      memory limits still enough without child processes.
- [ ] `check-network`, `check-runtime`, `check-live` and `check-browser` pass against the branch (live, headless).
- [ ] pi-coding-agent and the `@howaboua/*` add-ons are removed only after the switch-over.

## Status

2026-10-17: the agent is in `src/agent/` and is the server's default worker on this branch. Ticked items have faux-model
tests in `test/agent.test.ts` or are covered by the existing server tests. `check-runtime` and `check-live` run the durable agent, and `login-codex` uses pi-ai's login, writing the same
`auth.json`. Still open: the live checks, the whole-app restart, the deploy check, and removing the Pi CLI path
(`src/rpc.ts` PiWorker, `profile/` apart from `instructions.md`, the internal socket).

## Risks

- Pi Durable is experimental and its API may change without notice. Pin exact versions (pi-durable, chord and pi-ai
  1.3.0) and keep all use of it in `src/agent/`.
- pi-ai labels its Codex provider "legacy". If it goes away, the model call needs its own provider.
- Compaction runs only when a request would not fit, inside the turn (`backgroundTokens: 0`): background compaction
  would keep calling the model after a turn ended or was stopped.
- One process owns a SQLite file, so the server must never run twice against the same `/data`.

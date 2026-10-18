# Moving Home Chat to Pi Durable

Started 2026-10-17 on `feat/pi-durable`. The spike on `spike/pi-durable` (74b1b38) showed the four unknowns work:
Codex login through pi-ai, `web_run` and `imagegen` against the Codex endpoints, `ask` waiting on a person, and a
transcript that survives a crash.

## Phase 1 decisions

- **In-process harness, one file per conversation.** Each conversation keeps its model transcript in its own SQLite
  file, `chats/<id>/agent.sqlite`, opened by a `Harness` in the server process while the conversation has a worker.
  Pi Durable can't delete a conversation, so a shared file would keep deleted transcripts; with one file per
  conversation, deleting its directory deletes the transcript, as it did Pi's session file (chosen 2026-10-17). No
  more child process per conversation, internal Unix socket or per-worker token.
- **Same seam.** A `DurableWorker` implements the existing `ChatWorker` interface (now `src/chat-worker.ts`), so `server.ts`
  changes as little as possible in phase 1. A link document in the conversation's file names the durable conversation
  it continues.
- **Tools call the server directly.** `routine`, `memory` and `todo` are `defineTool` tools that call server functions
  in-process (`src/agent/extension.ts`), where the Pi CLI went through an internal socket. `document` writes its own
  files.
- **Mode per turn is passed, not parsed.** The Pi CLI extension read the turn's notes back out of the prompt to decide
  which tools are refused. Now the server passes `TurnMode` to the tools directly. The note text stays in the
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

## Shipped

Phase 1, parity, shipped in #17. Pi Durable replaced the Pi CLI worker, and every feature kept its behaviour, with one
exception. In a conversation started before the move, regenerating the first turn made after the move answers 409 ("send
a new message instead"). Faux-model tests in `test/agent.test.ts` and the server tests check the rest. The model is
offered exactly the eight tools in `ALLOWED_TOOLS`, and a routine run refuses `ask`, `routine` and `memory`.

In the container, SQLite runs on `/data` under the read-only root filesystem, and egress goes through the proxy
(`check-runtime`, `check-network`). Init has `KILL`, so a stop reaches the server. Docker on home-macmini kills a
container 1 s after SIGTERM unless told otherwise, so compose sets `stop_grace_period: 10s`. A stop while a reply runs
or a question waits then exits cleanly in about 3.4 s. The pids and memory limits are enough. On home-macmini, in the 11 hours after
the 2026-10-17 22:51 UTC restart, the container's cgroup peaked at 133 MiB of its 2 GiB and 28 of its 128 pids. How much
the app was used in that window is not recorded.

On 2026-10-17 on home-macmini, the check scripts, the container tests, both browser checks, web search, an image and its
edit, and restarts mid-reply and mid-question passed live. The same PR then removed the Pi CLI path: `PiWorker`, the
internal socket and its tokens, and pi-coding-agent.

Phase 2, the household features, shipped in #18 to #20 (`docs/household.md`). Phase 3, calendar and email, has not
started.

## Risks

- Pi Durable is experimental and its API may change without notice. Pin exact versions (pi-durable, chord and pi-ai
  1.3.0) and keep all use of it in `src/agent/`.
- pi-ai labels its Codex provider "legacy". If it goes away, the model call needs its own provider.
- Compaction runs only when a request would not fit, inside the turn (`backgroundTokens: 0`): background compaction
  would keep calling the model after a turn ended or was stopped.
- One process owns a SQLite file, so the server must never run twice against the same `/data`.

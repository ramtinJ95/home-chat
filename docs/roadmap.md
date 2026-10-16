# Home Chat roadmap

Agreed on 2026-10-16. Eight features, each in its own PR, built in this order.
Home Chat is for non-technical people on phones first: the model sets things up
through conversation and questions, and the interface only shows and stops them.

Status: PR 1 (Home Screen app) and PR 2 (push notifications) merged and deployed. PR 3 (artifacts and reader view) in review.

## Decisions

| Decision | For PR | Outcome |
| --- | --- | --- |
| Egress proxy may reach the push services (Apple `web.push.apple.com`, Google `fcm.googleapis.com`, Microsoft `*.notify.windows.com`) | 2 | Approved 2026-10-16. Only the server sends to them, never the model, and only to subscription endpoints on those hosts |
| Egress proxy may reach `api.exa.ai`; Exa key on home-macmini | 4 | Approved. The existing key is in home-macmini's `.env` as `EXA_API_KEY` (mode 600, test call HTTP 200); compose does not pass it to the app yet |
| Exa spending caps | 4 | None, by the user's choice |
| Household time zone for schedules | 5 | `Europe/Stockholm` |

## 1. Home Screen app

- Web app manifest, icons, theme colour, standalone display, iOS meta tags.
- A short in-app hint showing how to add it to the Home Screen (Safari share sheet on iPhone).
- Prerequisite for push on iPhone: iOS 16.4+ only delivers web push to Home Screen apps, never to Safari or Chrome tabs.

## 2. Push notifications

- Service worker plus Web Push with VAPID keys (made on first start and kept in `push/` on the data volume); one subscription per device, for owner and guest separately; an "Enable notifications" button, since browsers only prompt after a tap.
- Notify when a reply finishes while nobody is watching (deep research, long web searches), when a routine has run, and when the model is waiting on a question. Payloads are encrypted and short ("Your research is ready"), never the reply itself.
- Replies already keep running on the server after the app is closed; only the notification is new.
- Works in a normal tab on desktop Edge/Chrome and Android Chrome; iPhone needs the Home Screen app from item 1. iOS requires every push to show a notification.
- Expired or revoked subscriptions are deleted, and the app shows "Notifications are off on this device".
- Egress: add the push hosts, with suffix matching for Microsoft's numbered hosts (`src/egress.ts`, `PROVIDER_HOSTS` in `src/policy.ts`). Subscription endpoints come from the browser, so the server rejects any endpoint outside those hosts.
- Uses the `web-push` npm package to build the encrypted, signed request; `fetch` sends it through the egress proxy.

## 3. Artifacts and reader view

- A first-party tool, `document`, that saves a titled Markdown document to the conversation as an asset, and can revise it (each revision a new version; the latest is shown).
- In the chat it appears as a card ("Research report: … · Open"); tapping opens a full-screen reader built for phones: comfortable type, a contents list from the headings, a sources section with links, and copy, share and download (`.md`).
- Reuses the existing safe Markdown renderer (DOM text nodes only, under the CSP) and adds tables, which reports need.
- Useful beyond research: trip plans, meal plans, routine results.

## 4. Deep research mode

- Bring the user's Pi Exa tool (`~/.pi/agent/extensions/exa-deep-research.ts`, tool name `deep_research`, modes `deep` and `deep-reasoning`) into `profile/` as a first-party tool. Drop the Keychain and home-directory config lookups; read `EXA_API_KEY` from the environment (compose passes it to the app).
- Add `deep_research` to `ALLOWED_TOOLS` and the tool policy, a "Researching…" status label, and `api.exa.ai` to the egress allowlist. No spending caps.
- The toggle belongs to the conversation, not to one message: switched on, it stays on for that conversation (saved with it) until switched off. While on, every message carries an instruction to use `deep_research` heavily for questions that need research (`deep-reasoning` for ambiguous or judgment-heavy ones), and to answer ordinary chat normally.
- A research answer ends with a consolidated report saved through `document` (item 3), which the app offers to open in the reader; the chat reply is a short summary.
- Deep mode gets a longer turn deadline than today's 5 minutes and a larger tool-call budget than 12; Exa calls time out after 90 s each.
- Notifies when done (item 2).

## 5. Routines, set up through conversation

How it works:

- **Model tool.** A first-party Pi tool, `routine`, with actions list, create, update, pause, resume and delete. The model fills in a title, a self-contained prompt for future runs, and a structured schedule (`daily`, `weekdays`, `weekly` with days, `monthly` with day, `once` with date, all with a time). It uses `ask` to clarify and confirm ("Every day at 7:30, starting tomorrow — OK?") before calling create.
- **Tool to server.** The tool runs inside the Pi process, so it calls the server over a separate internal listener on `127.0.0.1` (never published, never behind the tunnel) with a per-worker token passed at spawn. The server validates, scopes everything to the conversation's owner, and returns a plain result ("Saved. Next run: tomorrow 07:30").
- **Storage.** `routines.json` on the data volume, written with the same atomic, synced write as conversations: id, owner, title, prompt, schedule, enabled, next run, last run and its outcome, and the routine's own conversation id.
- **Scheduler.** Each schedule is stored as a cron expression plus the household time zone, and a cron library (e.g. `croner`) computes the next run, including daylight-saving changes. The server keeps one timer set for the earliest next run, with no polling, and re-arms it at startup, after every change and after every run. A host crontab or a cron daemon in the container is ruled out: the container is read-only with no daemon, and the model would have to edit the host's crontab. A due routine becomes a normal turn in its own conversation through the same admission path as a sent message, so it inherits saving, interruption recovery and limits. It waits in a queue while workers are busy or the owner has an active reply.
- **Unattended runs.** Routine runs have no `ask` tool (nobody is watching) and no `routine` tool (routines never create routines). Each run adds a dated reply, marks the routine unread and sends a push.
- **Missed runs.** At startup, a run missed by less than a few hours runs once; older ones are skipped with a visible note in the thread.
- **Limits.** About 10 routines per person, nothing more often than hourly, runs counted against a daily budget, deep research in routines only when the prompt asks for it.
- **Interface.** Changes happen by chatting ("move my morning briefing to 8"), but pausing and removing never require it:
  - Sidebar "Routines" list: name, next run ("Tomorrow 07:30" or "Paused"), unread dot, an on/off switch, and delete behind a menu with one confirmation.
  - The same switch and "Delete routine" at the top of each routine's thread.
  - Saying "stop" or "pause my briefing" in any conversation also works.
  - Notification buttons "Pause" and "Open" where the browser supports them (desktop Edge and Chrome); on iPhone a tap opens the routine.
  - Deleting a routine stops future runs and keeps its past results as an ordinary conversation, which can be deleted like any other.

## 6. "About us" memory

- A short household profile (city, dietary preferences, names, interests) added to every conversation's instructions.
- The model suggests additions through `ask` ("Should I remember that you're vegetarian?"); a settings page shows and edits it.
- Per user, with an optional shared household part.

## 7. Search across conversations

- Search box in the sidebar over titles and message text of the user's own conversations, results jump to the message.

## 8. Small conveniences

- Regenerate the last reply, edit and resend the last message, copy and share a reply.

## Also open

- Backups and retention of the `home-chat_chat-data` volume (README "not done yet").
- Live checks still pending: full-size iPhone photo upload (PR #4), restart in the middle of a reply (PR #5).

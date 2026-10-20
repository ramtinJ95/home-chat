# Home Chat

A private, mobile-friendly chat app for everyday questions, web search,
image generation, documents, deep research, scheduled routines, household notes and todo lists. It runs a locked-down [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
agent against a Codex subscription inside Docker. The model can only use
eight tools (`ask`, `web_run`, `imagegen`, `document`, `deep_research`,
`routine`, `memory`, `todo`), can only reach OpenAI and Exa, and cannot run commands or read
files.

It runs in one of two modes:

- **Local** (`compose.yaml` alone): listens on `127.0.0.1:8787` only, with
  access codes. For development and testing.
- **Public** (`compose.public.yaml` on top, on `home-macmini` only): served at
  `https://home-chat.handmadeoasis.com` through a Cloudflare Tunnel, behind
  Cloudflare Access with Google sign-in. Nothing is published on the host. See
  [Public deployment](#public-deployment).

## Run it

Requires Docker. On the machine that hosts it:

```sh
docker compose up -d --build --wait
```

From another machine, forward the port over SSH, then open http://127.0.0.1:8787:

```sh
ssh -N -L 127.0.0.1:8787:127.0.0.1:8787 home-macmini
```

Only `127.0.0.1:8787` and `localhost:8787` are accepted as hosts. Don't
rebind to `0.0.0.0` or put a tunnel in front of local mode; public access goes
through [Public deployment](#public-deployment).

### Get an access code

Two random access codes (owner and guest) are created on first start.
Each user gets separate conversations.

```sh
docker compose exec -T --user 10001:10001 app node scripts/show-access.ts owner
```

Keep codes out of issues, commits and URLs. A sign-in lasts 8 hours, and five
wrong codes lock that address out for 15 minutes.

### Connect Codex

The app starts with no credentials and refuses to answer until Codex is
signed in. There is no API-key fallback. Pick one:

```sh
# Device-code login into the app's own profile (enable device codes in your OpenAI security settings)
docker compose exec -T --user 10001:10001 app node scripts/login-codex.ts

# Or copy only the OAuth credential from a fresh Codex CLI login on the host
node scripts/import-existing-codex.ts --i-accept-shared-refresh-session
```

The import leaves `~/.codex/auth.json` untouched. A copied refresh token can
conflict with the CLI's own session, so prefer the device-code login.

### Stop and data

```sh
docker compose stop
```

Conversations, images, routines (`routines.json`), household notes (`memory.json`) and credentials live in the `home-chat_chat-data`
volume, so they survive restarts, rebuilds and `docker compose down`;
`docker compose down -v` deletes all of them. A reply that is still
streaming when the app stops keeps the text saved so far (within about two
seconds after a crash) and is marked as interrupted. Deleting a conversation
in the sidebar removes its messages, pictures and model transcript for good; it is
refused while a reply is still running.

## Public deployment

Runs on `home-macmini` only, never on a work machine. Cloudflare sees every
request first; the app then verifies Cloudflare's signed token
(`Cf-Access-Jwt-Assertion`) itself, so traffic that skips Access is refused.

### Cloudflare, once

1. **Login method.** Zero Trust → Settings → Authentication: add Google (needs
   an OAuth client from Google Cloud Console with redirect URI
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`).
2. **Tunnel.** Networks → Tunnels: create a Cloudflared tunnel and copy its
   token. Add one public hostname, `home-chat.handmadeoasis.com`, with service
   `http://app:8080` and, under HTTP settings, **HTTP Host Header**
   `home-chat.handmadeoasis.com`. Add no private network routes.
3. **Access application.** Access → Applications: a self-hosted app for
   `home-chat.handmadeoasis.com`, Google as the only login method, and one
   Allow policy listing the two Google emails. Copy its **Application Audience
   (AUD) tag**.

### On home-macmini

```sh
cp .env.example .env && chmod 600 .env   # fill in team, AUD tag, emails and tunnel token
docker compose up -d --build --wait      # .env's COMPOSE_FILE adds compose.public.yaml
docker compose exec -T --user 10001:10001 app node scripts/login-codex.ts
```

The owner and guest emails in `.env` decide who is which account; anyone else
is refused even if the Access policy were to let them through. Sign out ends
the Cloudflare session too.

### On phones

Home Chat can live on the Home Screen and open full screen like an app. Edge,
Chrome and Android offer an **Install** button on the welcome screen; on an
iPhone or iPad, tap Share in the browser (in Safari it can be under ···), then
**Add to Home Screen**. The sidebar keeps the same option after "Not now". An
installed app can keep its own cookies apart from the browser, so it may ask
for Google sign-in again the first time it opens.

Next the welcome screen offers notifications (the sidebar keeps a switch for
them). Each device then hears when a reply is ready or the model asks a
question while the app is closed or in the background, never while that
conversation is on screen. On an iPhone or iPad this only works in the
installed app, not in a Safari tab. Tapping a notification opens its
conversation. The server makes its push key pair on first start and keeps it,
with the list of devices, in `push/` on the data volume.

Longer results (reports, plans, itineraries) arrive as a document card in the
reply. **Open** shows the document full screen with a contents list, and
Copy, Share and Download (a Markdown file); the back button or gesture
returns to the conversation. When the model revises a document, every card
of it opens the newest version.

**Deep research** beside the message box switches a conversation into research
mode until it is switched off again. Each message then asks the model to
research with Exa (`deep_research`) where the question needs it, and to
finish with a sourced report saved as a document; ordinary chat is answered
as usual. A research reply may run for 20 minutes and use 30 tool calls,
against 5 minutes and 12 calls otherwise, and each Exa call times out after
90 seconds. The switch only appears when `EXA_API_KEY` is set in `.env`;
compose passes it to the app. There are no spending caps on Exa.

**Routines** are set up by asking ("every weekday at 7:30, give me the weather
and my day"): the model confirms the plan, then saves a routine with its own
conversation, where each run arrives with a notification and an unread dot.
Schedules are daily, weekdays, weekly on chosen days, monthly (days 1 to 28) or
once, always in Stockholm time, daylight saving included. The Routines page
(in the sidebar) lists every routine with its schedule, next and last run and
task, and switches it off and on, edits its name, task, schedule and deep
research, or deletes it. The sidebar's Routines list and the bar at the top of
a routine's conversation switch and delete too; deleting keeps its past results
as an ordinary conversation. Saying "pause my briefing" anywhere also works, and on
desktop Edge and Chrome the notification has a Pause button. A run waits while
its owner has a reply running or both workers are busy, and is skipped with a
note if it cannot start within 3 hours, for example because the app was down.
Each person can have 10 routines and 20 runs a day; a run has no `ask`,
`routine` or `memory` tool, and uses deep research only if the routine was set
up with it.

**About us** holds short notes the model is told in every conversation: each
person's own ("vegetarian, but eats fish") and shared ones for the whole
household ("we live in Stockholm"), which either person can read and change.
The model suggests a note when it hears a lasting fact, and the user is asked
Yes or No before anything is saved. The About us page in the sidebar shows the
notes one per line for editing; it will not overwrite notes that changed after
it opened. Each list holds up to 30 notes of 300 characters.

**Todos** are lists, each private to the person who made it or shared with the
household ("Groceries"). Ask in any conversation ("add milk and eggs to
groceries", "what's left on my errands?") or use the Todos page in the sidebar
to add, tick off, rename and clear items. Both people can change a shared
list's items and name; only the person who made it can make it private again
or delete it. Routine runs can use lists too. Each person can make 30 lists of
up to 200 items; the page catches up with changes from the other phone when it
comes back into view.

**Shared conversations.** A conversation is private until the person who
started it taps Share in its header; then it is listed under Shared for both,
and both read, write, answer the model's questions and stop replies in it.
The model is told who wrote each message, by the names set as
`HOME_CHAT_OWNER_NAME` and `HOME_CHAT_GUEST_NAME` in `.env` (optional; "the
owner" and "the guest" without them), and a message's household notes, todo
lists and routines are its sender's. Only the sender of the last message can
regenerate or edit it. Only the owner deletes it or makes it private again,
which closes it on the other phone. A reply to one person shows as unread for
the other; routine conversations stay private.

**Starred conversations.** The star in a conversation's header, or on its row
in the sidebar, lists it under Starred, at the top of the sidebar, until it is
unstarred; the one starred first stays on top. Stars are each person's own, so starring a shared
conversation stars it only for you, and making a conversation private again
removes the other person's star. Routine conversations stay under Routines.

**The Library** holds single documents and pictures shared on their own, for
both people, while the conversation they came from stays private. "Share with
<name>" on a picture or in the document reader puts a copy there, so deleting
the conversation keeps it, and sharing a revised document again replaces its
copy. Only the person who shared an item can stop sharing it, and each
person's copies are their own. The Library entry
in the sidebar shows a dot when the other person shared something new. Each
person can share 100 items.

**Search** in the sidebar looks through the titles and messages of the
conversations you can see, your own and shared ones, ignoring case and
accents, and finds messages with every word typed. A result opens its
conversation at that message, which lights up for a moment. It shows at most 40 results, 5 per conversation.

Every finished reply can be **copied** (as Markdown) or **shared** as text.
The last reply can be **regenerated**, and your last message **edited** in
the composer and sent again; either way it replaces that turn, pictures
included, and the model forgets the old one too: the conversation continues
in a fork that ends just before that message, and the conversation's file
records the fork, so it is still in effect after a restart.

## Develop

Everything is TypeScript. Node 26 runs the server, scripts and tests
directly with no build step. Only the browser scripts are compiled
(`public/app.ts`, `public/theme.ts` and the `public/sw.ts` service worker to `.js`).

```sh
npm ci
npm run typecheck   # server + browser
npm run build       # public/app.js, public/theme.js, public/sw.js
npm test            # builds, then runs test/*.test.ts (faux model, fake worker for the server)
```

| Path | What it is |
| --- | --- |
| `src/server.ts` | HTTP API, uploads, SSE streaming, turn state and routine runs |
| `src/sign-in.ts` | Who a request comes from. Access codes and 8-hour sessions in local mode, or each request's Cloudflare Access identity in public mode |
| `src/access.ts` | Verifies Cloudflare's signed `Cf-Access-Jwt-Assertion` token against the team's keys |
| `src/http.ts` | `HttpError` for errors the client sees, `jsonBody` for request bodies, and `recent`, the time window behind the rate limits |
| `src/agent/` | Pi Durable in the server process: one SQLite transcript per conversation, the worker behind `ChatWorker`, the Home Chat extension and its eight tools |
| `src/chat-worker.ts` | `ChatWorker`, what the server needs from a conversation's worker |
| `src/policy.ts` | Tool allowlist, image-path and URL checks, limits |
| `src/egress.ts` | CONNECT proxy that only reaches OpenAI, Exa, the browser push services and, in public mode, the Cloudflare Access team host, on port 443 |
| `src/push.ts` | Web Push: push keys, each user's devices, and delivery through the egress proxy |
| `src/routines.ts` | Routine schedules (via `croner`), next-run labels, `routines.json` and the one timer for the next run |
| `src/search.ts` | Search over a person's conversations: matching, snippets and highlight ranges |
| `src/library.ts` | The Library in `library.json`, with copies of shared documents and pictures under `library/` |
| `src/todos.ts` | Todo lists in `todos.json`, private or shared, and the `todo` tool's actions |
| `src/memory.ts` | About us: each person's and the shared household notes in `memory.json`, and their part of the instructions |
| `src/files.ts` | Atomic, synced JSON writes shared by every store: conversations, routines, notes, todos, the Library, push and the Codex login. `jsonStore` runs the notes', todos' and Library's changes one at a time |
| `src/api.d.ts` | Request, response and event types shared by server and browser |
| `profile/instructions.md` | The model's instructions |
| `public/` | Single-page UI (HTML, CSS, `app.ts`, `theme.ts` for the light/dark choice), the `sw.ts` service worker that shows notifications, the Home Screen manifest, and `icon.svg`, which the server renders into the app icons |
| `scripts/` | Container entrypoint, login helpers and environment checks |

The image builds and type-checks everything. Run the test suite inside it
the same way it ships:

```sh
docker run --rm --network none --user 10001:10001 --cap-drop ALL \
  --security-opt no-new-privileges --entrypoint node home-chat-local:0.1.0 \
  --test 'test/*.test.ts'
```

Checks against the running stack:

```sh
docker compose exec -T --user 10001:10001 app node scripts/check-runtime.ts  # no capabilities, SQLite opens on /data, Codex signed in
docker compose exec -T --user 10001:10001 app node scripts/check-network.ts  # direct egress denied, proxy allowlist holds
docker compose exec -T --user 10001:10001 app node scripts/check-live.ts     # one real model reply through Pi Durable; uses quota
node scripts/check-browser.ts                                               # Chrome: login, upload, layout (no inference)
node scripts/check-browser-live.ts --confirm-subscription-usage             # end-to-end; uses quota and generates one image
```

The browser checks need Google Chrome in `/Applications` and write
screenshots to the git-ignored `.local/` folder.

## Security model

- **Tools.** Every conversation runs with exactly one extension,
  `src/agent/extension.ts`, so the model has `ask`, `web_run`, `imagegen`,
  `document`, `deep_research`, `routine`, `memory` and `todo` and nothing else: no
  read, write, edit or bash, whatever Pi Durable ships. Every call passes its
  `beforeTool` hook first, which validates the input and applies the
  message's limits: 12 tool calls (30 in deep research mode) and 2 image
  generations. The turn's mode comes from the server, not from the text:
  `deep_research` is refused unless the conversation's switch is on, and
  `ask`, `routine` and `memory` are refused in a routine run. `routine`,
  `memory` and `todo` call the server in its own process, bound to the
  conversation they run in, which scopes them to the person whose message the turn answers (the routine's owner in a
  routine run). `memory` changes nothing
  without the user's Yes, which the tool asks for itself, and the notes go
  into the instructions marked as facts, not instructions. `document` only writes new files
  under the conversation's `documents/` folder (at most 100, 256 K characters
  each), and the server reads them back through the same path check.
- **Input.** Browser text always follows the server's notes for the turn
  and a fixed prefix, so it can never pose as one of those notes. Model output is rendered with DOM text nodes
  only, under a strict CSP. The browser shrinks pictures to 2048 px before
  upload; the server then decodes them, strips metadata, limits them to
  2048 px and re-encodes them as PNG.
- **Network.** The app container's firewall allows only the egress proxy.
  The proxy allows CONNECT to `chatgpt.com`, `api.openai.com`,
  `auth.openai.com` and `api.exa.ai` on port 443, to the browser push services (Apple,
  Google, Mozilla and Microsoft's `*.notify.windows.com`), and in public mode to
  the Cloudflare Access team host (`<team>.cloudflareaccess.com`) for its signing keys. Only the server
  sends to the push services, never the model, and it accepts a device's push
  address only on those hosts. Notifications carry the conversation title and
  a short status, encrypted to the device, never the reply. It rejects non-public addresses and connects
  to the IP it already checked, so DNS can't be rebound. LAN, Tailscale,
  metadata endpoints and Docker DNS are all unreachable.
- **Process.** The root filesystem is read-only and the app runs as UID
  10001 with no capabilities and `no-new-privileges`. CPU, memory, PIDs,
  request sizes and storage (512 MiB at admission, not a filesystem quota)
  are all capped.
- **Accounts.** Owner and guest are separated by in-app ownership checks, not
  by OS users. Locally, logins use HttpOnly SameSite=Strict cookies. In public
  mode, every request must carry a valid Cloudflare Access token (RS256,
  checked against the team's rotating keys, this app's audience tag, issuer
  and expiry) for an email listed in `.env`. Both modes require CSRF tokens
  and an exact Origin match for changes.
- **Tunnel.** `cloudflared` runs read-only, without capabilities, pinned by
  digest, and only on the network that reaches the app. Its routes live in
  the Cloudflare dashboard, so the Cloudflare account is part of the trust
  boundary: keep it to the one hostname and no private network routes.

Not done yet: backups and retention, and an independent security review.

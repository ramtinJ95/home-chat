# Home Chat

A private, mobile-friendly chat app for everyday questions, web search,
image generation, documents, deep research, scheduled routines and household notes. It runs a locked-down [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
agent against a Codex subscription inside Docker. The model can only use
seven tools (`ask`, `web_run`, `imagegen`, `document`, `deep_research`,
`routine`, `memory`), can only reach OpenAI and Exa, and cannot run commands or read
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
in the sidebar removes its messages, pictures and Pi session for good; it is
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

**Deep research** at the top of a conversation switches it into research
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
once, always in Stockholm time, daylight saving included. The sidebar's
Routines list and the bar at the top of a routine's conversation switch a
routine off and on and delete it; deleting keeps its past results as an
ordinary conversation. Saying "pause my briefing" anywhere also works, and on
desktop Edge and Chrome the notification has a Pause button. A run waits while
its owner has a reply running or both workers are busy, and is skipped with a
note if it cannot start within 3 hours, for example because the app was down.
Each person can have 10 routines and 20 runs a day; a run has no `ask` and no
`routine` tool, and uses deep research only if the routine was set up with it.

**About us** holds short notes the model is told in every conversation: each
person's own ("vegetarian, but eats fish") and shared ones for the whole
household ("we live in Stockholm"), which either person can read and change.
The model suggests a note when it hears a lasting fact, and the user is asked
Yes or No before anything is saved. The About us page in the sidebar shows the
notes one per line for editing; it will not overwrite notes that changed after
it opened. Each list holds up to 30 notes of 300 characters.

**Search** in the sidebar looks through the titles and messages of your own
conversations, ignoring case and accents, and finds messages with every word
typed. A result opens its conversation at that message, which lights up for
a moment. It shows at most 40 results, 5 per conversation.

## Develop

Everything is TypeScript. Node 26 runs the server, scripts and tests
directly with no build step. Only the browser scripts are compiled
(`public/app.ts` and `public/theme.ts` to `.js`).

```sh
npm ci
npm run typecheck   # server + browser
npm run build       # public/app.js, public/theme.js
npm test            # builds, then runs test/*.test.ts with a fake Pi worker
```

| Path | What it is |
| --- | --- |
| `src/server.ts` | HTTP API, sessions, uploads, SSE streaming, turn state |
| `src/rpc.ts` | `PiWorker`: one Pi process per conversation over JSON RPC |
| `src/policy.ts` | Tool allowlist, image-path and URL checks, limits |
| `src/egress.ts` | CONNECT proxy that only reaches OpenAI and the browser push services on port 443 |
| `src/push.ts` | Web Push: push keys, each user's devices, and delivery through the egress proxy |
| `src/routines.ts` | Routine schedules (via `croner`), next-run labels, `routines.json` and the one timer for the next run |
| `src/search.ts` | Search over a person's conversations: matching, snippets and highlight ranges |
| `src/memory.ts` | About us: each person's and the shared household notes in `memory.json`, and their part of the instructions |
| `src/files.ts` | Atomic, synced JSON writes shared by conversations and push |
| `src/api.d.ts` | Request, response and event types shared by server and browser |
| `profile/` | Pi extension that filters tool registration and adds the household notes to the system prompt each turn, the `document`, `deep_research`, `routine` and `memory` tools, and the instructions |
| `public/` | Single-page UI (HTML, CSS, `app.ts`, `theme.ts` for the light/dark choice), the `sw.ts` service worker that shows notifications, the Home Screen manifest, and `icon.svg`, which the server renders into the app icons |
| `scripts/` | Container entrypoint, login helpers and environment checks |

The image builds and type-checks everything. Run the test suite inside it
the same way it ships:

```sh
docker run --rm --network none --user 10001:10001 --cap-drop ALL \
  --security-opt no-new-privileges --entrypoint node home-chat-local:0.1.0 \
  --test test/access.test.ts test/document.test.ts test/memory.test.ts test/policy.test.ts test/research.test.ts test/routines.test.ts test/search.test.ts test/server.test.ts
```

Checks against the running stack:

```sh
docker compose exec -T --user 10001:10001 app node scripts/check-runtime.ts  # real Pi starts with only the seven tools
docker compose exec -T --user 10001:10001 app node scripts/check-network.ts  # direct egress denied, proxy allowlist holds
node scripts/check-browser.ts                                               # Chrome: login, upload, layout (no inference)
node scripts/check-browser-live.ts --confirm-subscription-usage             # end-to-end; uses quota and generates one image
```

The browser checks need Google Chrome in `/Applications` and write
screenshots to the git-ignored `.local/` folder.

## Security model

- **Tools.** Pi starts with no built-in tools, extensions, skills or context
  files. `profile/extension.ts` drops every tool registration except `ask`,
  `web_run`, `imagegen` and its own `document`, `deep_research`, `routine` and `memory`, and validates tool input twice: at Pi's
  `tool_call` hook and in the execute wrapper. The server refuses a worker
  whose registered and active tools don't match exactly. Each message allows
  12 tool calls (30 in deep research mode) and 2 image generations.
  The server's notes open each message, ahead of the user's text, which
  cannot imitate them: `deep_research` is refused unless the deep research
  note is there, and `ask`, `routine` and `memory` are refused in a routine run.
  `routine` and `memory` reach the server only through a Unix socket in the data
  directory (mode 600, never a network port), with a token per Pi process
  that scopes them to the conversation's owner. `memory` changes nothing
  without the user's Yes, which the tool asks for itself, and the notes go
  into the instructions marked as facts, not instructions. `document` only writes new files
  under the conversation's `documents/` folder (at most 100, 256 K characters
  each), and the server reads them back through the same path check.
- **Input.** Browser text is always prefixed before reaching Pi, so it can
  never act as a slash command. Model output is rendered with DOM text nodes
  only, under a strict CSP. The browser shrinks pictures to 2048 px before
  upload; the server then decodes them, strips metadata, limits them to
  2048 px and re-encodes them as PNG.
- **Network.** The app container's firewall allows only the egress proxy.
  The proxy allows CONNECT to `chatgpt.com`, `api.openai.com`,
  `auth.openai.com` and `api.exa.ai` on port 443, and to the browser push services (Apple,
  Google, Mozilla and Microsoft's `*.notify.windows.com`). Only the server
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

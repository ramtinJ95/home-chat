# Home Chat

A private, mobile-friendly chat app for everyday questions, web search and
image generation. It runs a locked-down [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
agent against a Codex subscription inside Docker. The model can only use
three tools (`ask`, `web_run`, `imagegen`), can only reach OpenAI, and cannot
run commands or read files.

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

Conversations, images and credentials live in the `home-chat_chat-data`
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
| `src/egress.ts` | CONNECT proxy that only reaches OpenAI on port 443 |
| `src/api.d.ts` | Request, response and event types shared by server and browser |
| `profile/` | Pi extension that filters tool registration, plus the system prompt |
| `public/` | Single-page UI (HTML, CSS, `app.ts`, `theme.ts` for the light/dark choice), Home Screen manifest and `icon.svg`, which the server renders into the app icons |
| `scripts/` | Container entrypoint, login helpers and environment checks |

The image builds and type-checks everything. Run the test suite inside it
the same way it ships:

```sh
docker run --rm --network none --user 10001:10001 --cap-drop ALL \
  --security-opt no-new-privileges --entrypoint node home-chat-local:0.1.0 \
  --test test/access.test.ts test/policy.test.ts test/server.test.ts
```

Checks against the running stack:

```sh
docker compose exec -T --user 10001:10001 app node scripts/check-runtime.ts  # real Pi starts with only the three tools
docker compose exec -T --user 10001:10001 app node scripts/check-network.ts  # direct egress denied, proxy allowlist holds
node scripts/check-browser.ts                                               # Chrome: login, upload, layout (no inference)
node scripts/check-browser-live.ts --confirm-subscription-usage             # end-to-end; uses quota and generates one image
```

The browser checks need Google Chrome in `/Applications` and write
screenshots to the git-ignored `.local/` folder.

## Security model

- **Tools.** Pi starts with no built-in tools, extensions, skills or context
  files. `profile/extension.ts` drops every tool registration except `ask`,
  `web_run` and `imagegen`, and validates tool input twice: at Pi's
  `tool_call` hook and in the execute wrapper. The server refuses a worker
  whose registered and active tools don't match exactly. Each message allows
  12 tool calls and 2 image generations.
- **Input.** Browser text is always prefixed before reaching Pi, so it can
  never act as a slash command. Model output is rendered with DOM text nodes
  only, under a strict CSP. The browser shrinks pictures to 2048 px before
  upload; the server then decodes them, strips metadata, limits them to
  2048 px and re-encodes them as PNG.
- **Network.** The app container's firewall allows only the egress proxy.
  The proxy allows CONNECT to `chatgpt.com`, `api.openai.com` and
  `auth.openai.com` on port 443. It rejects non-public addresses and connects
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

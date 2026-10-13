# Home Chat

A private, mobile-friendly chat app for everyday questions, web search and
image generation. It runs a locked-down [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
agent against a Codex subscription inside Docker. The model can only use
three tools (`ask`, `web_run`, `imagegen`), can only reach OpenAI, and cannot
run commands or read files.

**Status: local prototype.** It listens on `127.0.0.1:8787` only. There is no
public deployment, Google sign-in or HTTPS yet.

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
rebind to `0.0.0.0` or put a tunnel in front of it.

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
volume. `docker compose down -v` deletes all of them.

## Develop

Everything is TypeScript. Node 26 runs the server, scripts and tests
directly with no build step. Only the browser script is compiled
(`public/app.ts` to `public/app.js`).

```sh
npm ci
npm run typecheck   # server + browser
npm run build       # public/app.js
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
| `public/` | Single-page UI (HTML, CSS, `app.ts`) |
| `scripts/` | Container entrypoint, login helpers and environment checks |

The image builds and type-checks everything. Run the test suite inside it
the same way it ships:

```sh
docker run --rm --network none --user 10001:10001 --cap-drop ALL \
  --security-opt no-new-privileges --entrypoint node home-chat-local:0.1.0 \
  --test test/policy.test.ts test/server.test.ts
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
  only, under a strict CSP. Uploads are decoded, stripped of metadata,
  limited to 2048 px and re-encoded as PNG.
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
  by OS users. Logins use HttpOnly SameSite=Strict cookies plus CSRF tokens
  and an Origin check.

Not done yet: public deployment (Cloudflare Access, Google allowlist, HTTPS
cookies), backups and retention, and an independent security review.

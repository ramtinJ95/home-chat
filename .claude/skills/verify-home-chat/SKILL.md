---
name: verify-home-chat
description: Drive the real Home Chat web app (the phone-first chat PWA in this repo) in a throwaway local Docker stack with headless Chrome, and capture screenshots, ARIA snapshots and data-volume proof. Use it to prove a change to the UI, the HTTP API or stored data works the way a user would see it, or when asked to verify, smoke-test or demo a Home Chat feature.
---

# Verify Home Chat

Home Chat is one web UI (`public/`) served by `src/server.ts` inside a sealed Docker compose stack: an `app` container
and an `egress` proxy container. Users touch it in a phone browser, so drive it at 390x844 first and 1360x950 second.
There is no CLI surface. The app's documented checks (`scripts/check-*.ts`) also run against this stack; see Drive.

Where this runs: the work Mac, for short local test stacks only. Never on `home-macmini` (the real deployment and the
household's data live there) and never with `compose.public.yaml`. The Claude Code sandbox can't use Docker, bind ports
or launch Chrome, so in Claude Code hand every command below to an Astra `general` worker and tell it "headless only, no
visible windows".

Everything below runs from the repo root. `stack.sh` is `.claude/skills/verify-home-chat/stack.sh`. If it is not
executable, run `chmod +x` on it once, or call it as `sh .claude/skills/verify-home-chat/stack.sh`.

## Launch

```sh
.claude/skills/verify-home-chat/stack.sh up
```

This builds the checkout into `home-chat-local:0.1.0` and starts compose project `home-chat-verify`, with its own empty
volume `home-chat-verify_chat-data`. Nothing needs seeding: the first start makes the data folders, the owner and guest
access codes and the push keys. `up` waits for the container health checks, records the git revision and image in
`.local/verify/stack.env`, then runs the doctor. Ready means `up` ends with a line like:

```
OK home-chat-verify at http://127.0.0.1:8787, built from e31903a-dirty, owner sign-in works, Codex signed in: false
```

The first build takes a few minutes; later ones reuse layers.

**One stack per machine.** Every Home Chat stack publishes `127.0.0.1:8787` (the server only accepts that host) and
uses the fixed `172.30.91.0/28` subnet, because the app's firewall names the proxy's address. `up` refuses when anything
already publishes 8787, and when `home-chat-verify` still has containers or a volume from an earlier run, so every run
starts from empty data. For a leftover `home-chat-verify`, run `stack.sh down` first. Anything else is
not ours: stop and ask the user, never stop or reuse it.

**Codex.** A fresh volume has no Codex sign-in, so the UI loads, but sending a message fails with "Codex is not signed
in to this isolated profile yet" and the yellow `#provider-warning` notice shows. The feature map marks which journeys
need the model. Sign in only if the user agrees, since replies use their subscription quota. Use either of these:

```sh
.claude/skills/verify-home-chat/stack.sh run docker compose exec -T --user 10001:10001 app node scripts/login-codex.ts   # device code; the user approves it
.claude/skills/verify-home-chat/stack.sh run node scripts/import-existing-codex.ts --i-accept-shared-refresh-session   # copies the host's ~/.codex login
```

## Doctor

```sh
.claude/skills/verify-home-chat/stack.sh doctor
```

Run it first whenever anything looks off. It only reads, apart from one sign-in and sign-out. It checks that the
`home-chat-verify` app container is running and healthy and runs the image `up` built, and that port 8787 belongs to this
project. It then loads the page, signs in as owner with the stack's own code and reports whether Codex is signed in. Any
`FAIL` line names the problem, so fix that or run `down` and `up` before driving.

## Drive

The harness is `scripts/browser-session.ts` (Playwright with the installed Google Chrome, always headless).
`openSignedIn('owner' | 'guest')` reads that user's access code from the container, signs in on a 1360x950 page and
returns `{browser, context, page, errors, openPhone}`. `openPhone()` gives a 390x844 touch page with the same session,
and `errors` collects JavaScript errors from both. Run every journey through `stack.sh run` so its `docker compose`
calls reach `home-chat-verify` and not another project:

```sh
.claude/skills/verify-home-chat/stack.sh run node .claude/skills/verify-home-chat/journeys/todos.ts
.claude/skills/verify-home-chat/stack.sh run node scripts/check-browser.ts    # sign-in, picture upload and removal, layout; screenshots only
.claude/skills/verify-home-chat/stack.sh run node scripts/check-browser-live.ts --confirm-subscription-usage   # needs Codex; uses quota
```

To write a new journey, copy `journeys/todos.ts`. Read `features/README.md` first, then the feature's file, which lists
its entry points, stable handles and end states. Use the element ids from `public/index.html` and roles with accessible
names (`getByRole('button', {name: 'Make list'})`). Never use coordinates. On phones the sidebar is a drawer, so tap
`#open-sidebar` before any sidebar control.

To read stored state on the data volume (read-only), run
`.claude/skills/verify-home-chat/stack.sh data todos.json`. The other files are `memory.json`, `routines.json` and
`library.json`, plus `chats/<id>/chat.json` for conversations. Each appears on the first change it records, so reading
it before then fails. Never read `local-access.json`: it holds the access codes in plain text.

## Evidence

Each journey writes to `.local/verify/<feature>-<UTC time>/`, which is git-ignored and survives `down`. It writes a
full-page PNG and an ARIA snapshot (`.aria.yml`) after each numbered step (one step can be several actions), `results.json` with the steps that passed, and
`failure.png` when a step fails. Keep the console output (`PASS ...` lines) with the evidence when reporting.
`scripts/check-browser.ts` is the app's own check and only writes `.local/desktop.png` and `.local/mobile.png`, so copy
those into the run's evidence folder. The proof standards are:

- Go through the UI the way a user would: the sidebar drawer, buttons, forms. Calling `/api/...` directly is only for
  reading state back, never for performing the step being proved.
- Capture the state after each action, not just the last screen.
- Check the side effect too: the stored JSON on the volume (`stack.sh data`), and what the other person sees, by
  signing in as guest.
- Report `errors` from `browser-session.ts`. A journey with JavaScript errors has not passed.
- Nothing is mocked: the stack is the shipped image. Without Codex, journeys that need the model report that they
  could not run and why. They don't pass by skipping the reply.

## Cleanup

```sh
.claude/skills/verify-home-chat/stack.sh down
```

It removes only what `up` made: the `home-chat-verify` containers, networks and volume (with its access codes and any
Codex login), and `.local/verify/stack.env`. It keeps the evidence folders under `.local/verify/` and the shared
`home-chat-local:0.1.0` image. Journeys close their own browsers. Never kill Chrome or node by name. Run `down` after
failed attempts too, so ports and the subnet are free for the next `up`.

## Helpers

- `stack.sh up | doctor | run <command...> | data <file> | down`: the stack lifecycle described above. It always uses
  project `home-chat-verify` and `compose.yaml` alone.
- `journeys/todos.ts`: the Todos journey, driven by the owner and the guest on phones. Run it with
  `stack.sh run node .claude/skills/verify-home-chat/journeys/todos.ts`.
- `features/`: the verification map. Keep it up to date when features change.

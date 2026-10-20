# Home Chat verification map

This folder is the maintained list of what a Home Chat user can do and how to prove each thing works. Read this index
before driving the app, then use the feature's file as the recipe.

## Baseline preconditions

- The stack is up through `stack.sh up` and `stack.sh doctor` prints `OK home-chat-verify ...`. Never drive a stack
  this run did not start.
- The data volume starts empty: no lists, notes, routines or Library items, and Codex is not signed in. The first time
  each person's workspace loads, it makes an empty "New conversation" for them.
- Every browser step goes through `scripts/browser-session.ts` in headless Chrome, run with `stack.sh run node <journey>`.

## Driving conventions

- Phone first: drive at 390x844 with `openPhone()`, then repeat what changes layout at 1360x950 (`page`).
- On phones the sidebar is a drawer, so tap `#open-sidebar` first. Its actions are `#library-entry button`,
  `#todos-entry button`, `#routines-entry button` and `#about-entry button`, plus `#new-chat`, `#search`,
  `#theme-toggle`, `#install`, `#notifications` and `#logout`. On desktop the sidebar is always shown, so skip
  `#open-sidebar`.
- The drawer slides in, so a screenshot taken straight after opening it can catch it halfway. Wait for the control you
  need to be visible, or pass `animations: 'disabled'` to `page.screenshot`.
- Prefer the ids in `public/index.html` and roles with accessible names. Cards drawn by `public/app.ts` have no ids, so
  find them by their heading, such as `.todo-card` that has the list's title as heading.
- Give anything a journey creates a unique name (`Groceries <random>`) and delete it at the end of the journey.
- Confirmation prompts are native `confirm()` and `prompt()` dialogs. Handle them with `page.once('dialog', ...)` before
  the click.
- Use `owner` and `guest` (`openSignedIn('guest')`) to prove what the other person sees.
- After an action that saves, wait for its response or for the new screen state before reading the toast `#error`. It
  can still hold the previous message.

## Proof and skip reporting

- A step is proved by what is on screen after it (a screenshot and an ARIA snapshot) together with the stored state
  (`stack.sh data <file>`) or the other person's view.
- A journey that needs Codex reports `NOT RUN: Codex is not signed in` when doctor says `Codex signed in: false`. Don't
  report it as verified through some other path, and don't write fixtures into the data volume to stand in for the
  model.
- Model replies vary. Assert on structure (a reply arrived, a tool card rendered, a document opened), and on exact text
  only when the prompt asks for exact text.
- Report the git revision from doctor with every result.

## Features

- [Sign-in](./sign-in.md): access-code sign-in, wrong codes, sign-out, separate owner and guest accounts. No model.
- [Todos](./todos.md): shared and private lists, items, ticking, clearing, renaming, deleting. No model. Has a journey
  script.
- [About us](./about-us.md): personal and household notes, saving, and the conflict guard. No model.
- [Conversations](./conversations.md): starring, sharing, title search and deleting need no model. Sending, streamed
  replies, `ask` questions, generated pictures, documents, reply actions and message search need Codex.
- [Routines](./routines.md): created by asking the model, then listed, paused, edited and deleted on the Routines page.
  Needs Codex, apart from the empty page.
- [Library](./library.md): pictures and documents shared from conversations, on the Library page. Needs Codex to make
  anything to share, apart from the empty page.
- [App shell](./app-shell.md): the theme toggle, adding to the Home Screen, and push notifications. No model.

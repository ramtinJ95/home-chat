# Routines

A routine is a task the model runs on a schedule (daily, weekdays, on certain days, monthly or once, in Stockholm
time). Each routine posts into its own conversation. The user creates one by asking in a conversation, then manages it
on the Routines page: switch it on and off, edit its name, task, schedule and deep research, open its conversation, or
delete it. Routines are private: the guest never sees the owner's.

## Sub-features

- `routine-create`: ask "every weekday at 7:30, give me the weather"; the model confirms and saves the routine.
- `routine-list`: the Routines page shows a card per routine with its schedule, next run, last run and task.
- `routine-toggle`: the switch named "Run “<title>”" pauses the routine and turns it back on.
- `routine-edit`: "Edit" turns the card into a form, and saving changes the schedule or task.
- `routine-open`: "Open conversation" opens the routine's conversation, with a bar `#routine-bar` at its top.
- `routine-delete`: "Delete" removes the routine and keeps its conversation as an ordinary one.

## How to get to it (user POV)

- Ask in any conversation to create one.
- Sidebar → "Routines" for the page (`#routines-page`, back button `#routines-close`). The sidebar's Routines section
  (`#routines`, list `#routine-list`) is hidden while there are none. Each of its rows has a switch and a "More for
  “<title>”" menu with "Delete routine".
- `#routine-bar` at the top of a routine's conversation reads "<schedule> · <next run>" and has the switch, "Edit"
  (opens the Routines page with the form) and "Delete routine". That conversation has no share or star button.

## Driving it with browser-session.ts

Preconditions:

- The empty page needs no model: `#routine-cards` reads "No routines yet." for both people, and `#routines` is hidden.
  Drive that at both sizes.
- Everything else needs a routine, and making one needs the model, so `stack.sh doctor` must print
  `Codex signed in: true`. Without that, report `NOT RUN: Codex is not signed in` for the rest.

The switch "Run “<title>”" and an "Edit" button appear in the sidebar row, the card and `#routine-bar`, so scope every
lookup to the card: `#routine-cards article.card` that has the routine's title as heading.

- **Create.** In a new conversation, send `Every weekday at 7:30, tell me one fun fact. Name it Fun fact.` and answer
  any `#question` with the confirming choice. `stack.sh data routines.json` then holds a routine titled `Fun fact`.
- **List.** Tap `#open-sidebar`, then `#routines-entry button`. The card has a `.card-detail` that names weekdays and
  07:30 and a `.card-note` "Next run: …". After a run there is also "Last run: <when>, <outcome>" (class `failed` when
  it failed), and a "Deep research" `.pill` when that is on.
- **Toggle.** Uncheck the card's switch. The card and the sidebar row read "Paused", and `routines.json` has
  `enabled: false`. Checking it again works out a new next run.
- **Edit.** Tap the card's "Edit". The card becomes `form.card.routine-form` named "Edit “Fun fact”", with fields Name,
  What it does each time, Repeats, the days, day of the month or date that the repeat needs, Time, and Deep research
  when it is set up. Change the task and tap "Save". The toast reads "Saved “Fun fact”. Next run: …." and the card's
  `.routine-task` shows the new text. Choosing "On certain days" with no day ticked is refused with "Pick at least one
  day".
- **Delete.** Tap the card's "Delete" (exact name, unlike "Delete routine" elsewhere) and accept "Delete the routine
  “Fun fact”? It stops running. Its conversation and past results stay." The card goes away, and the conversation moves
  to `#chat-list`. After the last one, the page reads "No routines yet." and `#routines` is hidden.
- **Guest.** The guest's Routines page reads "No routines yet." and the routine's conversation is not in their sidebar.

## Gotchas

- A one-off routine that has already run shows "Done" and its switch is disabled. That is how it is meant to work.
- Without Codex, a run that comes due is skipped: its conversation gets "This run was skipped: Codex is not signed in
  to this isolated profile yet." and the last run reads skipped.
- Each person can have at most 10 routines and 20 runs in any 24 hours. A routine's conversation counts toward the
  conversation limit and can't be deleted on its own: delete the routine first. Delete what the journey made.
- A routine run has no `ask`, `routine` or About us tools, so don't expect questions in its conversation. It can still
  change todo lists.
- Waiting for a scheduled run takes real time. To prove that a run happens, schedule it `once` a few minutes ahead
  rather than mocking the clock.

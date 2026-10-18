# Routines

A routine is a task the model runs on a schedule (daily, weekdays, weekly, monthly or once, in Stockholm time). Each
routine posts into its own conversation. The user creates one by asking in a conversation, then manages it on the
Routines page: switch it on and off, edit its name, task, schedule and deep research, open its conversation, or delete
it.

## Sub-features

- `routine-create`: ask "every weekday at 7:30, give me the weather"; the model confirms and saves the routine.
- `routine-list`: the Routines page shows a card per routine with its schedule, next run, last run and task.
- `routine-toggle`: the switch named "Run “<title>”" pauses the routine and turns it back on.
- `routine-edit`: "Edit" turns the card into a form, and saving changes the schedule or task.
- `routine-open`: "Open conversation" opens the routine's conversation, with a bar `#routine-bar` at its top.
- `routine-delete`: "Delete" removes the routine and keeps its conversation as an ordinary one.

## How to get to it (user POV)

- Ask in any conversation to create one.
- Sidebar → "Routines" for the page (`#routines-page`, back button `#routines-close`). The sidebar's Routines list
  (`#routine-list`) and `#routine-bar` also switch and delete.

## Driving it with browser-session.ts

Preconditions:

- A routine exists, and making one needs the model, so `stack.sh doctor` must print `Codex signed in: true`. Without
  that, `routine-list` can only show the empty state. Report `NOT RUN: Codex is not signed in` for the rest.

- **Create.** In a new conversation, send `Every weekday at 7:30, tell me one fun fact. Name it Fun fact.` and answer
  any `#question` with the confirming choice. `stack.sh data routines.json` then holds a routine titled `Fun fact`.
- **List.** Tap `#open-sidebar`, then `#routines-entry button`. `#routine-cards` has a `.card` with the heading
  `Fun fact` and a `.card-detail` that names weekdays and 07:30.
- **Toggle.** Uncheck the switch "Run “Fun fact”". The card reads "Paused", and `routines.json` has `enabled: false`.
- **Edit.** Tap "Edit", change the task, then save. The card's `.routine-task` shows the new text.
- **Delete.** Tap "Delete" and accept the dialog. The card goes away, and the conversation is still in `#chat-list`.

## Gotchas

- A one-off routine that has already run shows "Done" and its switch is disabled. That is how it is meant to work.
- Each person can have at most 10 routines and 20 runs a day. Delete what the journey made.
- A routine run has no `ask` or `routine` tool, so don't expect questions in its conversation.
- Waiting for a scheduled run takes real time. To prove that a run happens, schedule it `once` a few minutes ahead
  rather than mocking the clock.

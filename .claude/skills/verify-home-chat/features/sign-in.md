# Sign-in

In local mode, each person enters an access code to reach the workspace. The owner and the guest each see only their
own conversations and private lists. Sign-out returns to the code screen.

## Sub-features

- `signin-code`: a correct code opens `#workspace`, and the code field is empty afterwards.
- `signin-wrong`: a wrong code shows an error and stays on `#login`.
- `signin-signout`: `#logout` ends the session, and the page reloads to `#login`.
- `signin-accounts`: the owner and the guest are separate accounts. `#identity` reads "Your space" for the owner and
  "Guest space" for the guest, with the avatar letter Y or G. It does not show their names.

## How to get to it (user POV)

- Open `http://127.0.0.1:8787`, paste the code into "Access code" and tap "Enter Home Chat".
- Sign out with "Sign out" at the foot of the sidebar (inside the drawer on phones).

## Driving it with browser-session.ts

Preconditions:

- `stack.sh doctor` prints `OK`. `#provider-warning` is visible when Codex is not signed in, which is expected.

- **Correct code.** `openSignedIn('owner')` fills `#access-code`, clicks `#login-form button` and waits for `#workspace`.
  `scripts/check-browser.ts` then asserts that `#access-code` is empty. Run
  `stack.sh run node scripts/check-browser.ts`, which also covers picture upload and removal and both layouts.
- **Wrong code.** On a fresh page, fill `#access-code` with `not-a-code` and click `#login-form button`. `#error` shows
  "Invalid access code", `#login` stays visible and `#workspace` stays hidden. The toast hides itself after about 8
  seconds.
- **Sign-out.** Click `#logout` (on phones, `#open-sidebar` first). The page reloads itself and shows `#login`.
- **Accounts.** Sign in as `guest` with `openSignedIn('guest')`. `#identity` reads "Guest space". Each person's first
  sign-in made a "New conversation", so the titles match. Compare the `data-chat` ids of `.chat-item` in `#chat-list`,
  `#starred-list` and `#shared-list` instead: none of the owner's private ids appear for the guest.
- **Stored.** Sessions live in memory only, so restarting the app signs everyone out. The access codes are in plain
  text in `local-access.json`. Never read that file with `stack.sh data`, or the codes end up in evidence.

## Gotchas

- Five wrong codes from one address lock sign-in for 15 minutes, and during the lock even a correct code gets "Too
  many attempts; wait 15 minutes". A successful sign-in, the doctor's included, resets the count. The browser reaches
  the app through Docker's gateway, so every journey shares that address. Use at most one wrong code per run, and if it
  locks, run `down` and `up`.
- The server keeps at most 16 sessions, and each lasts 8 hours. A journey that signs in without signing out uses one
  up, and the 17th sign-in gets 429 "Too many sessions". `openPhone()` reuses its context's session. Sign out at the
  end, or run `down` and `up`.
- `openPhone()` shares its session with the desktop page, so signing out on the phone signs out the desktop page as
  well. That page keeps showing the workspace until it reloads or calls the API, which then answers 401 "Sign in
  required".
- Access codes never go into logs, URLs or evidence. Both `browser-session.ts` and `stack.sh doctor` keep them in pipes.

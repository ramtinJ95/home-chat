# Sign-in

In local mode, each person enters an access code to reach the workspace. The owner and the guest each see only their
own conversations and private lists. Sign-out returns to the code screen.

## Sub-features

- `signin-code`: a correct code opens `#workspace`, and the code field is empty afterwards.
- `signin-wrong`: a wrong code shows an error and stays on `#login`.
- `signin-signout`: `#logout` ends the session, and a reload shows `#login`.
- `signin-accounts`: the owner and the guest are separate accounts, and `#identity` names who is signed in.

## How to get to it (user POV)

- Open `http://127.0.0.1:8787`, paste the code into "Access code" and tap "Enter Home Chat".
- Sign out with "Sign out" at the foot of the sidebar (inside the drawer on phones).

## Driving it with browser-session.ts

Preconditions:

- `stack.sh doctor` prints `OK`.

- **Correct code.** `openSignedIn('owner')` fills `#access-code`, clicks `#login-form button` and waits for `#workspace`.
  `scripts/check-browser.ts` then asserts that `#access-code` is empty. Run
  `stack.sh run node scripts/check-browser.ts`, which also covers picture upload and removal and both layouts.
- **Wrong code.** On a fresh page, fill `#access-code` with `not-a-code` and click `#login-form button`. `#error` shows
  "Invalid access code" and `#login` stays visible.
- **Sign-out.** Click `#logout` (on phones, `#open-sidebar` first). `#login` becomes visible. After `page.reload()`
  `#login` is still shown, so the cookie session is gone.
- **Accounts.** Sign in as `guest` with `openSignedIn('guest')`. `#identity` differs from the owner's, and `#chat-list`
  shows none of the owner's private conversations.

## Gotchas

- Five wrong codes from one address lock sign-in for 15 minutes. The browser reaches the app through Docker's gateway,
  so every journey shares that address. Use at most one wrong code per run, and if it locks, run `down` and `up`.
- The server keeps at most 16 sessions, and each lasts 8 hours. A journey that signs in without signing out uses one
  up, and the 17th sign-in gets 429 "Too many sessions". Sign out at the end, or run `down` and `up`.
- Access codes never go into logs, URLs or evidence. Both `browser-session.ts` and `stack.sh doctor` keep them in pipes.

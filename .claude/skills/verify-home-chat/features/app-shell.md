# App shell

The parts of Home Chat around the conversations: a light and dark theme, adding the app to the Home Screen, and push
notifications when a reply or routine run finishes. The welcome screen of an empty conversation offers one setup step at
a time, install first and then notifications, and the sidebar keeps a quieter way to each.

## Sub-features

- `shell-theme`: `#theme-toggle` switches between light and dark and saves the choice. Without a saved choice the page
  follows the system setting.
- `shell-install`: on iPhone and iPad, a welcome card "Keep Home Chat on your Home Screen" and the sidebar's "Add to
  Home Screen" explain how to install. Chromium browsers that offer an install prompt get "Install" and "Install Home
  Chat" instead. Both are hidden once the app runs installed.
- `shell-notifications`: a welcome card "Know when a reply is ready" with "Turn on", and the sidebar's
  `#notifications`, which reads "Turn on notifications", "Notifications on · Turn off", or a note that they are blocked
  in the browser's settings.
- `shell-dismiss`: "Not now" on either welcome card hides that card for good on this browser.

## How to get to it (user POV)

- The theme button is at the foot of the sidebar, beside "Sign out".
- The welcome cards are on an empty conversation, above the suggestions. `#install` and `#notifications` are among the
  sidebar's actions.

## Driving it with browser-session.ts

Preconditions:

- `stack.sh doctor` prints `OK`. Codex isn't needed.

- **Theme.** Tap `#theme-toggle` (its name is "Switch to dark mode"). `html` gets `data-theme="dark"`, localStorage
  `home-chat-theme` is `dark`, the button is renamed "Switch to light mode", and the choice survives a reload. Tap it
  again for light. In a context made with `colorScheme: 'dark'` and nothing saved, the page is dark, `data-theme` is
  unset, and the button reads "Switch to light mode".
- **Install, default browser.** Headless Chrome is neither an Apple device nor offering an install prompt, so
  `#install` is hidden and there is no install card. That is expected.
- **Install, iPhone.** Make a context with an iPhone user agent and the signed-in storage state. The empty conversation
  shows "Keep Home Chat on your Home Screen" with "Tap Share in your browser (in Safari it can be under ···), then Add
  to Home Screen." The drawer's `#install` has an "Add to Home Screen" summary that opens the same text. "Not now" sets
  localStorage `home-chat-install-dismissed` to `1`, and the card stays away after a reload. This proves the iPhone
  branch of the page, not an install on a real device.
- **Notifications.** With the browser's default permission, `#notifications` reads "Turn on notifications" and, with
  no install card ahead of it, the empty conversation shows "Know when a reply is ready". "Not now" sets
  `home-chat-notify-dismissed` to `1`, which survives a reload while the sidebar control stays.

## Gotchas

- Headless Chrome has no push service, so "Turn on" fails with the toast "Registration failed - permission denied"
  even after `context.grantPermissions(['notifications'])`. Subscribing and delivery can't be proved in this harness.
  Report them as not run.
- A tapped notification opens `/?chat=<id>` (with `&pause=<routine>` from a routine's Pause button). The app opens that
  conversation and sets the address back to `/`.

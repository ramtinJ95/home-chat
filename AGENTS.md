# Agent instructions

## Who writes the code

The primary agent (Claude Code) writes the code. Astra (pi in Herdr) verifies and reviews it: running tests, headless browser checks, and reviewing diffs.

Hand work to Astra only when it is strictly necessary because the primary agent cannot do it from its sandbox, such as:

- commands on home-macmini (deploys, Docker, Cloudflare)
- `npm install`, pushing, and opening or merging PRs
- anything that needs to bind ports or open sockets

The one exception is when the user explicitly says Astra should write the code for a specific task.

## Screenshots in PRs

When a feature or bug fix changes what the UI looks like, its PR description shows the change in screenshots from the headless browser check. Put the 390px phone width first, then desktop, and add dark theme where the change looks different there. Give each screenshot a one-line caption saying what it shows.

`gh` can't upload images, so commit the PNGs to the `pr-screenshots` branch in a folder named after the PR's branch, and embed each one as `![caption](https://github.com/ramtinJ95/home-chat/blob/pr-screenshots/<pr-branch>/<file>.png?raw=true)`. Keeping them off the feature branch keeps the images out of `main`.

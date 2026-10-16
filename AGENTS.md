# Agent instructions

## Who writes the code

The primary agent (Claude Code) writes the code. Astra (pi in Herdr) verifies and reviews it: running tests, headless browser checks, and reviewing diffs.

Hand work to Astra only when it is strictly necessary because the primary agent cannot do it from its sandbox, such as:

- commands on home-macmini (deploys, Docker, Cloudflare)
- `npm install`, pushing, and opening or merging PRs
- anything that needs to bind ports or open sockets

The one exception is when the user explicitly says Astra should write the code for a specific task.

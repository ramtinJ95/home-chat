# Home Chat roadmap

Agreed on 2026-10-16. Eight features, each in its own PR: the Home Screen app, push notifications, documents and the
reader, deep research, routines, About us, search, and small conveniences. Home Chat is for non-technical people on
phones first. The model sets things up through conversation and questions. The interface was to only show and stop
them; routines have since become editable in the app as well.

All eight PRs are merged and deployed. The [README](../README.md) describes how each feature works now.

## Decisions

| Decision | For PR | Outcome |
| --- | --- | --- |
| Egress proxy may reach the push services (Apple `web.push.apple.com`, Google `fcm.googleapis.com`, Microsoft `*.notify.windows.com`) | 2 | Approved 2026-10-16. Only the server sends to them, never the model, and only to subscription endpoints on those hosts |
| Egress proxy may reach `api.exa.ai`; Exa key on home-macmini | 4 | Approved. The existing key is in home-macmini's `.env` as `EXA_API_KEY` (mode 600, test call HTTP 200); compose passes it to the app from PR 4 |
| Exa spending caps | 4 | None, by the user's choice |
| Household time zone for schedules | 5 | `Europe/Stockholm` |

## Also open

- Backups and retention of the `home-chat_chat-data` volume (README "Not done yet").
- A live check of a full-size iPhone photo upload (PR #4).

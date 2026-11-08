# A session cannot move to another account when its account is exhausted

A routed session is pinned to the account allocated at launch for its whole
life (`topics/agent-auth-router.md`: "Existing pins cannot switch accounts";
`/resume` rejects router fields with "resumed sessions retain their pin").
Pool policies skip exhausted, rate-limited or blocked accounts only when a
session launches. When the pinned account hits its 5-hour or weekly limit, the
session is stuck until the window resets:

- Restart, handoff and fork-with-summary refuse routed sessions
  ([routed-auxiliary-launch-inheritance](routed-auxiliary-launch-inheritance.md)).
- Clone and turn fork inherit the same binding, so they hit the same limit.
- A direct (unrouted) session cannot be moved onto a pool or account either;
  the only cross-provider move is restart/handoff into a new session.

Why it should be cheap: YA owns the transcript and resumes it by provider
session id, so moving between accounts of the same provider and model loses
only the prompt cache. The resume must use the new account's credentials for
the same native transcript.

Proposed shape: a "switch account" action (and optionally automatic failover
when the router reports the pinned account rate-limited) that revokes the old
binding, allocates a new one from the same pool or an explicit account,
updates the session's stored binding, and resumes on next turn. Moving direct
↔ routed is the same operation with an empty side. Never fall back to the
owner's direct login implicitly. Open questions: whether Codex/Claude native
resume tolerates a credential change mid-transcript (server-side state such as
Codex response ids may be account-scoped), and whether the old account's
in-flight stream must finish first.

Found 2026-11-08 while auditing launch paths after a queued session ran on
the maintainer's rate-limited personal account.

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
owner's direct login implicitly.

The provider process must be replaced: YA hands the routed credential to
Claude as per-launch environment/flag settings and to Codex as a launch-time
provider definition, so a live process cannot change account from YA's side.
An alternative that would avoid the restart is for AAR to repoint an existing
allocation's token at another account; AAR deliberately refuses silent
switching today and lists cross-account continuation as later work
(`agent-auth-router` `docs/plan.md`, `docs/routing-policies.md`).

Claude evidence (2026-11-08, isolated YA on port 4610 with its own data dir,
paired to the live AAR with two Claude accounts granted; Claude Haiku 5.5,
thinking on): one session ran turn 1 on account A with a signed thinking
block, then, with the server stopped and the session's stored
`routerBinding` replaced by a second session's account-B binding, resumed on
B and recalled the codeword; ran a Bash tool turn on B; then switched back to
A and answered with a new signed thinking block, recalling the codeword and
tool output. AAR's request log attributed each turn to the expected account
and binding, all 200. So a resumed Claude transcript carrying another
account's thinking signatures is accepted, and switching needs only a
process restart. Not covered: a switch in the middle of a tool loop
(the experiment switched between turns), and Codex, whose only enrolled
account was at 100% weekly usage. Codex encrypted reasoning items may be
account- or org-scoped and need their own check before Codex switching ships.

Found 2026-11-08 while auditing launch paths after a queued session ran on
the maintainer's rate-limited personal account.

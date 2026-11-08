# Switch a session's router account

Topic: agent-auth-router

Status: implemented 2026-11-08.

## Goal

Move an existing Claude or Codex session to another Agent Auth Router
account, or between Direct and a router account, when its pinned account is
exhausted. Previously a pin lasted for the session's life, so a session whose
account hit its 5-hour or weekly limit was stuck until the window reset
(restart, handoff and fork-with-summary refuse routed sessions; clone and
fork inherit the same account). Kept deliberately basic (maintainer, 2026-11-08): no hints, usage bars,
automatic failover or "any account in pool" entry yet.

## Behaviour

- The session header's router chip opens a small menu: the provider's pool
  accounts grouped by pool, then Direct, then Details (the Process info tab
  the chip opened before). Direct sessions show a "Direct" chip when the
  router is connected, with the same menu.
- Picking an entry switches immediately. The provider process is killed
  whatever its state (no idle requirement, no interrupt); the next message
  resumes the same transcript on the new account. The process must be
  replaced because YA hands the routed credential to Claude as per-launch
  settings and to Codex as a launch-time provider definition.
- Order, so a refusal changes nothing:
  1. Allocate, prepare and commit the new pin in AAR (`/v1/pools/prepare`,
     policy `manual`, the picked account), and check the account serves the
     session's model, thinking and tier. A refusal returns the router's
     message; the old pin and process are untouched.
  2. Save the new binding (or remove it, for Direct).
  3. Kill the process (`abortSessionWithVerification`, as Kill does; not
     `/terminate`, which archives and writes a done boundary).
  4. Cancel the old allocation (best effort; cleanup stays retryable in
     Settings → Providers).
- A pick is saved as a Manual pool pin on that account, so New session from
  the composer keeps the same account.
- The model is the live process's resolved model or the saved requested
  model. When moving onto the router the concrete id is saved as the
  requested model, since the router refuses aliases such as `opus`.
- Refused for remote executors, project-write sandboxes and providers other
  than Claude and Codex (the existing router launch rules). Limited users
  cannot reach it: the route lives under `/api/agent-auth-router`, which
  limited users are already denied.

## API

`POST /api/agent-auth-router/sessions/:sessionId/switch` with
`{ routerPoolId, routerAccountId }` or `{ direct: true }`. Returns
`{ routerBinding }` (null for Direct). Capability
`agent-auth-router-session-switch` (optional bit with the router bits).

## Steps

1. AAR service: `switchBinding`, sharing prepare/catalog checks with
   `launch`; metadata can clear `routerBinding`.
2. Route and capability.
3. Client: chip menu in the session header; reload the page after a switch,
   as Restart provider does.
4. Tests: switch success, refusal leaves the pin, Direct clears it.
5. Docs: router topic, gap deleted.

## Review (Opus 5.5, 2026-11-08)

Fixed: a resume that took the old token before the switch registering after
the kill (refused at registration; its cleanup no longer cancels the new
pin); orphaned allocations after a lost reply; retained hosted runtimes not
yet reattached (switch refused); model fallback to the current pin; missing
`service-tiers-v1` check; a misleading error when the kill fails; limited
users keep the Session info shortcut; menu keyboard focus. Aliases resolve
by family without the accounts' CLI rows, as `resolveRouterModel` does
elsewhere; a `[1m]` context suffix is not carried onto the router.

Live (standalone YA, Work-claude pool, Haiku 5.5): switched an idle session
between all three accounts, and once mid-turn while streaming; each resume
ran on the new binding per AAR's request log and recalled the earlier
codeword. Direct and back, and a refused target (a Codex account), behaved
as specified.

## Evidence

Claude, 2026-11-08, isolated YA on port 4610 paired to the live AAR with two
Claude accounts (Haiku 5.5, thinking on): a session ran turn 1 on account A
with a signed thinking block; with the stored `routerBinding` replaced by an
account-B binding it resumed on B, recalled the codeword and ran a Bash tool
turn; switched back to A it answered with a new signed thinking block. AAR
attributed each turn to the expected account, all 200. So a resumed Claude
transcript carrying another account's thinking signatures is accepted after a
process restart. Not covered then: a switch in the middle of a tool loop, and
Codex (its only enrolled account was exhausted); the maintainer expects Codex
to behave the same with a fresh process.

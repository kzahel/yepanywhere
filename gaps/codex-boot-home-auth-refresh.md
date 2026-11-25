# Codex token refresh through a boot home's linked auth.json is unverified

A Codex [boot home](../topics/session-boot-instructions.md#codex-boot-home)
links `auth.json` to the operator's file
(`packages/server/src/sdk/providers/codex-boot-home.ts`, `linkCarriedEntry`).
That is correct only if Codex rewrites the file in place when it refreshes its
login. If it instead writes a new file and renames it over the link, the boot
home gets a private copy holding the rotated refresh token while the
operator's file keeps the now-dead one, logging the operator out. The next
boot launch then replaces that private copy with a link again, discarding the
only valid token.

Codex accepted the link for an ordinary turn on CLI 0.172.0; no run has
crossed a token refresh. The session sandbox's private homes copy
`auth.json` instead, and have the divergence problem in its plain form.

Likely fix: read how the pinned Codex CLI writes `auth.json` on refresh. If it
renames, have `linkCarriedEntry` treat a regular `auth.json` newer than the
operator's as the current login and move it back over the operator's file
before relinking, or refuse the launch with an explanation.

Found 2026-11-25 while implementing session boot instructions.

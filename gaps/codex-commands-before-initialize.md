# Early Codex commands can reach app-server before `initialize`

`/goal`, `/status` and `/usage` read the session's client as
`activeClient ?? (await initialActiveClient)`
(`packages/server/src/sdk/providers/codex.ts`, `runProviderCommand`). Both
become available when `runSession` creates the client: `setActiveClient`
runs before `appServer.connect()`, and `connect()` spawns the child
synchronously. A command that is waiting on the latch, or that arrives in
that window, therefore writes its request to the new process before
`initialize`. For a resumed session it can also write before
`thread/resume`.

Codex refuses any request before `initialize` with "Not initialized"
(`references/codex/codex-rs/app-server/src/message_processor.rs:1013`).
The expected results:

- **`/goal`:** returns that error to the user.
- **`/status`:** quietly drops the account and rate-limit sections.
- **`/usage`:** reports "Token activity unavailable".

The test fixtures answer requests in any order, so no test sees this.

**Not established:** whether any current caller dispatches a provider
command in that window. The resume route's `/goal` case
(`test/api/codex-compact.test.ts`, "keeps an initial goal query idle")
passes only against a fixture that does not enforce ordering. Reproduce
against a fixture that enforces `initialize` before choosing a fix.

**Likely fix:** publish the client to commands, and settle the latch, only
after `initialize` and the thread start or resume have completed. Slice 3
of the [Codex session lifecycle plan](../docs/tactical/186-codex-session-lifecycle.md)
moves this latch. Decide there, as its own behaviour-changing commit, not
inside the refactor.

Found 2026-11-09 while writing the slice 0 tripwires for that plan.

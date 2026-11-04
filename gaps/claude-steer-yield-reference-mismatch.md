# Claude steer-yield observation compares the pre-translation object

`waitForMessageYield` in `packages/server/src/sdk/providers/claude.ts` watches
`messages.includes(message)` in yielded/removed notifications. The Claude queue
uses `prepareClaudeInput`, which clones steering inputs to apply native priority
(`sdk/providers/claude-delivery.ts`). The emitted queue entry therefore keeps
the input UUID but is not the object captured by that observer.

Static inspection indicates its completion promise can wait until abort and
prevent the subsequent `steerBackgroundController.backgroundEligible()` call.
The native command itself can still be accepted: command-lifecycle receipt
coverage is not evidence that this optional background-Bash callback ran.
No real foreground-Bash failure was reproduced in the FIFO/identity slice.

Verify with a real held foreground Bash and enabled background-on-steer policy,
then match the authoritative queued input UUID (with reference fallback only
for genuinely identity-free entries). Cover cancellation/removal and listener
cleanup as well as positive consumption. Keep the optional tool/background
policy separate from ordinary FIFO delivery; changing it without native
qualification would expand that slice's behavioral scope. Existing controller
unit tests exercise its decisions but not this cloned-input observation seam.

Found 2026-11-04 while checking queue consumption identity after native priority
translation.

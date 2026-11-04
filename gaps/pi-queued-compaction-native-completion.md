# Pi successful queued compaction lacks completion evidence

`PiProvider.runProviderCommand` returns `{ handled: true }` after native RPC
`compact` succeeds. That result means more than dispatch acknowledgement for
Pi, but does not carry completion evidence into YA. `Process` deliberately
holds a queued compact and subsequent input until both a compact boundary and
terminal result arrive. Pi's normalizer has no compact-boundary conversion;
the session iterator also waits for user input between ordinary prompts.

The retained native scenario proves the small-session refusal and recovery by
explicit cancellation. It does **not** qualify successful Pi compact, and no
successful native compaction was fabricated to make the shared suite green.
Native success with enough context must be the next executable-backed repro.

Define the distinction between synchronous native completion and asynchronous
dispatch before repairing this path. Pi's real successful RPC result can supply
evidence, while Codex/Claude must retain their existing native boundary/terminal
ownership. Do not guess completion from `handled`, a timeout, optimistic UI or
the arrival of a model summary alone. Verify durable native compaction and
separate A/B delivery afterward; cover errors and an aborted/lost RPC result.

This remains separate from the completed Claude/Codex queued-compact scenarios
and does not authorize advertising new Pi command UI. See
[plan 175](../docs/tactical/175-native-provider-integration-scenarios.md) and
[native coverage](../topics/native-provider-testing.md#retained-lifecycle-and-recovery-depth--2026-11-04).

Found 2026-11-04 while extending all-provider native integration coverage.

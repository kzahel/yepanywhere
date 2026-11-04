# Explicit interrupt batching can lose contributing input identities

The implicit provider-queue concatenation path is repaired (2026-11-04):
`MessageQueue` now yields one supplied input at a time. Real Claude/Codex/Pi
backlog scenarios retain input boundaries, and current Claude native grouping
uses authoritative `mergedSendUuids`, normalized as `inputMessageIds`, to remove
contributing echoes and resolve original-input links. Native grouping remains
the provider's decision. The real browser covers the current Claude path.

Remaining: `Process.interrupt` deliberately drains accepted direct/deferred
input and assembles one provider turn through `concatMessages` /
`concatUserMessages`. That explicit join keeps the first UUID and every present
`tempId`, but does not retain every contributing UUID. Earlier direct entries
can already have separate sent echoes. An id-only later chunk can therefore
lack a durable counterpart, leaving a stale sent copy beside the combined row.
The optional deferred join window has its own identity/navigation obligations;
its queued-chip reconciliation already uses `tempIds`, so do not infer that
every configured join produces a duplicate sent echo.

Keep this narrower remainder open until an explicit interrupt/drain scenario
proves every prior echo reconciles after delivery and reload, including inputs
without temporary IDs. Audit configured join callers before changing their
product semantics. Do not remove explicit batching as a side effect of the
ordinary FIFO repair or infer identity by arbitrary prompt-text matching.
Pi's separate supplied-UUID/native-node mapping remains in
[its identity gap](provider-user-turn-durable-identity.md).

[Plan 175](../docs/tactical/175-native-provider-integration-scenarios.md#input-batching-investigation-and-recommendation)
records the native evidence and selected boundary. The original October 21
Rendez upload report and November 4 fail-before probes remain in Git/task
history; Rendez itself no longer takes the original implicit queue path.

Found 2026-10-21 while diagnosing batched Rendez uploads; narrowed 2026-11-04
after the implicit queue and current native-group identity repair.

# Transient metadata read errors can remove retained discovery inputs

Status: addressed by the native discovery fixes. Acceptance exercises real
Windows exclusive locks, retained project/index rows, recovery without a second
event, and true absence. The contract lives in `topics/session-index-validation.md`.
This historical entry is retained in this draft rather than deleted.

## Original diagnosis

`packages/server/src/utils/jsonl.ts` `readFirstLine` catches open/read errors
and returns null. `packages/server/src/sessions/codex-discovery.ts`
`readCodexRolloutMetadata` treats that result as unreadable metadata, so the
incremental scanner's exception-based retry cannot preserve a previously
accepted contribution for these errors. Its stat-error path does preserve it.

Similarly, `packages/server/src/projects/paths.ts` `readCwdFromSessionFile`
returns null on I/O failures. Claude directory discovery cannot distinguish
those failures from files without cwd metadata. If no usable file remains in
the directory scan, its previously retained contribution can disappear.

This is established from the current call paths, not a reproduced explanation
of the maintainer's healed starred-item incident. Add real read-error injection
before changing the shared helpers: distinguish absence/invalid metadata from
transient I/O failure, preserve accepted inputs and pending retry work, and
audit the helpers' other callers. Keep invalid-file and missing-file behavior
deliberate. Deferred from the startup-timing slice because the shared read
contract extends beyond project discovery.

Found 2026-10-09 while auditing incremental project discovery for
`gaps/new-session-tab-boot-latency.md`. Contributing-model: 6-astra.

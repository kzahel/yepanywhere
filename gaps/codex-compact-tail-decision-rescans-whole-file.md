# Codex compact-tail decision rescans the whole rollout on every read

When a plain Codex rollout is larger than the compact-tail size estimate
(2 MiB per requested boundary) but has fewer than the requested number of
`compacted` records, the reader learns that only by scanning the whole file.
`findCompactWindowStart` (`packages/server/src/sessions/codex-rollout-window.ts`)
reads backward in 1 MiB blocks and returns `null` only after reaching byte 0.
`getSession` (`sessions/codex-reader.ts`, the compact-window branch) then
falls back to `readEntries`, the complete reader. The decision is not
remembered, so:

- A cold open scans the file, then reads and parses the same bytes again.
- A warm open, with the complete entries already cached, rescans the whole
  file and then reuses the cache.
- Every incremental catch-up does the same. `readCodexIncrementalSnapshot`
  (`sessions/codex-incremental-snapshot.ts`) reuses a cached snapshot only when
  its start byte is above 0, so a complete cache never qualifies, and it calls
  `findCompactTailStart` again before reusing or extending the cache.

Catch-up is the session page's `afterMessageId` fetch, coalesced to one
request in flight (`fetchNewMessages` in
`packages/client/src/hooks/useSessionMessages.ts`, `runExclusiveFetchNewMessages`
in `lib/sessionDetail/sessionDetailCoordinator.ts`). For a viewed session that
another process owns, rollout file changes trigger it through a 500 ms
throttle (`hooks/useSession.ts`, `throttledFetch`, `handleFileChange`,
`handleSessionWatchChange`). A session this server owns ignores file changes;
it fetches at completion and idle, on reconnect, on the 30-second heartbeat
when liveness reports unreconciled progress, and every 3 s while a sent
message is unconfirmed. It is not per streamed token, but a session in use
pays a full-file scan on each of these.

On one maintainer host on 2026-11-15, 192 of 3,798 rollouts (1,912 MB) took
this path for the default two-boundary request; 53 of them are over 10 MB
(1,018 MB), and the largest is 97 MB. A cold open of all 192 scans 1,912 MB
before the complete read. Measured with
`scripts/perf-repro/codex-complete-read-fallbacks.mjs`.

The complete result itself is the contract: with fewer than N boundaries the
detail endpoint returns the whole transcript
([compact-tail pagination](../topics/session-compact-tail-pagination.md#contract)).
Only the repeated decision scan is wasted.

Not fixed while measuring: that slice changed no runtime behaviour.

Cheap fix: when a complete entry snapshot is cached for the same file
version, count its `compacted` entries instead of scanning. Otherwise remember
"fewer than N boundaries through byte X" per file identity and scan only
`[X, size)` on the next request. Cover it with a test that counts bytes read
on a repeated catch-up.

Found 2026-11-15 while measuring Codex complete-reader fallbacks
([provider history facts](../topics/provider-history-facts.md#delivery-order)
step 3).

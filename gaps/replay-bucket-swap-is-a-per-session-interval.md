# The replay buffer swaps buckets on one interval per provider process

`Process.startBucketSwapTimer` (`packages/server/src/supervisor/Process.ts`)
starts a `setInterval` every 15 seconds when a `Process` is constructed and
clears it only when the process terminates. Every YA-owned provider process,
including one that is idle with no viewer, therefore holds its own repeating
timer for as long as it is retained. The interval is not unref'd.

`ARCHITECTURE.md` (Bounded retention) says never to add a timer per session,
and [resource quiescence](../topics/architecture-mandates.md#resource-quiescence)
says an idle session with no active view must not create repeating server
work. Each tick only swaps two array references, so the cost is small; the
defect is the shape, which scales with retained sessions.

Not fixed in place because `DEVELOPMENT.md` lists the replay buffer among the
load-bearing pieces whose trade-offs are surfaced before code changes.
The cheap direction: rotate by timestamp when a message is appended or the
buffer is read, and release an idle process's buckets through
`lib/processIdleSweep.ts`, so no per-process timer exists. Remove the
`Process.ts` entry from `scripts/timer-ownership.json` in the same commit.

Found 2026-11-15 while recording the timer ownership baseline.

# Field ownership typing acknowledgement exceeds 100 ms in CI

`packages/client/e2e/field-ownership.spec.ts` intermittently fails the native
typing acknowledgement gate with 500 settings rows and concurrent 50 ms
updates. In [CI 43526368642](https://github.com/kzahel/yepanywhere/actions/runs/43526368642)
on `5568f05c3`, the desktop phase measured 123.2 ms; its retry passed at
43.3 ms desktop and 67.1 ms phone. Exact prefixes, retained input and focus
passed before the failing latency assertion. No lost key or input remount was
observed in that attempt.

The November 7–14 survey covers 78 CI runs, of which 34 executed this newer
case. Five needed a retry, with no terminal failures: runs `42990576039`
(132.5 ms), `43017361333` (123.0 ms), `43080010248` (119.8 ms),
`43280666871` (109.6 ms) and `43526368642` (123.2 ms). Reproduce the survey
with `node scripts/e2e-flake-report.mjs --since 2026-11-07 --case field-ownership`.

The first failure has only screenshot/error context; CI traced the passing
retry, whose per-key samples do not establish the failed attempt's mechanism.
The fixture's synchronous filtering and repeated row renders are candidates,
but no failed-frame profile implicates them. The concurrent
[queued-compaction miss](queued-compaction-typing-ack-over-100ms.md) was in a
different shard and browser process. Runner pressure is also unproven.

Both cases now retain first-attempt per-key browser phases, original gate
samples and long-task/long-animation-frame attribution as JSON attachments.
Inspect a failing sample's dispatch, input and frame timings and overlapping
script/layout attribution before selecting a production or fixture change.
The original timing assertion, workload and retry policy remain intact.

Three serial local repetitions on macOS/Node 22.23.3 passed without retries;
maximum across both viewports was 25.4 ms. This is diagnostic evidence, not a
repair or hosted reliability qualification.

Found 2026-11-14 while investigating the two retries in the first green CI run.

Later on November 14 the maintainer authorized a shared-CI ceiling distinct
from the responsiveness target: these two cases use 500 ms with `CI` set,
retaining 100 ms locally and recording target misses as report annotations.
The [queued-compaction finding](queued-compaction-typing-ack-over-100ms.md#shared-ci-ceiling-authorized-november-14)
records the measured rationale. The analysis script counts annotated executions
even when tests pass. No character-retention, focus or identity assertion was
relaxed. This policy avoids making the observed sub-500 ms misses fail CI;
the underlying attribution question remains unresolved.

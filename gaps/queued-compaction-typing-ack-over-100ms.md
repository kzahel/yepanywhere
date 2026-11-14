# Queued compaction typing acknowledgement exceeds 100 ms in CI

`packages/client/e2e/queued-compaction.spec.ts:12` ("Queue preserves compact
order through reload and acknowledges typing during completion") asserts that
every keystroke typed during compact completion, with 1,000 creation history
rows and concurrent title updates, is acknowledged within 100 ms
(`queued-compaction.spec.ts:223`). In the 64 CI runs on `main` from
2026-11-07 to 2026-11-12 it failed its first attempt in 19: 13 passed on
retry and 6 failed every attempt. Observed maxima ranged from 100.3 to
246.4 ms, most between 103 and 160 ms; every miss was latency, not a lost
key. The last miss was [CI 43195703271](https://github.com/kzahel/yepanywhere/actions/runs/43195703271)
on `bd2165618`, at 106, 136 and 144 ms across its three attempts.

As of November 12, the case had not missed in the five runs since `27e43f896`
(input responsiveness calibration) and `f2551873d` (session updates no longer
re-render every transcript text block). The calibration commit changed only
measurement tooling and documentation, so it was not a production repair.
Five passing runs did not establish that the renderer change repaired this.
Confirm with `node scripts/e2e-flake-report.mjs --case queued-compaction`
over at least a week of runs before closing this. If it
recurs, capture input and frame attribution from the retry trace before
changing anything. At that point the 100 ms limit was also the CI failure
gate; the later maintainer-authorized CI policy is recorded below.

Found 2026-11-12 while surveying first-attempt browser failures in CI.

## November 14 investigation

The apparent improvement above did not hold. The first green repair run,
[CI 43526368642](https://github.com/kzahel/yepanywhere/actions/runs/43526368642)
at `5568f05c3`, failed its first attempt at 160.7 ms; its retry passed at
96.7 ms. The November 7–14 report survey now counts 14 retry passes and six
terminal failures in 78 executions. The exact prefix and sample-count checks
passed before the latency assertion; this occurrence supplies no lost-key
evidence. The following provider-turn/order assertion is after the latency gate
and was not reached on that attempt.

CI's `on-first-retry` policy retained only the successful retry's trace.
The first attempt has an error context and screenshot, but neither records
which key was slow or whether event dispatch, input handling, layout or frame
scheduling consumed the time. The successful trace cannot establish that cause.
The independent [field ownership finding](field-ownership-typing-ack-over-100ms.md)
in the same run is on another shard, so these are not two pages contending in
one browser process.

The two specs now attach browser key dispatch/input/first-frame/second-frame
times, retained values and supported long-task/long-animation-frame attribution
before their existing latency gates. CI retains those JSON files from the
first attempt as well as retry traces. The original acknowledgement samples,
100 ms gates, workload, retries and timeouts are unchanged. These diagnostics
prepare the next occurrence; they do not repair or explain this failure.

Three serial repetitions on macOS/Node 22.23.3 passed without retries (maximum
per repetition 30.3, 22.8 and 29.5 ms). These local diagnostic controls do not
qualify CI reliability. An initial local invocation under the shell's Node 27
alpha failed fixture startup because that runtime is unsupported; those were
not reproductions of the input failure.

With diagnostics, five more repetitions per spec passed across two-worker
runs. A temporary real key-handler stall measured 150.7–150.9 ms through input
and 151.3–151.5 ms through the second frame in the final control, with a 150 ms
long-task entry; one control also supplied `INPUT.onkeydown` frame attribution.
The temporary control was removed rather than adding another permanent CI
case. The final six-case invocation (four existing cases plus two controls)
took 34.4 seconds including startup and teardown. No speed improvement is
claimed from the different worker schedules.

## Shared-CI ceiling authorized November 14

The maintainer requested that busy shared CI stop failing repeatedly at the
100 ms responsiveness target. These two cases now use a 500 ms CI regression
ceiling and retain 100 ms locally. The observed maxima in this survey are
246.4 ms here (38 failing attempts) and 132.5 ms for field ownership (five),
so 500 ms provides 2.0–3.8 times measured headroom. None of those historical
timing misses exceeds the new ceiling; their historical failures remain in
the analysis, not rewritten as green runs.

Each measured window above 100 ms records a `typing-target-miss` annotation.
The existing flake-report script counts executions with those annotations
separately from failing tests, including cases passing under the CI ceiling.
This is a CI policy change, not a product responsiveness repair; attribution
of the historical stalls remains open. Character-retention, input identity,
focus, workload and queue-order checks remain intact. The owning contract is
[sequential typing latency](../topics/ui-testing.md#sequential-typing-latency).

The changed cases pass without retries in both CI mode (31.8 seconds including
the temporary boundary control and setup/teardown) and local mode (31.7 seconds).
The control verifies a 150 ms key stall exceeds the local gate but fits the CI
ceiling, while a 550 ms stall exceeds both. Both windows still emit target-miss
annotations. The real Playwright JSON report, replayed through the analysis
script using an isolated local run-list fixture, reports two annotated windows
as one affected passing execution and zero failures. The temporary control was
removed; no permanent browser case or extra retry was added.

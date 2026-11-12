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

The case has not missed in the five runs since `27e43f896` (input
responsiveness calibration) and `f2551873d` (session updates no longer
re-render every transcript text block). Either may be the repair; five runs
do not establish it. Confirm with `node scripts/e2e-flake-report.mjs --case
queued-compaction` over at least a week of runs before closing this. If it
recurs, capture input and frame attribution from the retry trace before
changing anything; the 100 ms limit is the project's typing rule and is not
to be raised.

Found 2026-11-12 while surveying first-attempt browser failures in CI.

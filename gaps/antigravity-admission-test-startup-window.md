# Antigravity admission test can miss child startup and race cleanup

`packages/server/test/sdk/providers/antigravity.test.ts:145` waits for an
asynchronously admitted real child using `vi.waitFor` without an explicit
startup timeout. During the full 2026-11-11 suite, `active` remained undefined
at the assertion, followed by an `ENOTEMPTY` failure while deleting its fixture.
The same eight-test file passed immediately in isolation (3.96 s total), and
the earlier full run on the same production revision passed. A second complete
server run without the smoke/typecheck workload reproduced the missing-process
assertion (7354 passed, 94 skipped, one failed); cleanup did not fail that time.

This is an observed intermittent failure, not a proven production admission
bug. The failing full run overlapped type checking and a functional smoke run;
the regression suite should allow realistic child startup and await the
creation/process lifecycle during failure cleanup. Diagnose before merely
increasing a timeout. The perf qualification changed no production or provider
test code, so this follow-up is kept separate.

Found 2026-11-11 while validating plan 190 combined-scale measurement tooling.

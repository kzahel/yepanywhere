# Native Codex lifecycle test exceeds its 5 s limit in a full local run

`packages/server/test/native-provider/native-lifecycle.test.ts`, case
"native lifecycle: codex > live model selection changes the actual next
request and cold launch", has no explicit timeout and so runs under vitest's
5000 ms default. In a full `pnpm -r test` on macOS on 2026-11-25 it took
6518 ms and failed with "Test timed out in 5000ms". Three isolated runs of the
file right afterwards passed all six cases. The case starts a real Codex
executable twice, so its duration follows machine load.

Not fixed in place: the failure appeared while landing an unrelated router
change, and [test time budgets](../topics/test-time-budgets.md) requires a
limit taken from measured runs rather than a guess. The fix is to measure the
case under a full-suite run and give it an explicit budget at 2 to 4 times the
observed maximum, counting the 6518 ms run.

Found 2026-11-25 while running the full suite for plan 198 step 2.

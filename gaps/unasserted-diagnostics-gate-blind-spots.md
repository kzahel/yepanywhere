# The client diagnostics gate misses four kinds of emission

`packages/client/test/unassertedDiagnostics.ts` fails a client unit test that
emits an unasserted React or jsdom diagnostic. A review reproduced these ways
for one to pass or be blamed on the wrong test:

- **Swallowing spies.** `vi.spyOn(console, "error").mockImplementation(…)`
  replaces the gate's wrapper for as long as it is installed, so a fixture
  that silences `console.error` and asserts nothing hides every diagnostic
  under it. The convention is to assert the spy; nothing checks that.
- **Unlisted wording and `console.warn`.** The gate matches a fixed list of
  React message prefixes sent to `console.error`. A warning outside the list
  passes, and so does anything React sends to `console.warn`, such as the
  deprecated-lifecycle notices.
- **Teardown after the gate.** Vitest runs a cleanup returned from a root
  `beforeAll` after the gate's `afterAll`, so a diagnostic emitted there is
  never judged. A cleanup returned from `beforeEach` runs after the gate's
  `afterEach`, so its diagnostic fails the following test, reported as
  "after" the one that caused it.
- **Concurrent tests.** Emissions are attributed through one shared current
  test. Under `it.concurrent` a diagnostic can fail whichever test finishes
  first. No client test is concurrent today.

Separately, the allowlist in `packages/client/test/unasserted-diagnostics.json`
shrinks by convention only: its integrity test accepts a new entry for any
existing file, as `scripts/timer-ownership.json` does. A comparison against a
base revision, as `scripts/check-source-file-budgets.mjs --base` makes, would
close both.

Not fixed in place because none is cheap: the first needs a wrapper around
`vi.spyOn` or a restore-time check, and the last two need per-test state from
the runner rather than module variables.

Found 2026-11-16 while reviewing the gate.

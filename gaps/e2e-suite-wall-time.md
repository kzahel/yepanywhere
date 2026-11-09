# Client E2E suite time is dominated by growth, failures and retries

The full client Playwright suite has nearly doubled since the
[ratchet plan](../docs/tactical/135-e2e-suite-cost-ratchet.md) baseline: 348
listed cases on 2026-09-30, 601 on 2026-11-09. CI runs every case on every
pull request and `main` push. Before 2026-11-09 the gate took about 17
minutes, because Playwright's `--shard` split files by case count and gave
one shard 29.7 of 43 case-minutes. Local runs defaulted to one worker,
roughly an hour of serial case time, and reportedly reached two hours with
failures and reruns.

## Addressed

The [ledger](../docs/testing/e2e-ci-cost-ledger.md#time-planned-shards--2026-11-09)
records the measurements.

- CI now runs four time-planned shards with two workers each
  (`scripts/e2e-shard-plan.mjs`); the slower shard took 7.1m and 7.9m in two
  fixed-source runs.
- The local default is four workers: 7.6 minutes for the full suite on a
  14-core Mac. [E2E testing](../topics/e2e-testing.md#local-validation) owns
  local validation guidance.
- Global setup builds the two clients concurrently.
- `rendez-composer.spec.ts` no longer sleeps 10.5s to restate a fake-timer
  unit contract.

## Remaining

1. **`main` is red in three browser cases**, each failing all three attempts
   in every run since at least 2026-11-08: `session-page-header-paths.spec.ts:497`
   (routed account chip), `long-context-effort-warning.spec.ts:18`, and
   `session-page-correction-attachment-paths.spec.ts:188`. Besides hiding
   regressions, their retries make their shard the slowest.
2. **First-attempt failures are common.** Five comparison runs failed 5–11
   cases each; most passed on retry. Recurring cases:
   `limited-instructions.spec.ts:103` (with the
   [proxy header defect](frontend-proxy-writes-headers-twice.md)),
   `session-creation-remote-qualification.spec.ts:232`,
   `session-creation-recovery.spec.ts:47`, `session-page-fork-paths.spec.ts:349`,
   `explored-group-containment.spec.ts:154`, `acli-commentary.spec.ts:223`,
   `limited-browser-defaults.spec.ts:118`, `new-session-draft-windows.spec.ts:86`,
   `mockup-export.spec.ts:35`. Several also fail locally under four or eight
   workers and pass alone, so CPU load exposes them. Each retry adds its
   timeout and a replacement worker's 3.4s server startup.
3. **Session creation is the largest area**: 13 specs and 22% of local case
   time. Their time is real launches, restarts and acknowledgement waits rather
   than fixed sleeps, so reductions need per-case review of which provider and
   restart variants add a distinct boundary, per the plan's sequence.
4. **No suite budget.** Nothing makes growth a review decision. A budget on
   the slower shard (for example eight minutes at four shards) and a
   durations-record refresh when shards drift apart would surface it.

Found 2026-11-08 while answering why a full local E2E run could take two hours.

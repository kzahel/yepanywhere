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
- The three cases that failed every attempt on `main` pass: the account-chip
  and long-context effort assertions now follow the Account tab and the effort
  radio group, and the correction-attachment case was repaired separately in
  `55b466d50`. The model switch modal's thinking heading no longer shows a raw
  `{mode}` placeholder.
- `budgetSeconds` in the durations record fails CI planning when the suite's
  planned case time exceeds 50 minutes
  ([suite time budget](../topics/e2e-testing.md#suite-time-budget)).
- November 10 repairs preserve turn-narrowed indexed transcript cursors, follow
  the account chip's direct Account tab, and reveal the copy control again after
  its earlier copied state expires. The Hono adapter patch also fixes the
  in-process proxy's premature empty response. The full macOS run passes 592
  cases with 14 skips and no retries in 7.0 minutes; hosted acceptance remains
  pending.
- The sidebar performance harness retains mounted-session lifecycle state across
  timing-buffer resets. Its Linux run passes the unchanged 200 ms switch p95
  ceiling at 26.8 ms and verifies cleanup; this is local ARM64 evidence.

November 11 hosted follow-up: source `23021f5e6` confirms the account and
copy-control repairs, but still fails removed menu/retained-layer selectors,
the former grant-specific bootstrap preview, and a stale desktop action-grid
expectation. Those assertions now follow the emitted state hooks, stable
`/v0/me` bootstrap, and measured two-column packing. Six focused browser
cases pass locally without retries. The native-allocation route fixture now
explicitly admits its Claude catalog family, preserving the quarantine and
public-identity assertions; the full workspace suite passes. Source `ae932ec61`
passes all 26 jobs in [CI 42966233783](https://github.com/kzahel/yepanywhere/actions/runs/42966233783)
and all nine jobs in [runtime/SQLite 42966233796](https://github.com/kzahel/yepanywhere/actions/runs/42966233796).
The browser shards pass 602 cases with 12 skips. Three unrelated cases need
retries: remote creation draft handoff, attachment drop and diff scrolling.
The repaired cases pass first attempt; repeated first-attempt suite reliability
remains open.

## Remaining

1. **First-attempt failures are common.** Five comparison runs failed 5–11
   cases each; most passed on retry. Recurring cases:
   `limited-instructions.spec.ts:103`,
   `session-creation-remote-qualification.spec.ts:232`,
   `session-creation-recovery.spec.ts:47`, `session-page-fork-paths.spec.ts:349`,
   `explored-group-containment.spec.ts:154`, `acli-commentary.spec.ts:223`,
   `limited-browser-defaults.spec.ts:118`, `new-session-draft-windows.spec.ts:86`,
   `mockup-export.spec.ts:35`. Several also fail locally under four or eight
   workers and pass alone, so CPU load exposes them. Each retry adds its
   timeout and a replacement worker's 3.4s server startup.
2. **Session creation is the largest area**: 13 specs and 22% of local case
   time. Standalone servers now share tsx's compile cache and six cases serve
   the built client (together about 25% off those specs' case time). The
   2026-11-09 audit's remaining proposals, largest first:
   - Drop or make HTTP-only the hosted variant of
     `codex-session-creation.spec.ts` (about 32 case-seconds). Hosted bind,
     restart and continuation stay covered by `session-creation-callers`
     (`:19`, `:293`) and `session-creation-recovery` (`:111`, `:167`), but it
     is the only case combining an auto-started host with the New Session form.
   - Move `opencode-session-creation.spec.ts:212` (HTTP-only refusals, about
     16s) beside `packages/server/test/sessions/session-identity-opencode-resume.test.ts`.
   - Drop the hosted variant of `project-queue-session-creation.spec.ts:15`
     (HTTP-only, 14s); queue promotion enters `supervisor.startSession` like
     every other caller.
   - Move the three Pi native-file layout cases (`pi-session-creation.spec.ts`,
     HTTP-only, about 14s) to a server test of the `pi.ts` store check, which
     has no lower-level coverage today.
   - Make the hosted Pi variant HTTP-only, and share one remote-client Vite
     server across `session-creation-remote-qualification.spec.ts`.
   The hosted variants are a coverage judgment for the maintainer; the moves
   need new server tests that keep the saved-prompt and replay assertions.

Found 2026-11-08 while answering why a full local E2E run could take two hours.

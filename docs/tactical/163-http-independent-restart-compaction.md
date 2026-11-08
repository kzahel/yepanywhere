# HTTP-independent restart compaction

Status: complete, 2026-10-27; both implementation steps validated and
independently reviewed. The maintainer authorized both commits, individual
pushes and a second review. Source baseline: `1aba656fb`; saved plan: `29caa5ba5`.

## Purpose and boundary

Take one useful step toward separating session operations from HTTP: move the
existing restart-compaction attempt out of `routes/sessions.ts`, then repair
its observer cleanup in a separate commit. Plain TypeScript; no Effect
dependency or framework decision.

The larger goal remains reliable queued `/compact` followed by message
delivery. This is independent hygiene: restart compaction is not on that
queue-delivery path. Its justification is testing the cleanup fix directly
without exporting internals from an HTTP route. It does not implement queued
compact delivery, a headless runtime, or a general session service. It can
stop here without leaving a half-connected replacement core.

This plan follows the [house-cleaning direction](../../topics/core-house-cleaning.md)
and [core-service proposal](../../topics/core-service-api.md). It reopens
only the restart-compaction item in the dormant
[sessions route ledger](053-sessions-route-refactor-ledger.md), with a matching
entry in [the module-boundary worklog](058-typescript-module-boundary-refactor.md).
The maintainer accepted this limited revival before implementation.
Other deferred route extractions stay deferred. The
[module-boundary discipline](../../topics/typescript-module-boundary-refactor.md)
governs the move; the cleanup is a separate behavior-fix commit.

## Source at baseline `1aba656fb`, not the archived assembly

`packages/server/src/routes/sessions.ts` owns `RestartCompactAttempt`,
`RESTART_COMPACT_WAIT_MS`, `waitForRestartCompactBoundary`, and
`tryRestartCompact` (roughly 100 lines). Two production callers use the
attempt: GET `/projects/:projectId/sessions/:sessionId/restart/handoff`
returns its status, and POST `/projects/:projectId/sessions/:sessionId/restart`
in handoff mode awaits it before proceeding. The latter skips it for fork
mode and any supplied `handoffText`. Route parsing, transcript preparation,
launch and interruption remain in place.

The route's `isCompactBoundaryMessage` also serves transcript handling. Keep
that predicate and those consumers intact; do not move unrelated code merely
because it shares the same name.

The archived extraction at `938a0dfd4` and local historical review
`tasks/session-core-workstream/slice-2-plan-response.md` are reference
material, not instructions to resume the old campaign. Do not cherry-pick
them wholesale or restore their shared compaction module, test framework,
subsequent reconciliation steps, or prerequisites.

### Preserve the two existing policies separately

| Aspect | Restart attempt being extracted | Resume attempt remaining in Supervisor |
| --- | --- | --- |
| Deadline | 12 seconds; referenced timer | 3 minutes; unreferenced timer |
| Readiness | Idle check before command discovery only | Input-intent and idle checks before and after discovery |
| Command choice | Exact `compact` preferred over exact `compress` | Normalizes names, selects first matching command |
| Dispatch | Ordinary `queueMessage({ text: "/compact" })` or `/compress`; no metadata/options | Native provider command, then hidden queue fallback with `allowSteer: false` |
| Completion | Compact boundary only | Boundary or supported success status; detects provider failure |
| Error/termination while waiting | Returns `timed-out` immediately | Returns `failed` with reason |

These differences are current behavior, not endorsements. Do not unify them
in this work. In particular, a boundary is not proof that the provider is
ready to accept the next queued message.

## Proposed commits

### 1 — Extract the existing restart-compaction attempt

- Destination: `packages/server/src/supervisor/restart-compaction.ts`, a narrow
  operation module under the existing supervisor directory. No new package,
  runtime factory, generic observer library, or re-export from the route.
- Move the four symbols listed above. Export only the attempt function and
  its result type. Keep constants and observation details private.
- Keep the existing `Process` parameter using `import type`. That introduces
  no runtime dependency and keeps this commit within the strict move-only
  discipline. No Hono, route back-import or runtime `Process`/`Supervisor`
  import. A narrower target is optional in the second commit, derived with
  `Pick<Process, ...>` rather than hand-copying member signatures.
- Update both production callers. Preserve status values, reasons, command
  selection, timer semantics, queue input shape, subscription-before-dispatch
  ordering, exception propagation and all route behavior.
- Keep the route predicate for its other users; the extracted observer can
  retain its own identical private boundary check.
- Add a compact direct test file under `test/supervisor/` exercising the
  operation without Hono, an app instance or a real provider. Use controlled
  events and Vitest timers rather than adding a production clock abstraction.

Keep two or three direct cases: a boundary emitted synchronously during
dispatch; a table for boundary-only completion versus timeout/error/termination;
and optionally exact `compact` taking priority over earlier `compress`.
Flush discovery microtasks before controlling the deadline. Existing route
tests already check dispatch shape and both callers; keep them unchanged
instead of duplicating those assertions. Avoid trivial early-return matrices
or the archive's large test suite. Do not encode retained observer resources
after refusal as desirable behavior.

The observer and Codex dispatch defects were captured in separate gaps
when the plan was saved, allowing the move to stand on its own.

### 2 — Release the observer on every dispatch exit

The current queue-refusal path returns `failed` while leaving its subscription
and timer alive until an event or the 12-second deadline. A synchronous dispatch
throw also escapes with the observer alive. This is a bounded 12-second
retention defect, not evidence of unbounded work. Repair it in the extracted
operation only.

- First demonstrate each cleanup regression with controlled tests.
- Give the private observation lifetime an explicit, idempotent cleanup path.
  Refusal and throw release it immediately; a throw still propagates unchanged.
- Retain the existing timeout and result meanings. No new public cancellation
  API, request-disconnect policy, timer `unref`, or provider abort behavior.
- Use one table for refusal, dispatch throw, boundary, timeout, error and
  termination. Assert zero owned listeners/timers, then emit a late event.
  Reuse the first commit's dispatch-ordering case. No separate matrix for
  subscription behaviors the production `Process.subscribe` cannot exhibit.
- Acquire the subscription synchronously outside the promise executor, before
  creating a timer or dispatching. A setup exception propagates before dispatch
  with no timer acquired, avoiding a rejected orphan promise. This is an
  intentional failure-path change in this commit, not part of the move.
- Keep setup ordering and cleanup simple: resolve an early completion safely,
  dispose a subscription returned after completion, and create no deadline
  once finished. Production `subscribe` only registers a listener; the early
  completion guard needs no dedicated hypothetical-behavior test.
- Do not catch and relabel exceptions as new result statuses. Delete the
  observer-retention gap when fixed.

Record the lifetime guarantee in
[restart handoff templates](../../topics/restart-handoff-template.md), consistent
with [resource ownership](../../topics/architecture-mandates.md#resource-quiescence).
This fix does not cancel provider work or establish completion correlation.

## Explicit exclusions and adjacent work

Heartbeat, recaps, wake, automatic compaction policy, post-compact replay,
helper targets, same-host provider hosting, worker/reload ownership, storage,
queue ordering and provider protocols remain unchanged. No Gemini maintenance
or Antigravity implementation is a prerequisite. No new feature deletion.

The [Codex literal-text dispatch gap](../../gaps/restart-compaction-codex-literal-text.md)
is a separate provider-dispatch diagnosis, not permission to change the move.
The misleading existing test name mentioning native compaction is not
evidence that native dispatch occurs here. The observer-retention gap was
fixed and removed in the second commit,
following the gaps lifecycle. Its original report remains in `29caa5ba5`.

Source also suggests two concurrency follow-ups: a new turn can begin during
command discovery without an idle re-check, and concurrent preview/restart
requests can start duplicate attempts. Neither was reproduced in this plan
review. Do not add serialization, input-intent checks or boundary correlation
here; evaluate those in a separate concurrency proposal.

Existing adjacent work stays separate:

- [Queue survival across compaction](../../topics/queue-across-compaction.md)
  is the larger motivation; its dated source findings need reproduction before
  choosing a repair.
- Codex turn-start compact guard coverage was provider-protocol regression
  work, not required to move this helper. It is now covered by
  `codex.test.ts` ("refuses compaction while turn/start awaits its reply").
- [Merged queue identities](../../gaps/merged-queued-turn-orphans-chunk-echoes.md)
  and [durable provider user identities](../../gaps/provider-user-turn-durable-identity.md)
  concern delivery correctness but are not prerequisites for this boundary.

## Verification and stopping point

For each implementation commit, follow the repository testing and code-quality
guides: focused direct tests and existing `test/routes/sessions-metadata.test.ts`,
shared build/server typecheck, exact-file lint, `git diff --check`, root
`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm test`.
The timer/queue tripwire additionally requires `pnpm test:e2e:sdk`; use isolated
test homes/data and owned runtimes, never the user's localhost:3400 instance.
Record runtimes in seconds. No client E2E is proposed: no UI, route registration
or wire-contract change; existing route tests cover the two HTTP callers.

Review the extraction using `git diff --cached --color-moved=dimmed-zebra`.
Non-move source hunks must be explained by imports or the declared dependency
changes (none proposed for commit 1). Stop and re-cut if a cycle, behavioral
assertion change, or wider Process/Supervisor redesign becomes necessary.
Any unrelated failures get
diagnosed and recorded without quietly expanding this scope.

After discussion and selection, each completed implementation commit is pushed
individually under the standing workflow. Carry the required
`core-service-api` and `typescript-module-boundary-refactor` topic trailers for
the extraction; track the cleanup separately from the move.

Done means both production callers use the extracted attempt, meaningful
direct tests protect it, cleanup owns all acquired resources, required checks
pass, and ledgers/contracts describe the result. Stop there. A later proposal
may extract resume compaction while preserving its separate policy; that is
not automatically the next implementation step.

## Independent plan review

Completed 2026-10-27: Opus 5.5 High through localhost:3400, Work-claude pool
with Weekly pace. API metadata confirmed model, effort and allocation policy.
Session: `fce9dd3f-a023-4b61-a1fd-966a1618a90b`. Local report:
`tasks/house-cleaning/opus-restart-compaction-plan-review.md` (gitignored).
No blockers; source claims and bounded scope verified. No tests were run.

| Finding | Plan decision |
| --- | --- |
| Strict move discipline disallows the proposed type narrowing in commit 1 | Keep a type-only `Process` import; a derived `Pick` is optional in commit 2 |
| Observation setup can reject before the queue result is checked | In commit 2, setup fails before dispatch; no orphan promise or acquired timer |
| Direct test matrices overlap existing route coverage and hypothetical subscription behavior | Keep a few ordering/policy cases plus one cleanup table |
| Defects should survive if the cleanup is deferred | Added separate observer and Codex dispatch gaps |
| Extraction does not advance the queue-delivery path | Framed as independently useful hygiene; roadmap corrected |
| Wrong route/draft wording and unspecified contract owner | Named exact routes, any supplied draft, and restart-handoff-template topic |

SDK E2E has no direct restart-compaction coverage; it remains the mandated
timer tripwire, not proof of this operation. Direct and route tests provide
that evidence. No broader deduplication or native-dispatch work was accepted.

Discussion point: the original restart helper was graehl-authored. This plan
preserves his features; the second commit would fix shared resource cleanup,
not remove an automation policy. The maintainer authorized this shared repair
after reviewing the plan.

## Implementation record

### Existing restart attempt extracted — 2026-10-27, `06cff21d6`

Both production callers use `supervisor/restart-compaction.ts`. Four symbols
moved, the route predicate remains for transcript handling, and the moved
helper text matches baseline verbatim except exports. No signature, policy,
route-registration or wire-contract changes. No runtime import of Process or
Supervisor. Five direct cases plus 123 unchanged route cases pass.

Validation (macOS, Node 22.23.3): focused tests 3.63 s wall / 0.584 s test work;
SDK tripwire 22.48 s wall, 80 passed and 4 environment-gated cases skipped;
lint 15.17 s; format check 1.47 s; root typecheck 46.97 s. Explicit strict
compilation also covers the new direct test, which normal server source
checking excludes. Root tests passed in 136.06 s wall (server: 6,587 passed; client: 7,058
passed).

Tier 1/2 and the timer tripwire apply. Client E2E is omitted because no UI,
route registration or client-visible contract changes; existing route tests
exercise the HTTP boundaries. Focused and SDK checks are warning-free.
Unrelated negative-path diagnostics in the workspace suite are recorded in
`gaps/full-suite-timing-and-diagnostics.md`; changing those fixtures would
cross unrelated queue, provider, highlight-worker and gateway boundaries.

### Dispatch observer cleanup — 2026-10-27

Added refusal/throw cases to the existing terminal-path table. Both failed
against the extracted implementation with one retained listener. The fix uses
one idempotent finish path and `finally` around dispatch/wait; failures retain
their previous result/exception meanings. Subscription setup happens outside
the promise executor and before timer creation/dispatch. No target-interface
narrowing was needed. The contract lives in `topics/restart-handoff-template.md`;
the fixed observer gap is deleted. Resume, providers and automation are untouched.

Validation (macOS, Node 22.23.3): focused 130 tests passed in 2.42 s wall /
0.481 s test work; SDK 80 passed / 4 environment-gated skipped in 20.49 s wall;
lint 14.37 s; format 1.36 s; root typecheck 47.16 s and strict direct-test
compilation passed. Workspace tests passed in 134.67 s wall (6,589 server /
7,058 client). Focused and SDK output was warning-free; unrelated suite
diagnostics remain recorded in the existing diagnostics gap.

Independent implementation review: Opus 5.5 High, Work-claude / Weekly pace,
confirmed by launch metadata. Session `efdcb451-a346-4b39-8c1f-ed981059dfb8`;
local report `tasks/house-cleaning/opus-restart-compaction-implementation-review.md`
(gitignored). No blockers. The reviewer independently passed the seven direct
cases and verified both callers, resource ownership, setup ordering and
exception/result preservation.

Addressed its relevant findings: finalized plan/roadmap status and validation,
linked the new test from the owning topic, clarified baseline source wording,
rewrapped prose, and removed a tautological settled-promise assertion. The
resource assertions still verify teardown and late-event inertness. No code
policy changes were requested. A replaying subscription's possible stale
boundary remains a hypothetical correlation concern for the separate proposal;
the production subscription does not replay.

The reviewer rechecked the updates and closed all findings, with no remaining
blockers or concrete correctness issues. Final focused rerun: 130 passed in
2.67 s wall; final lint/format/typecheck also passed. Final workspace rerun
passed in 133.57 s wall with the same 6,589 server / 7,058 client counts.

This completes the selected scope. Resume extraction, queued compact delivery,
Codex native dispatch and concurrency decisions remain separate work.

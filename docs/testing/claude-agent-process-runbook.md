# Driving a Bounded Agent Process Through the Local API

Use this runbook when one supervising agent needs to give a bounded repository
slice to a fresh Claude Opus or Codex Luna worker, wait for that worker to
finish, and independently audit the result. It describes the local YA API on
the default `https://localhost:3400` server. It is not a remote automation or
unattended deployment contract.

The controller owns selection, scope, acceptance, and batch progress. The
worker owns the approved slice and its normal implementation, verification,
captures, and commit. During initial calibration, repeat important checks and
fixture replays independently. After repeated clean runs, use trusted campaign
mode: monitor process state mechanically, inspect output only on an alert, and
perform a cursory completed-commit audit instead of duplicating the worker's
entire run.

## Safety and checkout invariants

- Use one campaign worker at a time in a shared checkout. Do not edit the tree
  from the controller while the worker is active. Unrelated human or separately
  authorized work may still land; handle it through the attribution rule below.
- Record a clean base SHA before launch. A dirty tree makes attribution and
  rollback ambiguous, so stop rather than guessing which changes belong to the
  worker.
- Treat the base SHA as an attribution anchor, not a requirement that no other
  commit may land. If the worker observes a new clean commit, it must compare
  that commit's paths with its work order. Disjoint committed work may remain in
  place: do not rebase, revert, or stop solely because the worker's eventual
  parent changed. Report the drift and run all checks on the combined tree.
  Stop on overlapping paths, unattributable dirty files, or a check failure
  caused by the concurrent change.
- Give the worker an explicit file boundary and permission to stop. It may not
  substitute another candidate when the approved slice is blocked.
- Capture every required before-state before the first edit. Once editing has
  started, do not temporarily replace tracked paths with base-commit contents
  to manufacture a comparison for an advisory report, test, or screenshot,
  even if the worker intends to restore them byte-for-byte. If required
  before-state evidence was missed, report the gap; only the controller may
  request a separately isolated control after reviewing why it is needed.
- `bypassPermissions` is appropriate only for a trusted local checkout and a
  reviewed, tightly bounded prompt. Choose a supervised permission mode when
  those conditions do not hold.
- Use `-k` only for the expected self-signed localhost certificate. Do not
  generalize certificate bypass to a remote server.
- Capture the returned YA `sessionId` as the canonical session identifier. Do
  not replace it with a provider-native id.

For CSS work, read [CSS architecture](../../topics/css-architecture.md) and
run the class-string, emitted-hook and module contracts before browser verification.

## Route the task shape to a worker

Choose the worker from current evidence after freezing the candidate and its
fixture. Do not alternate models mechanically and do not let a worker choose a
different candidate to suit itself.

Use Claude Opus at high effort as the campaign default for a mechanical slice
when all of these are true:

- ownership is concentrated and the inventory has no unresolved or generated
  vocabulary;
- dynamic classes are absent or already proven to be a small closed union;
- composition edges are absent or have an explicit keep-global or prop boundary;
- focused tests and a deterministic browser fixture already exist or can be
  replayed without discovery; and
- the work is primarily moving declarations and literal callsites, not deciding
  product or analyzer semantics.

Use Codex Luna at xhigh effort when the slice benefits from diagnosis or
recovery, especially when it has one or more of these shapes:

- finite state-class mapping whose exhaustiveness must be proved;
- coupled selectors, shared keyframes, generated markup, or caller reach-ins
  whose ownership needs careful classification;
- a possible CSS/TypeScript analyzer trust-gate defect;
- a visual fixture with timing, projection, responsive, portal, or overlay
  behavior that may require causal investigation; or
- a bounded refactor needed to expose an honest component boundary before the
  mechanical extraction.

Size alone does not select Luna. A large but local literal move can still suit
Opus; a small ambiguous selector can justify Luna. When the task shape changes
after launch, do not switch provider inside the session. Before edits, the
worker may return a stopped report recommending the other worker. After edits,
it must finish or stop safely within its work order; the controller audits the
tree before deciding whether a fresh session should resume from a clean base.

Record the routing decision in the work packet and final campaign ledger:
worker, effort, candidate metrics, decisive routing signals, fixture kind,
elapsed time, attention events, steers, audit findings, and acceptance result.
Revisit the criteria after each five-slice audit interval. Routing is an
evidence loop, not a permanent ranking of providers.

## 1. Freeze the work order

Before launch, the controller records:

- base commit and clean `git status`;
- one selected product surface;
- inventory evidence and every known ownership edge;
- allowed ordinary files and conditional tool-repair files;
- focused tests and required repository checks;
- a controller-proven visual fixture packet when rendered UI changes; and
- stop conditions, including the maximum batch size.

The inventory's `testFiles` field reports tests and harnesses that mention the
legacy selector vocabulary. It does not claim to enumerate every direct test
of the owning component. After drilling into an owner, perform one bounded
search for component imports and matching test filenames and record those
behavior tests separately in the work packet. A zero inventory test count is
not evidence that no focused tests exist, and this documented distinction is
not by itself an analyzer trust-gate failure.

A reported selector-contract test or harness that names vocabulary being moved
is ordinary migration scope. Allow the narrow file in the work packet and
replace the class locator with an existing accessible or structural contract
when possible. Do not delete the global token while freezing its reported
consumer read-only: a tolerant best-effort helper may otherwise become a
silent no-op even though the normal test matrix stays green.

### Bound the visual fixture before launch

For visual work, the work order defines a fixture packet containing:

- the exact URL, using the YA session id when the route is session-backed;
- normalized API evidence that the target data is present;
- rendered-DOM evidence that the exact target locator exists after the stated
  reveal steps; an API or transcript record is not proof that the owning
  component renders that record;
- reveal steps that work from a clean page load, expressed as accessible roles,
  names, or other selectors that are not being migrated;
- a stable target locator and the text or state expected inside it;
- a change-specific marker that will prove the post-change page is serving the
  current worktree rather than stale built assets;
- the required desktop and phone viewports; and
- baseline captures at both viewports.

For local campaign fixtures, use the repository-installed headless Playwright
directly with a fresh context, `ignoreHTTPSErrors: true`, and service workers
blocked when stale assets are possible. Do not open or control the maintainer's
main browser for these fixtures. Browser control is reserved for a work order
that explicitly depends on existing browser state such as a logged-in account
or installed extension. A localhost certificate warning in the main browser is
therefore a harness-routing error, not a fixture failure; abandon that path and
use headless Playwright without interacting with the warning page.

For a component whose important states are deterministic from props but hidden
behind rare product or provider state, the client dev server exposes the test-only
fixture page `packages/client/e2e/css-component-fixture.html`. Supply a component
module below `/src/components/`, its named export, and JSON props:

```text
http://localhost:3402/e2e/css-component-fixture.html
  ?module=/src/components/ThinkingIndicator.tsx
  &export=ThinkingIndicator
  &props={"variant":"pill","label":"Running"}
```

URL-encode the query values in an actual request. A prop whose JSON value is
`"$noop"` becomes a no-op callback, which permits isolated rendering of a
controlled component without adding product-only fixture state. Wait for
`html[data-css-fixture-ready="true"]`, fail on
`html[data-css-fixture-error="true"]`, and capture the bounded component beneath
`[data-css-fixture-root="true"]`.

Use this page only when isolated rendering is sufficient to verify the owned
CSS. A caller-layout edge, portal relationship, generated markup boundary, or
product-state interaction still needs the real integration surface. The fixture
does not turn ambiguous ownership into a mechanical slice.

In calibration mode, the controller replays the steps and inspects both
baselines before launch. In trusted campaign mode, the worker may prepare the
packet from the clean base before editing, with a strict discovery limit. If a
stable target and both baselines are not available promptly, it stops the slice
without editing instead of browsing unrelated sessions or substituting a new
candidate. Do not promote normalized session data into a fixture assertion
until the same record is observed through the intended rendered component;
projection, grouping, and collapsed history may make stored records absent from
that surface.

Give any controller-known fixture details and baseline paths to the worker. The
worker replays that exact fixture after implementation and may not browse for a
substitute after editing begins. This makes before/after comparison the normal
path rather than a recovery step. A visually identical result is not sufficient
by itself: the worker must also prove the live target contains the supplied
post-change marker, such as the new module class, and no longer contains its
removed legacy class.

Visual equivalence does not mean byte-for-byte image equality. Relative times,
background activity, animation phase, font rasterization, and content outside
the migrated target can change between captures. Inspect the target captures
and the supplied behavioral and DOM markers first. After one clean replay, a
small unexplained pixel delta should be reported with its location; it is not a
license to stash or revert the shared checkout to manufacture a new control.
Only perform a base-tree control replay when the controller explicitly asks for
one after reviewing the delta.

## 2. Build a bounded worker prompt

The prompt should contain these sections in this order:

1. **Authority and base:** current repository, exact base SHA, permission to
   edit and commit, and prohibition on branches, worktrees, and delegation.
2. **Frozen candidate:** one component or surface, its current inventory
   metrics, and every already-known edge.
3. **Allowed files:** ordinary migration files plus narrowly conditional files
   for an analyzer regression.
4. **Trust gate:** when ownership, a producer, generated vocabulary, or a
   coupling edge is materially wrong, add the smallest regression, repair the
   analyzer in a separate commit, regenerate inventory, and end the batch.
5. **Mechanical rule:** move behavior before cleanup; no redesign, adjacent
   refactor, broad `className` normalization, or replacement candidate.
6. **Verification:** exact focused tests, ratchets, lint/typecheck, console
   scan, the controller-proven visual fixture packet and baseline paths, and
   `git diff --check`.
7. **Commit rule:** one commit only after every required check succeeds.
8. **Final report:** status, commit, files, before/after metrics, edges, checks,
   captures, scope pressure, and recommendation.

Five slices is an audit interval, not a quota. A worker completes one slice and
returns; the controller decides whether another fresh session should start.

## 3. Launch the session

Get the project id from `GET /api/projects` or an existing project URL. Every
mutating request must send `X-Yep-Anywhere: true`; omitting it returns `403
Missing required header`.

```bash
curl -ksS \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-Yep-Anywhere: true' \
  'https://localhost:3400/api/projects/<project-id>/sessions' \
  --data '{
    "message": "<bounded worker prompt>",
    "provider": "claude",
    "model": "opus",
    "thinking": "on:high",
    "mode": "bypassPermissions",
    "recapMode": "off",
    "promptSuggestionMode": "off"
  }'
```

`model: "opus"` is the YA model alias. Verify the live process rather than
assuming its resolved provider name; the 2026-09-22 smoke resolved it to
`claude-opus-5-5`. Effort remains whatever the launch requested (`high` in the
bounded-worker example above).

For a Luna-routed slice, change only the provider/model/thinking fields:

```json
{
  "provider": "codex",
  "model": "gpt-5.6-luna",
  "thinking": "on:xhigh"
}
```

Verify that the live process reports provider `codex`, requested and resolved
model `gpt-5.6-luna`, and effort `xhigh`. These launch identifiers are observed
campaign defaults, not assumptions about future catalogs; revalidate them when
the server or provider catalog changes.

A successful immediate launch returns `200` with `sessionId`, `processId`, and
`projectId`. Persist all three with the base SHA and prompt digest.

### Queued-launch limitation

A `202` response contains a queue id but does not currently provide a durable
way for an external controller to recover the new session id after that queue
entry starts. Do not automatically submit the prompt again: the first request
may still start and duplicate the work.

Prefer a sequential controller and inspect `GET /api/queue` before launch. If
a launch still returns `202`, stop automated progression and surface the queue
id for manual reconciliation. A durable queued-result handoff is the first API
improvement to make before relying on this for unattended batches.

## 4. Monitor the authoritative process state

Use the read-only monitor. It prints one compact status sample per minute by
default and exits when the process completes or needs attention:

```bash
pnpm agent:monitor -- <session-id>
```

For a one-off manual check, request:

```text
GET /api/sessions/<session-id>/process
```

The command reads only `GET /api/sessions/<session-id>/process`; it never reads
the transcript, sends a message, approves a tool, interrupts a process, or
retries a launch. Use process state, not transcript-file growth, as the turn
boundary:

| Observation | Controller action |
|---|---|
| `in-turn` and progressing/retrying | Continue minute-scale polling without reading the transcript. |
| `waiting-input` or `needs-attention` | Monitor exits 3; inspect once and ask the supervisor rather than approving automatically. |
| `providerRuntimeStatus.kind == "terminal"` | Monitor exits 4; inspect the provider error. |
| `idle`, `queueDepth == 0`, `activeWorkKind == "none"`, and `verified-idle` | Monitor exits 0; fetch only the final report and begin audit. |
| `terminated` or an absent process | Monitor exits 4; reconcile recently terminated processes. |
| three API errors or the wall-clock deadline | Monitor exits 5; inspect server/process health. |

Use a wall-clock deadline as well as liveness. Progress evidence permits a
long-running check; it does not permit unlimited research outside the work
order. The visual state should require no discovery: replay the supplied
fixture from a clean load. One route-specific correction is the limit for
ordinary app-state drift; after that, stop and report which fixture assertion
failed.

One minute is the normal status cadence for both workers. A check-in means the
authoritative process sample above, not a transcript read. In trusted campaign
mode, Opus gets no mid-turn transcript inspection without an alert. During Luna
calibration, the controller may add one bounded scope sample at the first
visible edit or after four minutes without an edit. After three consecutive
Luna slices finish without a steer, scope correction, or surprising audit,
reduce Luna to the same alert-only cadence. Any Luna trust-gate event, scope
steer, unexplained verification failure, or out-of-order commit resets the next
two Luna slices to the extra bounded sample.

## 5. Inspect only on completion or an alert

Read the provider-neutral transcript from:

```text
GET /api/projects/<project-id>/sessions/<session-id>
```

The final assistant text lives in the normalized `messages[].message.content`
blocks. In trusted campaign mode, do not fetch the transcript during ordinary
progress. Fetch the normalized detail once after verified idle, or after a
monitor alert that requires diagnosis. Prefer this endpoint to Claude JSONL or
Codex rollout files. Raw provider files are a debugging fallback, not the
orchestration interface.

To give a bounded correction while the turn is active:

```bash
curl -ksS \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-Yep-Anywhere: true' \
  'https://localhost:3400/api/sessions/<session-id>/messages' \
  --data '{
    "message": "Supervisor steer: stop the out-of-scope discovery, do not commit, and return a stopped report.",
    "mode": "bypassPermissions"
  }'
```

The pilot delivered this steer after the worker's current shell command
finished. The worker left its approved files staged and returned without a
commit. Treat steering as graceful correction, not instant process
cancellation; use the explicit interrupt/abort controls only when graceful
steering is insufficient and the operator has chosen that outcome.

## 6. Audit in proportion to trust and risk

After the process reaches verified idle, always:

1. Confirm the base and inspect `git status`, staged and unstaged diffs, and all
   commits since the base SHA.
2. Attribute files outside the work order to exact intervening commits. Accept
   clean disjoint commits as concurrent work; reject uncommitted, overlapping,
   or unexplained files unless the analyzer trust gate and conditional repair
   scope explain them.
3. Re-run inventory and compare ownership, coupled, generated, dynamic, and
   unresolved findings.
4. Read the worker's final check and capture summary and verify that its commit
   message does not claim a truncated or piped command as evidence.

In calibration mode or after any suspicious result, independently rerun the
focused tests, warning-sensitive checks, and fixture. For CSS work this includes
`css:check`, `css:unused`, lint, typecheck, console scan, relevant tests, and
desktop/phone inspection.

In trusted campaign mode, a clean in-scope commit, plausible inventory and
ratchet movement, named warning-free checks, and linked desktop/phone artifacts
are sufficient for the routine cursory audit. Spot-check the diff and captures;
do not rerun the complete matrix unless the report, diff, artifacts, or metrics
are missing or surprising. The worker remains responsible for running the
matrix, not merely reporting expected commands.

If the worker committed before audit, acceptance is still a separate decision.
Do not start the next session merely because a commit exists.

## 7. Run campaigns with five-slice audit intervals

For each accepted slice:

1. record its commit and new clean base;
2. regenerate the inventory;
3. select the next candidate from the new data;
4. route and launch a fresh worker with a new frozen prompt; and
5. perform the batch audit after five accepted slices.

Without an explicit larger campaign authorization, stop after that five-slice
audit and return the report. When the originating instruction supplies a larger
run or wall-clock cap, the controller may continue after each clean audit
interval until the first terminal cap. Every launch counts toward a run cap,
including a worker that stops without editing. A larger cap never relaxes the
one-worker checkout invariant, trust gate, fixture requirements, or stop
conditions.

End the batch immediately when:

- the analyzer changes materially;
- a candidate needs an unapproved production boundary;
- the working tree or intervening commits are overlapping or not attributable;
- required visual state is not deterministic;
- a warning/check budget regresses; or
- the controller cannot attach a queued launch to its resulting session.

The batch report includes accepted/stopped sessions, commits, ratchet movement,
before/after inventory, verification evidence, steering or input events, and a
fresh top-candidate list. It does not silently begin the next batch.

For an explicitly continuous campaign, append that report to the durable
campaign ledger and then continue from the newly audited clean base. Push at
the audit interval and before any planned pause so the remote is a recoverable
checkpoint. Stop at the authorized run count, wall-clock deadline, provider
credit exhaustion, or the first condition that makes further automatic
selection unsafe.

## Pilot observations

The first CSS pilot validated the launch, polling, normalized transcript,
steering, and stopped-report paths. It also exposed two useful controller
requirements:

- the mutation header must be part of every POST helper; and
- the controller must supply a replayed visual fixture packet and inspected
  baselines instead of making the worker discover a route after implementation.

The stopped worker preserved a bounded staged diff. The controller then found
a ten-message session whose normalized detail contained two Grep calls,
expanded its single activity group, and captured the component directly. That
is the preferred visual-state pattern for future renderer slices.

The second CSS pilot supplied an exact standalone Glob row, reveal actions,
assertions, and inspected baselines. The worker replayed it at both viewports
without discovery or steering, then confirmed the live DOM carried the new CSS
Module class and retained the intended shared global classes. That last check
prevents an unchanged screenshot from falsely passing when a server happens to
serve stale client assets.

## Mixed-model calibration observations

The initial comparison found equivalent implementation quality with different
operating biases. Opus was more economical once given a proven mechanical
packet and is the better default for high-throughput literal slices. Luna was
more persistent when verification required diagnosis: it recovered from
click-protection timing and an unrelated overlay to obtain bounded visual
evidence. Luna also spent longer in pre-edit investigation and needed a scope
correction when it included an attractive dead-rule cleanup outside the frozen
owned set.

These observations justify the routing criteria above; they do not establish a
permanent winner. Continue recording corrections and audit surprises. Change
the routing policy when campaign evidence changes rather than prompting either
worker around a stale reputation.

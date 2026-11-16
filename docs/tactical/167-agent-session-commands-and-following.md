# Agent session commands and compact following

Status: **implemented locally**, 2026-10-30. Delivered end to end in
five reviewed, committed phases. The maintainer approved the sequence and
autonomous delivery, with YA-launched Sol 6.1 high reviews between phases.
The owning contract is [HTTP v0](../../topics/http-api-v0.md#next-slice-session-commands-and-compact-following-proposal).
This extends [165](165-http-api-v0.md) and [166](166-agent-api-bootstrap-and-documentation.md).

Later change, 2026-11-16: receipts are no longer persisted. They last for the
server process, migration 39 dropped `agent_api_receipts`, and restart
reconciliation was removed; creator relationships remain durable. The Phase 4
evidence below describes the original SQLite design. See
[creation and retry receipts](../../topics/http-api-v0.md#creation-and-retry-receipts).

## Outcome and boundaries

An explicitly authorized local agent can read a compact conversation, follow
new prose and activity, create a session, send follow-up input, and inspect
trusted creator/submission attribution. Agents choose their workflow, checkout
and waiting strategy. Keep HTTP v0 unstable and use existing provider owners.
No managed delegation lifecycle, worktree policy, alternate client rewrite,
new transcript database or Effect migration is selected.

Defer Windows qualification until multi-device enrollment can exercise the
available Windows host. Peer grants/enrollment and remote routing remain later
work. Preserve current local/private transports and restricted-principal
ceilings. Current read-only launch credentials must not silently gain writes.
Any management opt-in is separate, explicit and initially off.

## Existing evidence and constraints

- [Simple Client API](../../topics/simple-client-api.md) retains useful pure
  projection and shared subscription ownership. Its experimental native reader
  refuses files above 8 MiB, large records and inherited Codex history. Current
  long sessions exceed that cap. Improve acquisition without lifting the cap
  into an unbounded full-history read. Preserve its existing consumers.
- [Portable compiler](../../topics/portable-transcript-compiler.md), active
  branch selection, compaction scope and YA/provider identity mapping remain
  authoritative. Reuse provider readers/indexes rather than parse a byte tail
  without lineage evidence. Unavailable/truncated coverage stays explicit.
- [Architecture mandates](../../topics/architecture-mandates.md) require shared
  keyed work, cancellation and final-consumer teardown. No permanent per-session
  poll loop, full file read per token or uncapped replay/consumer map.
- [Unconfirmed sends](../../gaps/unconfirmed-send-loss-across-reload.md) means a
  successful queue response cannot claim durable delivery. Use persistent
  request identity/outcomes and reconcile native evidence. A crash between
  reservation and external launch/send may remain explicitly uncertain.
- [Provider host API](../../topics/provider-host-api.md) owns live workers and
  submission evidence. Its turn receipts are useful prior art, not a universal
  platform prerequisite. Desktop/in-process paths must work independently.
- [Principals/grants](../../topics/principals-and-grants.md) distinguish actor,
  credential and authority. New attribution derives from authenticated launch
  identity, never a caller-supplied source-session header. Existing client
  creation hints, limited-user ownership and fork relationships survive.

## Implementation phases

### 1 — Acquire bounded conversations from real provider histories

Replace the experimental whole-file limitation with a source-aware reader
boundary. Start with Claude/Codex, preserve branches, inherited history,
compaction scope, stable message ids and coverage. Keep pure projection apart
from source I/O and full-app construction. Bound retained normalized input;
reuse existing indexed/native read capabilities where available. Measure cold
and warm acquisition and validate a real long session read-only.

Retain deterministic large-history, branch/lineage, incomplete-row and mutation
tests. No model eval is needed. Review, repair and commit the phase.

### 2 — Serve compact conversation and activity through v0

Add server-addressed bounded conversation reads to the core API and private
adapter/controller bridge. Default to exact user text and agent Markdown with
stable identities, activity/pending attention and coverage. Exclude routine tool
payloads, thinking and rendered HTML; preserve useful bounded failure/artifact
references. Update generated help/schema and executable examples together.
Unsupported provider/history shapes return explicit errors.

Use real HTTP/private auth and principal-scope tests. Two opt-in Sol medium
trials cover finding an answer in tool noise and incomplete/unknown evidence.
Grade requested facts rather than a prescribed request sequence. Review and
commit before adding streaming.

### 3 — Follow visible messages and activity over HTTP

Add a bounded HTTP follow binding sharing the same observation owner. Deliver
initial state and changed messages/activity, not full raw transcript snapshots
per tool event. Define cursor scope, revisions, reconnect and explicit reset for
rewind/compaction/retention loss. Finalized prose is sufficient initially;
partial token assembly is deferred. Keep controller replacement, revocation,
slow-consumer limits and listener teardown explicit across private transports.

Deterministically test subscribe/read races, reconnect, reset, stalled consumers
and cleanup. Two light agent trials cover following a scripted worker and
recovering after disconnect. Polling and streaming are both valid strategies.
Review, repair and commit.

### 4 — Create sessions with trusted provenance and retry identity

Expose native creation through an application service shared with existing
launch ownership, not a loopback call into legacy routes. Reuse project,
provider/model/effort/permission/admission configuration. Add persistent scoped
request identity and conflict/uncertain/reconciliation states, using real
SQLite. Preserve the resulting canonical YA id and creation facts through
restart. Record principal, originating server/session/launch, destination,
request id and time separately from client hints and fork or /btw parenting.
Build the receipt foundation so messaging reuses it. Enable writes only under
an explicit management opt-in; do not silently broaden existing read grants.

Test duplicate/concurrent/conflicting requests, lost responses, restart/crash
windows and provider startup failure using native protocol boundaries. One
light eval creates a worker and reports its result and creator. Review and
commit.

### 5 — Submit attributed messages and complete the agent workflow

Use the incumbent session owner and common receipt service for input. Separate
accepted/queued, provider-delivered, failed/uncertain and response completion
evidence. Retrying a submission cannot duplicate input; stopped-session policy
is explicit. Follow by submission identity as well as session activity. Busy
queueing, canonicalization and restart must preserve attribution and receipt
lookup. No automatic second provider resume or hidden approval is allowed.

Test input ownership, busy delivery, duplicates, cancellation/disconnect,
restart and follow continuity. Run one or two light end-to-end trials: create
a reviewer, follow its prose, send a follow-up, reconnect and retrieve the
answer/creator without duplicate work. Review, repair and commit.

## Checks, evidence and completion

Run root lint, non-writing formatting, typecheck and workspace tests for source
changes, plus meaningful focused boundary tests. Add UI only for necessary
opt-in semantics, using exact capability gates/older-host omission and final
desktop/phone capture plus sequential typing evidence. Baseline releases have
no v0 management promise; add a distinct capability rather than broaden the
existing read-only bootstrap capability. Retain existing user defaults.

Reuse the opt-in [eval runner](../../scripts/agent-api-eval/README.md), with fresh
scratch environments, deterministic fixture truth, controlled API authority,
no model calls in CI, and approximately 6–8 targeted trials overall. Sol medium
is the evaluator; Sol high reviewers are separate code review. Record success,
requests/errors, returned bytes, elapsed time and reported usage without
inventing unique-context tokens, cache savings or subscription prices. Local
Qwen is optional diagnostic evidence, not an acceptance gate.

Record each phase's actual tests, reviewer findings/fixes, model trials,
remaining limits and commit. Existing intermittent Rendez watcher failures are
tracked in [its gap](../../gaps/rendez-nested-watch-event-after-restart.md);
do not hide them, widen timeouts or call a failing final suite green.

## Phase 1 evidence

Implemented bounded native acquisition with frozen Codex lineage, Claude branch
selection, exact queued prose, generation validation and a bounded warm cache.
The read-only Sol high review found and drove repairs for rewrite-plus-append,
metadata/body races, clipped queued prompts, queued admission and long wrapped
Codex failures. Tests include those regressions and captured-provider parity.
A read-only local diagnostic acquired a roughly 18 MB native Codex session;
its next unchanged read parsed zero JSONL body records. These are diagnostic
observations, not a cross-host performance benchmark.

Phase 1 review is closed after a further interruption-marker regression. Final
focused acquisition/source/subscription checks pass (40 tests); root lint,
format, typecheck and workspace tests pass. The full server run passed 6,595
cases before the final guard-only repair; the changed boundary was rerun with
15 reader cases afterward. Native Windows qualification remains deferred.

## Phase 2 evidence

Added the server-addressed compact conversation read, pure core source port,
production shared-owner adapter and private provider/controller bridge support.
Real Hono authorization tests assert acquisition never begins for inaccessible
sessions. Private Unix HTTP tests cover missing/revoked credentials, unknown
coverage and final observer teardown. Served-schema/example tests cover the new
window bounds and explicit missing-anchor behavior.

Two opt-in Sol medium trials passed (conversation artifact and incomplete
evidence). They used the real private adapter and shared projection with noisy
scripted native messages. Observed durations were 14.4/17.1 seconds, 4/5 HTTP
requests, zero HTTP errors, 75,012 fetched documentation bytes per trial. Reported
processed input was 77,186/61,866 tokens; this is not unique context or a causal
measure of documentation overhead. Raw local reports remain ignored. Reviewer
found missing conversation errors across the hosted bridge; the shared decoder
and real worker/socket regression now preserve both codes and statuses.

Phase 2 root lint/format/types pass. The workspace run is red solely on the
previously tracked Rendez nested watcher at line 353 (6,597 other server cases
passed); its gap records this observation. Do not substitute the phase 1 green
suite or a later isolated pass for this failed run. Focused core/real hosted
bridge checks pass (60 tests). Query preservation was also repaired so a typo
cannot become a successful latest-window read across the bridge.

## Phase 3 evidence

Selected bounded HTTP long polling, preserving the existing finite private
controller protocol. Full compact replacement plus explicit reset is the first
reconnect contract; no event-log replay or token assembly is claimed. Source
ownership is shared, tool-count-only changes do not wake waits, and lease
revocation now cancels already admitted requests. Deterministic tests cover
shared reads, invalidation, window/server scope, rewind replacement, unchanged
waits, tool noise, abort and real Unix HTTP disconnect/revocation teardown.
The existing real hosted-worker test also exercises a follow response.

Two final opt-in Sol medium trials passed: following scripted progress (24.7 s,
6 requests) and reconnecting with a changed window (15.1 s, 5 requests). Both
had zero HTTP errors and fetched 89,752 documentation bytes. Reported processed
input was 141,173/62,585 tokens, not unique context or a documentation-only cost.
The increased schema/help fetch size is evidence to consider a more concise
operation-discovery path later; it is not a causal comparison between variants.

Review found no material product-runtime issues, but two eval defects: observer
teardown paused simulated worker progress, and a grader accepted two initial
reads without reconnect/reset evidence. Both were repaired with a real private
HTTP regression; the two earlier trials are diagnostic only and the final pair
above reruns the repaired harness. Polling and held waits are both accepted.
Root lint, formatting, types and workspace tests pass; final core/fixture
regressions were rerun after the harness repair. Windows remains deferred.

## Phase 4 evidence

Added default-off command authority, immutable launch grants, a distinct hosted
feature/capability gate, native creation with durable SQLite reservations,
operator receipt/relationship reads, canonical remapping and conservative
restart reconciliation. No prompts/tokens are stored. Receipts hard-stop at
10,000 without silent expiration; 16 concurrent admissions share native queues.
The pure command service and real in-memory SQLite tests avoid full app/HTTP
startup; separate private HTTP and real Supervisor tests exercise boundaries.

Sol high review identified remap listener replacement, queued retryable failure
handling, an enablement race, mutable-catalog retry lookup and missing owning
documentation. Repairs preserve both issue/API remap subscribers, capture both
native failure callbacks, recheck admission authority, look up durable retry
identity first and document the authority/lifetime/retention contract. Regression
coverage uses actual Supervisor queue startup and concurrent private HTTP.

One opt-in Sol medium creation/provenance trial passed: 20.1 seconds, 10 HTTP
requests, zero errors, 13,097 fetched documentation bytes. Reported processed
input was 108,524 tokens; no unique-context/cache-saving claim is implied. The
trial used the new shipped bootstrap and fetched only the Markdown guide;
operation-specific schema discovery is separately tested.

Browser verification exposed a 105.9 ms first-search-frame miss. Search entry
now waits for the deferred query before mounting the full settings corpus,
keeping that work off the urgent first-character update; focused settings tests
pass. The preview test also now waits for the responsive pane remount before
reading/toggling its native details state after a viewport change.

Final desktop capture at 1000×600 shows separate discovery/command rows,
independent active toggles and their documentation links. Descriptions wrap
inside their own rows with no control overlap. No stale-runtime banner appears.
Capture: `.artifacts/ui-testing/20261030-agent-session-commands-final-reviewed/agent-session-commands-desktop.png`.

Final phone capture at 375×812 shows readable, wrapped captions with distinct
row backgrounds and practical toggle targets. Discovery and management remain
visually independent; no horizontal overflow or stale-runtime banner appears.
The keyboard test retains the 100 ms gate; final browser run passed. The initial
failed run and its timing evidence remain in ignored logs, not retried away.
Capture: `.artifacts/ui-testing/20261030-agent-session-commands-final-reviewed/agent-session-commands-phone.png`.

Phase 4 root lint/format/types and the workspace suite pass (6,608 server and
7,019 client cases). The console scan is unchanged at its existing 108-warning
budget; no touched file adds chatter. CSS ownership extraction is deferred for
the two touched settings owners because their rules span coupled legacy shared
styles (38/14 edges); this slice adds no authored CSS. Current hosted compatibility
uses the existing supported release corpus and a distinct optional capability,
with old servers omitting the new row/field. No transport horizon is changed.

The final release-copy browser run passed (26.5 seconds including setup).
All six captures under `.artifacts/ui-testing/20261030-agent-session-commands-release/`
were presented through the artifact capture facility and inspected one at a time:

- Desktop default: both grants off; rows and captions fit, toggles remain separate, no horizontal overflow or stale-runtime banner.
- Desktop enabled: both independent toggles active, command caption stays within its row and its doc link remains readable. No overlap.
- Desktop preview: platform-specific commands show variable references only; long instructions wrap inside the pane and continue by vertical scroll. No horizontal overflow.
- Phone discovery view: separate command row is still visible below the collapsed preview; long captions fit the narrow content column and toggles stay clear.
- Phone commands view: command authority has its own row, active state and documentation link. Caption stays contained; no horizontal clipping or stale-runtime indicator.
- Phone preview: platform heading and wrapped variable-only command remain legible; preview scrolls vertically, with no horizontal overflow.


## Phase 5 evidence

Added strict attributed queue submission and bounded receipt following through
normal HTTP, private transport and the hosted controller bridge. Durable identity
precedes external input; identical retries cannot enqueue a second message.
Stopped owners are explicit 409s with no automatic resume/steer. Native iterator
consumption is distinct from admission, acknowledgement and task completion.
The owner and proxy retain bounded positive API input evidence; no polling or
transcript UUID inference establishes delivery. New active summaries and replay
cover the catalog-materialization gap with explicitly incomplete history.

Sol high review identified abort monitor leaks, loss of constituent submission
identities during interrupt concatenation, and false admission evidence after a
failed native push. Repairs release on completion, preserve all constituent API
identities through native/proxy yield notifications, and record admission only
after successful push. Native integration regressions cover those mechanisms,
including an optimistic echo that cannot establish admission. Explicit input
cancellation on the existing session route drops positive admission markers,
wakes receipt following as uncertain and releases that monitor while the owner
stays alive. Native regressions verify that distinction from external drains.
Controller
replacement reconciles positive owner evidence and reattaches pending input
observation without resending. Receipt follow tests cover cancellation, committed
remapping, subscribe/read races, capacity reuse and stronger evidence surviving
late admission errors. Real hosted-worker/socket coverage includes sending,
strict receipt queries, consumption and duplicate retry after replacement.

One opt-in Sol medium workflow trial passed: 35.3 seconds, 14 HTTP requests,
zero errors, 14,699 fetched documentation bytes, and 152,574 reported processed
input tokens (136,960 cached). This is descriptive subscription-lane evidence,
not unique-context or causal cache/price evidence. It used the shipped bootstrap
and real private API with scripted native-owner truth. The grader requires a
same-receipt duplicate submission, consumed observation, creator and exact
follow-up result; a deterministic no-model HTTP regression checks rejection
without that evidence. Eight model trials ran across this plan: six accepted
final trials and two diagnostic follow trials before the harness repair.

Sol high fix review is closed with no remaining material runtime findings,
including a read-only diagnostic of 1,024 cancellations without monitor-capacity
leakage and consumption of an unrelated pending input. Final root lint,
non-writing formatting and typecheck pass. The focused API/source/native/hosted
suite passed 96 tests in 12.04 seconds; the subsequent cancellation/legacy queue
regression run passed 32 in 1.86 seconds (295 ms aggregate test bodies).

An initial workspace attempt overlapped the cancellation edit and failed the
new assertion; that result is retained, not accepted as final evidence. The
subsequent unchanged-source workspace run passed all new regressions and 6,615
other server tests, but failed only the previously tracked Rendez nested watcher
restart at line 364. Its gap records the run; the full workspace gate remains
red. No watcher retry or timeout change was used to replace that outcome.
The separately completed client suite passed all 7,019 cases in 127.98 seconds.
Native Windows, packaged-provider qualification, peer routing/enrollment and
retention/export policy remain explicitly deferred; no primary server setting
or provider host was changed or restarted during this implementation.


The implementation series consists of the plan commit `54e3c6de3`, bounded
acquisition `c777bee4e`, compact v0 reads `890fa5c21`, HTTP following `40d3e4c4f`,
native creation/provenance `36ea1b9c7`, and the attributed messaging/receipt-follow
commit carrying this final evidence. All five local implementation phases are
complete. Next design work is directional peer grants/enrollment and routing;
use that to qualify the deferred Windows host. Receipt retention/export policy
and independent packaged-provider smoke qualification remain separate follow-ups.

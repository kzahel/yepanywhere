# Durable session identity and creation

Topic: ya-owned-session-ids

Status: the November 2 ordinary Claude/Codex text milestone is implemented in
three larger slices, with one Sol 6.1 High review per slice and focused corrections.
Claude, Codex and recovery qualification have passing end-to-end evidence. All
three sole reviews completed; material findings were corrected and verified with
focused checks, without repeat-review cycles. Broader provider,
attachment, caller and release qualification below remains a separate backlog.
The original November 1 plan/schema/identity and read/discovery/watch foundations
were independently accepted; their historical review records remain below.

The maintainer subsequently requested incorporation of the separate
[creation-provenance admission notes](../../topics/session-creation-provenance.sketches.md).
The coordination requirements and coverage ledger below extend this plan;
Sol 6.1 High separately accepted this documentation addition on 2026-11-01.
The common caller rollout is partial; the provenance defect remains open.

## Active milestone — Claude and Codex creation, November 2

The maintainer narrowed execution after the implementation audit: deliver a
complete text-creation workflow for Claude and Codex before broadening provider
or caller coverage. This section supersedes the remaining nine-phase ordering
and repeated review instructions below for this milestone. Completed foundations
remain; the historical progress and broader backlog are retained as reference.

The user outcome is one permanent YA session, saved prompt/settings/source before
provider effects, usable startup/failure/uncertainty presentation, and preserved
history after refresh. Claude accepts YA's chosen native id; Codex returns a
native thread id which must bind without changing the YA URL. Include the routed,
account-pinned Claude path that motivated the work. Native history stays with the
provider, while YA owns accepted intent and startup evidence.

Implement three larger slices, each with focused tests and one Sol review:

1. **Claude creation end to end.** Complete ordinary text admission through API,
   Supervisor/provider and the browser. Save before startup, expose the stable
   session promptly, show honest startup/failure/uncertainty, and retain/copy the
   prompt after refresh. Cover selected router/account ownership and the existing
   supported local/hosted runtime choices. Integrate only the unfinished host
   work needed by these scenarios. Capture submitted draft identity before async
   work; acknowledgement must preserve newer local/sibling/device edits.
2. **Codex through the same workflow.** Reuse the application lifecycle/UI,
   explicitly bind the returned native thread id, and keep public identity through
   streaming, discovery, history, refresh and continuation. Keep the pinned
   app-server protocol/target. Native first-input confirmation must be real
   provider evidence; YA's fabricated user echo is insufficient.
3. **Recovery qualification.** Add focused fault scenarios and fix their findings:
   missing executable before subscription, lost acceptance response, restart
   during startup, Hono replacement with surviving worker, full owner loss and
   uncertain first-input delivery. Prove no duplicate logical session or initial
   prompt, unchanged routing, and safe draft acknowledgement while typing.

Tests accompany each implementation slice. Reuse real SQLite/application tests,
owned standalone profiles and existing browser/native protocol fixtures. Retain
browser E2E where actual form submission, navigation, reload, typing or transport
is the boundary. Report controlled native/model endpoint tests separately from
small actual installed-provider smokes; record unavailable live evidence without
claiming it passed. Run focused checks during edits and required broad/static
checks at slice completion, avoiding repeated passing runs without new cause.

One actual localhost:3400 Sol 6.1 High / bypassPermissions review covers each
complete slice. Fix its material findings and verify with focused checks; do not
start another review cycle for each correction or adapter. Commit coherent slices
on the current branch. This replaces the earlier mandatory re-review loop.

The first milestone excludes attachments, optional background creation/shortcuts,
automated retry, broad other-provider new creation and migration of Queue, review,
fork, native/peer and maintenance callers. Preserve their existing behavior and
keep the provenance/unconfirmed-send gaps open for uncovered paths. The safety
invariants still apply: acknowledged input is durably saved, public identity is
stable, uncertain effects never trigger automatic replay, newer drafts survive,
and authentication/router account selection remains authoritative.

Client rollout must use an exact narrow capability/negotiated contract for the
qualified text providers, with the existing flow when absent or ineligible.
Do not weaken or advertise the broader `session-creation-receipts` promise before
its attachment/all-caller guarantees exist. No compatibility cutoff, provider
refresh, global host restart, or bulk identity rewrite is part of this milestone.

## Release qualification — selected next slice

The maintainer approved one bounded qualification slice after the November 2
milestone. Keep ordinary Claude/Codex text scope, standalone profiles, focused
corrections, one actual localhost:3400 Sol 6.1 High/bypassPermissions review and
commits as work proceeds. This authorizes exercising the declared provider
versions; it does not select a provider protocol refresh, default change or
migration of attachments, Project Queue and other creation callers.

| Check | Required evidence |
| --- | --- |
| Actual providers | Pinned Codex executable creation/answer/restart/continuation; live Claude through available authorized credentials/router, with unavailable evidence explicit. |
| Phone-width relay interruption | Real encrypted relay submission/reconnect recovers the same public session and never replays initial input. A viewport check does not claim physical-phone lifecycle qualification. |
| Worker saturation | Queued UI/prompt/source, exactly-once promotion and an accurate recoverable state after restart before dispatch. |
| Source/account retirement | A delayed acceptance cannot navigate another source/account or clear its draft; original result remains recoverable. |
| Browser draft handoff | Real sibling tabs and independent browser contexts preserve newer unsent drafts across acknowledgement. |
| Supported older server | Current client falls back when narrow capability is absent; unsupported shapes retain the existing path. Reuse the existing released corpus where practical. |
| Router/auth refusal | Unavailable/expired authorization remains pinned, retains saved input and gives honest failure/uncertainty without direct fallback or duplicate dispatch. |

Use permanent E2E only where browser/transport interleavings are the unique
boundary. Keep one-off installed-provider/compatibility probes as qualification
evidence; report exact runtimes, wall time and limits. The existing draft-loss,
creation-provenance and general unconfirmed-follow-up gaps remain open outside
this scope. The routed-Codex direct-account discovery gap is independent and
must not be represented as closed by successful routed model inference.

## Release qualification results

- The actual official Codex 0.166.0 executable and live model pass creation,
  native ACK, split public/native ids, profile restart and continuation in the
  same native thread. The disposable install leaves the normal CLI unchanged.
- The current client passes against actual published YA 0.8.0 and 0.11.0 servers:
  one established start, no new receipt endpoint, native answer and reload.
  Permanent capability-absence coverage also edits the streamed bootstrap's
  version part so the test exercises the real source of capability facts.
- Browser worker saturation/promotion exposed one product defect: saved/queued
  pre-dispatch attempts stayed queued after Hono restart although the in-memory
  queue was gone. Startup now retains intent as failed/not-admitted/launch-refused
  only with evidence that the recorded controller PID is gone;
  dispatched unconfirmed effects remain uncertain. Focused store and real
  standalone browser checks pass, with no automatic dispatch or input replay.
- Real sibling tabs, independent browser draft sync and a signed acting-account
  switch preserve the newer/account-owned draft. Encrypted relay tests pass
  phone-width reply interruption/read-only recovery and host-A/host-B retirement.
  Router refusal with direct bait credentials causes zero model requests.
- Live Claude is ACCESS-BLOCKED: the independently paired router client has no
  account grants; direct portable credentials are absent. Controlled pinned
  SDK/CLI/AAR checks remain distinct. Physical-device and Linux/Windows execution
  are not claimed. The routed-Codex discovery/account gap remains open.
- The single actual localhost:3400 Sol 6.1 High/bypassPermissions review found
  a competing-startup defect: recovery ran before the new server discovered an
  occupied port and could invalidate the incumbent queue. Private controller-PID
  provenance and conservative liveness checks correct it. The focused real
  duplicate-startup check proves rejection leaves the incumbent queued, then
  capacity release promotes it exactly once. Untagged legacy pre-dispatch rows
  remain conservative; live/reused PIDs never authorize delivery. The original
  REVISE report and correction evidence are retained under ignored
  `tasks/session-identity/reviews/release-qualification.md`. No second review was
  requested; only the owned reviewer was retired, with verified stop.
- All 18 bounded browser cases passed together in 2.1 minutes before this
  review correction. Post-correction Node queue/duplicate-startup and recovery
  checks pass four cases in 37.6 seconds; Bun 1.3.14 passes the same full-worker
  duplicate-startup/restart case in 12.6 seconds. The full server suite passes
  6,888 tests in 130.31 seconds. Root typecheck, lint (zero warnings), format and
  exact-file checks pass.
- The pre-review full workspace run passed 6,888 server / 7,067 client tests.
  The final workspace attempt omitted the browser-cache environment under its
  temporary home, producing browser-not-found failures and skipped browser
  cases; its concurrent server run also hit an unrelated filesystem-watch
  timeout. All nine affected client files pass with the cache configured
  (51 cases); the complete isolated server run above passes. The failed logs
  remain recorded rather than represented as a successful final root command.
  A concurrent Node/Bun Playwright output collision was corrected with separate
  output directories; Bun's different occupied-port wording is accepted without
  weakening the incumbent-state/promotion assertions.
- This bounded slice is complete with the explicit live-Claude access gate
  above. No attachment/Project Queue migration, provider expansion, protocol
  defaults or primary-server changes were made.

## Execution progress

- Recovery milestone slice: four owned-profile fault cases pass: lost HTTP
  acceptance reply with read-only recovery and one submission; abrupt Hono loss
  under an independently owned host with the same worker PID and later native
  ACK; local and hosted owner loss before ACK retaining prompt/uncertainty,
  refusing resume and resolving identical admission without replay. These cases
  take 26.2 seconds together. macOS auto-bootstrap follows launcher IPC lifetime;
  the surviving-worker case therefore uses the documented independent host owner.
  The local owner-loss case also passes with Bun 1.3.14 (1.7 seconds).
  A routed Claude browser case with 200 persisted saved sessions proves every
  sequential key is acknowledged within 100 ms from event timestamp through
  a rendered frame, while title updates and acceptance arrive mid-typing; the
  newer draft survives explicit navigation and return. The ten focused E2E cases pass together in 1.3 minutes. Root
  typecheck, lint, formatting and exact-file E2E lint pass. The final one-per-slice
  Sol review found two typing-qualification gaps: acceptance was outside the
  measured interval and the timer ended before paint. Acceptance now arrives
  midway through sequential keys; event timestamps include dispatch delay and
  the second animation frame observes the preceding rendering/paint. The exact
  corrected case passes. A controlled-fixture stdin-close exit now prevents
  orphaned barrier timers after local Hono loss; owned leaked fixture groups
  were reaped with identity checks. No repeated review was requested. The current
  runtime's full run passed 6,888 server and 7,067 client tests. This slice adds qualification, with no runtime changes.

- Codex milestone slice: the same text API/UI now binds Codex's independently
  allocated native thread id while preserving YA identity through discovery,
  history, browser reload and continuation. Successful native `turn/start` ACK
  confirms input; the adapter's user echo cannot. Host and worker negotiate an
  additional Codex creation feature before launch. Controlled local/host browser
  cases pass; the initial live-reply misses were traced to missing WebSocket
  upgrade forwarding in the fixture, corrected without a product refresh change.
  All five Claude/Codex browser cases now pass (44.1 seconds). A separate actual
  installed Codex/live model smoke confirms split IDs, native ACK, one native
  thread and retained answer after standalone server restart. This installed CLI
  reports 0.160.0; the protocol target/reference remains 0.166.0. The sole Sol review
  found an empty-CODEX_HOME namespace mismatch, now corrected to native semantics
  with a focused regression. No repeated review was requested. The recovery
  slice above completes the narrowed fault qualification. Root typecheck, lint and
  formatting pass. The corrected full run passes 6,888 server and 7,067 client
  tests (149.57 seconds for the server workspace); the initial run failed only
  an outdated expected host-feature array, corrected and focused-verified.

- Claude milestone slice: the narrow text acceptance API, routed/account-pinned
  dispatch, saved startup/failure UI and captured draft acknowledgement are
  implemented. Three owned-profile browser cases cover real Claude CLI against
  a controlled model endpoint: routed startup with browser reload,
  disappeared executable plus page/server restart, and form retirement before
  acceptance followed by recovery without a second submission. Focused server
  checks pass (164 tests); draft checks pass (93 tests). One actual Sol 6.1 High
  review identified delayed sibling storage and retired-form recovery defects;
  both were corrected and the exact interleavings verified without re-review.
  This is controlled native evidence, not a live Anthropic model smoke. The
  Codex and recovery slices above extend this checkpoint. Required root
  typecheck, lint and formatting pass; the final full run passes 6,886 server
  and 7,067 client tests (140.34 seconds for the server workspace).

- Phase 3 provider-variant continuation is independently accepted by Sol
  6.1 High after correcting a vacuous Gateway readiness assertion to configure
  an actual autostart-capable service. Claude/Gateway/Ollama share one native
  environment validator; Gateway checks before readiness and revalidates before
  SDK launch. Codex OSS retains per-turn exec, validates UUID/native-store/header
  before routing/leases, refuses a different native thread, reports failed turns
  and releases actual children, input waits and installation leases on teardown.
  Pinned `rust-v0.166.0` source proves UUID resume avoids the missing-name
  allocation fallback; no target/protocol refresh is made. Focused checks pass
  68 cases / five files / 2.75 s. All nine standalone variant/runtime probes
  pass on Node 22, Node 26 and Bun. Gateway/Ollama use the actual pinned SDK/CLI
  and an owned fake model for two split-id cold resumes across restarts, with
  competing native history untouched. OSS uses a controlled OS CLI/native
  rollout peer. Neither external model/installed-Codex nor Linux/Windows native
  execution is claimed. Final lint has zero warnings; format/typecheck pass.
  Both complete workspace outcomes remain red at the existing Rendez restart
  defect: pre-correction top-level line 231 (135.35 s), final corrected nested
  delivery (133.09 s), each with 6,882 other server / 7,064 client cases passing.
  No watcher source/budget changed or blind retry replaced either result.
  Hosted cold workers, broader released-client observation and new-launch gates
  remain open.

- Phase 3 retained ACP cold continuation is independently accepted by Sol
  6.1 High. Grok and frozen Gemini validate their actual launch store and
  original physical project before CLI/bridge effects; native RPC keeps N and
  public observations keep P. Grok tool shells retain P after attachment.
  Failed/unsupported Gemini resume now refuses without a replacement allocation
  or prompt, resolving its recorded gap without changing protocol or registry
  mapping. Shared ACP teardown retains the real child, settles in-flight calls
  on transport closure and cancels idle input waits. Actual ENOENT/EPIPE tests
  exposed pinned-SDK pending-call hangs; the corrected tests pass without
  timeout increases. Standalone Gemini's owned native/reader roots now agree.
  Real app/SQLite/OS protocol/native-history/reopen checks pass: 84 cases /
  seven files / 4.53 s. All nine standalone restart probes pass for Grok,
  Gemini's legacy alias and Gemini ACP on Node 22, Node 26 and Bun. These use
  controlled native peers; installed-CLI/model, other-OS, hosted cold-worker and
  released-client observation qualification are separate. Initial fixture and
  transport failures remain recorded. Final lint has zero warnings,
  format/typecheck pass, console budgets are unchanged, and the complete
  workspace passes 6,880 server / 7,064 client cases (server 133.43 s).
  The separate Rendez instability remains open. New provider creation and
  remaining host/variant gates stay pending.

- Phase 3 Pi cold continuation is independently accepted by Sol 6.1 High
  after correcting child-home and empty-directory namespace handling. It passes
  the proved absolute native file, validates scope/header/original physical
  project before CLI effects, and verifies returned native id/file before input.
  A changed child home or working-project overlay refuses explicitly. Public
  identity remains YA; the saved original input is never replayed. Startup
  errors retain real child evidence, asynchronous spawn/pipe errors reject RPC,
  and idle abort or iterator return releases its wait and child. Real app,
  SQLite, competing native history, OS RPC failure and database-reopen checks
  pass: 55 cases / five files / 2.92 s. Owned standalone native-file continuation,
  history and profile-restart probes pass on Node 22, Node 26 and Bun, with an
  additional final-correction Node 26 pass. The Pi CLI is absent; these use a
  controlled OS RPC peer, without an external model or Linux/Windows runtime
  claim. Relevant path/cwd behavior was inspected in upstream 1.1.0 and the
  current pinned 1.4.0 source; no version/protocol refresh is made. Final lint
  has zero warnings, format/typecheck pass, and the corrected full workspace
  passes 6,876 server / 7,064 client cases (server 133.63 s). New Pi creation,
  its separate durable user-turn-id gap and remaining provider/host gates stay
  open.

- Phase 3 OpenCode cold continuation and fileless source acquisition are
  independently accepted by Sol 6.1 High after pinning the protected native
  listener's hostname explicitly. One source callback supplies proved native
  facts and an optional actual path; fork/copy requires a physical source.
  DB, JSON and CLI-export cold resumes retain their existing native handle and
  public identity, with no native session allocation. Wrong scope/handle refuses
  before CLI effects. Scoped owners use a selected unused loopback port and
  fresh private HTTP credential; an unrelated endpoint receives no input, and
  startup failure retains the actual child until exit evidence. The existing
  internal basePort option is now honored for isolated fixture ownership.
  Real app/SQLite/OS HTTP/native-store/reopen checks pass; the broader focused
  scope passes 214 cases / eight files / 25.36 s. The final hostname-bound subset
  passes 24 cases / two files / 4.05 s. Standalone OS YA/fileless-native HTTP and
  profile-restart probes pass on Node 22, Node 26 and Bun; a final Node 26 probe
  enforces the explicit hostname argument. The installed OpenCode CLI is absent,
  so this records controlled native protocol evidence, not an external model or
  installed-CLI smoke claim. Lint has zero warnings, format/typecheck pass.
  The pre-hostname-correction full run hit the known Rendez nested-restart
  failure (6,872 other server / 7,064 client; server 132.45 s); it is preserved.
  Eight isolated instrumented watcher restarts did not reproduce that failure
  and justify no watcher fix or gap closure. The corrected complete Node 26
  workspace passes (6,873 server / 7,064 client; server 130.10 s). New OpenCode
  launch ownership and remaining provider/host cold gates
  remain later slices.

- Phase 3 owned released-client observation passes on published 0.8.0 and
  0.11.0 for Claude and Codex. Four existing-API probes and four actual released
  composer probes exercise differing public/native ids, one pending input,
  confirmed output and one durable user turn after page reload. URLs, all public
  requests and collection identities stay YA. Each profile owns its server,
  browser and native/protocol fixture; browser network is restricted to that
  server. Claude uses the pinned actual SDK/CLI with a local fake model; Codex
  uses the real adapter and controlled OS app-server/native rollout path, without
  external model calls. Composer probes acknowledge every sequential character
  within 20 ms (Claude 10/20 ms, Codex 16/16 ms for 0.11.0/0.8.0). Initial Codex
  fixture failures are retained: response/event ordering and a missing seed
  receipt were corrected to the existing native provenance contract; normalized
  API evidence showed one user turn rather than a product duplication defect.
  Sol 6.1 High independently accepts this evidence. No runtime/client/capability
  change is made by this qualification. Remaining provider/host cold paths and later phases stay
  gated; this does not claim phase 8's future draft/concurrent-volume checks.

- Phase 3 local Claude/Codex cold continuation is independently accepted by
  Sol 6.1 High after correcting retained legacy-host interception and failed
  bridge cleanup. One provider-owned native-source boundary supplies native
  resume/control id and proven path, while Process/events and child/API/self
  authority retain the YA id. Existing bindings validate without allocation;
  stale scope, deletion during source/instruction awaits and a different
  provider attachment refuse before later input. Claude retains account-home
  selection and its prompt-cache native address; Codex uses the exact rollout
  path and refuses unsupported negotiation. Stored equal-id legacy host
  sessions attach only to the incumbent; missing owners and destructive
  configuration/sandbox replacements refuse before launch/termination.
  Focused checks pass 232 cases / five files / 24.79 s, including actual host
  worker generation replacement with real SQLite. Actual pinned SDK/CLI
  standalone probes pass two split-id cold HTTP resumes across profile restarts
  on Node 22, Node 26 and Bun, selecting one native alias despite competing
  same-id history. A final Node 26 run also checks one retained original native
  input. The initial full run exposed two instruction-source fixture adapters
  missing their new opt-in; their production id/path/public assertions now pass.
  The pre-review-correction complete workspace passed 6,870 server / 7,064
  client cases (server 131.01 s). Final corrected source passes lint with zero
  warnings, format and typecheck. Its complete workspace run passes 6,871 other
  server / 7,064 client checks but hits the existing top-level Rendez restart
  failure (server 133.51 s). The red run is retained without retry; the separate
  [watcher gap](../../gaps/rendez-nested-watch-event-after-restart.md) stays open.
  Other provider cold paths, fresh hosted cold workers and owned released-client
  qualification remain gates before differing-id new launches.

- Phase 4 hosted transport and saved-attempt reconciliation are independently
  accepted by Sol 6.1 High after correcting compiled asset delivery, deferred
  owner selection and destructive configuration/compact bypasses. The private
  managed feature negotiates before launch, pins host versus local ownership
  and requires exact protocol-2 claims before ownership changes. Worker proof
  reconciles only the current SQLite attempt; startup marks unconfirmed owners
  uncertain before admission. Reattachment restores observation without
  replaying the original input. Native commands use the same admission guard.
  Qualified hosted Claude text survives Hono replacement with both confirmed
  and delayed input evidence; full owner loss keeps the exact saved prompt and
  refuses automatic native relaunch. Actual pinned SDK/CLI standalone probes
  pass on Node 22 and Node 26. A clean compiled-server startup also passes with
  the copied decoder assets and no TypeScript loader/source fallback.
  Corrected focused checks pass 98 cases / nine files / 11.15 s, followed by
  36 command-boundary cases / four files / 10.34 s. The assembled test now
  waits for HTTP readiness after worker reattachment (one case / 9.16 s): the
  first full run exposed that host ownership precedes HTTP listen, with all
  other 6,859 server and 7,064 client cases passing. The corrected complete
  Node 26 workspace passes (6,860 server / 7,064 client; server 142.58 s);
  lint has zero warnings and format/typecheck pass. No global receipts capability,
  unsupported provider rollout or automatic replacement is enabled. Cold
  resume, broader input shapes and remaining callers stay gated.

- Phase 4 worker ownership and protocol-2 attachment are independently accepted
  by Sol 6.1 High after correcting an inner-bridge/AgentSelf bootstrap gap.
  One immutable bounded creation record carries public id, attempt, native
  namespace/optional chosen id and independent input UUID. The worker retains
  native binding and matching input confirmation across detach and acknowledged
  replay; stale/forged attach fails before replay. Native conflict, completion,
  API failure and failed public publication close input while retaining cleanup
  ownership. Private public-id bootstrap initializes inner bridges and self/API
  identity before native startup; native handles remain separate.
  Focused checks pass 94 cases / eight files / 10.91 s. Owned pinned SDK/CLI
  owner probes pass on Node 22, Node 26 and Bun. Actual production-worker
  socket-2/detached proof and wrong-namespace pre-effect refusal pass on Node 22
  and Node 26. Real native Bash verifies the inner bridge, AgentSelf and local
  API all use P with P != N and no controller identity publication on both Node
  runtimes. Its explicit approval controller preserves existing permission
  ownership; detached delivery is a separate probe. Lint has zero warnings,
  format/typecheck and the complete Node 26 workspace pass (6,855 server /
  7,064 client; server 130.30 s). Host transport, saved-attempt reconciliation,
  Hono replacement and managed feature advertisement remain gated.


- The phase 4 host design refinement and non-enabling startup negotiation are
  independently accepted by Sol 6.1 High. Required worker features withhold
  stdin until a supporting pre-start hello; premature readiness is rejected,
  legacy launches remain immediate, and pipe failure cannot terminate the host.
  No managed feature or caller is enabled. Real IPC regression cases and the
  assembled host/Hono replacement pass (45 checks / two files / 11.59 s).
  Owned production-refusal and old-worker deadline/reap probes pass on Node 26
  and Node 22. Lint has zero warnings, format/typecheck and the complete
  Node 26 workspace pass (6,846 server / 7,064 client; server 132.08 s).
  Worker evidence, protocol-2 attach and managed hosted dispatch remain gated.

- Phase 4 default-wrapper consolidation is independently accepted by Sol 6.1 High:
  the thin Claude SDK
  bridge declares its canonical provider, allowing omitted-provider requests
  to use the configured AgentProvider and the same durable text path. Explicit
  provider overrides (including disabled discovery) and unnamed independent
  SDKs keep precedence. The start path also preserves provider-visible client
  identity. An owned Node profile passes default project/detached missing-CLI
  saved failures, profile reopen, and real pinned SDK/CLI healthy HTTP launch
  plus native-history restart against a local fake model. The same owned Bun
  qualification passes. Focused checks pass 183 cases / five files / 3.83 s;
  lint has zero warnings, format/typecheck and the complete Node 26 workspace
  pass (6,841 server / 7,064 client; server 129.40 s).
  Other phase 4 rollout gates remain open.

- Phase 4 ordinary request integration is independently accepted by Sol 6.1 High:
  qualified superuser
  project/detached Claude AgentProvider text starts now admit durable intent
  before availability checks. Versioned input choices retain temp-id/mode,
  origin/effort and composition/speech/timing across worker deferral; actor,
  receipt/hidden authority and arbitrary fields are excluded. Existing response
  shapes, post-start associations and idle preemption are preserved. Real
  SQLite/reopen and HTTP tests cover failures before native launch, exact
  metadata, source-at-admission, queued promotion and private-field exclusion.
  An actual owned Node standalone profile passes project/detached failure,
  saved-state restart, then real pinned Claude SDK/CLI healthy HTTP launch and
  native-history restart using a local fake model only. The same owned Bun
  qualification passes. Focused checks pass 187 cases / six files / 3.87 s;
  lint has zero warnings, format/typecheck and the complete Node 26 workspace
  pass (6,841 server / 7,064 client; server 129.09 s). Deferred callbacks retain
  copied launch values instead of raw HTTP contexts/bodies.
  Slash/attachment/runtime-authority inputs, limited/routed/sandboxed/hosted
  paths and later phase gates remain pending; no receipt capability ships.

- Phase 4 managed runtime boundary is independently accepted by Sol 6.1 High:
  a private Supervisor
  dispatcher reads stored choices/input identity, checks current authority and
  provider availability, claims the actual native namespace before effects,
  and uses the existing worker queue for deferral. Managed Process binds before
  publication while keeping its YA id and recognizes native input confirmation
  independently of local queue pulls. Unconfirmed exit retains uncertainty;
  queued cancellation persists before returning. Actual pinned Claude SDK/CLI
  qualification uses an owned local fake model and caught/corrected pre-init
  title telemetry and response stamps without user re-echo. Ordinary routes,
  router/sandbox/hosted integration and all later rollout gates remain pending.
  Review corrected premature ownership release, ended-stream input admission,
  native-directory leaf aliases and the native API-error/explicit-stop paths.
  The final focused scope passes 225 checks / eight files / 4.84 s; real
  SDK/CLI probes pass on Node 22.23.3, Node 26.7.0 and Bun 1.3.14. Lint has zero
  warnings; format/typecheck and the final complete Node 26 workspace pass
  (6,836 server / 7,064 client; server 128.51 s). The initial pre-correction
  full run hit the separately recorded Rendez nested-restart failure; its red
  evidence remains preserved and this successful run does not close that gap.

- Phase 1: concrete design accepted, including attempt/evidence budgets,
  durable retry fencing and the bounded retained-fork source bridge. Existing
  storage/provider-resolution baseline: 13 checks passed on Node 26.7.0.
  The desktop-pinned Bun 1.3.14 binary was checksum-verified in the owned local
  task directory; Bun storage qualification remains a source-slice check.
- Phase 4 storage foundation is implemented and independently accepted by
  Sol 6.1 High: migration 18 and the common
  atomic identity/metadata/payload/attempt boundary, with fenced binding and
  idempotent explicit pre-effect retry. This precedes the first equal-id Claude
  vertical path; focused real-SQLite/reopen checks pass on Node 22 and pinned
  Bun. Remaining phase 3 cold-resume/browser gates still block
  differing-id launches. Public creation behavior and capability are unchanged.
  Final focused storage/identity/native-helper checks: 18 passed across three
  files in 2.47 s. Lint has zero warnings; format/typecheck pass. The complete
  Node 22.23.3 workspace passes (6,803 server / 7,064 client; server 134.65 s).
  Both Node 26.7 workspace runs hit the existing Rendez restart line-364
  failure; those red runs remain recorded in its gap. A separate reviewed
  type-only helper-fixture cleanup clears three inherited lint warnings.
- Phase 4 fatal-startup correction is independently accepted by Sol 6.1 High:
  wrapped missing-binary classification, admission fencing before error callbacks
  and established dead-owner refusal preserve lazy first input. Four regressions
  fail against the prior Process and pass after correction; final focused scope
  is 98 checks across four files in 1.19 s. Actual pinned SDK missing-executable
  probes pass on Node 26.7 and Bun 1.3.14 without a model call. Lint has zero
  warnings; format/typecheck and the complete Node 22 workspace pass (6,808
  server / 7,064 client; server 132.86 s). Durable launch integration remains
  the next vertical boundary.
- Phase 3 released-browser non-owned refresh qualification now passes using
  integrity-verified published npm 0.8.0 and 0.11.0 client assets, actual isolated
  YA HTTP/WebSocket listeners, unequal UUID ids and native Claude/Codex append
  followed by refresh/reload at the unchanged YA URL. All four combinations pass
  on Node; latest Codex also passes with the pinned Bun server. Only test assets
  are intercepted; API/WebSocket traffic reaches the real owned listener.
  Chromium's loopback network permission is granted only to that fixture origin.
  Owned-process browser cases and cold-resume consumers remain unqualified.
- Phase 4 saved-record detail/metadata and access-fact reads are independently
  accepted by Sol 6.1 High after preserving optional identity access in retained
  metadata facades. Exact prompt/source after profile reopen, creator ownership,
  safe status projection, no native project-directory creation and ordinary
  unbound-resume refusal pass real-app/SQLite/auth checks and actual standalone
  Node/Bun HTTP probes. Saved facts override cached native aliases without
  borrowing their activity. Final focused checks: 231 across six files in
  7.32 s. Lint has zero warnings; format/typecheck and the complete Node 26
  workspace pass (6,810 server / 7,064 client; server 127.92 s). The Node 22
  full run hit the existing Rendez restart failure and remains recorded in its
  gap. Collection discovery and the actual durable launcher remain later
  boundaries.
- Phase 4 collection slice is independently accepted by Sol 6.1 High:
  global/project/inbox collections and public project cards include Saved/Failed control rows;
  native-bound records with no transcript remain readable. Migration 19's atomic
  revision invalidates collection conditionals and cached stats without payload
  decoding or native catalogue rows. Ordinary unconsumed/uncertain resume refuses.
  Three review corrections preserve global hiding/restoration, count the union
  of a published native inventory and controls, and merge controls after native
  notification enrichment. Final focused checks pass 152 cases across 13 files
  in 6.06 s, including real notifications and mixed bound/no-transcript counts.
  Corrected standalone Node/Bun HTTP collection/restart probes and pinned Bun
  18→19/revision/reopen probes pass. Lint has zero warnings; format/typecheck
  pass. The first workspace invocation hid the browser cache under its temporary
  home and failed browser fixtures; its log is retained, with an explicit cache
  path supplied for the final run. That corrected complete Node 26 workspace
  passes (6,814 server / 7,064 client; server 127.96 s). Public creation, actual
  durable launching and capability remain unchanged.
- Phase 4 native-allocation quarantine is independently accepted by Sol 6.1
  High. Dispatch
  and the selected native namespace claim commit together, preventing an early
  provider transcript from being adopted as a second public session. Known
  bindings remain usable; matching binding releases its claim, while uncertainty
  and deletion without native proof retain it. Private namespace evidence uses
  existing attempt budgets. Real SQLite and HTTP/native-file checks cover
  rollback/capacity, two concurrent claims, wrong/stale binding, reopen, legacy
  read/list exclusion and publication solely under the YA id after binding.
  A review correction removes the asynchronous no-claim watch fallback: the
  deterministic red case attached N after a paused lookup; the corrected source
  refuses N while known and unrelated scopes still receive actual append events.
  A full-gate regression also exposed unnecessary summary acquisition in the
  retained preview path. Direct guarded excerpt reads preserve that historical
  behavior; a separate Sol review accepts the correction. Final focused checks
  pass 107 cases across 14 files in 5.26 s. Corrected owned
  Node/Bun standalone early-file/guarded-preview/restart/live-binding/restart
  probes pass; direct
  Node 22/Bun 19→20 and retained-quarantine probes pass. Node 22 emits its
  documented SQLite experimental notice. Final lint has zero warnings;
  format/typecheck and the corrected complete Node 26 workspace pass (6,817
  server / 7,064 client; server 129.64 s). The earlier full preview failure is
  retained as red evidence. No actual durable launcher or capability is enabled
  by this prerequisite.
- Phase 4 launch-intent storage is independently accepted by Sol 6.1 High: migration 21
  reserves an independent first-input UUID in the admission transaction, while a
  versioned allowlist retains additional submitted model/tool/sandbox/router/
  helper/compaction choices without environment objects or live desktop proof.
  Existing request/payload budgets apply; old records retain null input ids and
  absent launch snapshots. Real SQLite checks cover caller mutation, replay,
  changed-choice conflict, retry/reopen stability and actual 20→21 legacy replay.
  Final focused checks: 23 cases / five files / 3.11 s. Actual Node 22 and
  pinned Bun migration/snapshot/input-id/retry/reopen probes pass; lint has zero
  warnings and format/typecheck pass. Full Node 26 and Node 22 runs both hit the
  existing Rendez top-level restart line-231 failure (6,818 other server /
  7,064 client checks pass; 128.91/134.60 s server runs). Both red results remain
  recorded in the existing gap; this slice changes no watcher code or budgets.
  This is preparation for dispatch; no new launch route/capability is enabled.
- Phase 2: implemented and independently accepted by Sol 6.1 High after fixing
  stored-identity missing-transcript fallback and Codex read ownership. Migration
  17, scoped forward/reverse adoption and bound Claude/Codex detail/history are
  qualified with unequal ids, collisions and profile reopen. Focused checks:
  79 passed / 2 retained skips across five files in 2.59 s; pinned Bun 1.3.14
  migration/adoption/reopen probe passed. Lint, format, typecheck and full workspace
  tests passed (6,720 server / 7,064 client). Launch behavior is unchanged.
  Whole-suite expected fault-path logs and unowned client navigation diagnostics
  remain covered by the existing diagnostic gaps; focused checks are clean.
- Phase 3: first discovery/source slice implemented and independently accepted
  after correcting project-membership checks and native/public metadata-key
  collisions. Claude/Codex full/lightweight/retained lists share batch adoption;
  summary refs and migrated helper reads retain native addresses. The real
  profile/app/merged-root fixture includes append/reopen, an unrelated public id
  equal to a bound native id, and correct/wrong/moved-project bang routes.
  Corrected focused checks: 46 passed across six files in 2.90 s under a private
  temporary home. Native catalogue row format 3 retains actual source scopes;
  no physical source/index keys are renamed. Lint, format, typecheck and full
  workspace tests pass (6,721 server / 7,064 client); pinned Bun 1.3.14 also
  passes batch-conflict rollback and reopen.
  The subsequent focused Claude/Codex watch slice is independently accepted:
  native append/public wire events/detail refresh, shared-viewer teardown,
  unbound/missing-source isolation and late-resolution cancellation pass eight
  focused checks in 2.63 s. Lint, format, typecheck and workspace tests pass
  (6,723 server / 7,064 client); pinned Bun observes the scoped native append.
  The retained fork/clone source cut is also independently accepted after
  restoring torn-JSONL tolerance and refusing copy destinations that current
  cold launch cannot address. Provider inputs/results name native ids; public
  lineage/settings/account pins remain public. Actual SDK/profile fixtures cover
  unequal parent ids, original/working projects, copy/read/reopen, bounded and
  missing anchors, retained metadata failures and pre-copy scope refusal. Pi
  child cold reads retain their recorded root; controlled Codex protocol checks
  preserve native path/id/turn and configured launch namespace. Corrected focused
  checks: 153 passed / 2 retained skips across four files in 22.96 s; pinned Bun
  1.3.14 source-copy probe passed. Lint, format, typecheck and workspace tests
  pass (6,726 server / 7,064 client). Fully scoped cold resume/immediate helpers
  remain an enabling requirement, with unqualified copies refused before I/O.
  The native read-consumer cut is independently accepted after adding original
  project/path consistency and scope-less legacy Codex upgrade fences.
  Instruction restoration, issue indexing and Conversation acquisition retain
  native sources with public observations; corrected catalogue publication can
  recover a deferred source without reopening. Actual app/SQLite fixtures cover
  both families, working-project moves, two viewers/native append, public issue
  keys, instruction-source capture, reopen and post-shutdown cancellation.
  Focused checks: 46 passed across five files in 5.20 s; lint, format, typecheck
  and corrected workspace tests pass (6,738 server / 7,064 client). Standalone
  Node 26.7.0 and pinned Bun 1.3.14 servers also pass actual HTTP Claude
  unequal-id Conversation/native append/public issue/restart probes under the
  Node coordinator. These do not qualify native CLI/model or hosted continuity.
  The process/child projection cut is independently accepted: process enrichment
  retains public facts for unbound/unreadable identities and reads bound native
  models/titles without ambient or public-metadata collisions. Child listings
  use native parents while returning YA parents and existing native child handles.
  Metadata/full reads reuse their native source; summary/settings recovery works
  through empty moved working projects. Actual app/SQLite/native fixtures cover
  profile reopen, scoped Codex child content and recovered launch context.
  Focused checks: 46 passed across six files in 5.22 s; warning-free lint,
  format, typecheck and workspace tests pass (6,742 server / 7,064 client).
  Standalone Node 26.7.0 and pinned Bun 1.3.14 HTTP probes pass scoped native
  child/public parent/original-A–working-B reads before and after restart.
  These do not qualify native CLI/model or hosted continuity.
  The native catalogue/helper consumer cut is independently accepted. Optional
  Codex question enrichment resolves public archive facts through scoped reverse
  binding. Vocabulary reads use actual native roots; old scope-less rows defer
  without checkpoints or blocking other learning. Maintenance comparison borrows
  the app's scoped reader and retains the public response id. Existing actual
  app/SQLite fixtures now include private-versus-ambient vocabulary and an owned
  maintenance HTTP comparison. Focused checks: 41 passed across five files in
  5.56 s; warning-free lint, format, typecheck and workspace tests pass
  (6,742 server / 7,064 client). Private-home actual app/SQLite/native vocabulary
  and metadata-collision probes also pass on Node 26.7.0 and pinned Bun 1.3.14.
  The production maintenance callback is source-reviewed; the controlled HTTP
  fixture qualifies its handler and bound reader, not native CLI/model startup.
  The Claude/Codex external file-observation cut is independently accepted after
  correcting cold-reader source ordering, disposal of active summary batches
  and working-project changes during external activity. Physical source proof
  and scoped binding precede ownership/grace/decay joins; native Codex thread ids
  remain distinct from reverted leaf filenames. Known native files update the
  existing reader/scan cache without corpus rescans or fabricated freshness.
  Acquisition is bounded and shutdown cancels late adoption and publication.
  Corrected focused checks: 110 passed / 2 retained skips across eight files in
  6.19 s. Warning-free lint, format, typecheck and corrected workspace tests pass
  (6,749 server / 7,064 client). Owned standalone Node 26.7.0 and pinned Bun
  1.3.14 actual FileWatcher/HTTP/native-file probes pass public ownership,
  working-project/native-id collisions, reverted leaf history and profile
  restart. These do not qualify native CLI/model or provider-host continuity.
  The earlier full run's unrelated extensionless-image failure remains recorded
  in [its adjacent gap](../../gaps/files-api-extensionless-image-index-race.md);
  the failed run was retained and its renderer/test fixture was left unchanged.
  Remaining all-provider observation, released-browser/owned-confirmation
  qualification, native source consumers and other provider shapes are pending;
  phase 3 is not complete.
- Standalone fixture: the existing E2E process helper now has opt-in private
  environment composition and a selected server executable, retaining its
  process registry/host cleanup. The poisoned-parent actual-config/native-path
  probe and ordinary creation/history/restart/cleanup pass under Node and the
  pinned Bun server with a Node coordinator. Sol independently accepted the
  fixture after correcting shell-bridge inheritance and case-insensitive Windows
  name handling. Focused checks: 8 passed / two files in 4.86 s on Node;
  3 passed / one file in 2.24 s with pinned Bun 1.3.14. Lint, format, typecheck
  and the corrected workspace run pass (6,729 server / 7,064 client).
  The earlier workspace run's known Rendez restart failure remains recorded in
  [its existing gap](../../gaps/rendez-nested-watch-event-after-restart.md).
  Hosting remains a separate owned scenario; native Linux/Windows execution,
  durable-creation and live model qualification are not claimed.
- Phase 3 legacy-alias guard is independently accepted after three review
  fixes: proof selects a scope-constrained pooled reader, unknown-parent child
  fallback requires native evidence, and the production fork-source callback
  carries app cancellation. Missing public native spellings cannot read or
  control another scoped public binding; existing ids retain their spelling.
  Real App/SQLite merged-root, orphaned-child and held-fork teardown regressions
  pass. Focused checks: 36 passed across six files in 5.38 s. Owned Node 26.7.0
  and pinned Bun 1.3.14 HTTP/append/restart probes pass. Lint, format and
  typecheck pass. The final workspace run passed 6,752 server / 7,064 client;
  an unchanged-tree preceding run failed the separately tracked
  [Rendez restart watcher](../../gaps/rendez-nested-watch-event-after-restart.md).
  Both outcomes are retained; this slice does not resolve that instability.
  Host PID correlation and other retained-provider qualification remain next;
  launch behavior and capability advertisement are unchanged.
- Phase 3 host PID correlation is independently accepted. Native PID/start
  evidence and the configured canonical namespace select a unique retained
  catalogue source; public metadata supplies title/working-project facts.
  The released native-id wire field stays native, and its legacy project link
  is omitted for unequal YA/native ids. Uncached PID records share one existing
  TTL batch. Optional reads neither initialize discovery nor recover corrupt
  shards; normal collection reads retain rebuild ownership. A review finding
  exposed the indirect corruption callback, now covered by the existing real
  over-budget catalogue fixture without a wall-clock delay. Retirement fences
  pending catalogue work before SQL teardown. Focused checks: 34 passed across
  six files in 6.13 s. Owned actual-OS/PID/HTTP/restart probes pass on Node
  26.7.0 and pinned Bun 1.3.14; the inert process fixture does not qualify
  provider/model startup. Frozen final lint, format, typecheck and full tests
  pass (6,753 server / 7,064 client). An intermediate run that overlapped the
  final regression/source correction is retained separately and is not final
  qualification. Other native-family/control and old-client focused-watch
  browser qualification remain phase-3 enabling work; no launch/capability
  behavior changes here.
- Phase 3 OpenCode SQLite prerequisite is independently accepted. The native
  reader now uses the common Node/Bun adapter with engine-enforced read-only
  file opens; normal YA/relay/push opens are unchanged. Fixed SQL statements
  and handle-dependent caches are released on replacement/retirement, misses
  do not hide later native creation, and finite catalogue scans release their
  native handles before walking JSON history. Pending lookup retirement cannot
  reopen native storage or launch a new CLI fallback. Existing export/file-tree
  fallbacks and native schema/target versions remain unchanged. Focused checks:
  26 server checks in 0.661 s plus seven shared checks in 0.094 s. Actual
  read-only/no-create/write-denial/WAL/lifetime probes and owned standalone YA
  DB-only history/100-refresh/restart probes pass on Node 26.7.0, Node 22.23.3
  and pinned Bun 1.3.14. Node 22's existing experimental SQLite notice remains
  deliberately unsuppressed. Final lint, format, typecheck and full workspace
  tests pass (6,755 server / 7,064 client). Native scope/public adoption,
  bound OpenCode history and focused DB/WAL observation remain next; this
  prerequisite does not qualify live model startup or another platform.
- Phase 3 OpenCode directory membership fixes the previously recorded non-Git
  transcript defect. Shared `global` rows are scoped by their actual directory,
  including physical path aliases; known foreign rows cannot escape through
  export fallback. Child/list/history reads share that boundary. Existing Git
  worktree and legacy `/` links retain their behavior; catalogue grouping uses
  per-session directories only for `global`. Old schemas retain worktree reads.
  Sol independently accepted after two alias-proof corrections. The real
  SQLite/symlink regression verifies 13 sessions reuse one physical lookup
  and a subsequent operation observes symlink retargeting. Focused checks:
  36 passed across three files in 0.817 s. Actual Node 26.7.0 and pinned Bun
  1.3.14 directory-SQL/child/retarget probes and owned YA HTTP/WAL/restart
  checks pass. Final warning-free lint, format, typecheck and workspace tests
  pass (6,758 server / 7,064 client). This does not yet enable scoped native
  binding or different-id launches; other native families remain pending.
- Phase 3 OpenCode binding/read/watch migration is independently accepted.
  Canonical DB/JSON data-directory sources, nested-project/physical-alias proof,
  public catalogue/working-project projection, constrained CLI fallback and
  focused DB/WAL refresh share existing owners. Review caught two source-joining
  defects: summary index keys now distinguish native roots, and asynchronous
  catalogue proof preserves valid original project spellings. Compact shared-DB
  metadata bypasses main-file timestamp certification through the existing
  in-flight index owner, so WAL-only updates remain fresh. Cancellation fences
  filesystem proof before SQL teardown. The initial full run exposed an Inbox
  regression from guessing a root for an unqualified reader; its exact focused
  reproduction now passes and OpenCode adoption requires reader-provided proof.
  Corrected focused checks: 180 passed across 13 files in 4.41 s. Owned Node
  26.7.0 and pinned Bun 1.3.14 actual HTTP/WebSocket/WAL/100-refresh/restart
  probes pass. Final lint, format, typecheck and workspace tests pass (6,761
  server / 7,064 client). No split-id launch or new capability is enabled;
  other native-family/cold-resume/released-client work remains phase 3.
- Phase 3 Pi source migration is independently accepted: canonical native
  catalogue scope, public adoption, root-scoped indexed metadata and focused
  refresh use existing owners. Selected-file fingerprints prevent discovery's
  five-second TTL or a fixed mtime from hiding appends. Qualified missing proof
  cannot emit a guessed public native id. Review caught pending publication
  after reader retirement; public await boundaries now discard partial lists
  and late point results. Seven deterministic scheduling regressions delegate
  real parsing/acquisition. Focused checks: 40 passed / seven files in 2.56 s.
  Actual Node 26.7.0 and pinned Bun 1.3.14 standalone HTTP/WebSocket/fixed-mtime
  append/restart and direct retirement-race probes pass. Final lint, format,
  typecheck and full workspace tests pass (6,770 server / 7,064 client).
  New-session launches remain unchanged until later admission/provider slices;
  Grok/frozen-Gemini sources, scoped cold resume and released clients remain
  phase-3 enabling work.
- Phase 3 Grok native-source migration is independently accepted.
  Canonical root/summary-handle evidence, original-project bound readers,
  indexed metadata and focused companion observation retain public identity.
  Late replay-file creation, proven child cache misses and media below the
  actual native directory work across an empty working-project move. Initial
  app fixtures exposed child and media 404s; both reproductions now pass.
  Pending real reads and partial lists are discarded on retirement. Sol found
  canonical-id substitution through a directory-name fallback; all acquisition
  now requires the canonical handle. Cold/warm replacement and post-invalidation
  regressions preserve the positive different-directory case. Focused checks:
  53 passed across five files in 2.58 s. Actual Node 26.7.0 and pinned Bun
  1.3.14 HTTP/WebSocket/late-replay/restart and canonical-collision probes pass.
  Final warning-free lint, format, typecheck and workspace tests pass (6,778
  server / 7,064 client; 127.44 s server run). Launch behavior/capabilities are
  unchanged; frozen Gemini, cold resume and released clients remain phase 3.
- Phase 3 frozen Gemini native-source migration is independently accepted.
  Root/header-id/project-hash proof applies across bound history, summaries,
  indexed catalogue enumeration and focused observation. Original raw/physical
  project aliases are scoped without consulting another store's project map.
  Existing unknown-project hash coordinates retain historical grouping. Warm
  id/hash replacement cannot substitute a source; retirement discards pending
  results. The real app/SQLite fixture qualifies two roots, unequal ids,
  physical aliases, working-project moves, indexed metadata, old row-format
  recovery, adoption and profile reopen. A real enumeration/header-replacement
  probe exposed scope-less native catalogue publication; qualified missing proof
  now omits the candidate. Sol caught an index-dispatch prefix regression.
  Corrected scope keys preserve `gemini::`; index-requested root enumeration
  also bypasses point-discovery TTL so create events refresh immediately. The
  real reader/index/EventBus regression proves edit and create before a 60 s
  validation interval, with both initial failures retained. Corrected focused
  checks: 83 passed across six files in 3.16 s. Actual Node 26.7.0 and pinned
  Bun 1.3.14 owned HTTP/WebSocket/rewrite/restart, catalogue-race and warm-index
  probes pass. Final warning-free lint, format, typecheck and full workspace
  tests pass (6,791 server / 7,064 client; 132.44 s server run). Frozen protocol,
  schema and launch mapping are unchanged; the ACP failed-resume gap remains a
  later enabling boundary. Cold resume/helpers and released clients remain
  phase 3; durable admission is still pending.
- Phase 3 fork-backed helper sources are independently accepted. Retitle,
  handoff summary and forked recap resolve the public generator once through
  the existing native source boundary; provider inputs are native-branded and
  application metadata/results remain public. Acquisition cancellation cannot
  dispatch a helper. Codex validates the selected home, supplies the exact
  rollout path and refuses another returned thread before turn start. Claude
  retains its configured account home and proves its native selector or
  conventional physical-cwd directory. Two Sol findings exposed an unsafe cwd
  fallback and relative-home resolution across a symlink; corrected native
  fixtures prove refusal before model calls and transcript mutation, plus
  successful valid aliases, ordinary directories longer than 64 characters,
  and the physically correct relative home. The initial failures are retained.
  Corrected six-file checks pass 293 cases with two retained skips in 24.40 s;
  the final physical-cwd correction passes four boundary checks in 2.41 s.
  Owned Node 26.7.0 and pinned Bun 1.3.14 execute the actual pinned Claude SDK
  and CLI against a local fake model, including over-200-character native keys;
  Bun also qualifies relative-home refusal and correct context. These use no
  operator credentials or upstream model calls. App/SQLite reopen/collision/
  cancellation and actual Codex subprocess path/home/mismatch checks pass.
  Final lint, format, typecheck and full workspace tests pass (6,797 server /
  7,064 client; 129.82 s server run). General Claude alias-history migration,
  cold resume/prompt-cache touches, durable helper admission/provenance and
  released-client qualification remain outside this cut.
- Phases 4–9: pending; no global creation capability is advertised.

The reviewer ran through localhost:3400 with effective `gpt-6.1-sol`, High
effort and bypass permissions verified in session metadata. Initial/revised
reports and launch evidence are under ignored `tasks/session-identity/`.

## Outcome and scope

A new YA-created session has a permanent public id and saved request before
provider startup. A missing executable, failed startup or server restart leaves
an inspectable session with the last established startup boundary. Native ids
are provider addresses associated with that session, not replacement public
ids. A receipt identifies submission evidence; startup attempts identify
execution attempts. Neither replaces the logical session.

Owning contracts and prior work:

- [Session identity](../../topics/session-identity.md): selected behavior,
  existing-id preservation, native binding and November 1 compatibility audit.
- [Creation/navigation](../../topics/session-creation.sketches.md): durable
  acceptance, attachment ownership, draft safety and later background creation.
- [Plan 150](150-ya-owned-session-ids.md#november-1-selected-follow-up): SQLite
  and caller-chosen Claude ids already shipped; the selected new-session
  follow-up does not resume its entire fork/clone program.
- [Remap](../../topics/session-id-remap.md),
  [liveness](../../topics/session-liveness.md),
  [HTTP v0 receipts](../../topics/http-api-v0.md#creation-and-retry-receipts),
  [storage](../../topics/optional-sqlite.md#database-ownership-and-migration)
  and [provider-host ownership](../../topics/provider-host-api.md).
- Existing gaps: [draft acknowledgement can delete newer text](../../gaps/new-session-draft-clear-captures-after-submission.md)
  and [unconfirmed sends](../../gaps/unconfirmed-send-loss-across-reload.md).
  The [creation-source audit](../../gaps/session-creation-source-missing-launch-paths.md)
  and [admission recommendation](../../topics/session-creation-provenance.sketches.md)
  supply source-specific invariants and producer coverage; their owning current
  contract is [creation provenance](../../topics/session-creation-provenance.md). Preserve
  distinct closure conditions: this plan does not automatically close general
  existing-session send loss or the full fork/clone source gap.
- [Architecture comparison](../competitive/t3code-provider-architecture.md)
  and [core house cleaning](../../topics/core-house-cleaning.md): preserve the
  existing runtime owner and queues. Live-recipient admission and queued
  compaction are related consumers, not prerequisites for this plan.

The first milestone is durable identity/startup ownership and safe creation.
Optional Create in background / Command-Enter follows that milestone under the
creation proposal. Do not add it during infrastructure slices. No new scheduler,
conversation store, framework, provider refresh, cross-provider continuation,
remote placement, bulk id replacement or full fork/clone redesign is selected.

## Implementation rules that keep translation small

- Use branded `YaSessionId` and `NativeSessionId`, following the existing
  [project-id convention](../../packages/shared/src/projectId.ts). A native
  reference includes provider and storage/account scope, not just a string.
  `sessionId` means YA id; provider-facing names say `nativeSessionId` or use
  the explicit native reference. Existing `ses_*` and other public ids remain
  valid YA ids; branding is not UUID-only validation.
- One store/service owns forward lookup, reverse lookup and native binding.
  Build on the current metadata/identity ownership rather than retain a
  competing resolver. A request resolves an operation-scoped session reference
  once and passes the native reference to provider readers/control code.
  Avoid a mutable global mapping cache, database access per streamed token,
  scattered SQL, format guessing and repeated translation deep in helpers.
- Unbound is a first-class state, not permission to pass the YA id as a native
  fallback. For Claude the two strings may be equal, but conversion is explicit.
  Legacy adoption is an explicit discovery/import boundary with native evidence,
  not a catch-all fallback after a failed YA lookup.
- Bind only to the current startup attempt; use transactional conflict checks
  and idempotent same-binding replay. A delayed callback from an older attempt
  cannot bind or update the current attempt. Choose the provider/storage scope
  before creating the unique index. Preserve routing/account/sandbox facts.
- Once a native session is established, ordinary runtime replacement resumes
  that binding. A new startup attempt is not permission to allocate a different
  native conversation or overwrite its history. Retry without a known binding
  must distinguish definitive pre-launch failure from uncertain creation; any
  deliberate native-conversation replacement needs a separate explicit policy.
- Keep public ids in routes, queues, metadata, grants and client events; keep
  native ids at provider I/O boundaries. Authorize the YA resource under the
  existing [principal/grant vocabulary](../../topics/principals-and-grants.md)
  before resolving native access. The mapping grants no additional authority.
- Native transcripts remain authoritative history. Saved request/attempt state
  is authoritative YA control state, not evidence of provider consumption.

## 1 — settle the contract and standalone qualification fixture

Before changing the runtime, record a concrete design in the owning topics:
session/binding/attempt schema and ownership, provider/storage uniqueness,
request-key scope, payload/receipt atomicity, safe errors, retention/deletion,
byte/entry limits, capacity refusal and crash recovery. Select exact new
creation/status routes or negotiated mode, startup fields and absence fallback.
Define attempt progression and which boundaries permit explicit retry; never
automatically replay ambiguous launch/input effects. Include staged attachments
and committed router pins in the saved intent without copying secrets.

Refresh the [release audit](../../topics/session-identity.md#compatibility-research--2026-11-01)
if another stable release ships. Present the concrete capability/fallback plan
under [server capabilities](../../topics/server-capabilities.md#minimum-compatibility-horizons)
before runtime contract edits. Existing direction approval covers permanent YA
identity; it does not silently approve a new cutoff, unavailable provider or
changed legacy endpoint meaning.

Select the reusable isolated server/protocol fixtures below and capture a
small baseline: current normal creation, response-loss behavior and differing
native-id refresh. Prefer exercising existing harnesses before adding tooling.
Any harness addition must be needed by later behavioral checks, not another
general test framework.

Completion: the implementation decisions and provider rollout boundaries are
explicit, the fixture owns startup/restart/cleanup, and the design reviewer has
no unresolved material objections. Commit the reviewed plan/contracts before
source implementation. Documentation-only checks suffice for a docs-only cut.

### Intermediate identity and admission boundaries

These boundaries constrain the following slices; exact persisted fields and
limits must be closed at this entry gate before schema/API implementation.

| Phase | Intermediate API and invariant |
| --- | --- |
| Binding owner, section 2 | `resolveYa(YaSessionId)` returns the public id, launch provider, authorization/project facts and either an explicit native reference or unbound state. `lookupNative(NativeSessionRef)` resolves native discovery. `adoptDiscovered` requires verified native facts and preserves the existing public id. The first migrated real operation is existing-session detail/history resolution through `session-existing-identity` and its reader adapter. It exposes no new launch behavior. |
| Reader adapter, sections 2–3 | Native readers/catalogs use explicit native references/facts. Physical index/cache keys keep native addresses; a projection adapter maps returned public entities to YA ids. Existing unmigrated callers retain explicitly named native-entry adapters until migrated; no unchecked YA/native casts, namespace guessing or equal-id fallback. Section 3 finishes retained consumers before differing-id launch. |
| Attempts, section 4 | Add the persisted current-attempt token and attempt-aware `bindNative`; stale-attempt qualification belongs here, not section 2. Fence binding, status/failure, input admission and cleanup/cancellation, not only the SQL bind. A resolved reference is operation-scoped and must not authorize an effect after its attempt/owner generation becomes stale. |
| Durable admission, section 4 | `admitSession` commits immutable text/settings/context, public session id, initial attempt and idempotent operation/receipt identity through one synchronous transaction on the owning profile connection. Provider I/O follows commit. It includes the minimal common transaction API before any durable-acceptance claim; section 7 expands callers and attachments, not the atomicity foundation. |
| Publication | Extend existing metadata/receipt stores with transaction-owned internal write operations rather than nest their current save/reserve transactions. Stage metadata cache changes; update in-memory mirrors and publish events only after commit. Rollback publishes nothing and preserves the prior mirrors. Private runtime/controller callers reach the same admission owner rather than write a second independent journal. |

Distinguish `launchProvider` from native storage family. A native binding key is
the audited native namespace/storage family, canonical storage-scope key and
native id. `codex`/`codex-oss` and Claude variants may share a family while
retaining different launch settings and credentials; they share a binding
namespace only when they actually address the same store. Gemini CLI/ACP must
not be collapsed merely because names are similar. Select the actual scope
normalization per provider before the unique index. Ambiguous discovery or two
existing public ids claiming one native resource produces a conflict for
inspection, not a silent merge, reassignment or third public session.

Normalized `CreationContext` is required on migrated admission entry points:
authenticated ownership/grants and descriptive provenance are separate fields.
Do not add an optional context with a default that silently preserves omissions.
Keep an explicit per-slice ledger of migrated callers and retained low-level
bypasses; callbacks are outcome notifications, not the durable request owner.

### Creation-source admission and coverage

Carry the [provenance recommendation](../../topics/session-creation-provenance.sketches.md)
through the same owner/transaction, not a parallel source service. Every fresh
admission requires a validated source decision. The internal shape distinguishes
normalized request provenance from an explicit internal creation reason drawn
from a bounded set, such as an archived summary generator. These are internal
design categories, not new public `surface` values. Internal helpers can remain
unmarked in today's public field. Keep authenticated principal/creator facts,
grants, receipts and lineage separate from descriptive client hints.

Normalize request source once at ingress using existing body/header bounds and
fallback rules; local agent and incoming peer APIs deliberately choose `api`
while preserving trusted caller identity separately. Do not persist request
objects, credentials or transport handles. Require context at runtime for
untyped callers and persisted input as well as in TypeScript. No no-context
overload, arbitrary internal reason, default `unknown` or default dispatcher
source is allowed on migrated fresh admission. Missing context fails before
provider effects.

The original source is immutable for the logical session: native binding,
startup success/failure, explicit retry, resume and later messages preserve it.
A child fork/summary target describes its own creating request, not its parent's
surface or its internal generator. Existing-session follow-ups do not relabel
the destination. Persist source with session/intent before effects; an
`onStarted` wrapper calling the old writer is not completion of this invariant.

Project Queue retains normalized context at original enqueue, before promotion
allocates the session. Edits, attachment materialization, worker deferral,
restart and explicit Start/Force start keep that source. `createdFrom.client`
is navigation context, not a source classification. Legacy/import/discovery is
an explicit boundary: existing sessions and old queue records without evidence
remain unknown. Do not infer UI/API source from provider `originator`, a native
id, parentage or the client that later starts old work. This legacy path must
not become a convenience default for new admissions.

Use the following ledger in sections 4, 7 and 9. Direct text project/detached
creation first migrates in section 4; all other bypasses remain named until
their specific cut satisfies the invariant and evidence.

| Audited path | Required integration and acceptance evidence |
| --- | --- |
| Project Queue new-session targets | Capture UI/API context from both New Session and the session composer at enqueue, persist it with the durable item, and pass it through normal/forced promotion, worker deferral and staged attachments. Restart and a later Start/Force start must not change the original source. |
| Source Control new review sessions | Carry the original review request through both submission-aware and legacy review launch entry points; persist source at logical admission, including worker-deferred creation. Existing-session review follow-ups retain their existing source. |
| Fork after summary, final navigable target | Preserve the user's request context across the background job; the target gets that source and the archived generator explicitly chooses an internal reason. Prove cross-surface parent/child behavior and failure retention; do not copy the parent's source. |
| Native v0 and incoming peer creation | Persist public API provenance beside, but independently of, existing trusted creator/peer receipts and ownership. Verify immediate and worker-deferred creation, restart and the same list/detail projections. |
| Maintenance diagnostic create | Require an explicit API source decision through its existing authorized maintenance path; do not leave this direct Supervisor caller outside the fresh-admission inventory. |
| Restart fork followed by failed continuation | Persist recoverable original-request source before native fork effects, then attach it to any retained child before continuation can fail. Cover queue refusal, queued cancellation and resume exceptions, not only successful restart. |

Source integration for retained fork/helper targets is a bounded section 7
cut; it does not authorize a full child-id redesign. Section 1 must settle how
pre-effect source ownership composes with those retained native fork boundaries.
If that guarantee cannot be delivered without reopening deferred child identity,
record the precise remaining path and required scope decision. Do not substitute
a successful-resume writer or declare the whole provenance gap fixed.

Verify through application/public entry points, real SQLite and collection
projections, using controlled provider protocols and owned profiles. Include
missing-context rejection with zero provider effects, storage refusal before
launch, explicit internal decisions, legacy unknown records, cross-surface
forks and existing-session resume. Assert source on transcript-less saved/failed
sessions and after reload/binding/restart, and assert the fields consumed by
Inbox/Global Sessions filters. No model call or browser is needed solely to
prove source persistence; avoid mocked writer tests per caller.

Internal context/storage tightening alone does not require a new UI capability.
Any changed request/queue/status contract still follows the capability/skew gate,
including persisted old queue schemas and absent fields. Do not broaden
`session-creation-provenance` or claim complete coverage for a partial migration.
Remove independent source-writing duties only for callers that have actually
migrated. Keep the [audit gap](../../gaps/session-creation-source-missing-launch-paths.md)
open until its listed paths and retention/failure cases are verified, narrowing
any remainder explicitly. The current provenance topic must describe the actual
implemented scope; completing ordinary creation alone does not close this gap.

Project Queue allocates the YA session at first promotion, not enqueue. Persist
the original enqueue context in the queue item. Use a stable promotion operation
key derived from its durable item identity so a crash before `onStarted` resolves
the same admission/session. Its JSON state and SQLite do not pretend to form one
transaction: post-commit queue publication may be recovered by that key. Once
admitted, edits cannot silently replace the frozen request; define an explicit
new/superseding operation instead. Supervisor worker deferral likewise carries
the persisted admission/attempt reference, not only a callback.

### Startup and retry boundary table

| Last established boundary | Permitted recovery |
| --- | --- |
| Definitive failure before native effects | Authorized explicit recovery may create a new attempt in the same YA session, rechecking admission and preserving committed account/settings. |
| Launch attempted, native allocation unknown | Reconcile existing provider/host evidence. Remain uncertain if no unique result is provable; no new native start. Orphan discovery uses the scoped reverse lookup/evidence, not content/title guesses. |
| Native binding established; initial input definitely not admitted | Attach/resume that binding. Only explicit creation recovery may authorize the retained initial input after definitive non-admission evidence; do not allocate another native conversation. |
| Binding established; initial input outcome uncertain | Reconcile the same binding/input identity and show uncertainty; no automatic resend or new conversation. |
| Initial input consumed | Never replay it as a creation retry. Ordinary later user turns and normal runtime resume use their existing admission semantics. |

Ordinary send/resume/reactivate and automatic queue paths refuse unbound or
uncertain startup advancement; only the authorized creation-recovery operation
can cross that boundary. A caller on an older client does not bypass it. Extend
`auth/sessionAccess.ts` to authorize transcript-less sessions from persisted YA
project/creator facts, preserving limited-user reads and peer receipt scope
without adding launch authority.

Router credential cancellation remains terminal. Same-session recovery targets
a new attempt-scoped reservation/token pinned to the original committed account;
it must not revive a cancelled credential, reselect an account or use direct
login. Settle the representation with the existing router owner before section
4: today's cancelled allocation keyed to a session refuses reuse. If the router
cannot safely issue that pinned replacement, refuse recovery and retain the
session/error rather than fabricate success. Late old-attempt cleanup cannot
cancel a newer attempt's reservation. The exact policy/API is an entry-gate
decision, not an assumption that current cancellation already supports retry.

### Provider-host enabling boundary

Sections 4–5 must carry YA id, native reference and attempt/owner generation
through host claims/targets, worker launch/init/bound messages, attached-state
snapshots and child environment publication. In particular the current
`provider-runtime-host.ts` resume-id claim, single-id `ProviderSessionOwner`
bound message and host equal-id assignments must change together. Public child
identity remains YA; provider-native resume remains native.

Reuse host receipts/observation to retain native-binding/input evidence while
Hono is detached, then reconcile it into the YA attempt on reattach. Prove that
launch/binding/input during detachment cannot cause a second native start after
reattach. Full owner loss remains a separate uncertain-outcome test. Define an
explicit private host/worker support negotiation or controlled upgrade boundary
before enabling split ids: preserve old workers, and refuse unsupported new
transitions with update guidance rather than restart them or claim that Hono
reload upgraded their code. This enabling qualification cannot wait for section
9. Plan 150's historical late-rename exclusion does not override this continuity
requirement.

## 2 — add typed identity and one native-binding owner

Add the minimal append-only schema and store needed for permanent YA identity
and scoped native bindings. Preserve existing `session_metadata` and its public
keys. Adopt existing sessions with their existing public ids at a bounded
discovery/import boundary; do not scan all transcripts in migration startup.
Integrate the owner into the section 1 detail/history lookup while retaining current launch
behavior. New differing-id launches remain disabled until their read/watch
paths are ready; advertise no new creation capability yet.

Move affected signatures to the branded types. Update
`routes/session-existing-identity.ts` and provider resolution at their ownership
boundary instead of layering another infer-and-fallback service beside them.
Avoid a repository-wide type-only sweep unrelated to a migrated operation.

Completion evidence: real SQLite migration/rollback preservation, equal and
unequal strings, scoped reverse lookup, duplicate/conflicting adoption and
idempotent repeats. Include legacy `ses_*` ids. Attempt fencing is introduced
and qualified in section 4, after its schema exists.
Use a native reference whose id differs from its YA id in retained fixtures.
Review, fix/re-review, check and commit this coherent slice.

## 3 — translate history, discovery and watch boundaries

Route history/detail/list, native discovery, export and focused watches through
the shared binding owner. Preserve working-project versus transcript-project
identity. Return canonical YA ids to callers and prevent a native scanner from
creating a second public row for an already bound transcript. Preserve physical
file paths as file facts; do not fabricate a YA-named path for an old client.

Qualify the existing focused-watch compatibility bridge from the audit. Cover
both owned-session pending/durable confirmation and non-owned transcript updates.
Audit other references: child/parent links, attachment ownership, drafts,
recents, shares, grants, queue targets and API/peer receipts. Keep existing public
ids; do not eagerly rewrite all ancillary stores merely to change an id format.

Translate every retained native source consumer before differing-id parents
can be created: fork/clone source reads (including direct copies), restart,
retitle/summary/helper reads, rewind/compaction, recovered launch settings,
provider-child discovery, issue/history readers in `app.ts`, external-session
tracking, process-inventory ownership joins and access-filtered events. Those
operations receive the native source reference; metadata, lineage, authorization
and returned events keep the YA source id. Child allocation/remap redesign can
remain deferred. A split-id parent must still fork/clone through retained paths
and its child must resume correctly.

Completion evidence: a session with differing ids loads the correct provider
history, updates after native append, survives refresh/restart and appears once
in collections. Existing urls still resolve. Test actual provider-reader shapes,
including Codex and OpenCode, using controlled native data/protocol fixtures.
Run the old-client focused-watch case before enabling differing-id launches.
Review, fix/re-review, check and commit.

## 4 — persist startup intent and make failed Claude startup durable

Add the durable saved request and startup-attempt lifecycle to the common new
session admission boundary. For migrated text-only callers, persist identity,
launch settings, initial prompt and ownership/provenance before provider effects.
Write boundaries
and safe terminal failures independently of a live subscription. Preserve the
existing runtime/worker queue rather than introduce another process owner.

Use caller-chosen-id Claude as the first vertical provider path. Correct wrapped
fatal startup handling and dead-owner input rejection. Make YA-only saved/failed
sessions readable through authorized catalog/detail projections without a
provider transcript. Legacy endpoints keep their established completed/queued
response semantics; do not return a pending session in place of a process.
This text-first slice includes section 1's session/intent/operation transaction,
post-commit publication, required creation context, retry/router rules and
hosted enabling boundary. Migrate ordinary text project/detached callers here;
source must be present even on a saved/failed row before any provider callback.
List the remaining Project Queue/review/v0/peer bypasses until section 7.
Attachments explicitly retain legacy two-step behavior until durable claims
land there; section 4 makes no attachment-acceptance guarantee. Do not advertise
the complete new web contract prematurely.

Completion evidence: missing executable before subscription; refresh after
failure; restart before dispatch, during startup and after native binding;
durable prompt/settings; no false active turn or dead queue admission; known
failure versus uncertain outcome; transcript-less limited-user access; fencing
of all late-attempt actions. Include equal-id Claude behavior, cancelled-token
same-account recovery and hosted launch/reattach using controlled faults. No
additional automatic retry policy.
Review, fix/re-review, check and commit.

## 5 — enable permanent YA ids for Codex launches

Mint/store the YA session before `thread/start`, bind the returned native thread
id to the current attempt, and keep provider init/events from renaming it.
Resolve native references for resume, transcript reads, control and host targets.
Handle unsolicited native discovery through the same reverse lookup.

Completion evidence: actual differing ids through start, first turn, watch,
full server restart/resume, native-history discovery and API reads; one public
session, correct account, no public remap. Inject delayed/stale callbacks and
crashes around binding and first-input admission. Exercise hosted and in-process
ownership. Keep provider protocol/target versions unchanged; this is not a Codex
refresh. Review, fix/re-review, check and commit.

## 6 — migrate the other retained provider identity shapes

Use bounded provider-specific commits/reviews: OpenCode first (native `ses_*`
and reader-prefix assumptions), then the retained Pi/ACP/Grok and Claude variant
paths as applicable to the actual enabled provider inventory. Do not claim all
providers are migrated because two adapters pass. Frozen Gemini is not a refresh
project: preserve its supported behavior and historical readability; surface any
blocking migration cost under the existing retention decision.

Before each provider commit, name the ingress/egress translations it replaces
and the launch/read/resume/watch evidence. If a provider cannot participate,
record that concrete limitation and obtain a rollout decision rather than
silently falling back or advertising a complete global contract. Keep incomplete
paths explicit during development; qualify the whole selected provider set
before the global capability ships. Fork/clone paths not migrated here retain
their documented explicit remap behavior.

Completion: every retained new-session provider path in the selected contract
keeps its YA id through launch and recovery. Exercise the real adapter shape
with controlled transcripts/protocols, plus bounded live smoke qualification for
available providers. Each provider cut is reviewed, checked and committed.

### Retained-provider rollout matrix

Each row is an enabling gate, not a claim of passing qualification. Fill the
per-slice ledger with native scope, reader/source consumers, discovery joins,
resume/control, owned-input confirmation, old-client observation and host
evidence before enabling that row. Do not assume the focused-watch manager's
current Claude/Codex/Gemini support covers the other rows.

| Launch provider | Native/storage shape to audit | Reader/discovery/resume and old-client watch gate |
| --- | --- | --- |
| `claude` | SDK caller-chosen id, Claude transcript family | Equal strings still cross typed boundaries; hosted/in-process launch and input evidence, normal/child transcript watches. |
| `claude-gateway` | Claude SDK/transcript family with gateway launch facts | Preserve configured gateway/credentials and source reads; verify actual chosen-id behavior and host projection rather than assume it. |
| `claude-ollama` | Claude SDK/transcript family with Ollama launch facts | Preserve retained provider/configuration; qualify native scope and the same read/resume/watch boundaries. |
| `codex` | App-server thread id, rollout reader | Differing-id launch, native source fork/clone, rollout discovery, owned-input confirmation and focused watch; host claims/bound/reattach. |
| `codex-oss` | Codex runtime/storage family with distinct launch choice | Qualify alongside Codex or in its own reviewed cut; preserve launch variant even when native discovery reports the family. |
| `opencode` | Native `ses_*`; JSON, SQLite DB and export-backed history | Prefix-independent reader selection, native resume/control and reverse lookup; qualify/extend focused observation for each available source, including no single transcript path. Current normalization to Claude is insufficient. |
| `pi` | Retained RPC/native transcript shape | Native read/resume/control/discovery and process ownership joins; qualify a focused/bounded observation path for old clients before split-id launch. No current focused Pi target is assumed. |
| `grok` | Retained ACP/native transcript shape | Native read/resume/control/discovery and ownership joins; qualify bounded old-client observation. No current focused Grok target is assumed. |
| `gemini` | Frozen CLI/native history path | Preserve current protocol and historical reads; audit namespace separately from ACP and qualify broad/focused observation or obtain an explicit limitation decision before enabling. |
| `gemini-acp` | Frozen ACP/native history path | Preserve current mapping without refresh; qualify source/resume/control, storage scope and observation independently of CLI assumptions. |

Preserve the existing hosting/platform availability for every row. Extend the
current focused observer only where required by a real retained shape; do not
invent a general watcher framework. An unsupported old-client watch shape is
a rollout blocker for that row, not something a new global capability repairs.

## 7 — unify accepted creation, retries and attachments across callers

Expose the reviewed durable acceptance/status contract and reuse receipt
identity/admission machinery without widening agent API authority or changing
its existing state meanings. Commit the saved payload and operation identity
together before acknowledgement. Retrieve an authorized existing request before
mutable admission checks; conflicting request reuse fails, response loss returns
the original session, and ambiguous effects are not replayed.

Bring staged attachment validation/retention/materialization and the first
message through this boundary; upload failure must not leave an unintended
empty running provider. Preserve explicit storage policies and ownership.
Seal validated immutable staged objects in owned app-data before admission;
commit their durable claims with the session/operation. Draft TTL cleanup must
consult these claims and cannot expire an accepted object's source. A crash
between sealing and commit leaves only an unclaimed object for bounded cleanup.
Materialization uses recoverable intent/completion and atomic filesystem steps,
not in-memory move rollback; restart reconciles it without blindly sending.
Choose bounds, capacity accounting, deletion/release and orphan cleanup at the
entry gate. SQLite and filesystem steps are an explicit recovery protocol,
not a claimed cross-store transaction.

Audit ordinary project/detached creation, durable Project Queue promotion,
native v0/peer creation and review-session launches against the common owner.
Carry original provenance and permissions across deferred dispatch; do not infer
source from the dispatcher or copy a parent's descriptive source. Treat unrelated
full fork/clone identity redesign as deferred, but use section 1's provenance
ledger for targeted fork-summary, retained restart-fork and internal-helper
source decisions. Keep any uncovered remainder in the provenance gap. Split
callers or attachments into separate reviewed commits when necessary rather
than create one large ingestion rewrite.

Completion evidence: lost response/reload, concurrent duplicate keys, changed
payload, disabled provider after acceptance, full capacity, interrupted staging,
foreign attachment refusal, crash at side-effect boundaries and pinned settings.
Reads/replays remain possible at capacity. Qualify legacy/v0 response semantics
and existing queue behavior. Satisfy the source ledger for each migrated caller;
partial coverage cannot close the full provenance gap. Review, fix/re-review,
check and commit each cut.

## 8 — present saved and failed sessions with safe draft acknowledgement

Add startup/recovery presentation at the normal permanent session URL, including
saved prompt/copy/restore and safe expandable failure details. Distinguish saved,
starting, failure and uncertainty from provider liveness and consumed input.
Use additive fields with explicit absence handling; do not insert new startup
values into old process-state enums. Keep existing-session input ownership intact.

Capture submitted draft text, slot, source and attachment selection at ingress.
Only clear that submission after durable acceptance. Preserve newer local,
sibling-tab and remote edits; late responses cannot navigate another source or
newer work. Reuse a small submission-lifecycle helper rather than decompose the
whole form. Keep the editor's acknowledgement independent of status rendering.

Allocate/advertise `session-creation-receipts` from the live ledger only when
the complete reviewed contract/provider coverage is ready. Before absent/denied/
unknown support, send no new writes/status requests and use legacy creation.
Keep provenance, agent-management and collection capability meanings unchanged.

Completion evidence: delayed acceptance with intervening edits, failed/reloaded
submission recovery, no late navigation, IME-safe existing submission, and real
sequential typing under expected data/concurrent startup updates within 100 ms.
Desktop/phone startup/failure/recovery captures use the artifact facility and
are inspected individually. Review, fix/re-review, check and commit. Optional
background creation is the next feature slice, not implicit completion here.

## 9 — qualify upgrade, skew, restart and retained legacy paths

Run the refreshed release/client matrix, preservation fixtures and bounded live
provider matrix. Include old client/new server, new client/old server and both
current, direct and encrypted relay where the contract crosses them; verify
existing-session links and defaults after upgrade. Test Node/Bun storage and
macOS/Linux/Windows paths or state unavailable qualification honestly.

Exercise Hono replacement with hosted workers and full owner loss separately.
Old workers retain loaded provider code: qualify reattachment or enforce the
reviewed controlled upgrade boundary; never restart localhost:3400 or its
workers as a test action. Remove only remap branches with no remaining native
consumer; retain client compatibility handlers through the required horizon and
record fixed fallback retirement under the 90-day rule. Do not equate partial
new-session migration with removal of all fork/clone remaps.

Completion: all intentional behavior has owning contracts, evidence names the
qualified provider/runtime/platform matrix, reviewer objections are resolved,
required gates pass and remaining defects have precise tracked remainders.
Review and commit final qualification/docs/removal cuts separately as needed.

## Standalone YA test profile

Use an owned standalone process on a dynamic loopback port, not the existing
3400 instance. Reuse
[`startYaServerProcess` / `restartYaServerProcess` / `disposeYaServerProcess`](../../packages/client/e2e/support/ya-server-process.ts)
and the [owned provider-host cleanup](../../packages/client/e2e/support/provider-host-runtime.ts)
when suitable. Prefer a small command-driven integration/probe runner over UI
automation for API, database and crash boundaries.

The fixture owns a temporary project, data directory, provider transcript roots,
child HOME/USERPROFILE, provider configuration homes, short runtime/socket paths,
port files and process identities. `YEP_PROFILE` alone is insufficient because
providers and host sockets otherwise remain shared. Clear inherited provider-host
credentials/descriptors and unrelated agent launch authority through the existing
hermetic environment helpers. Do not copy a production YA database, scan normal
user transcripts, modify ordinary provider credentials or share the live host.

The process helper's inherited environment is not hermetic by itself. Compose
the child environment explicitly: apply the configuration scrub inventory from
`test/setup/config-env-vars.ts` without importing Vitest lifecycle setup, then
set all owned paths/gates. Override `CLAUDE_CONFIG_DIR`, `CLAUDE_SESSIONS_DIR`,
`CLAUDE_PROJECTS_DIR`, `CODEX_HOME`, `CODEX_SESSIONS_DIR`, both Gemini/Pi/Grok
session roots and `GROK_HOME`; isolate HOME/USERPROFILE, XDG config/data/cache/
runtime roots and TMPDIR/TMP/TEMP. Audit provider-specific roots not read by
server config. Clear inherited host/worker sockets, tokens, descriptors and
unrelated `AGENT_*` launch authority; set the owned host runtime and hosting
mode explicitly. Preserve only explicitly selected test inputs/credentials.

Add a poisoned-parent-environment check proving the selected native roots,
OpenCode DB/JSON paths, detached-project temp root and host targets remain inside
the fixture. Reuse the existing safe-home rules with a temporary root outside
the checkout and
[`provider-host-system.test.mjs`](../../packages/server/test/scripts/provider-host-system.test.mjs)
for detached-owner scenarios. Any needed scrub extension is bounded to the
actual leak; do not introduce a second fixture framework.

Deterministic tests use controlled native protocols/transcripts through real
adapters. For live smoke checks, use an explicit isolated provider credential
setup that preserves operator account choice; no bulk home copy or credential
logging. Missing live authentication is recorded, not worked around by direct
account fallback. Run provider hosting disabled and explicitly enabled in
separate owned fixtures, preserving the platform default/availability rules.

Restart the same owned profile to test durability; use a new profile for an
independent scenario. Await process-tree/host cleanup before removing files and
report leaked ownership as failure. Use Playwright's separate test browser,
never the user's installed browser with a temporary profile. UI captures follow
[UI testing](../../topics/ui-testing.md), including presentation when configured.

## Sol review and commit loop

The requested reviewer is an actual YA session created through the running
`http://localhost:3400` ordinary API, with provider `codex`, model
`gpt-6.1-sol`, `thinking: "on:high"`, `mode: "bypassPermissions"`, recaps and
prompt suggestions off. Model presence/high-effort support was read from that
instance's `/api/providers` on November 1. Recheck availability at launch; do
not substitute another model or reasoning level silently.

Use a fresh reviewer session after every implementation slice and for the
initial design. Supply the exact plan section, base commit, changed paths/diff,
contracts, test evidence and known limits. Ask for a concrete accept/revise
verdict, regressions and scope/compatibility concerns. Reviewer instructions are
read-only except a named report under ignored `tasks/session-identity/reviews/`:
no source edits, commits, pushes, nested reviewers, provider probes or server
restarts. Bypass is the requested provider permission mode, not permission to
expand the review task. Do not let the reviewer run the full suites concurrently.

Record the returned session/process ids immediately. Verify effective model,
reasoning effort and permission mode from session metadata/provider evidence,
not just the requested body. If launch acknowledgement is lost, inspect existing
sessions before another POST; today's ordinary API has no new idempotency promise.
For the active milestone, wait for one terminal review, fix material findings
and verify corrections with focused checks; do not launch another review cycle. Report a missing/unavailable reviewer rather than self-certify its gate.
Retire only this work's reviewer when idle; never affect unrelated sessions.

For each source slice: run focused checks, review, reconcile corrections, then
pass `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` and applicable
browser/CSS/console checks. Typecheck and tests run sequentially because they
share generated output; see [the existing race](../../gaps/parallel-typecheck-test-shared-build.md).
Avoid repeated passing full runs unless changes or unresolved evidence justify
them. Retain meaningful race/persistence/adapter tests, not shallow wiring tests;
record runtime/cost under [the testing guide](../development/testing.md).

Commit coherent accepted slices on the current branch with explicit paths;
preserve concurrent edits. Use `Topic: ya-owned-session-ids` (already in
`topics.md`) and one `Contributing-model:` trailer per contributing model,
including `gpt-6.1-sol` for its review. Follow
[commit conventions](../development/commits.md) and the attribution guard.
Do not push or release as part of this plan without an instruction to do so.
Update this plan/roadmap with actual progress; local detailed evidence stays in
ignored tasks and durable contracts stay in topics. A commit is a checkpoint,
not permission to stop an explicitly authorized end-to-end implementation run.

# YA-owned session identity and startup lifecycle

Status: the November 2 Claude/Codex ordinary text milestone is implemented:
YA saves intent/source before launch, retains its public id, binds the native
address and exposes startup/failure/uncertainty with prompt recovery. Narrow
provider capabilities select the new workflow; other inputs retain their
existing flow. Scoped history/watch/discovery and local/host continuation
foundations are implemented. Remaining caller/provider shapes, attachments,
automated retry and broader release/OS qualification remain separate follow-ups.
Published 0.8.0/0.11.0 Claude/Codex observation is qualified as described below.
OpenCode and Pi ordinary owner text creation now have independent optional
capabilities; their provider sections record native proof, storage and validation
limits. This does not enable every retained provider or input shape.

[Plan 171](../docs/tactical/171-durable-session-identity-and-creation.md)
defines the implementation slices, isolated-profile qualification and requested
Sol 6.1 High review/commit loop. It is a plan, not implementation evidence.

### Selected consolidation target

The selected end state is one stable, transport-independent creation contract
for retained YA-owned new user-visible sessions. Qualified text creation is the
implemented foundation; remaining callers/input shapes must migrate to that
admission/startup owner and retire the implementations they supersede. Supported
older HTTP routes may remain compatibility adapters into that same owner.
Provider-native allocation stays in adapters; existing-session resume and
external-history adoption keep their explicit boundaries. This is a selected
migration target, not a claim of universal current coverage.
[Plan 171's completion criteria](../docs/tactical/171-durable-session-identity-and-creation.md#completion-target--one-creation-contract-retired-legacy-implementations)
require deletion of the legacy creation implementations as adoption proceeds.

### Qualified Claude text acceptance — November 2

The narrow optional capability `session-creation-claude-text` (global id 142)
selects owner-only ordinary Claude text creation, including an explicitly
selected router account/pool. Attachments, slash commands, machine control,
project-write sandboxing, limited-user launches and other providers retain their
existing entry points. This does not promise the broader proposed
`session-creation-receipts` attachment/all-caller contract.

`POST /api/projects/:projectId/session-creations` and detached
`POST /api/session-creations` use existing start-body choices plus an owner-scoped
8–128 character `requestId`. A 202 response carries `requestId`, permanent
`sessionId`, `projectId`, `provider`, public `creation` status and server time;
it means saved intent, independently of provider readiness/delivery.
`GET /api/session-creations/:requestId` recovers that owner's result without
starting anything. Identical submissions resolve the original record; conflicting
input is 409 and deleted operations are 410. A canonical hash of submitted
body/project precedes mutable defaults and availability. Concurrent requests
recheck the saved key immediately before dispatch admission. Legacy start
endpoints keep their established process/queued response semantics.

Identity, exact text/settings/source and independent initial-input id commit
before acceptance. Existing Supervisor/WorkerQueue machinery owns later dispatch;
closing the originating browser does not cancel it. A routed request retains its
chosen account/pool and uses AAR authorization independently of direct login.
Routing failure never falls back to direct credentials. The selected executable
is rechecked even when its path was cached before an installation change, so a
missing CLI can fail before native effects.

The form retains a source/account/draft-scoped recovery identity before sending,
then opens the stable session on acceptance. Draft capture precedes async work.
Acknowledgement clears only that value/slot; newer edits remain and offer Open
saved session without forced navigation. Response failure tries read-only receipt
recovery; unresolved requests remain visible with their original identity. Source
change or view retirement cannot navigate a later view.
The recovery identity and accepted receipt remain stored until the owning view
settles its captured draft; returning after retirement recovers the same session.
Draft acknowledgement checks the physical account-scoped storage value through
the sync coordinator, including when a sibling storage event has not arrived.
Saved/startup/failure/uncertainty presentation exposes the saved prompt and
Copy/Refresh. Follow-up
submission waits for proved native first-input consumption. Startup reconciliation
is temporary and view-owned, bounded to fifteen checks with explicit refresh
afterward; it adds no server per-session poller.

### Codex text acceptance — November 2

The separately negotiated `session-creation-codex-text` capability (global id
143) selects the same owner text API and client lifecycle for Codex. It keeps
the pinned 0.166.0 app-server protocol. YA allocates the public id before launch;
Codex allocates its native thread id, which binds under the canonical configured
`CODEX_HOME/sessions` namespace. The native id never replaces the URL or enters
browser request paths. Resume/history use that exact stored native address.

Codex's adapter-generated user echo is presentation, not delivery evidence.
Only successful `turn/start` acknowledgement confirms its exact initial-input
UUID. The callback records native binding and input evidence synchronously
before later effort-restoration awaits. Local attempts validate their current
fence; hosted workers retain the same evidence across controller detach and
reattach. Failed or unknown acknowledgement cannot authorize automatic replay.
Hosted Codex additionally requires `session-creation-codex-v1` from the host and
the worker's pre-launch hello; the older Claude owner feature alone is insufficient.
Empty `CODEX_HOME` follows the pinned native default, including auth/config reads.
Other input shapes and servers without the narrow capability keep their existing
flow; the broader receipts capability remains unadvertised.

### OpenCode text acceptance — November 2

The optional `session-creation-opencode-text` capability (global id 144)
selects ordinary owner text acceptance for OpenCode. The
[OpenCode contract](opencode-backend.md#durable-ordinary-text-creation) owns its
native scope, observable-store requirement, authenticated HTTP proof and host
feature gate. Public UUID and native `ses_*` remain separate throughout the
same saved-intent, recovery, history and continuation lifecycle. DB/WAL and JSON
stores qualify for new launches; export-only sources remain read/resume-only.
The global receipts capability and other provider/input shapes remain gated.
A live OpenCode 1.18.18/OpenAI subscription smoke with `openai/gpt-6.1-sol`
qualifies local-owner API creation, native input proof and cold continuation
through two owned restarts under one public id; both exact answers and exactly
two native user inputs are verified. Its provider contract records the separate
controlled browser/host coverage and remaining live OS/runtime boundaries.

### Pi text acceptance — November 2

The separately negotiated `session-creation-pi-text` capability (global id 145)
selects ordinary owner text acceptance for Pi. The
[Pi contract](pi-provider.md#durable-ordinary-text-creation) owns canonical
reader/native scope agreement, native file validation, prompt-preflight proof
and the host/worker feature. The same saved-intent recovery rules retain YA's
public ID while Pi allocates its native ID. Other input/caller shapes and the
global receipts contract remain gated independently.

### Recovery and verification boundary — November 2

Owned-profile fault checks establish that a lost HTTP acceptance reply recovers
through a read with one POST/native input. An independently owned host retains
the same worker across abrupt Hono loss and can later prove initial-input
consumption. Loss of the local or hosted owner before native ACK retains the
saved prompt and uncertainty; resume refuses and identical admission resolves
the original session without replay. On macOS the automatic source-server host
belongs to its launcher; its loss is full owner loss, not worker survival.

A routed Claude browser check with 200 saved sessions holds acceptance during
native startup, releases acceptance during sequential typing and applies live
title updates. Every key is acknowledged within 100 ms from its event timestamp
through a rendered frame; the newer draft survives explicit navigation/return.
The sibling-tab physical-storage check and retired-form recovery regression
cover their separate acknowledgement interleavings. These checks do not close
the legacy Queue/attachment or general unconfirmed-follow-up gaps.

Controlled tests use the actual pinned Claude SDK/CLI against owned model/AAR
endpoints, and the Codex adapter against a pinned-protocol OS child with real
native history. A separate installed Codex 0.160.0/live model smoke proves
split IDs, native ACK and retained history after standalone restart. It does
not qualify the pinned 0.166.0 executable. Node 22/macOS and local Bun owner-loss
are exercised; macOS Bun hosting, Windows/Linux release qualification and live
Anthropic credentials are not claimed.

### Bounded release qualification — November 2

This qualification slice keeps the same ordinary Claude/Codex text scope.
Actual pinned Codex 0.166.0/live model creation, native acknowledgement, profile
restart and continuation pass under one public id/native thread. This supersedes
the earlier 0.160.0 live-executable limit for this workflow, without changing the
pinned protocol or the machine's installed CLI.

Current-client compatibility passes against isolated published YA 0.8.0 and
0.11.0 servers using the established start endpoint and history reload. A permanent
capability-absence case also covers version facts inside the streamed New Session
bootstrap, as well as standalone version reads.

Owned encrypted relay checks cover a phone-width client losing the actual
acceptance replies and recovering by read without a second native input, plus
late host-A acceptance after switching to host B. Host B's draft and view remain
unchanged; returning to A recovers its original session. This is browser/transport
evidence, not physical-phone backgrounding or OS lifecycle qualification.

Real sibling tabs and independent browser contexts preserve newer unsent drafts
through acknowledgement and reload. A real signed acting-user switch followed by
the document renewal used by Settings keeps the new account's draft separate and
refuses owner receipt reads. Account switching does not grant access to the
superuser's saved operation.

Worker saturation exposes queued status and promotes exactly once. Restart before
dispatch marks a stranded saved/queued attempt safely failed/not-admitted when
its recorded controller PID no longer exists, retaining its id, request, prompt
and source. This corrects the prior indefinite
queued presentation; no automatic dispatch/replay is added. Attempts record their
controller PID privately, retaining it across state changes and stamping retries
with their new controller. A live or reused PID, permission-denied liveness probe,
or legacy pre-dispatch attempt without controller evidence is left conservative.
A competing startup that later fails its port bind cannot invalidate the running
controller's queue; Node and Bun browser checks exercise rejection followed by
exactly-once promotion. PID liveness never authorizes dispatch or native input.
Router preparation refusal with available direct bait credentials retains saved
intent and causes no
model request or direct fallback, including after reload.

The live Claude access gate is now qualified after explicit owner sign-in through
the official CLI into a dedicated router profile. A new standalone YA integration
received a grant for only that account. The pinned Claude Agent SDK 0.3.312,
its Claude Code 2.1.312 executable and live routed model pass saved acceptance,
native input confirmation, retained answer after standalone restart and
continuation under the same public session and exact account pin. Two short model turns establish this narrow workflow;
controlled browser/SDK/AAR checks remain separate evidence for failure cases.
A subsequent actual-browser smoke also passes form submission, server-side live
completion while the browser is offline, automatic catch-up on reconnect, reload
and a second turn submitted through the composer. The public id and selected
account remain unchanged; the native transcript contains each of the two inputs
exactly once, and persisted creation provenance is `web`. The passing run took
15.9 seconds with source-mode session modules preloaded while online. Desktop
and phone-width captures were inspected; this does not qualify cold asset
loading while offline or physical-device lifecycle.
The test integration was disconnected and verified revoked, and its temporary
single-account pool removed; the enrolled account remains ready for future
explicit tests. Existing router credentials alone never
authorize a newly paired integration. Linux/Windows native execution and
physical-phone qualification remain separate release evidence.

### Project Queue provenance repair — November 2

Project Queue now saves the original enqueue source, retains it through
restart/edit/retry/promotion and passes it into Supervisor's pre-effect metadata
write for ordinary, worker-deferred and staged-attachment new-session launches.
The [provenance contract](session-creation-provenance.md#project-queue-origin)
owns its behavior and compatibility limits. Existing-session turns preserve
the destination source; old source-less queue items remain unknown.
The subsequent ordinary text Queue migration now uses the same durable
creation owner and a stable item admission key; its [contract](project-queue.md#durable-new-session-admission)
records handoff, recovery and explicit safe-retry boundaries. Attachments and
other unqualified caller shapes remain migration work. Other audited source
omissions remain open.

### Managed dispatch boundary

The stored-request dispatcher reads committed text/settings and the
independent initial-input UUID, requires a caller-supplied current authority
check, and records dispatch before invoking the provider. Worker deferral keeps
the existing worker queue and re-reads the saved request at promotion; cancellation
records a safe failure before acknowledgement. It does not reconstruct live
desktop credentials or silently downgrade router, sandbox or hosted choices.
The qualified path is superuser-owned unsandboxed Claude text, including selected
router accounts/pools and supported local/hosted ownership; other choices refuse
before effects until their later rollout slices.
The existing project/detached creation routes use it for superuser text requests
resolved through the Claude AgentProvider adapter, without attachments, slash
commands, runtime-only input authority, project-write sandbox or machine control.
Hosting additionally requires the negotiated private owner contract described
below. Other shapes retain their existing path during rollout.
The legacy Claude SDK bridge now resolves the same configured adapter when
provider is omitted; explicit overrides and unnamed independent SDKs retain
their existing behavior. Completed/queued/error response shapes and advertised
capabilities are unchanged; the broader creation-receipts contract remains unadvertised.

Before provider availability checks, the qualified route commits the exact
prompt, trusted creator and request source. Failure leaves a readable failed
session even when no process/native transcript exists. Deferral retains the
initial client temp id, per-turn mode, descriptive origin, one-turn effort,
composition/speech and receive-time metadata through an allowlisted versioned
input snapshot under the existing payload budget. Actor, receipt, hidden-turn
authority and arbitrary nested fields are excluded. Missing snapshots on older
records remain absent; their original replay hashes do not change.
Queued promotion re-reads stored input and keeps the existing post-start
association callback; idle-worker preemption still verifies the prior owner.
Deferred starts retain copied launch values, without the originating HTTP
context, credentials or unrelated JSON fields.
Accepted superuser work survives its originating HTTP request/cookie; it has
no mutable project grant. Owner shutdown refuses subsequent native dispatch.
Limited-user policy/sandbox dispatch remains a later cut, with its existing
route enforcement intact in the meantime.

A managed Process keeps its YA id in live output, replay and ownership events.
The first session-scoped native event records binding before publication; the
pinned Claude CLI can emit title telemetry before `init`. Provider-id settlement
still reports the native id. A later conflicting native id fails the owner
instead of remapping the public resource. Late binding and input admission
cross the current-attempt fence, without per-token control-store queries.
Managed stream failure and normal iterator completion close ordinary/deferred
input before callbacks. The actual owner remains tracked while provider teardown
is pending or unverified; only verified shutdown releases replacement ownership.
The namespace resolves the complete native directory, including an existing
symlinked leaf, so discovery, quarantine and reverse lookup use the same scope.

An optimistic user echo or SDK queue pull does not establish consumed initial
input. Matching native user echoes, or the pinned Claude main-thread reply's
input-UUID stamps, supply that evidence. Error-result send echoes and subagent
stamps do not. Unconfirmed owner exit retains uncertainty and never automatically
resends the prompt. Retained Processes that do not opt into this boundary keep
their existing launch/remap behavior while callers migrate.

## Selected ownership boundary

A YA-created session must exist durably before YA asks a provider to start.
YA owns its permanent public id, saved launch request and startup outcome.
The provider's process, native id and transcript belong to that session; their
absence must not erase the session or make it inaccessible.

This is the selected foundation for
[session creation, acknowledgement and navigation](session-creation.sketches.md).
It reopens the new-session identity work from
[plan 150](../docs/tactical/150-ya-owned-session-ids.md#november-1-selected-follow-up),
whose October deferral assumed there was no immediate feature needing durable
pre-launch session ownership. Reliable creation now supplies that need.
It does not resume the archived session-core experiment or select every old
fork/clone migration step. The [roadmap](../docs/roadmap/README.md) owns priority.

## Current implementation

- SQLite is required. Migration 10 stores metadata JSON keyed by `session_id`;
  it does not supply the general indexed provider/native-id relationship or
  durable startup-attempt state described here. See
  [session metadata](optional-sqlite.md#session-metadata).
- Migration 17 adds profile-owned public identities with optional scoped native
  bindings. Existing metadata/public keys remain intact; migration performs no
  transcript scan. Explicit discovery adoption preserves existing public ids,
  reuses a scoped binding and refuses conflicting or unbound public claims.
- A stored binding is authoritative for detail/history reads. Claude and Codex
  read the original transcript project at the bound native root/id; only the
  application summary is projected to the public id/launch variant. An unbound
  row or missing bound transcript does not probe another provider or redirect
  to a same-string native session. Existing process-history fallback remains.
  This is a read foundation, not transcript-less startup status yet.
- Bound readers share the bounded app reader pool. Codex indexed hints and
  cursors remain native-scoped; compact-tail reads accept validated appended
  prefixes, concurrent equivalent reads coalesce, and retirement releases parsed
  entries without allowing an in-flight read to re-admit them afterward.
- Claude/Codex discovery adopts native evidence in a publication transaction.
  Full, lightweight and retained collections project an existing binding back to
  its public id and launch variant. The native catalogue/index keys and physical
  file locations remain native. Merged readers report the actual native root;
  a private transcript is not adopted under its merged reader's ambient root.
  Summary references carry the resolved native id for subsequent source reads.
  Scoped reverse binding wins before consulting metadata under a native string:
  that string may also be another session's unrelated public metadata key.
  Other provider adoption and the remaining source/watch consumers are still
  being migrated before differing-id launches are enabled.
- Focused Claude/Codex watches resolve the stored native root/id while retaining
  the subscription's YA id and effective project in change events. Provider hints
  cannot override that binding, and event paths remain physical native paths.
  Unbound/missing bound sources never watch a same-string ambient transcript.
  The final viewer cancels pending source resolution as well as watches/retries;
  a delayed result cannot acquire reader work after application shutdown.
  Other native-family observation and released-client/browser qualification
  remain enabling work before differing-id launches.
- Published clients 0.8.0 and 0.11.0 are qualified for owned Claude/Codex
  sessions with differing YA/native ids. Both existing API submission and actual
  released-composer submission preserve one visible user turn through held
  native work, confirmed output and durable page reload. Requests, URLs and
  collection rows keep the YA id. Qualification uses pinned Claude SDK/CLI and
  the real Codex adapter with a controlled app-server process, isolated profiles
  and immutable released assets; it makes no live external Codex/model claim.
  This extends the existing non-owned focused-watch qualification. It does not
  qualify other provider launches, new receipt APIs or future draft handling.
- Retained fork/clone source resolution uses an operation-scoped stored/legacy
  lookup and passes the native id, actual file and original transcript project
  across the provider boundary. Provider fork inputs/results explicitly name
  `nativeSessionId`; Supervisor results, router pins, settings and lineage keep
  public ids. Claude SDK copies use the recorded native store, including anchored
  sandbox stores. Codex forks supply the native rollout path. Pi forks retain
  their actual native root and have a scoped cold reader. Before native copy,
  the adapters reject a source outside the current launch-discoverable store:
  Claude requires a direct project directory in its configured projects root;
  Codex requires its configured home/sessions or inherited sandbox root; Pi
  requires its CLI agent sessions root and current project. Direct Claude clone
  applies the same guard. Exact-source reading alone does not qualify scoped
  cold resume. These exclusions stay until native addresses reach cold resume
  and immediate helpers with independent qualification; supported conventional
  and anchored sandbox stores retain their existing copy behavior. The Claude
  store loader preserves the pinned native SDK's malformed/torn-row tolerance
  without changing source bytes; absent requested anchors still fail.
  This does not qualify new split-id launches or all-provider observation.
  Child native ids retain their existing public spelling by explicit discovery
  adoption. Account inheritance precedes identity publication; post-copy
  metadata failure retains a known-child outcome. Retained fork admission and
  lost-result recovery remain later work in plan 171.
- Instruction restoration, background issue indexing and Conversation
  acquisition use the stored native reader/id and original transcript project.
  Issue associations and Conversation subscriptions/results retain YA ids and
  effective working-project observations. Codex ancestor acquisition remains
  within the selected native store. Conflicting original-project catalogue
  evidence is refused before native acquisition/watch attachment. Legacy Codex
  rows without scope evidence wait for a scoped catalogue publication and retry
  through the same observer. Unbound/missing sources do not read an
  ambient same-string conversation; closing a Conversation cancels pending
  catalogue resolution before further native work.
- Process enrichment reads model/title/context from the stored native source,
  including after a working-project move, while retaining public metadata and
  process ids. Unbound or unavailable native history does not discard saved
  public title/provider facts or trigger ambient source fallback. Summary and
  recovered-settings callbacks resolve known working projects even when they
  contain no native transcripts; the stored provider wins over a stale hint.
- Child listings use the bound native parent/root and return the YA parent id.
  Child handles themselves remain native handles beneath the existing public
  parent-scoped `/agents/:child` routes. Metadata/full reads reuse the source
  selected for native history; collection attachment retains its accepted/cheap
  lookup and sequential per-provider work. External ownership joins and
  remaining helper/launch consumers are still being qualified before
  differing-id launches.
- Optional catalogue question enrichment resolves archive metadata through the
  scoped reverse binding. A native spelling already claimed by another public
  resource supplies no metadata to that row. Speech vocabulary history uses the
  raw catalogue's native root/id and original project while retaining native
  checkpoint keys; scope-less old Claude/Codex rows wait for the next scoped
  publication without blocking other learning. Maintenance history comparison
  borrows the app's bound reader/native id/original project and keeps the
  requested public id in its result. It does not allocate a separate reader or
  scan projects to infer a stored session's source.
- Claude/Codex external file observation resolves the physical native source
  before Supervisor ownership, own-write grace, decay and summary joins. Existing
  scoped bindings win over unrelated public native-spelling claims; explicit
  legacy discovery uses bounded native project/header evidence and adopts before
  publishing. Codex uses the metadata's thread id, including reverted rollouts
  with a different leaf filename, and excludes native subagents from admission.
  Watcher-reported native scope preserves private-store addressing; older
  in-process events use the configured root and cannot borrow it from outside.
  File paths/relative paths remain physical facts. Public summary callbacks keep
  working-project overlays without treating an arbitrary requested project as
  membership evidence.
- Native ingress reuses the batch processor with five concurrent source tasks,
  at most 1,024 pending tasks plus one bounded active batch, and coalescing by
  physical provider/path. Overflow remains unproven and is counted; native
  catalogue/history and later writes retain their own observation paths. Closing
  the observer cancels pending resolution and publication before reader/SQL
  teardown. No recurring per-session observation loop is added.
- Missing public-id lookups do not turn a provider address into another URL
  alias for an existing YA resource. Qualified legacy readers resolve their
  actual native scope before history/index/control access and reject an address
  already bound to a different public id or original project. Detail, metadata,
  agent, helper and resume fallback paths share this guard; they do not redirect
  or substitute the other YA resource before authorization. Valid legacy ids
  remain unchanged. A verified native reference selects a pooled reader
  constrained to that root before history/index/child access; an empty first
  file cannot authorize falling through to another merged root. A missing
  parent transcript supplies no native proof for an otherwise unknown child
  URL. Explicit metadata-only recovery and unmigrated reader boundaries retain
  their legacy behavior. Physical Claude filename case is checked rather than
  treating case-folded provider addresses as public aliases. The operation
  carries its verified native reference onward instead of asking downstream
  helpers to infer it again. App read-lifetime cancellation, including the
  production fork-source callback, fences asynchronous native proof before
  further identity queries.
- External host PID observations retain their documented provider-native
  `sessionId`. A unique scoped catalogue match resolves public title metadata
  and original/working project facts. The legacy project/session backlink is
  omitted when the YA id differs, rather than relabeling the native wire field.
  Matching is shared per uncached batch in the existing correlation TTL and
  never chooses a source from cwd. Missing/ambiguous native namespace evidence
  remains unlinked. App retirement cancels pending catalogue joins before SQL
  teardown; see [process observability](agents-process-observability.md#native-pid-correlation-and-permanent-ya-ids).
- OpenCode discovery/history/children also use explicit native data-directory
  addresses. Its native DB/JSON source and actual directory are proved before
  adoption; public projections preserve bindings even when a Git worktree
  groups a bound subdirectory. Bound CLI reads cannot escape into another
  configured data root, including through cached list results. DB/WAL reads
  include both physical source versions; focused changes retain the public id
  and effective project. This is native-source migration; OpenCode launch
  remapping remains until durable admission and provider launch slices qualify.
- Pi native discovery, indexed metadata and focused history refresh use its
  recorded canonical sessions root and native file handle. Public observations
  retain the YA id and working project across profile reopen. Point acquisition
  refreshes native file versions within the directory-cache TTL; a fixed-mtime
  append cannot reuse an old parsed transcript. Reader retirement clears caches
  and refuses late proof/parse publication. Remaining provider sources and
  differing-id launches are still gated.
- Grok native catalogue/summary/history and focused observation use the bound
  sessions root, canonical summary handle and original project. Late creation of
  the replay log refreshes the public session, including after a working-project
  move. Child metadata proves parentage before reading a native child. Media
  sources follow the actual native session directory rather than reconstructing
  it from public identity. Reader retirement discards pending results. See
  [Grok's source contract](grok.md#native-source-identity-and-observation).
- Frozen Gemini CLI and ACP history share the existing CLI JSON family, with
  canonical native-root/session-header proof. Bound reads use the original
  project and only its known raw/physical path hashes; an ambient project's map
  cannot select another source. Header hash membership applies to point reads,
  lists, paths and indexed enumeration. Native directory slugs and filenames
  do not replace header ids/hashes. A warmed source whose id/hash changes is
  unavailable under the old binding. Existing `gemini:<hash-prefix>` discovery
  coordinates retain their bounded historical grouping. Focused events retain
  the YA id and working project; retired readers discard late results. This
  preserves the frozen launch/protocol mapping. Scoped ACP continuation now
  validates the launch store/original project, keeps public Process identity and
  refuses failed resume without creating a replacement; see
  [retained ACP ownership](provider-abstraction.md#retained-acp-continuation-and-teardown).
- Fork-backed retitle, handoff-summary and recap generation resolve the public
  generator through the same scoped source boundary used for native forks.
  Provider requests carry a branded native generator id and the captured source;
  public metadata, results and overlay associations retain the YA id. Abandoned
  requests and application retirement fence final acquisition before generation.
  Claude helpers retain the original native project, configured account home
  and validated native project-directory selector; they do not redirect auth
  configuration. Selector-free lookup is allowed only when the physical cwd's
  conventional native directory is the captured scope, including the pinned
  runtime's long-path key. Relative account homes are proved from the physical
  original cwd used by the query; symlink spelling cannot approve another store.
  Unaddressable aliases fail before a model request;
  sources outside the configured launch store/private sandbox are refused. Codex helpers supply the exact rollout path and refuse unsupported
  path addressing or a different returned thread before starting a turn. Tailed
  helpers are unchanged. This does not qualify cold resume, prompt-cache touches,
  new launch identity or durable helper admission/provenance.
- Qualified local Claude-family, Codex and OpenCode cold continuations resolve one
  operation-scoped native source before launch. The provider receives the
  native id and proven storage/path facts; Process, public events, settings and
  child/API authority retain the YA id. A continuation validates the existing
  binding instead of allocating or replacing it, and a different returned
  native id fails before a later user turn. Unconsumed creation attempts still
  require explicit recovery; cold continuation never replays the saved first
  input. Generation/deletion and binding checks run again before admission.
  Claude retains its configured account home and only uses a validated native
  project selector or the exact conventional cwd address; unaddressable roots
  refuse. Codex retains its configured native home, supplies the proven rollout
  path, and refuses a peer without path support before thread resume. Its child
  environment and bridge keep the public id even after native thread init.
  Claude's prompt-cache callback also retains this native address.
  OpenCode resolves DB-backed, JSON-backed or fileless CLI-export proof from
  its configured native data root. Continuation uses the native `ses_*` handle
  without allocating another conversation; public ids never choose an HTTP
  session. A missing source, wrong root or invalid native handle refuses before
  launch. A scoped OpenCode owner uses an unused loopback port and a temporary
  local HTTP credential; readiness must reject a wrong credential before the
  real credential is used. An unrelated or unsupported endpoint gets no input.
  All owner operations authenticate, and failed startup retains its real child
  handle until exit is verified. Sending a signal does not certify exit.
  Hosted continuation uses the separately negotiated native-binding contract
  below. Stored equal-id legacy workers retain their claim-only attach path;
  a new cold worker requires the exact native source. Changed sandbox settings
  and restart-only configuration changes refuse before aborting an incumbent.
  Other unqualified equal-id paths remain unchanged.
- New Claude sessions receive YA's chosen id through the provider launch
  option. This avoids an ordinary native-id change, but does not establish
  complete durable launch ownership or recovery by itself.
- Other providers can still replace a provisional id with their native id.
  The implemented [remap contract](session-id-remap.md) reconciles that change.
  Legacy OpenCode creation exposes its native `ses_*` id; qualified ordinary
  text creation keeps the YA UUID. See
  [its provider contract](opencode-backend.md).
- `initialPrompt` is useful recovery metadata. It is not proof that all launch
  settings and attachments were saved before dispatch, or that a provider
  received the prompt.

## Selected behavior

1. Authorize and validate the request, then commit the YA session, exact
   submitted launch intent and durable attachment references before launch
   side effects or a successful durable-acceptance response. Capacity/storage
   refusal leaves the draft recoverable and starts no provider.
2. Keep the same YA session id through startup, native-id discovery, failure,
   refresh and server restart. Store a provider-native binding when one is
   established; never replace this session's public id with it.
3. Retain startup progress and a safe failure outcome even when no provider
   transcript was created. Authorized list/detail reads must find these
   sessions from YA storage rather than require a transcript or live process.
   A saved or failed startup is not an active provider turn.
4. Track startup attempts separately from the logical session. A known failed
   attempt may be explicitly retried within the same YA session, preserving
   its chosen settings and committed router account. An uncertain launch or
   delivery must be reconciled before another side effect; restart is never
   permission to replay it automatically.
  Once a native binding exists, ordinary runtime replacement resumes that
  native session; it does not silently allocate another conversation or replace
  history. Deliberate native-conversation replacement is a separate policy.
5. Distinguish durable saving, startup, native-session binding and initial
   input delivery. An id, live process or optimistic bubble proves none of
   the later stages. Preserve the last established boundary and the uncertainty
   after it; final state/field names remain an implementation decision.

The permanent session id, caller's idempotency key, receipt id and startup
attempt id serve different purposes. Lost-response retries recover the same
logical session/operation rather than create another session. A receipt may
refer to the session before provider startup; it need not be a separate
user-facing resource that later turns into a session. Reuse the existing
[HTTP v0 receipt semantics](http-api-v0.md#creation-and-retry-receipts) where
suitable without claiming that today's receipts retain request bodies.

The [creation proposal](session-creation.sketches.md) owns draft capture,
attachment acceptance/retention, navigation and background creation. The
[creation-source admission notes](session-creation-provenance.sketches.md) and
[plan 171 coverage ledger](../docs/tactical/171-durable-session-identity-and-creation.md#creation-source-admission-and-coverage)
require an explicit immutable request/internal source decision in the same
admission boundary, including deferred work and saved/failed sessions. This
descriptive source is separate from authenticated ownership and grants. The
[liveness contract](session-liveness.md) owns provider progress and input
eligibility. A startup failure must remain visible after the original event
and must not admit more messages into a dead provider queue.

## Identity translation and existing data

Browser URLs, REST/WebSocket session ids, metadata, grants, queue targets,
relationships and `AGENTCTL_SESSION_ID` use the canonical YA id. Native
resume/read/export calls and provider-specific CLI instructions use the stored
native binding. Native transcripts remain the conversation-history authority;
this work does not introduce a YA conversation store or rewrite provider files.

Preserve existing public ids and links, including externally discovered
sessions. Do not mint replacement public ids for the existing corpus. Native
discovery must resolve an existing binding before inventing a second YA row
for the same transcript. Select and qualify the binding's provider/storage
scope and uniqueness rule before schema changes; a UUID alone is not an
authorization boundary or a complete account/profile address.

Use an append-only migration under
[the SQLite migration rules](optional-sqlite.md#database-ownership-and-migration).
Do not scan the provider corpus in migration initialization. Preserve metadata,
router pins, sandbox facts, provenance and ownership through import and binding.
The existing no-downgrade policy remains: recovery is upgrade or an explicit
consistent pre-upgrade backup restore, not an older binary on the newer database.

## Translation conventions for the implementation plan

Use separate branded YA/native id types and explicit native references carrying
provider/storage scope. `sessionId` means the public YA id. Resolve one
operation-scoped reference at the provider I/O boundary; application routes,
queues and events keep YA ids. The same store owns forward/reverse lookup and
atomic, attempt-fenced binding. An unbound session is a normal lifecycle state,
never permission to pass its YA id to a native operation as a fallback.

Legacy adoption occurs at an explicit native discovery/import boundary.
Existing-id shape is not proof of namespace: equal Claude strings and existing
`ses_*` public ids still have separate YA/native meaning. Prefer real lookup
over more provider-prefix guessing, repeated deep translations, ad-hoc SQL or a
second mapping cache. [Plan 171](../docs/tactical/171-durable-session-identity-and-creation.md)
owns migration order and slice acceptance evidence.

## Current-client creation and compatibility cleanup

The maintainer selected current-client convergence after the server owner
migration. New servers advertise `session-creation-admission-v1` (bit 147):
configured-provider creation, limited/owner authority, sandbox/Machine Control
options, staged initial files and explicit empty `intent: prepare`. Prompt,
files, source and settings are accepted together. Preparation requires empty
message/no attachments and sends no phantom turn. This bit does not promise
automatic uncertain replay or the separate broad receipts guarantee.

New Session and Session-page Start now use that full contract. Current form
restrictions are no longer reasons for selecting an older request sequence.
Selected files finish staging before acceptance; newer text/files and retired
source/account views cannot be cleared or navigated by a delayed reply. The
Session-page recovery link can read an earlier operation without a second write.
It clears the saved original draft only while its text and file references
still match; attachment hydration timestamps do not imply a new selection.
A failed response retains the submitted files. Retry reuses the original wire
payload and request identity, and a parked page cannot navigate on completion.
Client recovery helpers/types now name session creation, rather than text-only
creation. Existing saved local recovery keys retain their spelling.

`legacySessionCreation.ts` owns the older-server create/materialize/send
sequence and the earlier narrow text/attachment eligibility rules. A server
advertising full admission cannot enter that adapter. The maintained older
server corpus remains v0.8.0–v0.11.0; clients send only established writes there.
Old extension clients are not a blocker for subsequent removal of new-server
aliases and SDK execution scaffolding. Existing native history/resume remains
independent of this client/server protocol cleanup.

## Retained caller consolidation

Qualified ordinary owner launch shapes use the same admission owner from native
v0/peer API creation, Source Review new-session submission, maintenance create
and text successor/handoff routes. This is an internal server migration; their
existing URLs, authenticated principals and response/receipt enums remain.
Descriptive source is captured at the requesting surface, independently of
trusted creator, grants and input receipts. Existing-session messages/resume
remain separate and never allocate a new logical session merely to translate
an id.

A native API receipt owns its already server-generated input UUID. Common
admission reserves that exact UUID as the saved initial input, while allocating
a separate public YA session id. Native ids bind at the adapter boundary. The
native API receipt retains its creator/authentication scope and existing delivery
meaning; creation's stronger native-input proof remains its separate evidence.
Native first-input text bypasses YA slash-command emulation, matching the
native API's exact-text contract. The public association is persisted before provider startup, and queued dispatch
rechecks the incumbent command enablement and authenticated project/operation
authority. Cold recovery can recover saved confirmed creation proof; it never
replays uncertain input. Peer identity/grants are not inferred from provenance.

Keyed Source Review stores its public association at acceptance before native
effects, and resolves retries through the canonical creation operation instead
of a process-local cache of successful starts. The superseded successful-start cache is removed. A changed input under the same
key refuses. The review manifest stays immutable; existing submission state
records delivery/association, and existing-session follow-ups keep their own
receipt semantics. A keyed saved failure remains linked to that original resource. Legacy unkeyed
review failures still propagate as errors and leave comments pending; they are
not reported as a queued delivery without an associated operation.

The older create-only endpoints are compatibility adapters into common admission. They admit an explicit empty preparation intent before native startup
and return their existing process/deferred/error shape. No initial turn is sent.
An additive `creation.initialInputExpected: false` distinguishes that resource
from an unconfirmed submitted prompt; its first turn may enter its live incumbent
while a lazy provider still owes native init. Without such an incumbent, an
unbound or uncertain preparation refuses new allocation. Once bound, ordinary
scoped continuation retains its native identity. Collections project the flag
from a compact column without reading saved prompts. Old servers omit it; no new
request is sent to learn it. Published older clients ignore the additive field.
The text/attachment capability meanings and global receipts advertisement remain
unchanged. Restricted/sandbox launches and new forks/clones now share that same
owner as described below.

### Retained native provider admission

All registry providers expose their actual new-session namespace before native
allocation. Internal admission eligibility uses that adapter contract rather
than the public text-capability ledger. Claude, Gateway and Ollama explicitly
accept a chosen native spelling; allocated providers return N which binds to P.
Native input acceptance is separate: ACP confirms only after successful
`session/prompt`; Codex OSS confirms the immutable exec input on native
`turn.started`. Their earlier YA user echo is never confirmation. The first
Codex OSS echo waits for `thread.started` so no invented pending native id can
bind. Lost acceptance proof preserves uncertainty and refuses fresh allocation
on continuation; confirmed cold continuation addresses only the bound N/store.

The frozen Gemini ACP protocol, target versions and model defaults are retained.
This is internal identity migration, not an upstream refresh. The private host
requires `session-creation-adapters-v1` from the running host and new worker for
these additional adapters; an old host refuses before launch instead of
silently falling back. Existing workers retain their original loaded contract.
Public text bits 142–145, staged bit 146 and the unadvertised broad receipts
contract keep their meanings. Additional internal adapter coverage does not
change requests sent to older servers or broaden those client capabilities.

### Creation consolidation — November 3

Every production native new-session ingress now requires trusted admission.
Project/detached start and create-only URLs, Project Queue, Source Review,
native/peer API, maintenance, text successors, template preparation and
fork/clone helpers converge on `SessionCreationStore` and Supervisor's saved
attempt lifecycle. The native I/O guard refuses a fresh launch without that
attempt before effects. Separate empty-provider creation bodies, Queue's
create/materialize/resume engine, its startup metadata callback and route
creation-source writers are removed. The explicitly simulated mock backend
supplies its own namespace/acceptance; stateless SDK test scaffolding is not a
production fallback. Resume and external-history adoption remain separate.

The permanent public P, original owner/source, prompt, resolved launch choices,
working project, requested sandbox policy and operation identity commit before
native allocation. Current authority is rechecked at dispatch, worker promotion
and retry: limited users retain the original accepted lock or fail safely after
revocation; they cannot downgrade confinement or change owners. Desktop-control
credentials are opaque live objects, never serialized. A saved requirement flag
requires a freshly authorized credential on retry. Prepared sandbox transcript
roots supply the native namespace; private `session-creation-sandbox-v1` gates
both loaded host and worker support. An old owner refuses without receiving
launch input or being restarted.

Legacy raw files and inline images are sealed by the same immutable digest/claim
owner as staged attachments. Inline images have a 32 MiB combined decoded limit;
64 files/images per operation and 64 MiB per ordinary file remain bounded by
the existing 2 GiB profile claim budget. Limited raw paths must resolve to that
account's staged draft. Literal document references retain their original text
semantics. Native adapters that cannot carry inline images save a failed
resource before effects instead of dropping them. The initial native input
bypasses YA command emulation; a slash-only command without native receipt
proof stays unconfirmed. This does not strengthen later-turn delivery.

Forks and full Claude clones admit a public P **before** native/file copy I/O.
Saved copy intent freezes the exact native source, parent, settings, cut and any
planned continuation. `creation.kind: copy` distinguishes a pending copy from
an empty preparation: its composer stays disabled until native binding. Copy
sends no first turn and makes no claim that a later continuation was delivered.
The actual returned N binds to P; failure, busy continuation and restart retain
that P and original source. Internal recap/retitle/fork-summary generators are
archived at admission with explicit internal reasons. The final fork-summary
target uses the original request source and deterministic operation key;
parent-display association recovers through the indexed common key after a
SQLite/metadata publication gap. No second creation journal is introduced.
Concurrent copy calls share the admitted attempt; uncertain copies never replay.
Filesystem/native effects and SQLite are not one transaction. Lost native result
correlation remains quarantined and requires evidence-based reconciliation; see
the [narrowed gap](../gaps/session-creation-source-missing-launch-paths.md).

Template preparation uses one keyed canonical acceptance with its full prompt
and staged files, replacing create/upload/send. The server's canonical route
supports this broader authenticated internal workflow, including limited users;
owner-keyed recovery reads cannot expose another account's operation. Public
client bits 142–146 keep their narrower existing meanings, the supported
older-server client fallback remains, and broad `session-creation-receipts`
stays unadvertised. Existing HTTP URLs remain thin response/policy adapters.
No full workspace/lineage redesign, automatic uncertain retry or optional
background/shortcut UX is implied by consolidation.

## Compatibility research — 2026-11-01

This is a source/release audit, not passing client/server skew qualification.
Apply the [core 60-day review](server-capabilities.md#minimum-compatibility-horizons)
and [hosted compatibility](remote-hosted-compatibility.md). The latest two
published stable servers are v0.11.0 and v0.10.2. The preceding 60 days begin
September 2; retain v0.8.0 as an additional check because it is the supported
client baseline.

Release dates were checked against the
[GitHub releases](https://github.com/kzahel/yepanywhere/releases) (through the
release API),
[npm package metadata](https://registry.npmjs.org/yepanywhere) and
`scripts/capability-releases.json`. Tagged source was inspected at every row:

| Server tag | Commit | Release evidence/date | Identity/storage behavior |
| --- | --- | --- | --- |
| v0.8.0 | `03b96b9c4005` | August 31; additional baseline | JSON metadata; provisional/provider id remap |
| v0.8.1 | `2fb6557234b6` | September 5 | JSON metadata; provisional/provider id remap |
| v0.9.0 | `fb109623f9fe` | September 22 | JSON metadata; provisional/provider id remap |
| v0.9.1 | `f2daae2c063b` | September 24 | JSON metadata; provisional/provider id remap |
| v0.9.2 | `ec0108c37662` | September 26 | JSON metadata; provisional/provider id remap |
| v0.10.0 | `a095b9c61e8d` | October 20 in local release ledger; tagged source checked | SQLite metadata; YA-chosen new Claude id; other provider remaps |
| v0.10.1 | `e65db78de294` | October 20 in local release ledger; tagged source checked | SQLite metadata; YA-chosen new Claude id; other provider remaps |
| v0.10.2 | `9a355a739bed` | October 20 | SQLite metadata; YA-chosen new Claude id; other provider remaps |
| v0.11.0 | `bcdd87c0f0a8` | October 24 | SQLite metadata; YA-chosen new Claude id; other provider remaps |

v0.10.0 and v0.10.1 have tags and ledger dates but no published GitHub release
or version entry in the npm metadata returned during this audit. They were
included conservatively; this is not evidence that either artifact is currently
available. Desktop/extension release numbers are independent of server versions.

### Observed contracts and migration hazards

All nine tags retain the four ordinary creation routes:
`POST /api/projects/:projectId/sessions`, its `/create` variant, and
`POST /api/sessions`, its `/create` variant. Successful immediate launches
return session/process/project fields; worker-queue admission has its separate
202 response. None advertises `session-creation-receipts`. No reviewed release
promises the complete selected durable session lifecycle.

| Boundary | Finding and required treatment |
| --- | --- |
| Public ids | Existing session-id fields carry strings; preserving their shape allows server-side native translation without a capability solely for the database implementation. Audit consumers rather than assuming every string is already opaque in practice. |
| Creation responses | A pending YA session cannot replace the legacy process/session result unconditionally. Preserve established success/queue/error behavior; select early durable acceptance through a new route or negotiated mode. A valid id before startup must not imply a ready process. |
| File events | All reviewed clients' broad file handlers compare the id extracted from `relativePath` with the viewed session id (`hooks/useSession.ts`, `lib/sessionFile.ts`). A native filename differing from the YA id can suppress that refresh path. All nine also have `useSessionWatchStream` for non-owned sessions; its focused change handler fetches without filename-id comparison. This is an existing compatibility bridge to qualify: resolve the requested YA id to the native watch target server-side, while keeping the subscription's YA identity. Owned Claude/Codex pending/durable paths are now qualified on published 0.8.0 and 0.11.0, including released-composer submission and reload; other provider/skew gates remain. An additive canonical-id field alone does not fix old clients; do not falsify physical file paths to conceal the mismatch. |
| Lists and detail | Catalogs/readers currently derive substantial state from provider discovery. YA-only saved/failed rows need a joined projection and transcript-less detail response; a metadata row alone is insufficient. Preserve existing row/detail fields and define absence of new startup fields. Old clients may show only a generic failure and do not gain recovery UI automatically. |
| Provider selection | Readers/resume paths must resolve the binding before provider-specific id/path parsing. OpenCode currently uses native `ses_*` identity, including read fallback selection; a new UUID must not turn it into an empty Claude session. |
| References and access | Keep old ids stable. Preserve drafts, recents, grants, shares, attachment ownership, queue records, API receipts, peer relationships and parent/child links. Native-id resolution must not bypass existing principal/project/session authorization. |
| Provider host | Surviving workers retain launch facts and older loaded code across Hono reload. Qualify binding/reattachment under both hosted and in-process ownership; if old workers cannot participate safely, specify a controlled upgrade boundary. Do not silently restart them or assume Hono reload upgrades them. |
| Database rollback | Append a migration; old builds reject newer schemas. Restore a consistent pre-upgrade backup to downgrade. Do not rewrite native history or existing public ids to make rollback appear supported. |
| Input outcomes | Keep existing receipt state meanings and separate saved intent from consumed input. A stable session id does not solve the broader [unconfirmed-send gap](../gaps/unconfirmed-send-loss-across-reload.md). |

Source entry points: [legacy routes](../packages/server/src/routes/sessions.ts),
[client session events](../packages/client/src/hooks/useSession.ts),
[filename interpretation](../packages/client/src/lib/sessionFile.ts),
[current metadata store](../packages/server/src/metadata/SessionMetadataService.ts),
[migration 10](../packages/server/src/storage/migrations/010-session-metadata.ts),
[receipt store](../packages/server/src/core-api/receipt-store.ts),
[native command adapter](../packages/server/src/core-api/native-session-commands.ts),
and [provider-host ownership](provider-host-api.md).

The Sol plan review further bounded these findings: the focused-watch client
exists throughout the corpus, but today's server manager supports Claude/Codex/
Gemini shapes, normalizes OpenCode to Claude and has no Pi/Grok target. Each
retained provider needs qualified native observation before split-id launches.
Retained fork/clone/helper operations must translate their **source** ids even
when their child-id redesign stays deferred. Host claims/bound messages and
reattachment must carry separate YA/native identity before enabling the first
hosted split-id launch. [Plan 171](../docs/tactical/171-durable-session-identity-and-creation.md)
records these enabling gates, the admission transaction/publication boundary
and bound/unbound/router retry decisions.

### Recommended feature gate and fallback

- Keep `session-creation-receipts` as the provisional capability name for the
  complete new web acceptance/status/recovery contract. Allocate its id and
  introduction version only when implementing from the live ledger. Prefer
  `version-implied` for universal released support, with explicit source-build
  advertisement; use an optional bit if implementation availability varies.
- Internal stable-id translation alone needs no new capability. The selected
  early-acceptance writes/status reads do. Do not reuse or broaden
  `agent-api-management`, `session-creation-provenance`, collection capabilities
  or SQLite readiness as evidence of this contract.
- Before version support is established, use only existing routes. Absent or
  denied support keeps ordinary creation and legacy responses; no new fields,
  endpoints, automatic retry or claim of durable acceptance/recovery. Optional
  background navigation may suppress navigation after the ordinary response,
  but cannot claim the new guarantees or clear newer drafts.
- An older client against a new server retains legacy route behavior and the
  same YA ids for existing data. New split-id sessions still require the file
  refresh and transcript-less-read qualification above; an extra capability
  cannot teach an already shipped client those semantics.
- New client/new server uses the permanent YA session URL and new durable
  acceptance/status contract only after support is established. Old client/old
  server remains unchanged. Startup fields added to existing reads need an
  explicit absence fallback; new status values must not be inserted into old
  process/liveness enums that older consumers interpret as execution state.
- No transport/SRP protocol bump, coarse hosted compatibility-level bump or
  server-baseline increase is currently justified by this audit. If old-client
  refresh cannot be preserved, return with that concrete limitation and a
  reviewed rollout decision rather than treating a capability as a cutoff.
- Record any new fixed-version fallback's actual introduction and retirement
  in the existing sunset inventory under the 90-day rule. Update the release
  corpus immediately before implementation if another stable release ships.

## Decisions still needed before runtime changes

### Phase 1 implementation decisions — 2026-11-01

The maintainer authorized autonomous end-to-end implementation of plan 171 on
November 1, including reviews and commits. The following selects the concrete
implementation boundary within that plan; rollout claims still require the
per-slice evidence. No server baseline, transport protocol or provider target
version changes are selected.

**Identity storage.** Append migration 17 for `session_identities`: public
`session_id` primary key, launch `provider`, canonical `project_id`, creation
time and nullable native family/scope/id columns. The three native columns are
either all null or all present, with a unique composite index. Preserve metadata
in its existing table and retain its public keys. Native family is the reader
namespace (Claude, Codex, Gemini, OpenCode, Pi or Grok), not the launch variant.
The scope is the canonical provider storage root, resolved by trusted server
configuration/discovery, including private routed/sandbox roots. It is never
taken from a client field or inferred from the public id. Launch variant and
account choice stay explicit launch facts. Two stores with the same native id
remain distinct; conflicting existing public claims fail rather than merge.

Only native discovery/import may adopt an existing public id with verified
native facts. New admission always mints a YA UUID before provider effects.
Typed YA/native ids validate opaque nonempty strings up to 512 characters,
excluding control characters and path separators; existing `ses_*` and test ids
remain valid. Constructors live at named ingress/discovery boundaries. Native
reader/index/cache keys remain native; operation-scoped public adapters resolve
and project the YA id without rewriting source bytes or physical paths.

**Creation owner and atomicity.** A later append-only migration adds one
`session_creations` row per accepted operation (owner-scoped retry key, stable
operation/session ids, normalized request hash, saved payload/context, current
attempt, phase, timestamps and safe failure/delivery evidence) plus retained
attempt records. This is the durable payload/control owner, not an event log
or a second conversation store. Existing v0 receipts remain their documented
audit/admission projection, linked to this operation when that caller migrates.
Their payload-free schema and state meanings do not change. Both writes use
the same profile connection/transaction owner; no cross-connection transaction
claim or nested `reserve`/metadata-save transaction is allowed.

Admission stages immutable metadata, identity, payload, operation and attempt
changes, commits synchronously, then publishes metadata mirrors/events. Rollback
leaves mirrors unchanged. Store an authenticated owner reference separately from
validated descriptive request/internal source; never persist credentials,
live request objects or child environment. Freeze normalized submitted options
and resolved launch facts, retaining committed router references in their
existing private store. A bounded internal-reason enum covers retained helper
purposes; explicit legacy adoption handles old unknowns, never a fresh default.

**Bounds and retention.** Retain at most 10,000 creation operations and 512 MiB
of serialized saved creation payload per profile; a normalized request may be
at most 256 KiB. Refuse excess before launch with a recoverable draft. Existing
v0 receipt capacity remains independently authoritative. Reads and identical
replays work at capacity. No silent receipt expiry or automatic failed-attempt
deletion. An explicit session deletion may release payload/attachments but
retains retry identity/hash and a deleted tombstone; replay cannot launch again.
Keep at most 16 outstanding native admission promises, using incumbent worker
capacity and bounded shared dispatch, not a timer per attempt.

Each operation retains at most 64 attempts. Serialized attempt/error/evidence
data is capped at 8 KiB per attempt and 64 MiB per profile; safe error text is
at most 1 KiB and evidence uses bounded structured fields, never raw stderr.
Account and refuse before reserving another attempt or calling router/provider
effects. Existing payload/status and identical replays remain available. No
automatic attempt eviction is selected; deleted tombstones still consume the
10,000-operation budget. Capacity refusal cannot mutate the current attempt.

**Attempts and retry.** Persist a dispatching marker before external startup.
After restart, saved/queued work with proof of no dispatch can be re-admitted
under current authorization; dispatching without conclusive owner evidence is
uncertain. Initial-input admission/consumption is separate from native binding.
Only explicit creation recovery can retry a definitive pre-effect failure;
uncertain effects reconcile the incumbent native/host evidence and never replay
automatically. Bound retry resumes that same native conversation. All binding,
failure, input and cleanup callbacks carry the current attempt/owner generation.
Cancelled router credentials remain cancelled; a known-failure retry needs a
fresh attempt reservation pinned to the same account, or refuses safely if the
router cannot provide it. It never reselects or uses direct login.

**Attachments and Project Queue.** Ordinary superuser unsandboxed Claude/Codex
creation accepts account-owned staged references (including attachment-only
input and several draft batches). The exact optional capability
`session-creation-staged-attachments` (146) is required in addition to that
provider's text capability. Without it, clients use existing
create/materialize/send and send no new staged field. The audited stable corpus
below has no bit 146; existing text/provenance/global-receipts meanings do not
expand. Other provider/limited/sandbox/command shapes retain their named legacy
consumer until the remaining caller migration.

The attachment slice seals immutable objects in
app-data, then commits claims with payload/operation; draft TTL cannot expire
claimed objects. Unclaimed sealed objects and partial preparation directories older than seven
days are reclaimed on the first attachment creation of a process, using an
indexed operation claim lookup; no per-session timer is created. Materialization
uses the saved public id and normal storage policy before the dispatch marker,
verifies SHA-256/size, and publishes each completed copy by atomic rename.
Existing files with changed bytes are refused, including equal-sized changes.
Preparation never deletes draft/Queue originals. Acceptance returns only after
immutable bytes and the transactional operation claim are saved; a failed
admission preserves the source and leaves at most an unclaimed bundle. A safe
pre-effect retry reads the admitted bundle even after draft/Queue deletion.
Unknown native effects remain uncertain and never replay automatically.
Concurrent identical preparation requests share one bounded in-flight admission;
conflicting payloads refuse. A definitive pre-admission refusal carries HTTP 400
and `reason: "creation-not-accepted"`, after checking for a committed result.
Clients retire that rejected recovery key while preserving text/files, allowing
corrected input. Generic failures or a recovery GET 404 alone never establish
non-acceptance. Draft acknowledgement checks the captured live file selection,
including unfinished uploads, in addition to persisted text/attachment state;
a newer paste stays on the form and continues uploading. Retain
claimed bytes until explicit deletion or a documented confirmed-delivery release
under existing media-preservation policy. Cap claimed bytes at 2 GiB per profile
and references at 64 per creation, in addition to the configured upload limit;
capacity refusal preserves staged files and drafts. No project-local write is
authorized by these decisions. Queue items retain original source at enqueue;
first promotion admits the session under the item's stable operation key.

Reserve byte/reference capacity durably before sealing, not only after a claim
succeeds. Reservations, sealed-unclaimed objects and accepted claims count
together against 2 GiB and 65,536 per-profile reference slots. Unclaimed
reservations/sealed copies expire after 24 hours and are reclaimed in bounded
batches of at most 64 through shared maintenance; accepted claims do not expire
by that rule. Their original draft staging keeps its existing retention policy.
Crash cleanup verifies no accepted claim before releasing a reservation/object.

**Public web contract.** Introduce `POST /api/session-creations` with a caller
`requestId`, project/detached selection, exact initial text, existing launch
options and (once qualified) owned staged attachment references. A request id
is scoped to the authenticated owner and this logical server/profile; reuse
with a different normalized submitted request is a conflict. Resolve an existing
authorized operation before new mutable provider/catalog checks. A 202 response
returns the permanent YA session/project ids and creation evidence, never a
pretend process. `GET /api/session-creations/:requestId` recovers that owner's
operation after response loss; the ordinary session URL/detail reads expose
additive `creation` status including when no transcript exists. Status describes
saved, queued, dispatching, bound, failed, uncertain or deleted separately from
delivery evidence and the unchanged process/liveness enums. Explicit retry is
`POST /api/session-creations/:requestId/retry` and revalidates launch authority;
ordinary send/resume/reactivate cannot advance an unbound/uncertain creation.

Retry takes `{ retryId, failedAttemptId }`: the retry id uses the same bounded
8–128 character key syntax as creation request ids; the failed attempt is the
expected current attempt token. Its unique key is scoped to owner and creation
operation. In one transaction, recover an existing retry result first, or
compare-and-set the definitive failed current attempt to a newly persisted
attempt and record that recovery key/result before effects. Concurrent identical
retries return the same resulting attempt; reuse with a different expected token
is 409 conflict. A new recovery key against a superseded token is 409 stale
recovery; unknown/bound-consumption evidence is not made retryable by a new key.
Reads/replays require current resource access; advancing a retry also requires
current launch authorization. A lost HTTP reply cannot create another attempt.

Gate those new writes/status reads on the provisional named capability
`session-creation-receipts`, allocating its ledger id only when implementing.
Use version-implied release support with explicit early source advertisement,
and advertise only after the complete qualified provider/caller/attachment
contract is available. Unknown/absent/denied support sends existing routes and
no new fields or status reads. Older clients/new servers retain existing
completed/queued/error response shapes; optional status fields need no request
probe and old process enums remain unchanged. Do not broaden provenance or
agent-management capabilities. The audited core corpus remains v0.8.1, v0.9.0,
v0.9.1, v0.9.2, v0.10.2 and v0.11.0, with v0.8.0 baseline and v0.10.0/v0.10.1
tagged-source checks retained. Recheck publication metadata before final rollout.

**Host upgrade boundary.** Carry public YA identity, native reference and
attempt identity separately in private host/worker launch/bind/attach records
and evidence. New split-id hosted launches require explicit host/worker support
for that shape; a loaded older host preserves its incumbent workers but refuses
unsupported transitions with update guidance. Do not silently upgrade/restart
it, claim equal ids or take over a worker with an in-process replacement. Hono
detachment retains host evidence; full owner loss becomes uncertain. Preserve
the supported platform/runtime matrix and macOS default-off host behavior.

**Native fork/source admission.** The November 3 consolidation supersedes the
intermediate retained-fork bridge: copies now save their permanent public id
before effects and bind actual native results through the ordinary attempt
owner. Archived generators and final user targets have separate explicit source
decisions. Lost-result uncertainty retains that public resource and quarantines
unknown native discovery; it never guesses parent/title association or replays.
This does not advertise the broader receipts guarantee.

**Standalone qualification.** Use existing owned server/protocol fixtures with
configuration scrub followed by explicit HOME/USERPROFILE, XDG, temp, provider
home/transcript roots and runtime/socket directories. Poisoned-parent tests
prove that no selected path or inherited agent authority escapes. Run Node/Bun
storage and hosted/in-process scenarios. Available live provider credentials
must be an explicit isolated setup, not a production home/database copy. Keep
localhost:3400 for actual Sol 6.1 High bypass reviews; no restart or migration
of that live profile is part of testing.

The phase 1 decisions above must receive the requested Sol design review before
their runtime slices. Record corrections and actual qualification alongside
the owning contract; selecting the design does not establish implementation or
passing provider/client/server evidence. Provider-specific native scope and
legacy observation qualification remain enabling gates before each split-id
rollout, and the global capability remains withheld until the full contract is
qualified.

Acceptance evidence must include response loss, crash/restart on either side of
native launch/binding/input admission, discovery deduplication, existing-link
preservation, known failure versus uncertainty, router-pin continuity,
attachments, and old/new clients and servers. Cover hosted and in-process
ownership and genuinely different provider identity shapes. Reuse bounded
observation and existing dispatch; no per-attempt pollers or new general runtime.

### Implemented creation storage foundation — 2026-11-01

Migration 18 adds a profile-owned creation store beneath the planned admission
path. It saves an unbound YA identity, exact initial text, explicit normalized
source/creator, launch-settings snapshot, operation and first attempt in one
synchronous transaction on the metadata connection. Metadata mirrors publish
only after commit. Failed writes leave both the rows and mirrors unchanged.
Owner-scoped identical request replays return the saved identity; changed reuse
conflicts. Explicit pre-effect retry retains that identity and records the retry
key/result atomically with its new attempt. Dispatch generations fence later
binding and delivery transitions; unknown effects remain uncertain and cannot
be retried. Explicit deletion releases saved payload while retaining a deleted
operation, request hash, native identity and historical retry results.

This is an internal storage boundary, with the bounds selected above. It does
not yet route ordinary creation or advertise `session-creation-receipts`.
Native namespace quarantine, provider startup integration, current-authority
dispatch, and all caller/attachment/client
qualification remain required before those guarantees become public behavior.

### Saved-record reads before native startup

The ordinary session detail and metadata endpoints can project an admitted
unbound creation from YA storage without opening a native transcript or creating
a provider project directory. They retain the YA id, effective working project,
exact initial prompt, original source and saved launch settings. Additive
`session.creation` fields expose the current attempt id, state, delivery and
bounded failure code; operation/request keys, owner generations and private
payload/context records are not public. There are zero transcript messages and
no native snapshot watermark, active process, pending approval or provider
command-discovery claim.

Persisted YA project/creator facts authorize these reads under the existing
limited-user rules, including the creator's retained access after grant changes.
A saved timestamp does not establish provider activity or freshness for joining.
An unbound identity cannot advance through ordinary resume; explicit creation
recovery owns that future transition. Deleted operation payloads and unbound
identities without a creation record are not synthesized as readable sessions.

Global sessions, project session lists, inbox and public project cards also
include nondeleted control records without manufacturing native catalogue rows,
transcript paths or activity evidence. Native rows win once available; their
additive creation status remains visible. A known native binding with no readable
transcript continues to expose the saved prompt and status. Ordinary send/resume
cannot advance it while delivery remains unconsumed or uncertain. Existing
archive, query and access rules apply; saved records do not imply unread content,
pending approval or a live provider. Project-list native/runtime enrichment runs
before the control merge, so notification state cannot turn a control timestamp
into unread provider content. Deletion removes the control projection.

For projects containing creation records, card counts are the identity union of
control records and one already-published compact native catalogue snapshot.
Both the native baseline and overlap come from that snapshot; aggregate scanner
counts cannot prove whether a bound session is already represented. Counts may
follow catalogue publication while discovery warms, and no card request starts
or refreshes native discovery. Binding before a transcript exists neither drops
its count nor doubles it when the transcript publishes. Global hidden-project
policy also applies to saved-only cards; explicit project restoration retains
its existing behavior.

Migration 19 adds one profile-wide control revision, advanced in the same
transaction as creation mutations. Replayed admission/retry and rolled-back
writes do not advance it. Collection conditionals and cached stats observe this
revision alongside native/runtime publications. Collections read compact current
attempt projections rather than decoding retained request payloads.

The later sections record the original foundation sequencing. Current caller
consolidation is described above; broader receipts advertisement remains gated.

### Native allocation and discovery quarantine

Migration 20 gives each dispatching creation one unresolved native-allocation
claim. The current attempt/generation and canonical provider family/store scope
commit in the same transaction as dispatch. The scope comes from trusted launch
configuration, including the actual account/sandbox store; it is never a client
hint or an id-format inference. The private namespace evidence remains in the
attempt's existing 8 KiB/64 MiB budgets. Oversized or over-capacity evidence
refuses dispatch and rolls back the claim. Claims are bounded by the profile's
10,000 operations; they have no timers or automatic expiry.

While a claim exists, unknown native discoveries in that namespace cannot be
adopted or exposed as another public session. Existing reverse bindings stay
readable, and unrelated proven scopes remain usable. Old scope-less catalogue
rows defer while that family has unresolved allocation. Batch discovery returns
an aligned absent result for each deferred row, so one quarantined native
resource does not prevent unrelated known rows from publishing. Point legacy
history, excerpts, helper/diagnostic reads and focused watches use the same
native-source proof; unavailable proof cannot authorize an ambient fallback.
Native catalogue/index rows and provider files keep their physical addresses.

A matching current-attempt native binding releases only its own claim atomically.
Another unresolved allocation in the same namespace continues to quarantine
unknown discovery. Wrong scopes, duplicate bindings and stale callbacks cannot
release it. Uncertain owner loss or deletion without a proven binding retains
the claim across restart; deleting a saved payload does not prove absence of
native effects. Explicit evidence-based reconciliation remains required before
that uncertainty can be cleared.

The copied-native adoption API remains an explicit boundary for legacy imports
and SDK scaffolding; production new copies now save P before effects and bind
N through the common attempt owner. Neither import nor copy may infer which
unknown discovery belongs to unresolved startup.

These paragraphs record migration 20's quarantine prerequisite. Actual launch,
owner/host reconciliation and caller consolidation are now implemented as
recorded in the current sections above; broad receipts remain unadvertised.

### Saved launch choices and initial input identity

Migration 21 reserves one independent initial-input UUID with every fresh
creation's identity, payload and attempt. Request replay, explicit pre-effect
retry, deletion and profile reopen retain it. It is a message/receipt identity,
not the YA session id, native session id or startup attempt id. Older creation
rows remain readable and replayable with a null input id; migration does not
invent missing original launch choices or authorize dispatch of those records.

The private saved request can additionally carry a versioned launch-choice
snapshot: explicit provider model, client name, router selectors, tool rules,
recap/suggestion/helper settings, compaction choices, sandbox/network choice,
machine-control choice and selected global instructions. Permission patterns
and nested data are copied; unknown option fields, actor hints, environment
objects and desktop-control credential proof are excluded. Retired execution
and resume-only options cannot enter this new-session snapshot. The serialized
snapshot shares the existing 256 KiB request and 512 MiB profile payload bounds.
Changed saved choices conflict on request-key reuse; identical choices replay.

These are submitted choices, not current authorization or proof that a provider
has accepted input. Dispatch must separately revalidate the actor/grants, obtain
current credential proof, preserve settled account/sandbox facts and establish
provider-specific binding/consumption evidence. A stored machine-control flag or
source hint cannot recreate desktop credential provenance. Raw provider options
and child environments are not restored from the database. Runtime dispatch and
public creation capability remain gated by the rest of plan 171.

### Hosted creation contract — implementation refinement

The private host protocol remains version 3. Managed creation support is
negotiated separately as `session-creation-owner-v1`; absence refuses this
new launch shape before dispatch. Existing protocol-1 workers and their
controllers retain their original contract and lifetime. No host restart,
worker replacement, direct fallback or provider reselection is implicit.

A managed launch carries a version-1 `creation` record: YA `sessionId`,
`creationId`, `attemptId`, positive integer `generation`, original scoped
native namespace, chosen `nativeSessionId` (omitted for provider-allocated ids),
and independent `initialInputId`.
It carries no principal, credentials, grants or saved prompt. The authenticated
Hono owner validates this record against the current SQLite attempt and current
authorization; the worker holds only that launch's immutable copy. The host
claims the YA id before startup and retains the distinct native id and worker
identity. Native ids cannot be derived from agentctl's public-id publication.

Before receiving managed provider launch input, a new worker sends an IPC
`launchHello` with `protocolVersion: 1` and its supported launch features.
The host withholds stdin until that hello positively accepts the managed
feature. An old worker blocks reading stdin and therefore cannot accidentally
start a provider with an ignored new field. The existing bounded startup
deadline and verified worker-group cleanup handle missing/invalid hello.
The worker must never report ready before the input release. A Hono request
timeout is not proof of pre-effect refusal: it leaves the attempt uncertain
unless a completed host response proves both withheld input and verified reap.
Legacy launches still receive their original stdin immediately; an old host
ignores the new hello and continues its legacy behavior. Feature support is
not advertised until its complete owner/attach behavior is qualified.

Managed workers require socket protocol 2, while legacy workers continue
requiring protocol 1. Protocol-2 attach includes the exact immutable creation
record and is rejected before controller attachment or replay if it differs.
A protocol-1 controller cannot attach to a managed worker. A current controller
must validate the record and reconcile its saved fence before attaching; the
mapping itself grants no authority. No managed worker may enter legacy recent
runtime recovery that would resend its initial input.

The worker observes native identity and matching initial-input confirmation
before buffering or acknowledging provider output, independently of Hono's
lifetime. Only provider evidence qualifies: a native user UUID echo or the
already qualified main-thread Claude response stamp, never a queue pull.
Repeated identical binding/proof is idempotent; conflicting native identity
closes admission and fails the owner. Ready/attached state and host inventory
retain bounded evidence for the one creation attempt, including whether the
initial input was confirmed. Public-id publication and child authority always
use the YA id. Native events stay native until the Hono Process boundary.

Private `StartSessionOptions.publicSessionId` bootstraps the YA id into
AgentSelf/API leases and each provider's child bridge before native startup.
Native new/resume handles stay in their existing provider-facing fields. The
managed owner also publishes the public id through the returned session hook
before draining output or exposing readiness; publication failure closes
admission while retaining the actual session for cleanup. A later Hono RPC is
not the initialization boundary for child authority.

Reattachment never queues the saved initial input again. Positive surviving
owner evidence can reconcile an uncertain attempt only when the complete fence,
native namespace/id and input UUID match. Missing/dead owners or unknown input
effects remain uncertain and cannot launch a replacement. Existing teardown
verification remains authoritative. Admission after Hono detach is constrained
by the surviving worker's exact launch; new authority is checked in Hono for
each later accepted action.

The registry marks the selected provider owner as local or hosted; independent
adapters remain local. Admission freezes that choice as optional version-1
launch `runtimeOwner` (absence on older records preserves local selection).
Promotion and retry refuse an owner switch. An unavailable/older selected host
fails before dispatch, preserving the saved row without a direct fallback.

Host claim, attach confirmation and release include the exact creation record
and managed worker protocol. Missing/stale records fail before host ownership
changes; public publication never enters the legacy native bind operation.
The headless host and TS worker/proxy use one bounded plain-ESM private decoder.
Host inventory retains monotonic native/input evidence; managed workers are
excluded from legacy orderly-restart launch recipes.

Before new admission at Hono startup, one bounded transaction marks previously
unconfirmed dispatched attempts uncertain when their recorded controller is no
longer alive; attempts owned by a live controller remain untouched. Older
unconfirmed dispatched attempts without controller evidence retain the existing
uncertainty treatment. It reads compact control rows, not
saved prompts or provider history. Reattachment reconstructs its expected
namespace from the saved allocation/binding and compares the full worker fence.
It can restore observation/approvals while input is unconfirmed, without
queueing a message. Binding alone preserves uncertainty and input refusal;
only confirmation of the exact initial UUID atomically restores bound/consumed.
Full owner loss keeps uncertainty and the original prompt. Saved/queued attempts
that never entered dispatch become `failed`/`not-admitted` with `launch-refused`
on startup only when their recorded controller PID is confirmed absent: the old
controller's in-memory worker queue no longer exists. Legacy pre-dispatch attempts
without this evidence remain unchanged. A live/reused PID or failed liveness
probe conservatively suppresses recovery; no exclusive profile lease is implied.
Their public id, request identity, prompt and source remain available; repeated
admission returns that same result. This recovery performs no automatic native
launch or initial-input replay.

Implementation is split into a non-enabling startup-negotiation cut, then
owner evidence and protocol-2 attach, then saved-dispatch integration and owned
host/Hono replacement qualification. Mixed host/worker generations, forged or
stale attach, wrong native id, detached input consumption and owner loss are
required negative/positive checks. A feature must not imply support on Bun,
compiled Desktop or another platform outside the existing host matrix.

### Hosted native continuation

An existing bound native session uses the separate private
`session-native-binding-v1` feature and worker socket protocol 3. Its immutable
version-1 record contains only the YA id and scoped native reference. It grants
no creation or initial-input authority. Host claims, worker attachment and
release must match the complete record and protocol before changing ownership
or replaying output. The host claims P while native provider operations use N;
worker child/API publication uses P. Native output stays native until the Hono
Process projection. A conflicting native id fails the owner.

Hono rechecks the stored binding and deletion/current-attempt fence around
asynchronous admission, attachment and later input. Providers still validate
their physical native source before CLI effects; Gateway does so before worker
catalog readiness can autostart its service. Private storage-scope facts stay
inside controller inventory and are omitted from the public host inventory.

A surviving creation worker retains its exact protocol-2 creation attempt.
Unconfirmed first input never cold-starts another owner or replays saved text.
After the first input is confirmed consumed, a later explicit continuation may
start a protocol-3 worker from its proved native source if the previous owner
is gone. A surviving protocol-3 worker is reattached instead. An older host or
worker without the negotiated feature refuses the new transition without
restarting incumbents. Existing legacy workers keep protocol 1.

Orderly-restart recipes for protocol-3 continuations retain their exact native
binding and remove the prior launch's initial message. A fresh accepted turn
supplies its own input. Managed creation workers remain excluded from those
recipes. This contract does not advertise global creation receipts or expand
the supported host platform/runtime matrix.

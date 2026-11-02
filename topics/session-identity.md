# YA-owned session identity and startup lifecycle

Status: implementation in progress under plan 171. Typed identity storage and
bound Claude/Codex detail reads are implemented; launch behavior is unchanged.
Discovery/watch/source migration, durable admission and release qualification
remain pending.

[Plan 171](../docs/tactical/171-durable-session-identity-and-creation.md)
defines the implementation slices, isolated-profile qualification and requested
Sol 6.1 High review/commit loop. It is a plan, not implementation evidence.

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
  qualifies native sources only, preserving the frozen launch/protocol mapping
  and the open [ACP resume defect](../gaps/gemini-acp-resume-starts-new-session.md).
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
- New Claude sessions receive YA's chosen id through the provider launch
  option. This avoids an ordinary native-id change, but does not establish
  complete durable launch ownership or recovery by itself.
- Other providers can still replace a provisional id with their native id.
  The implemented [remap contract](session-id-remap.md) reconciles that change.
  OpenCode currently exposes its native `ses_*` id; see
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
| File events | All reviewed clients' broad file handlers compare the id extracted from `relativePath` with the viewed session id (`hooks/useSession.ts`, `lib/sessionFile.ts`). A native filename differing from the YA id can suppress that refresh path. All nine also have `useSessionWatchStream` for non-owned sessions; its focused change handler fetches without filename-id comparison. This is an existing compatibility bridge to qualify: resolve the requested YA id to the native watch target server-side, while keeping the subscription's YA identity. Owned-session pending/durable confirmation paths still need coverage. An additive canonical-id field alone does not fix old clients; do not falsify physical file paths to conceal the mismatch. |
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

**Attachments and Project Queue.** Text-only durable creation lands first.
Until durable claims exist, attachments retain legacy two-step behavior without
the new acceptance guarantee. The attachment slice seals immutable objects in
app-data, then commits claims with payload/operation; draft TTL cannot expire
claimed objects. Unclaimed sealed objects have bounded cleanup; materialization
has persisted intent and atomic file steps recoverable after restart. Retain
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

**Retained native fork/source bridge.** Ordinary creation rows require a YA
session id before effects. An explicitly tagged `retained-fork` operation may
temporarily have no resulting session id: it stores its bounded operation key,
parent YA/native reference, normalized target request source, ownership and
saved fork intent before native fork I/O. It consumes the same operation,
payload and attempt budgets in the common creation owner, not a separate queue
or journal. The archived generator records its own explicit internal reason;
it never supplies the target's source. No child public-id redesign is selected.

When native fork returns a child id, atomically adopt that existing-style public
child id, bind it to the operation and persist its original source/ownership
before resume or another fallible continuation. Worker refusal/cancellation and
resume exceptions therefore leave the retained child marked correctly. Repeated
requests recover the same operation. A crash before unique child evidence is
retained leaves the fork operation uncertain and must not call fork again.
Only authoritative captured result/owner evidence can reconcile the child;
parentage, title and provider-origin guesses cannot. A discovered child lacking
unique operation association remains unknown. That precise lost-native-result
crash window remains an explicit provenance-gap remainder until qualified
native correlation can close it; ordinary successes do not claim its closure.
This exception does not advertise fork support under the new ordinary creation
capability or relax new ordinary sessions' pre-effect identity requirement.

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

Public creation, actual durable launching, the remaining callers and capability
advertisement remain gated by the rest of plan 171.

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

Retained native fork/copy adapters may import their known successful owned copy
through the explicitly named copied-native boundary. It preserves their existing
child id and conflict checks; it does not infer which unknown discovery belongs
to an unresolved startup. The remaining pre-effect fork/provenance admission
work in plan 171 is unchanged.

This prerequisite does not enable durable launch routes or advertise a creation
capability. Actual dispatch, owner/host reconciliation and caller rollout still
require the remaining phase 4–9 implementation and qualification.

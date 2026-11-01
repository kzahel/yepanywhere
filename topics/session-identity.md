# YA-owned session identity and startup lifecycle

Status: direction selected by the maintainer on 2026-11-01; not implemented
beyond the existing SQLite metadata and caller-chosen Claude id work.
Schema, runtime/API changes and release qualification remain pending.

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

Choose the exact durable session/attempt schema, binding scope, retention and
capacity bounds, idempotency/payload transaction, retry behavior after each
failure boundary, legacy refresh accommodation, provider-host upgrade boundary,
and new route/status representation. Review the concrete contract/fallback
under the existing capability rules before editing it. Direction selection and
this research do not claim those choices or provider qualification are complete.

Acceptance evidence must include response loss, crash/restart on either side of
native launch/binding/input admission, discovery deduplication, existing-link
preservation, known failure versus uncertainty, router-pin continuity,
attachments, and old/new clients and servers. Cover hosted and in-process
ownership and genuinely different provider identity shapes. Reuse bounded
observation and existing dispatch; no per-attempt pollers or new general runtime.

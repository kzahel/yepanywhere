# Make creation provenance part of session admission

Status: recommended solution shape, recorded 2026-11-01 at the maintainer's
request for coordination with session creation/lifecycle work, and incorporated
into [plan 171](../docs/tactical/171-durable-session-identity-and-creation.md#creation-source-admission-and-coverage)
at the maintainer's subsequent request. No runtime, schema or wire change is
implemented by this note; exact contracts remain at the plan's design gate.

The recommendation is to require an explicit creation context and persist its
source with the logical YA session before provider side effects. A caller
should not be able to create a session successfully while forgetting a second
metadata write.

## Background and evidence

[Session creation provenance](session-creation-provenance.md) owns today's
descriptive `web`, `desktop` and `api` hints. Inbox's **Started via** filter
and Global Sessions use those hints. Missing provenance is presented as
Unknown / external; it does not prove that another application created the
session. Source hints are separate from authenticated creator facts,
limited-user ownership and parent/fork relationships.

On November 1 a user reported a session they remembered launching through YA
missing from the Inbox's YA UI filter. Read-only checks found the session in
the active tier, with no source field in SQLite or either API projection.
Provider metadata and server logs identified a new YA-owned session. Queue
events bracketed its launch, consistent with Project Queue dispatch, although
the original enqueue request was unavailable.

The [launch-path audit](../gaps/session-creation-source-missing-launch-paths.md)
is the evidence owner, including exact code entry points and verification
limits. It found these omissions in the current checkout:

| Path | Problem |
| --- | --- |
| Project Queue new-session targets | UI/API enqueue does not retain the request's source; dispatch records other launch metadata but no source. This includes the New Session form and session composer. |
| Source Control new review sessions | Review launch goes straight to Supervisor; the callback records review delivery only. |
| Fork after summary | The final navigable target receives settings and lineage but no creation source. The archived generator is a separate helper. |
| Native v0 and incoming peer creation | Trusted creator receipts are stored, but the descriptive API hint used by session filters is absent. |
| Maintenance diagnostic creation | The direct Supervisor launch omits API provenance. |
| Restart fork followed by failed resume | A transcript fork can survive queue refusal/cancellation or a resume exception before the route records its source. |

Ordinary direct creation, successful restart, stale handoff, ordinary fork and
clone have source writers. Direct/relay header handling and metadata projections
were also checked without finding another omission. Archived helpers and older
or externally discovered sessions have documented reasons to lack a UI hint.
The additional omissions above are source-audit findings, not passing live
reproductions. Their shared mechanism is clear enough to motivate an ownership
change without inferring the source of every old unmarked session.

## Why the current arrangement keeps missing cases

The route-local `requestCreationProvenance` and `recordNewSessionLaunch` helpers
in [sessions.ts](../packages/server/src/routes/sessions.ts) cover callers that
use them. Supervisor creation and fork entry points do not require creation
context. Review, queue and API owners can legitimately launch through other
paths, so they can omit the writer without a type error or failed admission.

Recording source in an `onStarted` callback also ties a logical-session fact
to a later runtime event. A retained fork or failed startup can exist before
that callback or the route's successful-resume branch. Deferred dispatch and
server restart further separate the original request from the process that
eventually starts it.

The missing invariant is: every newly admitted YA session has an explicit
source decision durably attached to it, including when provider startup never
succeeds. Updating each missed route alone would repair today's list while
leaving future entry points exposed to the same omission.

## Recommended ownership and data shape

Use the common application-level session admission owner being designed for
[YA-owned identity and startup lifecycle](session-identity.md). It should own
the permanent YA id, saved creation intent and creation context together.
HTTP handlers, queue dispatch, review submission, native API commands and
user-visible fork creation should enter through that boundary. Provider
adapters continue to own provider I/O and native binding; they should not
guess which human or automation surface caused a launch.

Require an explicit, validated context on every fresh-session admission.
An illustrative internal type is:

```ts
type CreationSource =
  | { kind: "request"; provenance: SessionCreationProvenance }
  | { kind: "internal"; reason: InternalCreationReason };
```

These names are illustrative, not a proposed public schema. `request` covers
normalized web/desktop/API provenance; native agent and peer APIs deliberately
choose `api`. `internal` requires a bounded reason such as an archived summary
helper. It can remain absent from today's public `creationProvenance` field.
There is no need to add a new public surface merely to make internal intent
explicit. An arbitrary string or a default `unknown` would weaken the check.

Keep authenticated principal/creator evidence, grants, limited-user ownership,
fork parenting, idempotency and receipts as distinct facts associated with the
creation. Reuse their existing owners and the
[principal vocabulary](principals-and-grants.md); do not introduce another
authentication context or derive authority from a client hint. A peer-created
session has an API surface and separately retains its authenticated peer facts.

The durable source is immutable for the logical session. Native binding,
startup attempts, explicit retry, resume and later messages do not replace it.
A new fork's source describes its own creating request, even if its parent was
created through a different surface.

## Admission, deferral and failure behavior

1. At request ingress, authorize and normalize the source once. Reuse today's
   bounded body/header rules where applicable. Keep live request objects,
   credentials and transport handles out of persisted intent.
2. For deferred work, save the normalized context with the accepted work.
   Project Queue must retain it through edits, retry, profile restart, worker
   deferral and attachment materialization. Later Start/Force start actions
   must not relabel the original work. Queue `createdFrom.client` is navigation
   context, not a web/desktop/API classification.
3. When the logical YA session is admitted, commit its source with identity
   and saved intent before provider start or native fork side effects. Use the
   selected local transaction/idempotency boundary. Refused persistence starts
   no provider; acknowledgement does not claim input consumption.
4. Dispatch the saved session/attempt through existing runtime ownership. The
   dispatcher consumes committed context rather than manufacturing a source
   from its own identity. A known-failure retry uses the same logical session;
   an uncertain effect still requires reconciliation.
5. Read source from durable session state in startup/failure/detail/list
   projections, including before a transcript exists. Publish collection or
   metadata updates after commit through existing event owners. Delivery of a
   browser event is not required for persistence.

The lifecycle plan must decide whether Project Queue allocates the logical
session at enqueue or only at promotion. Either can preserve source: the
durable queue intent must carry it until admission. This note does not change
queue scheduling, when a queued item becomes a session, or Inbox tiering.

Archived helper sessions should make an explicit internal decision. A
user-requested fork-summary target must carry request provenance even though
it was produced by a background job alongside an internal generator. Existing
session follow-ups retain their original source.

Legacy/import/discovery is a separate explicit boundary. Preserve old public
ids and existing metadata; genuinely absent source can remain absent. Do not
backfill from `originator: yep-anywhere`, provider-native ids or a parent:
those facts cannot distinguish UI, API and internal creation. Old queued items
without sufficient evidence should stay unknown rather than acquire the
identity of whichever client later starts them.

## How to make future omissions difficult

Make context required in the common admission signature and validate it at
runtime for untyped callers and persisted inputs. Newly migrated callers
should have no no-context convenience overload or default. Missing context
must fail admission before provider effects; the explicit legacy/import path
handles old data without weakening new creation.

Keep fresh-session creation beneath one owner. Low-level provider start/resume
and native fork functions still have valid jobs, but feature modules should
not use them to invent a logical session independently. During migration,
name and track remaining bypasses from the audit; required arguments in one
helper do not protect paths that never call it.

Retain a compact integration matrix through public/application entry points,
real SQLite/session metadata and collection projections. Use controlled
provider protocols, deterministic scheduling and owned temporary profiles;
no model call or browser is needed merely to check source persistence.

The matrix should cover UI/API queue admission across restart and worker
deferral, staged attachments, review creation, fork-summary's final target,
native local/peer creation, maintenance create and restart-fork failure.
Assert source survives reload and reaches the filters' input. Also retain
cross-surface parent/fork and existing-session resume cases, plus explicit
internal and legacy cases. Exercise missing-context rejection with no provider
effect and storage refusal before launch. Prefer shared fixtures and the
meaningful boundary/race cases under [test value and CI cost](../docs/development/testing.md#test-value-and-ci-cost)
over a separate mocked writer assertion for every caller. Cover both active
collections and transcript-less saved/failed sessions once supported.

## Coordination with the lifecycle implementation

[Plan 171](../docs/tactical/171-durable-session-identity-and-creation.md) is the
implementation-sequencing owner. Its initial lifecycle plan was independently
accepted by Sol 6.1 High; it now incorporates this note's source-specific
invariant, six-path coverage ledger and acceptance cases. This does not create
a competing lifecycle service or implementation plan, and plan acceptance is
not evidence that the provenance defect is fixed.

| Lifecycle work | Provenance input to carry into that work |
| --- | --- |
| Settle the durable schema and admission contract | Choose the creation-context representation, its local transaction with session/intent, explicit internal/legacy decisions and validation before side effects. Keep trusted receipts and grants distinct. |
| Persist startup intent (plan section 4) | Source exists on saved/failed sessions before provider init, native binding or a live callback. Context belongs to the session, not each retry attempt. |
| Unify callers (plan section 7) | Carry original request context through direct creation, Project Queue, review and native v0/peer APIs. Cover both immediate and deferred paths; remove their independent source-writing obligations as they migrate. |
| Qualify collections/recovery | Verify metadata survives binding, startup failure, restart and old/new client operation, with transcript-less rows as well as native history. |
| Remaining fork/helper work | Integrate provenance at new logical fork creation when that boundary is migrated. Keep fork-summary, restart-fork failure and maintenance creation tracked until actually covered. Plan 171 explicitly defers the full fork/clone redesign. |

Plan 171 selects logical session allocation at Project Queue promotion, with
normalized source persisted on the original queue item at enqueue. Its stable
promotion operation key recovers the same session after a crash. Start/Force
start does not replace that original source; old unmarked items stay unknown.

Before implementation, agree on these remaining decisions with that plan:
the exact common admission API, persisted internal reason representation,
which callers migrate in each slice, and how
remaining legacy creation paths are kept visible. A wrapper that merely calls
the current post-start writer is an interim repair, not completion of the
durable invariant.

Internal types/storage changes do not automatically require a new UI
capability. Any changed public request/queue/status contract still needs the
existing [capability and skew review](server-capabilities.md#minimum-compatibility-horizons),
including old queued records and absent fields. Do not broaden the meaning of
`session-creation-provenance` or advertise complete coverage because one caller
has migrated. The [current provenance contract](session-creation-provenance.md)
and the [gap's closure conditions](../gaps/session-creation-source-missing-launch-paths.md)
must be updated against the final implemented scope.

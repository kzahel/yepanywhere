# Server-addressed HTTP API v0

Topic: http-api-v0

Status: local reads/following, native creation/queued prompts, directional
peer access, target-owned forwarding and basic session controls are implemented.
Revision `2026-11-13.1` adds target help/schema, opaque peer operations,
header-based retry keys and requests/respond/cancel/stop under
[plan 192](../docs/tactical/192-v0-session-control-and-peer-contracts.md).
The API remains alpha and deliberately unstable. Release priority is unchanged.

## Implemented local read contract

The ordinary app mounts `/v0`, `/v0/schema`, `/v0/me`, `/v0/servers`, and the
self server's description, access, capabilities, projects, providers, sessions
and single-session detail routes. Unknown targets never execute locally.
Compact conversations/following and separately authorized creation, messaging,
receipts and provenance are specified below. Other planned resources remain
absent.
Existing `/api/*` and the separate own-session listener retain their contracts.

Operator calls to the existing `relationships` resource can opt into the local
structural projection with `includeRelated=true`. Its optional `related` field
uses the [durable relationship page contract](session-relationships.md#operator-http-projection),
with independently named `relatedLimit` (1–100), opaque `relatedCursor`,
`relatedDirection` (`incoming`, `outgoing`, `both`; default `both`) and
`relatedType` (one known relationship predicate). Direction/type apply only to
the related page and are bound into its cursor; changing either requires
starting without that cursor. Invalid filter values return 400. For example,
`?includeRelated=true&relatedDirection=incoming&relatedType=created_session`
reads accepted creation parents without changing receipt history.
Receipt `limit`, numeric `cursor`, creation, initiated commands and outbound
ledger retain their existing meanings. Without opt-in, no graph query runs.
Absence of `related` on an older server means unsupported, not known empty.
Peer projections and limited-user provenance restrictions remain unchanged.
This local projection adds no remote traversal or new grant.
An opted-in related-section error fails the whole reply; retry from a fresh
related page, or omit opt-in to read receipts alone. This additive optional
projection originally kept revision `2026-11-01.1`: absence is its compatibility signal,
and existing access servers need no revision-only upgrade for receipt reads.
Unreleased source builds that first introduced `related` can ignore the later
direction/type filters; no stable release contains that intermediate contract.
Callers needing those filters against arbitrary source builds must validate
returned predicates/directions or consult the generated query schema.

- `/v0` returns public server id, current revision `2026-11-13.1`, unstable status and
  discovery links. The documentation slice adds Markdown
  help at `/v0/help`, links help/me/schema from discovery, and generates field
  descriptions, operation semantics and example requests alongside OpenAPI.
  `/v0/schema` generates OpenAPI 3.1 response/query schemas
  from the same Zod definitions used by the read surface. These schemas describe
  this subset, not every planned route in the table below. The documentation
  slice is implemented. The local agent runtime factory below adds launch
  binding; automatic provider advertisement/integration is implemented for qualified launches.
  Help/schema inherit the normal host's authentication policy, including
  configured auth-off localhost behavior; they do not introduce an independent
  credential requirement on that existing listener.
- `/v0/me` returns the resolved superuser/limited principal and `session: null`.
  Current operator cookies/tokens do not prove which agent session is calling;
  user-supplied ids or headers cannot establish that binding.
- Access describes all-project versus project-grant scope and implemented
  read operations. Existing limited-user project grants, creator access to
  their own sessions, and personal hidden-project list behavior apply. Catalog
  filtering precedes pagination; hidden lists do not revoke direct access.
- Projects use the existing retained project projection. Providers are exposed
  harness descriptors and supported steering/permission controls; this endpoint
  performs no installation/authentication/model discovery. Explicit launch catalog discovery is available through `selection`,
  described below. Sessions are retained native-catalog summaries with current
  metadata/runtime overlays, not full transcripts or messages.
- Catalog responses report `complete` and `refreshing`. A missing detail in an
  incomplete catalog returns `503 catalog_not_ready`; a missing or inaccessible
  session in a complete catalog returns `404 session_not_found`. Ambiguous native ids
  spanning projects are rejected before session-wide project metadata is applied,
  and projected collisions are also omitted. They cannot select one project's
  detail. Session ordering compares timestamps chronologically across fractional
  precision and timezone offsets, with the session id breaking ties.
- Collection defaults are 50 items, maximum 100. `cursor` is a nonnegative
  decimal offset; `projectId` filters sessions. Offset pages are best effort
  across concurrent catalog changes, not snapshots. Response item count is
  bounded by page size, while filtering/sorting still visits the retained
  projection and the existing catalog owner governs acquisition cost. No new polling or discovery service is created by this API.
- Successful route responses are non-cacheable. V0 errors contain
  `{error: {code, message}}`; existing host/auth/limited-user middleware may
  reject earlier with its existing JSON/text errors. Private exception text is
  not returned. Source cancellation is passed as an AbortSignal; this does not
  cancel refresh work independently owned by the shared retained catalog.

### Server names and host details

Revision `2026-11-01.1` adds optional `label`, `hostname`, `os`, `architecture`
and `icon` to server descriptions in `/v0/servers`, `/v0/servers/:serverId` and
`/v0/me.server`. The persistent `id` remains the only routing identity. Names
can collide or change; display facts do not authenticate a host or guarantee
its installed providers, capabilities or project access.

Local descriptions use a cheap injected metadata source, without starting
catalog/provider discovery. The application reports its current OS hostname,
platform, architecture and configured host icon. Peer collection entries use
last-recorded authenticated host facts and the access server's friendly alias.
Listing starts no peer probes and does not claim those hosts are online. Only
peers already addressable to this caller/launch are included, with existing
expiry, selection and agent-use filtering before pagination. Incoming-only,
unselected or otherwise unauthorized peer records are not an extra directory.

An individual peer description uses the existing protected request to that
selected target. Current reported fields override saved host facts; absent
fields from older peers use any saved facts, and unknown fields remain absent.
Its `label` is always the access server's saved alias, independent of target
reports. The reported target id must match the authenticated target id. Display
projections whitelist bounded strings and never include credentials, setup
routes, login names or private connection records.

The new fields are optional and do not change existing routes or grants.
Capability replies report the receiving build's revision as descriptive text;
compatible peer replies are checked against their operation schema rather than
requiring identical dated API revisions. An old build can omit these display
fields without losing addressability from this updated access server. Older
access-server builds that enforce exact capability revision matching still need
to be updated when talking to a newer peer build. No hosted-client capability
or browser connection change is needed for this API-only addition.

The public id is a fresh UUID stored in singleton `public_server_identity` in
the profile's existing SQLite database (migration 13). Transactional insertion
preserves the first id across concurrent handles and restarts. Invalid identity
data fails initialization without regenerating it. Backup restoration preserves
identity. There is no clone/reset command yet: running a copied profile as an
independent second server requires separate identity provisioning before peer
routing is enabled. The relay `installId` is unchanged and never reused here.

V0 shares the app's host/CORS/custom-header, operator authentication and
limited-user principal resolution. Socket-free fixtures inject the principal
at their trusted composition boundary; that is not production network auth.
The auth regression enumerates v0 as well as existing API routes. No hosted
frontend depends on v0 and no existing capability changes meaning. The current
stable corpus (v0.11.0/v0.10.2 plus optional-window v0.10.0/v0.10.1) has no v0
promise; callers discover it directly and treat absence as unsupported. No
compatibility shim, SRP change or new peer credential is introduced.

## Product boundary

Expose YA's projects, providers, sessions, messages, permissions and authorized
hosts through an understandable HTTP API. Agents decide how to arrange work:
create a worktree, prepare a checkout, choose a model, launch another session,
poll or observe it, and collect the answer. YA records facts and enforces access.

This direction supersedes the custom worker/delegation service as a prerequisite
in [cross-host delegation](cross-host-delegation.md). A created session need not
be a child task. Creation does not imply automatic result delivery, parent
wakeups, cancellation propagation, repository transfer or managed worktrees.
Session migration remains the distinct [super-session proposal](federated-super-sessions.md).
A session created by a session routed through the
[Agent Auth Router](agent-auth-router.md) runs on the caller's pool (a fresh
pick with the caller's policy) or explicit account (a new pin), with the
caller's model when the request names none; another provider is refused with
`admission_rejected` and the reason. It never falls back to the owner's
direct login (plan 183).
Scheduling remains valuable separate work under [Yacron](yacron.md), using the
same supported session operations when implemented.

## Development version and discovery

Use `/v0/`. It is explicitly unstable: routes, fields and behavior may be added,
changed or deleted during development. There is no additive-only compatibility
promise and no automatic promotion to stability. Introduce `/v1/` only by a
deliberate stability decision. A descriptive schema revision and source/build
identifier aid diagnosis without requiring a permanent adapter for every v0 build.

`GET /v0` reports the receiving server's public id, unstable API status and
revision, and links to its machine-readable schema and available resources.
The schema describes supported operations, bounds, errors and examples without
requiring the YA source checkout. Discovery reports implementation support
separately from effective caller permissions and reachability.

`GET /v0/help` serves a short Markdown introduction, the resource
model and executable examples for implemented operations. Operation summaries,
descriptions, field semantics, errors and examples should live with the
operation contracts and generate both the readable reference and OpenAPI.
Identity/access discovery alone is not sufficient documentation. See
[the review plan](../docs/tactical/166-agent-api-bootstrap-and-documentation.md)
for delivery and acceptance evidence.

`GET /v0/me` describes the authenticated caller. A launch-bound session credential
may identify its owning `{serverId, sessionId}`; an ordinary operator or peer
credential need not name a session. There is no ambient "current session"
inferred from the port, most recent activity, cwd or a model-supplied id.
This replaces the earlier, overloaded `/context` sketch. Bootstrap can provide
the API address and owning ids directly; callers query `me` when useful.

The existing opt-in own-session listener's `/v1/self` and `/v1/view` are a
different, narrow API ([agent self](agent-self.md)). V0 must not silently widen
those credentials or take over that listener's paths.

## Identity and addressing

A public `serverId` identifies a logical YA data/profile instance. Generate an
opaque id independently of network setup and persist it across upgrades and
restarts. Separate profiles receive separate ids. A copied profile intended to
run as a second independent server needs a new identity; backup restoration of
the same logical server preserves it. Exact persistence and clone/reset entry
points must be specified before implementation.

Do not use the relay-ownership `installId`, an SRP username/session id, a URL,
browser source key, hostname or display label as this public id. The existing
[source identity seam](client-source-runtime-topology.md#sourceruntimeregistry)
and [mobile pairing contract](mobile-server-pairing.md#deferred-installation-identity-and-route-continuity)
already distinguish public identity from relay registration and authentication.
An id names a resource; authenticated pairing binds a route to that identity.

All server-owned resources include the target in their path, including local
requests. Examples below are proposed routes, not installed endpoints:

| Method and path | Meaning |
| --- | --- |
| `GET /v0/servers` | Servers addressable by this caller, including self |
| `GET /v0/servers/{serverId}` | Server description and connection status |
| `GET /v0/servers/{serverId}/access` | Effective access for this caller at that server |
| `GET /v0/servers/{serverId}/capabilities` | Implemented API/provider capabilities |
| `GET /v0/servers/{serverId}/projects` | Authorized registered/discovered projects |
| `GET /v0/servers/{serverId}/providers` | Available providers/models and relevant options |
| `GET /v0/servers/{serverId}/sessions` | Bounded, filtered session catalog |
| `POST /v0/servers/{serverId}/sessions` | Create a native YA session in a selected workspace |
| `GET /v0/servers/{serverId}/sessions/{sessionId}` | Session facts and state |
| `GET /v0/servers/{serverId}/sessions/{sessionId}/requests` | Pending permission/question input |
| `POST /v0/servers/{serverId}/sessions/{sessionId}/requests/{requestId}/response` | Answer permission input |
| `POST /v0/servers/{serverId}/sessions/{sessionId}/cancel` | Existing YA interrupt behavior |
| `POST /v0/servers/{serverId}/sessions/{sessionId}/stop` | Verified provider shutdown |
| `GET /v0/servers/{serverId}/sessions/{sessionId}/conversation` | Bounded visible history |
| `POST /v0/servers/{serverId}/sessions/{sessionId}/prompts` | Submit input with explicit supported delivery semantics |
| `GET /v0/servers/{serverId}/sessions/{sessionId}/relationships` | Recorded provenance and optional related-session links |

A `sessionId` is the session's YA id for its whole life: collections, detail,
receipts, relationships and conversations name a session by the id its
creation receipt reported, while its process runs and after it ends. A provider
that names its own conversation, such as a Codex thread id, never replaces
that id, and the same session is never listed twice under both spellings.
[Session identity](session-identity.md) owns the binding.

Choose explicit observation, pending-input and interrupt/stop operations before
their implementation. Do not hide them in ambiguous configuration patches.
Root collections make sessions directly addressable without redundant project
ids; project filters do not imply one global project identity across hosts.
The schema defines pagination, field mutability and provider limitations per
operation. Unsupported queue/steer behavior must be explicit, not silently
translated into another delivery choice.

## Compact conversation reads

Implemented in revision `2026-10-30.4`: `GET
/v0/servers/{serverId}/sessions/{sessionId}/conversation` returns stable message
ids, exact visible prose/Markdown, observed activity, bounded failure/media
references, read-only pending attention, coverage and an opaque content revision.
It excludes routine tool bodies, thinking and rendered HTML. This is a filtered
projection, not an LLM summary or a completion verdict. Truncation, byte limits,
recent-two-compaction scope and unknown evidence remain explicit. `idle` does not
establish successful completion. Provider/history shapes outside acquisition
support return `503 conversation_unavailable`; no native history is guessed.

`maxMessages` is 1–100, default 20. `anchorMessageId` selects an existing stable
visible message; an unavailable anchor returns `404 anchor_unavailable`, without
silently moving to the latest window. Unknown window parameters fail. The
served help and OpenAPI schema describe the same bounds and examples. A launch
read lease can read this surface; no creation, sending or approval authority is
added by this slice. Resource access is checked before acquiring history.

Reads use the existing shared conversation observation owner. They add no
independent scanner, permanent poll loop or per-token transcript read. A request
that cannot obtain its first publication within four seconds releases demand
and returns unavailable, within the private controller bridge's deadline.
Final-consumer removal cancels source work and releases watches/viewers.
An exact managed Claude/Codex owner may precede retained catalog materialization:
its summary and bounded replay are immediately usable, with incomplete history
coverage. A later catalog row reconciles normal durable history. Unsupported
owners and mismatched/ambiguous identities never supply guessed history. Native
acquisition constraints are owned by [Simple Client API](simple-client-api.md).

## Bounded HTTP following

Implemented in revision `2026-10-30.5`: `GET
/v0/servers/{serverId}/sessions/{sessionId}/conversation/follow` uses the same
window parameters and authorization as a compact read. Without `after`, it
returns the initial compact view, a cursor, `changed=true` and `reset=true`.
Reissue with that cursor in `after` and the same window to wait for prose,
failures, pending attention, activity or coverage to change. Tool-count-only
updates do not wake the wait. Finalized prose is sufficient; token streaming
is not promised.

`waitMs` is 0–4000, default 4000, after the first observation. Initial
acquisition has a separate four-second deadline, so a request takes at most
eight seconds. An unchanged wait returns the same cursor, `changed=false`,
`reset=false`, `conversation=null`; retain the previous view. Changed responses
contain one full bounded compact replacement with `reset=true`. Consumers must
replace their selected window, including removals/rewinds. Cursors are scoped
to server, session, visible content and window, with no retained cursor registry.
A foreign/stale cursor in the current format returns explicit replacement
state. A malformed or unsupported cursor format returns 400. This contract
promises current-state recovery, not event-log replay or every intermediate
message. Coverage still describes retained history limits.

One request owns at most one response and one bounded wait. There is no SSE/PTY
or permanent per-client loop in this slice. Identical requests share source
acquisition and coalescing. A disconnect, deadline, controller replacement or
launch-credential revocation cancels demand; the final consumer releases the
source/watch/viewer. Active private reads revoked or detached return 503 where
the transport remains writable; later revoked-credential requests return 401.
Slow readers cannot accumulate repeated snapshots or keep observation alive
after the one response has been selected. Clients own retry/backoff and should
use bounded waiting rather than a tight zero-wait/error loop.

## Session command authority

Implemented in revision `2026-10-30.6`, behind **Agent session commands** in
Settings → Local Access (`agentApiManagementEnabled`, default false). This
setting is independent of read-only **Agent API discovery**. It enables v0
native creation and messaging for ordinary authenticated operators and grants management to
new eligible local agent launches when discovery is also enabled. Existing
read-only leases remain read-only. `/me` records `management=true` only on an
explicit management lease; `/access` lists credential-authorized operations.
Missing management authority returns 403, and a management launch whose owning
session is not yet bound returns `409 identity_pending`. Caller JSON/headers
cannot supply creator identity or command authority. Limited users cannot use
these command/audit surfaces in this first profile.

Turning discovery off, or turning management off, revokes current profile agent
API leases, including active waits. Turning management on does not upgrade old
leases. Enablement is rechecked immediately before durable admission after
asynchronous catalog lookup. Already accepted native work remains target-owned;
revocation/disconnect is not rollback, process termination or an automatic retry.
A hosted provider launch requires the distinct `agent-api-management` host
feature; an older source host must be restarted before issuing management
leases. In-process paths do not require that host. UI support uses a distinct
optional `agent-api-management` capability; older servers hide the command
setting and receive no unsupported field. This adds no peer grants or remote
access and retains the existing supported-release/transport horizons.

### Creation and retry receipts

The selected [YA-owned session identity](session-identity.md) follow-up and
[web creation proposal](session-creation.sketches.md) reuse receipt/admission
concepts below, but are not current v0 guarantees. In particular, today's
receipt does not retain the prompt/attachments or establish a durable YA
session before dispatch. Preserve v0 state meanings, authorization and native
input semantics when extracting shared implementation; the web contract needs
its own capability rather than broadening `agent-api-management`.

`POST /v0/servers/{serverId}/sessions` accepts an `Idempotency-Key` header
and strict JSON with `projectId`, `provider` and exact initial `prompt`. Optional model,
thinking/effort, permission mode and service tier map to incumbent native
launch controls. Permission mode defaults to `default`; bypass must be explicit.
Only configured local Claude/Codex providers and catalog projects are qualified.
Blank creation, remote executors, worktree/cloning policy, managed delegation,
terminal execution and provider upgrades are outside this slice. Global agent
context and native launch ownership/admission remain shared with existing YA
sessions. V0 asks for settled native identity before reporting an accepted
canonical session id. Fork and /btw parenting remain separate from creator facts.

The response is `202` with a durable receipt before native launch completion.
Use a caller-generated 8–128 character retry key and repeat the identical body
after response loss. Scoped retry identity includes authenticated principal,
origin server/session, operation, target project/session and request id; a new
provider launch of the same originating session can recover the same receipt.
The first originating launch id stays in the audit record. Conflicting payloads
return `409 request_id_conflict`. Existing identity is resolved before mutable
catalog/provider checks; disabling a provider or removing a project cannot
make an authorized retry launch a duplicate. There is no automatic side-effect
replay, provider restart or fallback routing.

`GET /v0/servers/{serverId}/receipts/{receiptId}` observes `dispatching`,
`queued`, `accepted`, `failed` or `uncertain`. These describe admission evidence,
not successful response completion. Native capacity rejection is recorded as a
known failure. An exception after reservation, queued startup failure, or an
unfinished reservation recovered after restart is uncertain; never generate a
new retry key merely to escape that uncertainty. Unique live-owner API-input
admission/consumption evidence can reconcile a target binding without launching
again. Inherited transcript UUIDs and optimistic user echoes are not admission
proof. Missing, evicted or ambiguous evidence remains uncertain. Cancellation
after reservation cannot assert that a provider was never launched.

Receipts persist in the profile discovery SQLite database, separately from
native transcripts and existing client creation hints. They contain no prompt
bodies or credentials. The implementation retains at most **10,000 receipts**,
with no silent expiry or deletion; further new requests fail capacity rather
than forgetting retry identity. Replays and reads remain available at capacity.
At most 16 native admission promises run concurrently, and native Supervisor
queues retain their existing limits. No new background poller or workflow queue
is added. Creation provenance and retry keys survive profile restart. Alias
reconciliation is bounded to 32 hops and updates both relationship ends. Future
retention/export/pruning needs its own explicit idempotency-window contract.

`GET /v0/servers/{serverId}/sessions/{sessionId}/relationships` returns the
first recorded v0 creation receipt and a bounded page of initiated command
receipts. `creation=null` does not prove that an older session was human-created.

The [durable relationship design](session-relationships.md) proposes a shared
application read model for these trusted creator facts, provider children and
YA lineage. It preserves the receipt owner and does not reinterpret initiated
message commands as parent/child creation. No response fields or authorization
rules are changed by that proposal; extensions need their explicit contract.

Both ends retain source/destination public server ids, trusted source session,
launch, principal, request id and time. Source/destination are currently this
same local profile; server-granted peer identity and cross-host routing remain
future work. Audit reads require operator authority and never disclose related
private session ids to limited users. Canonical-id remaps share a multi-subscriber
Supervisor observer so provenance does not replace existing issue remapping.

Help and schema support `?operation={operationId}` for a concise operation
reference/request schema; the full reference remains available without it.
Request bodies are limited to 256 KiB before command dispatch. When an early
network rejection closes an upload, clients may observe a transport error;
no oversized request may reserve or launch work.

### Attributed queued input and consumption

`POST /v0/servers/{serverId}/sessions/{sessionId}/prompts` accepts strict JSON
`{prompt,delivery?:"queue"}` and an `Idempotency-Key` header. It uses the same explicit management
opt-in, trusted origin and durable scoped retry rules as creation. `prompt`
is nonblank exact text, at most 100,000 characters. Only the incumbent active
native owner can accept a new input; otherwise return `409 session_not_running`.
There is no implicit resume, interruption, steering, mode/model change or provider
restart. An authorized identical retry resolves the original receipt before
looking at the mutable catalog or checking whether its process still runs.
A conflicting body/key returns 409; no input is repeated.

A `202` receipt's `state=accepted` means native queue admission. `delivery=unknown`
awaits evidence. `delivery=consumed` means the native provider input iterator
consumed that API input; it does not mean provider acknowledgement or successful
response completion. Native batching can consume several submitted messages in
one turn, including interrupt concatenation. Internal constituent identities
survive that batching and hosted queue notifications. They are server-stamped;
the public request body cannot supply submission/origin metadata. Queue removal
or a user echo alone never establishes consumption.

When an owner completes, aborts or detaches, or existing session controls remove
unconsumed input, `delivery=uncertain` is explicit. Restart conservatively marks admitted but
unconfirmed delivery uncertain. Receipt reads/follow can reattach to a uniquely
identified incumbent owner and reconcile positive admission/consumption evidence;
they never automatically requeue input. Each process/queue retains at most 512
positive API identities for this reconciliation; absent evidence is inconclusive.
Native observation shares one monitor per process, bounded to 128 processes and
1,024 pending API inputs, and releases after consumption, cancellation, completion
or command service shutdown. No transcript poller is added. `completion=unknown` remains
explicit for every receipt; idle or an unrelated reply does not complete it.
Follow the session's compact prose to interpret the response.

`GET /v0/servers/{serverId}/receipts/{receiptId}/follow` is operator-only like
receipt reads. The first request returns `{cursor,changed:true,receipt}`. Reissue
that opaque `r1` cursor as `after` with `waitMs=0..4000` (default 4000) to wait for
admission, consumption or provenance changes. Unchanged returns
`{cursor,changed:false,receipt:null}`; retain the previous receipt. Every changed
response is a complete replacement; foreign/stale cursors return current state,
malformed cursors/unknown parameters return 400, and missing receipts return 404.
The store admits at most 128 receipt observers. Disconnect, lease revocation,
command-owner shutdown and finite wait completion release demand. Observer
notification occurs after the durable transaction commits; no event log or every
intermediate transition is promised. Existing command work outlives the reader.

## Local agent runtime factory

Implemented independently of provider/UI integration, 2026-10-30. A provider
owner can construct a bounded runtime with a fixed public server id, issue an
operator catalog-read launch lease, and attach an existing CoreApi controller.
Restricted principals are not eligible in this first profile. The Unix adapter
creates a fresh private mode-0700 runtime directory and mode-0600 socket; native
Windows selects an OS-assigned IPv4 loopback port. No legacy API, browser cookie,
desktop bootstrap or unauthenticated localhost fallback is mounted.

Every request, including help/schema, requires its registered launch bearer.
Browser origins and non-loopback Host names are rejected. Credentials are
stored as digests in a registry capped at 1,024 live/retained leases. They expire
after 24 hours; only a trusted provider owner can renew them. Disposal, runtime
shutdown and revoke-all invalidate credentials; renewal cannot revive revoked
ones. This is API authorization, not isolation from a same-user shell.

`/v0/me` returns server identity, observation time, discovery links and the
credential's owning `{id, launchId}`; `id` is null until canonical binding.
Ordinary app authentication still returns `session: null`. Caller-supplied ids
cannot change that binding. The agent schema describes mandatory bearer auth.

Own-context/help/schema and local server facts do not require a catalog
controller. Catalog reads return `503 controller_unavailable` while detached,
at the bounded catalog concurrency ceiling, or when their attachment becomes
stale. Detach/replacement promptly cancels HTTP waiters and aborts source work
where supported; both stale errors and successes are rejected. Each attachment
has its own generation even when it reuses the same CoreApi object. Source
owners may retain independently shared work. Six real-transport regressions
cover identity, auth, lease lifecycle and controller handoff races. The bundled
macOS Bun 1.3.14 binary also passed Unix/loopback source-adapter smoke checks;
this is not native Windows or complete packaged-provider qualification.

## Local agent bootstrap

**Agent API discovery** in Settings → Local Access is independently configurable
and default-off. Enabling it gives new eligible local, unrestricted Claude-family
and Codex bypass-permissions launches a private connection, a launch credential
and the exact previewable instruction exported by
`packages/shared/src/agent-api-bootstrap.ts`. Restricted and remote-executor
launches receive none. This is the existing v0 read catalog, not a grant to future
writes or legacy `/api/*`. Turning it off revokes current access; turning it on
again applies to new launches. Old servers omit the control through the separate
`agent-api-bootstrap` capability (introduced in the 0.11.1 line).

The bootstrap enters native Claude system context or Codex developer context;
it never prefixes the submitted user request. Its stable text tells the agent
to discover current grants from `/v0/me`. Codex history can expose the exact
fragment through a collapsed informational disclosure. See
[placement and resume behavior](agent-context-injection.md#http-v0-bootstrap-placement).

Connection variables are `AGENT_YA_V0_URL`, `AGENT_YA_V0_SOCKET` (Unix only)
and `AGENT_YA_V0_AUTHORIZATION` (the complete `Bearer …` header value). They are
separate from the unchanged legacy self/view `AGENT_YA_API_URL/TOKEN` and from
the broader legacy operator `AGENT_SERVER_TOKEN`. An old self-only credential
cannot acquire catalog authority. No actual credential is injected into prompt
text, written to YA's shell bridge, exposed in the environment viewer, or sent
through worker launch recipes. Both provider environment filters remove an
inherited v0 family before an explicitly authorized new launch is injected.
Native child tools inherit their owning YA session, not a new session identity.

On macOS/Linux, the HTTP adapter owns a fresh mode-0700 temporary directory and
mode-0600 socket. Native Windows uses a random `127.0.0.1` TCP port with bearer
authentication on every route, including help/schema. The URL is a syntactic
origin when curl uses the socket; no DNS or TCP access is required. The transport
factory also supports loopback on Unix for qualification. These listeners mount
only v0, reject browser Origins and do not use desktop master credentials.

```sh
curl --unix-socket "$AGENT_YA_V0_SOCKET" -H "Authorization: $AGENT_YA_V0_AUTHORIZATION" "$AGENT_YA_V0_URL/v0/me"
```

```powershell
curl.exe -H "Authorization: $env:AGENT_YA_V0_AUTHORIZATION" "$env:AGENT_YA_V0_URL/v0/me"
```

Codex's default shell environment excludes names containing TOKEN, KEY or SECRET;
the header variable remains policy-admitted without widening that user policy.
For API-enabled Codex threads YA disables `shell_snapshot` and
`shell_snapshot_v2`, since snapshots can persist admitted values to disk. A
user's stricter environment policy may still hide the connection; instructions
say to report unavailable access instead of guessing another port or credential.
Other provider persistence, user shell startup scripts and agent-written files
are outside YA's guarantee; a full-shell agent can intentionally inspect its own
environment. This is attribution and authenticated access, not a shell sandbox.

The provider owner holds a bounded shared runtime per logical profile and one
24-hour lease per launch, renewed on observed SDK activity without heartbeat
loops. Abort/end revokes and releases the runtime when the last launch ends.
Disable is sticky across pending starts and applies by public profile id to
hosted workers. `/me`, help/schema and local identity stay available while a
hosted controller detaches; dependent catalogs return retryable
`controller_unavailable` until a matching controller attaches. A controller
that cannot parse its worker's request can only be a different version of the
same code, since the worker validated it first; it answers
`503 controller_unavailable` naming the version mismatch and the restart that
resolves it, never a `400` that blames the caller. The authenticated
worker socket dispatches only bounded catalog reads; stale replies and stalled
reads are cancelled. An older source host without revocation support must be
restarted before launching with this option. In-process desktop/Windows paths
do not enable the source provider host.

The desktop application still starts bundled Bun on loopback HTTP and loads its
web dashboard in Tauri. Native code bootstraps the browser session; dashboard
traffic uses HTTP/WebSocket. The private agent adapter is independent of that
listener and does not require a Tauri IPC transport.
[Desktop contract](desktop-v0.md#local-dashboard-authentication) owns that boundary.

Evidence: real curl bootstrap, credential separation, owner detach/reattach,
actual host/worker socket dispatch and revocation, plus desktop/phone preview and
sequential typing checks. macOS Node and bundled Bun source-adapter checks pass.
Native Windows PowerShell, Linux, packaged provider/tool invocation and crossing
native Windows/WSL remain qualification work; transport tests on macOS do not
establish that parity. Broader onboarding, peer grants/routing, additional session commands,
command execution and PTYs remain separate proposals.

## One HTTP surface across routes

An access server can receive `/v0/servers/B/...` and reach B through an
authorized connection. A direct call to B uses the same server-addressed path.
The resource owner remains B. Caller APIs do not gain `delegate`, checkout
placement, result-collection or workflow policy merely because B is remote.

The first slice handles the receiving server only. An unknown/unconfigured
target fails explicitly; it never falls back to local execution. A later slice
adds an injected peer directory and a request transport for the supported v0
surface. Target ids resolve through configured relationships, never arbitrary
caller-supplied URLs. A transit request cannot chain through the target's other
peers. One connection/request implementation can use direct HTTP initially and
SRP/encrypted relay later. No CLI, Tailscale or public relay is required for
local tests. Relay remains the intended usual remote-install route.

The target's own API revision and capabilities govern its operations. Routing
through a newer access server does not imply remote support or authorize
invented translations to older UI routes. Expose reachable/unreachable,
unauthorized and unsupported separately. Do not replay a possibly accepted
mutation on another route without its defined idempotency behavior.

## Isolated two-peer adapter

Revision `2026-10-31.1` adds an independently constructible v0 peer receiver,
router and durable outbound ledger. This is development enrollment: normal YA
startup does not install the peer receiver or issue peer-capable launch leases.
Production enrollment, HTTPS/SRP/relay qualification and grant UI remain later
work under [plan 168](../docs/tactical/168-peer-access-and-enrollment.md).

The isolated receiver authenticates a distinct high-entropy peer bearer into a
v0-only `peer` principal with explicit operation/project grants and expiry.
It exposes no legacy `/api` routes. `GET /peer/id` identifies its public profile;
this is configuration error detection, not cryptographic authentication. The
HTTP adapter requires HTTPS except explicit loopback fixtures, checks identity
before credential release, refuses redirects and checks response identity and
operation schemas. HTTPS credentials rely on normal certificate validation;
plain loopback evidence does not qualify production enrollment or target proof.

A source router lists configured outgoing peers only for an operator, or a
launch with separately issued `peerAccess` plus management authority and a bound
session ID. Existing read and management leases do not gain peer access.
Limited users and incoming peers cannot route onward. Local capabilities report
whether this adapter is available; the remote target governs its own operations.
There is no automatic retry, route failover, SSH or workflow orchestration.
Request bodies have a cancellable ten-second acquisition deadline and 256-KiB
cap, including when a sender never finishes an upload. Revocation releases its
slot even if that stream's cancellation promise does not finish. Outgoing
requests have a ten-second deadline and two-MiB response cap; each directory
holds at most 64 peers and each receiving/source owner at most 128 live requests.
Idle directories schedule no work. Expiry is checked at admission and response;
revocation aborts current observations and blocks new admission. It leaves
already admitted native agent work intact.

The target checks originating-peer identity and current project grants on
receipt reads, follows, mutation retries and provenance. A receipt for an
existing session also requires current access to that session. Native
admission can name a session before it starts or refuses it. Until the target
accepts the creation, the peer that requested it can read and follow the
receipt through `dispatching` and `queued`, and a refused creation stays
readable: its `failed` state and failure explain the refusal even though the
named session never existed. An `uncertain` creation is readable the same way
while its named session is listed in no project; once that session exists,
current access to it is required again. One peer cannot
read another peer's receipts even if both may view the same project. A peer's
relationship response exposes only its own creation receipt and no target-local
initiated relationships. The operator retains the full local view. Foreign
source IDs neither resolve through local aliases nor appear in local-only
native input metadata or initiated queries.

Before sending a mutation, the source reserves a bounded durable outbound
record keyed by source server/session, destination server, operation/resource
and request ID, with a payload hash. Prompts and credentials are excluded.
A missing response leaves `uncertain`, including after restart. A matching
retry reaches the target's durable receipt scope; changed payloads conflict.
Even confirmed retries reauthorize at the target, including conflicts before
revealing a payload mismatch. Message command responses carry the submitted
`requestedSessionId` separately from canonical target `sessionId`, so a target
alias remap can recover the original submission without repeating input. Source relationships include
a separately paged `outbound` collection; its `nextCursor` uses the ordinary
cursor parameter and the consumer treats that collection independently of
`initiated`. Ledger and receipt stores each cap at 10,000 records and refuse
new reservations at capacity without discarding retry identity.

Target receipt creators identify the authenticated immediate server and mark
any source session as `source-attested`. The source retains its current local
session identity separately from original `attestedSessionId` used on retries.
Canonical local remaps update the outbound scope while retaining that original
attestation, preventing duplicate target admission after a source ID change.
Integrators call both receipt and outbound remapping on canonical changes.
Source and target have separate transactions; `confirmed` means a matching
remote receipt was received, not that work completed or a response succeeded.
Authorized receipt/follow observations update the separately retained
`destinationSessionId` for an already correlated record, including pending
creation bindings. Source revocation before a reply is recorded leaves its
outcome uncertain while accepted native work remains at the destination.

The [opt-in production enrollment contract](peer-access.md) now adds owner-only
management, distinct expiring SRP credentials, protected direct/relay routing and
separately granted native peer leases. The opaque HTTP adapter above remains a
development fixture. Native agents address server UUIDs through their existing
private HTTP endpoint; they do not receive peer credentials or choose routes.

## Authentication and grants: defer UI, keep the boundary

Use [principals and grants](principals-and-grants.md)' vocabulary: principal,
credential, grant, route and execution boundary are distinct. The target
authorizes each resource/action. A source's local superuser credential is not
automatically remote operator authority. A session id in JSON is not proof of
the caller's identity.

First local app integration uses YA's existing operator/limited-user
authentication and access policy. For two-owned-server development fixtures,
prefer manually provisioned, distinct opaque bearer credentials over adding
HTTP Basic authentication. Each maps to a source server and an explicit
target-side action/project grant. Test enrollment can be constructor-injected;
human grant-management UI and production enrollment are deferred. These fixture
credentials must not enable an undocumented production authentication bypass.

Plain HTTP peer fixtures bind to loopback. Non-loopback use needs an explicitly
qualified protected transport: existing direct SRP, encrypted relay, or an
authenticated HTTPS connection. Reuse the audited SRP machinery when qualifying
it; do not implement SRP in the core API. The exact production peer credential,
revocation, caller-session attestation and enrollment contract remains a review
gate before deploying remote access. Deferring its UI does not approve it.

Incoming access and outgoing relationships are directional and non-transitive.
A → B grants neither B → A nor A → C through B. Server discovery exposes only
authorized facts. Target-side revocation ends further access; it does not itself
stop an already accepted provider turn. Existing execution/sandbox policy stays
authoritative. This proposal does not add a universal identity system.

## Provenance and mutation outcomes

Record creation on both ends without requiring a delegation/task state machine.
On the destination, retain the created session, authenticated immediate caller,
source server/session when known, request id and timestamp. The destination
authenticates the source server; any source-session attribution attested by that
server is distinct from direct local session authentication. On the source,
retain the outbound request and returned `{serverId, sessionId}`. Correlate with
one request/idempotency key. UI hierarchy, role names and grouping remain TBD.

Source and destination stores do not share a transaction. The source can remain
unconfirmed after destination acceptance. Retrying the same scoped key must
recover the original destination result, not create duplicate work. Different
payloads under the same key fail with a conflict. A crash window between durable
reservation and native provider launch must reconcile or remain explicitly
uncertain; a key alone does not make external effects exactly-once.

Keep creation provenance separate from later input/control audit records and
from existing fork and `/btw` relationships. Optional descriptive links do not
confer authority or imply parenting. Existing [creation metadata](../packages/shared/src/app-types.ts)
and limited-user attribution must survive this extension.

Acceptance, durable input, provider delivery and finished work are different
facts. New endpoints must describe exactly which boundary a successful response
establishes. The [unconfirmed-send gap](../gaps/unconfirmed-send-loss-across-reload.md)
is existing evidence; wrapping the current optimistic message route cannot
claim a new durable delivery guarantee. HTTP disconnection cancels view-only
work where supported, but does not undo accepted mutations or stop their agents.

## Future command execution and interactive terminals

Maintainer direction, 2026-10-30: both noninteractive command execution and a
real `node-pty` terminal are reasonable future API surfaces. Neither is part
of the implemented local read slice or a prerequisite for session interaction,
agent discovery, or peer enrollment. Specialized Git/file endpoints should
earn their investment against these more general primitives and concrete
consumer needs.

The command surface should accept an explicit target server, working directory,
argument vector and optional environment/timeout, and report stdout, stderr
and process exit status. Shell interpretation, when wanted, should be explicit.
Long-running execution needs defined process ownership, bounded output,
observation, cancellation and disconnect behavior; route names and persistence
are not selected yet.

The terminal surface should spawn an actual host shell through `node-pty`,
with input/output, dimensions, exit observation and explicit close behavior.
It does not require an SSH daemon or implement an SSH protocol tunnel. PTY
output and shell exit status do not supply per-command stdout/stderr or command
completion semantics. Terminal attachment/history/reconnection and any relation
to a YA session remain design questions.

Both surfaces use target-enforced grants distinct from merely discovering a
host or inspecting sessions. Their authority and execution boundary must be
stated before implementation. They must reuse the server addressing and
transport boundary rather than introduce a second peer connection system.

## Core boundary and testability

Use a small plain-TypeScript application-service module with typed operations,
caller context and errors. It depends on explicit catalog, native-session,
authorization and provenance capabilities. HTTP translates requests/results;
it is not the execution owner. Services import no Hono, Request/Response,
listeners, browser state or full-app composition. Production adapters reuse
existing Supervisor/provider/metadata owners rather than create a second runtime.

Keep pure policy/validation/transition decisions separate from I/O. The service
itself remains effectful: starting a provider and persisting provenance cannot
be made pure by an interface. Dependency construction belongs in an explicit
composition root; importing a module must not scan, listen or start timers.
Acquire only the operation's dependencies, not the entire app's option bag.

Tests can call services directly, route real Request/Response objects through
Hono's `app.request`, and connect two API apps with an injected fetch function.
None requires listening sockets. Retain a small real TCP HTTP check for the
network/auth adapter boundary. Unix sockets are optional transport coverage,
not the mechanism needed for fast tests or a cross-platform prerequisite.

Use the real SQLite adapter with `:memory:` for relevant store tests and real
temporary profiles for restart/durability/filesystem evidence. An in-memory
database is not an in-memory profile directory. Disable discovery by choosing
an explicit fixture catalog with no discovery owner; do not point at a real
home and hope an empty scan is cheap. Avoid a parallel Map database or a
generic fake filesystem just to accelerate tests.

Explicitly own clocks, ids, observation and cleanup. When a runtime needs
maintenance, give it a start/stop lifecycle; disposal joins pending work.
Production idle/readiness semantics must survive any lifecycle extraction.
See [architecture mandates](architecture-mandates.md) and the
[abandoned-work gap](../gaps/abandoned-work-outlives-the-client-that-wanted-it.md).

Effect's [Layers](https://effect.website/docs/v4/requirements-management/layers)
can manage dependency construction; [Scope](https://effect.website/docs/v4/resource-management/scope)
can manage resource lifetime. Those are relevant tools, but do not establish
the ownership or storage boundaries. Recommend ordinary TypeScript, explicit
dependencies, AbortSignal and disposal first. No Effect dependency, framework
migration, public core package or event-sourced conversation rewrite is a
prerequisite. Revisit a framework only against demonstrated lifecycle/concurrency
cost in the extracted seam, following the existing
[provider comparison](../docs/competitive/t3code-provider-architecture.md).

## Opt-in documentation evals

The [small eval runner](../scripts/agent-api-eval/README.md) imports the actual
bootstrap/help/schema and private HTTP adapter with deterministic source
functions. It needs no full YA app, scanner or ordinary profile. Normal tests
exercise fixture boundaries and grading without model calls; `--run` explicitly
opts into fresh Codex scratch sessions. Real-model execution currently requires
POSIX process groups; native Windows HTTP/bootstrap qualification remains
separate. Saved ChatGPT access is copied without refresh or API-key authority;
local Ollama is an optional diagnostic lane.

The [initial evidence](../docs/tactical/166-agent-api-bootstrap-and-documentation.md#delivered-eval-evidence--2026-10-30)
records 12/12 Sol medium trials across documentation variants, three extra Sol
high tasks and one local Qwen identity trial. Keep the short bootstrap plus
served help for now; this small sample does not establish cache savings or a
statistical model-quality ranking. Narrower operation docs/schema are a useful
next context-cost experiment. The runner reports bytes and provider usage
separately rather than inventing unique-context tokens or subscription prices.

## Next slice: session commands and compact following (proposal)

Maintainer direction, 2026-10-30: proceed toward creation, messaging and
following, including authenticated creation/message attribution. Defer native
Windows qualification until multi-device enrollment exists, so the Windows host
can exercise the actual enrollment and peer path. This qualification does not
block the local session API slice; no Windows support removal is selected.

### Existing caller behavior and reusable pieces

Read-only inspection of matching recent Claude/Codex histories found agents
polling `/api/sessions/{id}/process`, then fetching project-scoped session detail
and extracting user/assistant text with Python or jq. Some inspect the latest
few raw messages or read native JSONL directly. A representative Codex caller
first tried top-level message content and then corrected its filter to nested
`message.content`; the current shapes and tool noise cause avoidable discovery
and repeated reads. This was a targeted sample, not a population measurement.
The repository's `scripts/monitor-agent-process.mjs` is a stronger existing
example: it observes state/liveness/queue depth without fetching transcripts,
and distinguishes verified idle from missing ownership or needed attention.

The older compact API still exists: `GET /api/experimental/conversation` and
its `/subscribe` SSE route. Read-only live checks returned usable snapshots
for Claude/Codex examples and a valid SSE initial snapshot. One normal reviewer
detail response was 996,257 bytes (109 raw records; 9,484 serialized bytes of
user/assistant text), versus 12,408 bytes for the compact view. A Claude example
returned 2,308,285 versus 20,436 bytes. The compact query selected at most 20
logical visible messages with explicit coverage; these are representation
examples, not equal raw-record windows or latency benchmarks. Evidence is in
ignored `tasks/http-api-v0/discovery-research/response-shapes.json`.

[Simple Client API](simple-client-api.md) owns the existing experiment. It
already has shared grouping/projection, activity, important failures, pending
requests, bounded snapshots and subscription teardown. [House cleaning](core-house-cleaning.md)
row 10 defers its removal; this new use does not select the alternate UI or
promote that experimental protocol wholesale.

Its acquisition is not ready to become the universal agent reader: it caps
native history at 8 MiB/10,000 records, refuses inherited Codex rollouts, has
limited provider coverage and does not assemble partial token frames. The
current long agent session exceeds 8 MiB and returned `unavailable` in the live
check. Reuse useful semantic projection and lifecycle pieces while connecting
them to bounded canonical provider history acquisition. Do not raise the file
cap or load full histories merely to return a small tail.

### Recommended read and follow contract

Default to a deterministic compact conversation projection: stable message ids,
user text and agent-authored Markdown, current activity, pending attention and
honest history coverage. This is filtering/grouping, not an LLM-generated
summary. Routine tool calls/results, thinking and rendered HTML stay out of the
default response. Keep bounded warnings/failure references and media/artifact
references where they are the only relevant output; explicit diagnostics can
retrieve underlying activity. Commentary and final agent prose both remain
available, with phase/completeness when the provider establishes it.

Use bounded JSON history plus an HTTP follow binding over the same view. State
polling remains useful on its own. Following should deliver new/changed visible
messages and activity transitions, avoiding replay of a whole transcript on
each tool event. Stable ids and revisions permit replacement of growing text;
provider token streaming is not a prerequisite for useful finalized-message
following. SSE is an existing HTTP binding worth reusing; a client should not
need YA's browser WebSocket reducer or a helper CLI.

Define initial snapshot, cursor/revision scope, reconnect and explicit reset
before promising resumable delivery. The current experimental SSE sequence is
binding-local and its coalesced snapshots may skip intermediate states; it is
not a durable event-log cursor. Rewinds, compaction, scope changes and retention
loss must not silently appear as an ordinary append. Expose truncation/unknown
coverage; never turn unavailable ownership into successful completion.
Activity must distinguish working, idle, awaiting attention, ended and unknown.
Message acceptance/delivery/completion and queue depth remain separate facts.

### Creation, messaging and provenance

Reuse native YA launch and input owners through application services rather
than making the new API call legacy Hono routes or launch another provider
resume. Preserve project/provider/model/permission configuration without adding
worktree, checkout or delegation lifecycle policy. Extend the current read-only
launch grant explicitly when enabling writes; existing read grants must not
silently acquire newly added mutation operations.

Keep current creation-source hints (`web`/`desktop`/`api`) and limited-user
ownership, but add trusted creator facts: immediate principal, originating
server/session/launch when authenticated, destination identity, request identity
and time. Native local/peer creation now records the descriptive API surface
before provider startup, including worker-deferred launch; see
[creation provenance](session-creation-provenance.md#native-v0-and-peer-creation).
Current `creationProvenance` is optional client/source metadata, not
an authenticated agent-parent identity. The launch credential can establish
local session attribution; caller-supplied ids cannot. Do not overload the
existing fork or `/btw` parent fields. Attribute later submitted messages too.

Creation and messaging need scoped retry identities and inspectable outcomes.
The [unconfirmed-send gap](../gaps/unconfirmed-send-loss-across-reload.md) and the
mutation-outcome contract above remain acceptance inputs. An accepted queued
message is not yet durable provider delivery, and idle alone does not prove
that a particular submitted message received a response. Receipts identify the
submission being followed without imposing a managed delegation workflow.

A useful implementation order is compact bounded history/status; creation with
trusted provenance and retry reconciliation; then message receipts and follow
continuity through the same owners. Exercise the complete agent workflow after
each meaningful slice: launch a reviewer, observe new prose and activity, send
a follow-up, reconnect without duplicate input, and inspect creator facts.
Retain YA-launched Sol 6.1 high reviews between implementation phases. Native
Windows/enrollment stays at the later multi-device acceptance boundary.

The optional `capabilities.peerAuthentication: "refresh-v1"` identifies a
receiving profile with the separate protected peer authentication protocol.
Absence means automatic peer sign-in cannot be assumed. It adds no agent-facing
refresh/owner-grant routes to v0. Legacy fixed-expiry peer routing remains usable
until its existing deadline when an older target lacks this capability. See
[automatic peer authentication](peer-access.md#automatic-peer-authentication).

## Launch selection and effective configuration — 2026-11-12

Revision `2026-11-12.1` adds the following discoverable contract. There is no
hosted web client dependency or change to legacy `/api` semantics. Older peers
may omit the optional session-detail fields, and must advertise `selection`
before a caller uses that operation. No existing peer operation grant expands
to discovery implicitly.

- Every server-addressed route accepts `self` for the receiving access server.
  Both the launch adapter and peer router resolve it before choosing a target.
  Replies and receipt scopes retain canonical server ids. A peer requires its
  explicit discovered id; an unknown id still fails without local fallback.
- The launch bootstrap uses `/v0/me` alone for identity-only tasks and
  advertises `self` without a local server-list lookup. Earlier exact bootstrap
  blocks remain recognizable for transcript presentation.
- Default `/v0/help` includes a generated operation-id/method/path index with
  links to focused help and OpenAPI, plus a compact create/send/follow recipe.
  `operation` is the case-sensitive operation id, not a path alias. The full
  `/v0/schema` remains available; focused selectors serve exactly one operation.
- `GET /v0/servers/{serverId}/selection?provider=claude|codex` reads AAR launch
  choices on demand. The default `routing=aar` reports granted pools and their
  ids, names, account membership, revision and default policy; enabled account
  descriptors and their model catalogs; router policies; and tier-selection
  support. `routing=direct` explicitly reads the configured provider catalog
  and its available provenance. Model rows preserve reported effort, thinking,
  fast/auto support and service-tier ids/labels. Omitted controls are unknown,
  not a promise of support. This query does not allocate or launch inference.
  Existing provider descriptors and session lists start no catalog discovery.
- Discovery requires the existing operator principal or an explicitly granted
  peer `selection` operation. Limited users are refused before discovery. No
  new identity, credential, administration authority or grant type is added.
  All results are allow-listed projections: socket paths, authentication data,
  pin ids, quota payloads and arbitrary upstream fields are excluded.
  A disconnected/unconfigured catalog yields `available=false`; discovery
  errors yield `503 selection_unavailable`, never a direct-login fallback.
  Observations may be stale and launch rechecks eligibility and router grants.
- Creation additionally accepts `routerPoolId`, `routerAccountId`,
  `routerPolicy` and the app's explicit Claude connector choice. Policy needs a
  pool; manual selection needs an account. Explicit selection also needs a
  model id from that selection's catalog, since the router has no default
  model; without one the receipt fails with `admission_rejected` and a message
  saying to name a model. A project whose directory no longer exists on the
  target is refused the same way, naming the path, since the catalog keeps a
  project while its transcripts remain. Explicit selection takes precedence
  over caller inheritance and may deliberately select another provider's
  routed pool. Without explicit selection, a local routed caller retains its
  pool/policy or explicit account, with its model when omitted; a provider
  mismatch is refused. Thinking, tier and permission mode remain explicit
  request controls, not implicitly inherited. Retry hashing includes all
  selection fields, and no receipt or API-input semantics change.
- Single-session detail additionally reports `settings` and `routing`; paged
  session summaries retain their compact shape. Settings `source` is `live`,
  `saved` or `unavailable`. Live values use the incumbent owner's last applied
  effort, excluding a queued next-turn change, requested model, best-known
  runtime model, thinking, permission mode and tier. The model may still be an
  alias; it is not claimed as independently provider-confirmed. Saved values
  come from the durable last-applied launch snapshot, including its revision;
  they never manufacture a resolved model. With unavailable evidence, nulls
  mean unknown; otherwise null controls select provider/default behavior.
  Terminated owners do not override durable settings. Routing is `aar`,
  `direct` or `unknown`; saved pool/account labels and policy evidence carry
  their observation time when available. Reading never refreshes AAR. A pin
  identifies intended routing, not proof that the current turn succeeded.

The documentation eval adds operation discovery and a discover/create/verify
AAR task. Its grader requires successful HTTP evidence and actual settings
readback, not an answer that merely repeats the desired settings. The runner
records response/path bytes and focused/full-schema reads in addition to its
existing correctness, calls/errors/repeats, duration, docs bytes and usage.
`compare.ts` refuses incomplete/duplicate or mismatched model/CLI matrices and
reports paired per-case costs. Success, request/error count and
fetched documentation bytes have aggregate and per-case nonregression checks; runtime and
reported tokens remain descriptive, with no statistical latency/cache claim.

### Measured discovery evidence — 2026-11-12

On macOS, Codex CLI 0.167.0 and `gpt-6.1-sol`, medium effort, the existing
identity/project/pagination/workflow/control cases ran twice each with the
served-help variant, in fresh environments. Model, CLI, tasks, sample counts
and grading were held constant. Raw reports remain private local artifacts;
plan files retain exact documentation and harness hashes.

| Measure (10 trials) | Before | Final |
| --- | ---: | ---: |
| Successful tasks | 10 | 10 |
| HTTP calls | 61 | 54 |
| HTTP errors | 0 | 0 |
| Fetched documentation bytes | 111,188 | 72,138 |
| Total response bytes | 167,273 | 127,881 |
| Request-path bytes | 3,240 | 2,016 |
| Shell commands | 59 | 48 |
| Total elapsed seconds, descriptive only | 218.4 | 220.7 |

Both aggregate and per-case request/error/documentation checks pass. Identity
uses 2 rather than 3 requests across its two trials; project 10 rather than 12,
pagination 14 rather than 16, workflow 28 rather than 30, and control remains
at zero. Default help shrinks from 15,884 to 12,023 bytes. The bootstrap grows
from 1,032 to 1,215 bytes to eliminate unnecessary local discovery. Full schema
grows from 149,149 to 163,314 bytes because it now describes more functionality;
callers can use the indexed focused schema instead. Durations are model/network
observations, not a machine-latency benchmark: workflow duration increased in
these two samples, and no latency or unique-context-token improvement is claimed.

Iteration evidence is retained rather than excluded: index-only help passed
10/10 tasks but increased requests to 70, failing the comparison. Adding the
workflow recipe yielded 64 calls and one exact-artifact answer-format failure
(9/10); it still failed acceptance. The final local/identity bootstrap and
conditional settings-verification guidance produced the passing matrix above.
The initial new-task harness also exposed a fixture returning saved rather
than live model evidence and an overly prose-specific operation-id check.
Those were corrected: the scripted incumbent now reports its accepted model,
while grading still requires actual HTTP readback and rejects wrong settings.
New AAR selection and focused-operation tasks subsequently pass 4/4 with no
HTTP errors; these fixtures do not qualify live AAR accounts or provider APIs.

The final compared help/schema/bootstrap SHA-256 prefixes are respectively
`948396ae6b51`, `96418c6eb28c`, and `105a22b3da7a`. Reproduce with the runner and
comparison commands in its README. Normal CI covers deterministic grading,
redaction/authorization, native launch options, peer/local addressing,
last-applied-vs-pending effort and preserved historical bootstrap presentation.
Local Node 24.22.1 workspace tests, lint, formatting and typechecking pass;
Linux/Windows execution remains CI qualification, with no OS-specific API
behavior added. The known unrelated jsdom navigation diagnostics remain in
[their existing gap](../gaps/client-unit-navigation-diagnostics.md).

## Target-owned peer APIs and session control — 2026-11-13

The access server's API revision does not constrain a target's operation table.
For a peer, read `/v0/servers/{serverId}/help` and `/schema` on that target;
`?operation={operationId}` selects its focused documentation. Top-level help
and schema describe the receiving server. The new discovery operation ids are
`targetHelp` and `targetSchema`; the existing top-level resources remain useful
for local bootstrap.

Forwarding authenticates the local caller and its immutable launch authority,
then sends the target-scoped method/path/query, body text, content type and
retry key through the existing protected peer transport. It does not parse
operation bodies or validate target response schemas. Target status, selected
headers and body text survive, including Markdown help, unfamiliar JSON fields
and errors the access build does not recognize. Server descriptions likewise
remain target-owned; access-local names and saved host facts remain available
on the access server's server list. A response's `local` field is the target's
own observation rather than an access-side rewrite.

Incoming and outgoing operation/project grants remain separate. The source
attests its outgoing operation ceiling; the target maps its own route to its
operation id and enforces the intersection. Intermediaries store bounded
operation-name strings, enabling explicitly granted target-only operations.
Unknown operations gain no automatic grant. No caller can route onward, reach
ordinary `/api` or peer administration, choose an arbitrary origin, or supply
peer credentials/attestation in the public request. Revocation, expiry and
source launch fencing remain in force.

The peer wrapper is version 2 inside the existing SRP/NaCl exchange. Its version
is authenticated in the protected server-info proof before submission. Wrapper
mismatch returns `peer_incompatible`; both alpha endpoints need the initial
update. No old-format migration, credential copying, automatic connection
reset or compatibility aliases are added. Recreate affected alpha connections
and use fresh API fixture state as needed. Browser/native-client login,
ordinary sessions and provider transcripts keep their existing contracts.

Every v0 mutation uses an `Idempotency-Key` header (8–128 characters from
letters/digits/`._:-`), replacing the body `requestId`. The receipt's `requestId`
still reports that key. Creation and follow-up text is a plain `prompt` string;
follow-up operation id is `prompt` at `POST .../sessions/{id}/prompts`.
Old `message`/`sendMessage` spellings have no aliases. Other launch, selection,
settings and conversation/follow shapes remain unchanged.

The access server reserves outbound intent before submission, with source,
target, method/path/query, key and body fingerprint. It learns receipt and
canonical destination bindings from a bounded `X-YA-Receipt` header rather
than parsing operation results. Receipt reads/follows can fill a delayed
creation binding. Admission or a confirmed remote receipt does not prove task
completion. Current payload/frame/deadline limits and four-second follows
remain; no streaming or new waiter polling is introduced.

`GET .../sessions/{id}/requests` lists the current pending input with stable id,
kind, description, tool name/input and `canRespond`. Questions are visible
with `canRespond:false`. `POST .../requests/{requestId}/response` accepts
`{response:"approve"|"deny"}` and resolves the native permission request used
by the UI, recording decisions through the existing optional approval audit
log. A new command for a resolved/withdrawn request returns
`409 request_not_pending`; an identical retry returns its original receipt.
Combined approval/mode changes and question answers are unsupported.

`cancel` and `stop` accept `{}`. All three control mutations require existing
management authority and their peer operation grants, with session/project
access rechecked at the target. Authority revoked while the target session is
being resolved refuses the control before it reaches the provider. They return durable receipts; inspect receipt
state, `result` and `failure` to learn the actual control outcome. `cancel`
uses existing YA interruption and queue behavior and reports
`{interrupted,supported,aborted}`; it can hard-abort and does not automatically
resume. `stop` uses verified termination and reports `stopped` plus native
verification facts, or a recorded failure. Like the UI's Stop, it first pauses
the session's background recaps until its next user turn. Session metadata stays readable
after termination even without native transcript content.

Control retries resolve the existing receipt before acquiring an incumbent
again, so a lost reply cannot make the same command interrupt a later turn or
stop a resumed process. An interrupted/restarted unfinished reservation is
uncertain and is never automatically repeated. A control that recorded its
outcome before the restart keeps that receipt unchanged: it delivers no input,
so restart adds no delivery uncertainty or failure. Idle activity, accepted control
and consumed input do not establish successful completion of a particular
prompt. Mode/model/effort changes, richer updates and ACP conformance remain
outside this slice. The [blocking-question gap](../gaps/v0-blocking-questions-need-a-launch-policy.md)
remains open.

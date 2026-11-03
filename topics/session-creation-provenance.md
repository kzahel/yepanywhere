# Session creation provenance

YA records what first created a YA-owned session. Its `surface` is `web` or
`desktop` for a YA UI, or `api` for an HTTP request that identified no UI,
such as an agent or script driving the API. `clientOrigin` is the page's
HTTP(S) origin, not a device hostname; `clientVersion` identifies the frontend
bundle; and the desktop wrapper may also supply its source `clientCommit`. The
server bounds and normalizes these optional values before persisting them in
app-data session metadata. They are descriptive claims, not authentication or
access-control evidence.

Every HTTP request that creates a session records provenance: one-step start
and two-step create, for project and detached sessions, and restart, stale
handoff, fork, and clone of an existing session. A valid `creationProvenance`
in the request body wins; the New Session form and fork actions send one.
Otherwise the request headers decide. Every YA UI request carries
`X-Yep-Client-Version` (the relay adds it from the connection's announced
version) and `X-Yep-Client-Surface: web | desktop`; either header marks the
session as that UI (`web` when only the version is present), keeping the
version. A request with neither is `api`. A UI action therefore needs no
per-call provenance, and an agent needs no cooperation to be told apart.
Internal helpers retain an explicit bounded creation reason without a public
request surface. Existing unmarked history is not backfilled. Project Queue retains the original
enqueue request source as described below.

Creation source and trusted owner now commit with the permanent public session
at [shared admission](session-identity.md#creation-consolidation--november-3),
before native effects. The six audited launch-path omissions are repaired:
Queue, review, native/peer, maintenance, fork-summary target and failed
restart-fork continuation. Templates use that same owner. A fork's source is its
creating request, not its parent's; helper generators choose an explicit
internal reason and are archived at admission. Existing-session follow-ups never
relabel their source. Source-less old Queue/history rows remain unknown.

The [audit gap](../gaps/session-creation-source-missing-launch-paths.md) is narrowed
to a crash after native copy but before its exact result reaches SQLite. The
saved P already has source; the uncorrelated physical orphan is quarantined,
not guessed or replayed. [Plan 171](../docs/tactical/171-durable-session-identity-and-creation.md#final-consolidation-slice--november-3)
records the ingress inventory and qualification. The
[original admission recommendation](session-creation-provenance.sketches.md)
is now implemented at this boundary; later-turn receipts and broad public
capability/release guarantees remain separate.

## Native v0 and peer creation

Native v0 creation explicitly records `{ surface: "api" }` through Supervisor's
pre-launch metadata boundary, including worker deferral and incoming peer
creation. This API entry point does not infer web/desktop source from caller
headers or an asserted session id. Native binding/remap and restart retain the
source; existing-session messages do not relabel it. Trusted creator/peer
identity, directional grants, receipts and native input-consumption evidence
remain separate and unchanged. A failure to save metadata starts no provider.
This is provenance coverage on the existing native command path, not migration
to the ordinary text-creation receipt/identity contract.

## Project Queue origin

New queue items capture the enqueue request's normalized web/desktop/API source
from the existing client headers and persist it with the accepted work. Both
New Session and the session composer's queue action already send these headers;
no new client request field or frontend capability is required. Queue summaries
may return the optional `creationProvenance`; older clients can ignore it.
New internal `createItem` callers must provide a source, including at runtime.

Edits, retries, reorder, restart and Start/Force start preserve that original
source. `createdFrom.client` remains navigation context. The person pressing
Start later does not become the source; creator identity and authorization
continue to use their existing fields and checks. Existing-session queue turns
never relabel the destination session.

For new-session targets, Supervisor commits the saved queue source through the
existing SQLite metadata owner before provider/SDK start, including worker
deferral and create-only startup for staged attachments. Metadata persistence
failure starts no provider. The existing native-id remap moves this metadata;
it is not a post-start callback obligation. The original queue intent remains
the durable owner when startup fails. This repairs source recording across the
existing launch shapes; it does not migrate Queue into durable text receipts,
change scheduling/retry semantics or enable differing-id creation for providers.

Old queue items with no source evidence remain unmarked, including after a UI
edits or forces them. Existing unmarked sessions are not guessed or backfilled.
Supported older servers retain their prior behavior; the current client sends
no additional write or assumes source preservation on those servers.

The first accepted provenance value remains attached to the YA session across
provider restarts and later messages. Legacy creation requests waiting for a worker still use their existing start
callback; migrated text admission records it before waiting. Invalid or unknown
declared provenance falls back to the headers without blocking a session
start. Provider-native (for example terminal-started), pre-feature, and
server-internal sessions have no provenance; YA does not infer their source
from a missing field. Existing session-creator identity for limited users
remains a separate authorization fact.

Session detail, project lists, Global Sessions, and Inbox return this metadata
when present. Inbox groups these as YA UI, API / automation, and Unknown /
external, remembers its choice per connection in browser storage, and defaults
to All sessions; see [Inbox](inbox.md#client-view-filters). Global Sessions can
filter Web UI, Desktop app, API or agent, and
Unspecified; the filter is inactive until selected. `session-creation-provenance`
gates the request field and the filter. On an older server the client omits the
field and hides the filter. Older servers accept unknown creation JSON fields
but discard them, so sending one accidentally does not make the provenance
durable.

The optional compatibility corpus checked on 2026-09-27 is v0.9.0, v0.9.1,
and v0.9.2. None supports this contract. The new version-implied capability
has permanent ID 84, introduced in v0.9.3. Existing capability meanings and
older fallbacks are unchanged.

The `api` surface and header inference (2026-10-26) deliberately add no
capability. A newer client's API filter matches nothing on a server that never
records `api`. An older client shows `api` sessions only without a Created
filter, since none of its options match them. A UI bundle too old to send
`X-Yep-Client-Version`, or a relay client that announced no version, is
recorded as `api`. Sessions created before this change are not backfilled.

## Remaining ingress consolidation

Qualified owner new-session launches from native/peer API, Source Review,
maintenance create and text handoff/successor requests enter the
[common admission owner](session-identity.md#retained-caller-consolidation).
Review origin comes from the review request's normalized UI/API headers;
maintenance and native API remain API source. Empty preparation endpoints save
source before startup as well. Trusted API receipt creator, peer authentication
and grants remain independent facts. Existing-session follow-ups do not rewrite
source. Fork/clone and remaining provider/restricted shapes stay in the
[plan ledger](../docs/tactical/171-durable-session-identity-and-creation.md#consolidation-progress-ledger)
until their separate ingress migration is qualified.

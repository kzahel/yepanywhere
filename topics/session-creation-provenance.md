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
Server-internal launches that do not arrive as an HTTP request, such as helper
side sessions, project queue work, and routines, remain unmarked.

The [launch-path provenance audit](../gaps/session-creation-source-missing-launch-paths.md)
records known omissions beyond that boundary: UI-requested Project Queue and
review sessions, the final fork-after-summary target, native v0 API creation,
maintenance diagnostic creation, and retained forks after a failed restart
continuation. The HTTP coverage statement above describes the intended contract;
these paths do not yet satisfy it.

The [admission ownership recommendation](session-creation-provenance.sketches.md)
explains the shared cause, required creation context and coordination with the
durable session identity/startup work. It is a proposal, not current behavior.
[Plan 171](../docs/tactical/171-durable-session-identity-and-creation.md#creation-source-admission-and-coverage)
now incorporates that recommendation into admission, startup, caller migration
and qualification. It requires explicit source decisions and preserves legacy
unknown records; the omissions above remain open until implemented and verified.

The first accepted provenance value remains attached to the YA session across
provider restarts and later messages. A creation request that waits for a
worker records it when the session actually starts. Invalid or unknown
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

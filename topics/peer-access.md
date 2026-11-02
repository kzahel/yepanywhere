# Directional peer enrollment

Status: implemented through
[plan 169](../docs/tactical/169-server-connections-ui.md), building on
[plan 168](../docs/tactical/168-peer-access-and-enrollment.md). Server Connections
is available by default; no enable step or environment variable is required.
No devices gain access until explicitly enrolled. `YEP_PEER_API_ENABLED=false`
is an optional kill switch: it blocks routing and pairing without deleting
saved devices, and Settings cannot override it. Explicit `true` pins it on.
The owner API's existing runtime disable/enable operation remains supported;
an explicitly saved disabled setting is respected when the variable is unset.
Empty or unrecognized supplied values retain the disabled behavior; they cannot
override saved disablement by accidentally selecting the new default.
Settings has no global enable switch. Pairing/removing devices are its controls.
The qualification record in the plan distinguishes tested adapters from the
remaining packaging and platform matrix.

## Authority and identity

A server UUID identifies one logical YA profile. An incoming peer record binds
that source UUID to a distinct credential and a target-local grant. An outgoing
record binds a target UUID to a protected route and the source's explicit policy.
Neither record grants the reverse direction or onward routing. A shared relay
name, account login, route, public ID or source session ID grants no authority.

Reuse the `peer` API principal; never put a peer into the legacy operator or
limited-user authentication classes. A source session remains source-attested.
Unsandboxed create/message authority is authority to execute as the target YA
OS account; project filters choose API resources and do not isolate that agent.
Target settings and existing native permission/sandbox policy remain ceilings.

Public-key continuity registered by mobile clients proves continuity on an
already authenticated connection. It is not repurposed as unattended login.
The initial manual ceremony uses distinct random peer secrets with existing
SRP-6a and NaCl helpers. A subsequent identity-service-issued, device-key-bound credential
is a separate authenticator into the same identity/grant boundary; no new
signature/challenge protocol is introduced by this slice.

## Manual owner ceremony and management API

Device pairing remains an explicit owner action. Agent use defaults on for new
eligible launches; there is no separate agent-use switch in Settings. The owner
API retains its explicit opt-out for configuration and future owner-only use.
No enrollment is inferred from browser logins, remote-access setup or relay
registration. Browser-saved SRP sessions remain independent of peer connections;
this does not implement session federation in the UI.

Owner-only `/api/peers` operations serve the settings UI and manual administration. They independently
validate an owner cookie, desktop credential or established owner SRP context,
even when UI authentication is disabled or localhost is open. Resolved acting
principal must also be operator. There is no anonymous loopback exception: a
local reverse proxy must not turn remote traffic into owner admission. A plain
local install first configures its existing owner password/login. A null or
unknown cookie username is not proof; validate the session before classifying it.
v0 launch credentials, incoming peers, limited users and legacy agent bearers
do not authorize enrollment or secret export. Normal HTTP v0 peer routing and
outbound history require this same independent owner proof, whereas separately
issued private peer leases carry their own immutable authority. Local v0
operations retain their existing authentication policy. Agents with full OS
access still have that OS account's authority; this is not confinement.

Implemented operations:

| Method/path | Result |
| --- | --- |
| `PUT /api/peers/relay` | Configure an explicit peer relay URL/name and its separate private registration identity; leave browser relay configuration untouched |
| `DELETE /api/peers/relay` | Retire the peer relay route and its channels, retaining independent direct grants |
| `PUT /api/peers/agent-access` | Configure the hidden agent-use option (default on) for new eligible native launches; re-enabling uses a fresh durable grant generation |
| `GET /api/peers` | Public local ID and incoming/outgoing records, directions, expiry, operation/project policy and route state; no secrets/verifiers |
| `POST /api/peers/incoming` | Owner chooses source UUID, exact projects/operations and expiry; return a one-time invitation bundle |
| `POST /api/peers/incoming/{id}/rotate` | Replace secret/verifier and expiry, invalidating the old credential; return new one-time bundle |
| `DELETE /api/peers/incoming/{id}` | Durably revoke incoming credential and abort its observations/connections; accepted native work remains |
| `POST /api/peers/outgoing` | Import bundle for this source profile, choose route and outgoing operations; preflight the protected target before committing |
| `DELETE /api/peers/outgoing/{targetId}` | Durably remove outgoing access and cancel its requests; leave target incoming grant independently inspectable/revocable |

An invitation includes version, source/target UUIDs, credential ID, SRP username,
random secret, positive credential generation and expiry. It contains no browser password, browser resume token,
relay installation secret or default reverse permission. Transfer it through an
owner-chosen trusted channel. Holding it authenticates the named source; the
manual ceremony establishes that binding, not an unauthenticated ID assertion.
The source refuses a bundle for another source UUID. The source can inspect its
public ID before the owner grants access at the target.

Secrets are at least 256 random bits. The target retains only a SHA-256 bearer
verifier and SRP salt/verifier. The source retains the secret below its private
profile directory for unattended connections. It is not injected into provider
children, returned by list/help/schema routes or written to logs/provenance.
Invitation responses are `no-store`; later inspection never returns a secret.

The target grant names existing projects and supported operations. Creating an
unsandboxed session requires explicit execution acknowledgement in owner input.
Safe discovery/authorization facts are consistently available; resource reads
and mutation rights remain explicit. Outgoing agent use additionally requires
both a separately issued launch peer-access grant and that outgoing record's
explicit agent-use policy. Existing local management leases remain local.

Incoming credentials cap at 64. Outgoing topology caps at 64 distinct targets,
with up to 128 credentials so manual and identity-service access can coexist per pair.
Private v2 profile storage caps at eight MiB and uses durable atomic replacement;
v1 migrates preserving IDs, manual policy and selected routes. Unknown versions
fail closed. A separate selection maps each target UUID to one credential;
importing identity-service access never replaces a selected manual credential. Owner
selection is explicit, and denial/removal never falls back automatically.
Mutation serialization prevents lost
updates. Invalid/corrupt/unknown-version state fails closed rather than resetting
and granting access. Publish a new policy only after persistence succeeds. Increment credential
generation on rotation. Bind pending SRP challenges, verification and encrypted
HTTP admission to the same active generation, checking it again after async
crypto. A source import captures a state revision before preflight and checks
that revision in its serialized durable commit; a delayed import cannot undo
removal or replacement. Failed preflight never publishes or stores a new route.
There is at most one manual and one identity-service incoming record per source UUID. If a create or
rotation response is lost, list its nonsecret source/credential ID and generation,
then rotate or remove it; do not replay a secret export or silently make another
record. Incoming and outgoing expiry/revocation survive restart.
Listings do not try every peer or create background connections.

Expiry is finite and bounded to 30 days. There is no unattended renewal protocol
in this first ceremony. Owner rotation produces a new bundle; source import
updates its connection explicitly. Retry scopes retain the same source UUID
across rotation, so renewal cannot duplicate accepted work. Full profile backups
retain identity; cloning a profile creates a duplicate identity and is not a
supported way to enroll another host. A new install uses a fresh profile UUID.

## Protected request transport

The initial production routes are direct SRP and relay SRP only. Direct HTTPS
bearer transport remains an isolated adapter until its target proof and
certificate binding are separately qualified; an unauthenticated `/peer/id`
response is insufficient production identity. Public peer HTTP requests cannot
bypass SRP with a bearer. The receiving v0 app requires an internal Symbol
handoff from the restricted acceptor, bound to credential ID and generation.
External headers cannot manufacture that context. Peer HTTP is not mounted as
an authenticated alternative on the ordinary UI listener.

Direct SRP and relay SRP reuse the existing audited SRP-6a routines, NaCl
transport-key derivation, binary envelope format and sequence helpers. Their
peer-only state machine creates no RemoteSessionService session and admits no
resume control message. A strict first hello names `peer-v0` and a peer SRP
username. Browser transport does not accept these credentials.

The verify response retains the canonical SRP M2 and an encrypted server-info
proof under the derived base key, as in the existing metadata proof mechanism.
The peer proof additionally binds protocol `peer-v0`, public target UUID,
credential ID/generation, expiry and transport nonce. The client verifies M2
and this complete encrypted proof, including the expected target UUID, before
sending its encrypted HTTP bearer or any mutation. It then derives the normal
transport key. This is an extension of the existing peer-only authenticated
metadata, not a standalone signature/login scheme. It does not modify browser
verification or resume semantics.

A dedicated `/peer/ws` uses its own bounded WebSocketServer on the existing
listener. Relay access uses a separate RelayClientService registration and
username with a distinct private registration ID, on an explicitly configured
relay URL. It never copies the browser relay installation credential or
contends for the browser's waiting registration. The existing relay message
protocol is unchanged. No shared-channel first-message demultiplexer is needed.
The invitation can describe this peer route; callers still address a public
server UUID. An operator chooses the peer relay URL/name explicitly, including
when it is the same relay deployment already used for browsers. Existing URL
choices are not replaced or redirected.

The peer RelayClientService instance sets its own receiving parser limit before
registration/first message, independently of browser sockets. Both YA endpoints
therefore have bounded peer frame assembly. The general relay deployment may
retain the historical 100-MiB gateway allowance for legacy users; that existing
[admission gap](../gaps/lower-websocket-message-admission.md) is not fixed or
silently lowered by this work. Owned relay qualification also sets a small
parser limit at the gateway. It does not establish a lower limit at a public
relay whose configuration has not been qualified.

The restricted acceptor permits only one bounded v0 HTTP request per connection.
No subscriptions, uploads, speech, devices, browser capabilities, resume or
generic app requests. Its authenticated SRP record/generation and encrypted
HTTP credential must match. The receiver independently checks current grants.
Source session attribution is considered only after this proof. A lost reply
preserves uncertain outbound intent; there is no automatic reconnect, retry or
persistent browser resume secret. Pooling can follow measured need.

Concrete ceilings: 32 channels per profile across direct/relay, including
unauthenticated sockets; 8 KiB per plaintext handshake message, 384 KiB per
inbound peer wire frame, 256 KiB per HTTP body and 256 KiB per JSON reply; the complete encrypted frame
remains below the 384-KiB parser limit in both directions. The earlier two-MiB
HTTP fixture response limit does not apply to this initial production SRP
transport. A larger otherwise valid v0 result returns an explicit
`peer_response_too_large` error and asks the caller to narrow `limit` or
`maxMessages`; never silently truncate or begin a partial reply. Only JSON encrypted frames are
admitted; peer gzip/uploads/chunk negotiation are excluded initially. There is
one in-progress inbound frame, no accumulating promise queue, and at most one
pending response. Reject extra frames rather than retaining them. Bound outbound
buffering before sending. Direct and peer relay parsers apply wire limits before
assembling peer messages, not just after JSON parsing.

A channel has a 10-second handshake and 12-second whole-connection deadline,
and never outlives credential expiry; timers belong to that channel and clear
on close. Requests also retain their existing directory and controller limits.
The profile pre-auth hello budget is 256/minute with burst 32. The peer-specific
identity budget is 120/minute with burst 32, independent of the browser's 30/minute
budget; this allows fresh SRP per request and concurrent following. Unknown
identities still use bounded decoy/limiting machinery. No handshake may select
an operator credential. Rotation/revocation closes pending and authenticated
channels of that generation; native work already admitted remains intact.

Idle profiles create no peer channels or recurring discovery work. An explicitly
configured peer relay route has one existing RelayClientService waiting-route
owner and its bounded retry/heartbeat lifecycle, rather than per-session loops.
Only its registration phase interprets relay registration responses. Once
registered, every subsequent data message enters the restricted acceptor or
immediately closes and replenishes the waiting route, including malformed JSON
and relay-control-shaped messages such as a repeated `server_registered`.
Do not let a claimed connection remain indefinitely in registration parsing.
This strict handoff mode applies only to the separate peer instance.
Retiring that route or the profile stops it and releases its channels.

## Native agent bootstrap

Expose peer discovery through the existing private Unix HTTP/Windows-loopback
adapter. Issue immutable `peerAccess` only on explicitly enabled new launches
with management authority; propagate it through owned provider/controller
ports and negotiate a distinct worker feature. Older workers keep local API
access and receive no implied peer permission. New controllers strip peer
requests when that worker feature is absent. New workers require a matching
controller feature for remote operations; an old controller or a missing field
cannot imply peer enablement. Keep the lease's granted flag and peer grant generation immutable, separately
from the currently attached controller's negotiated ability to serve it. A controller outage leaves
self/context facts available while remote catalog/routing fails explicitly.

Remote server, access and capability requests go through the live controller;
private fallback context must not fabricate a peer catalog. Revoking peer use
retires peer-enabled leases without reviving them when the option returns.
A durable source grant generation also fences old leases across disable/re-enable,
independently of a delayed hosted revocation acknowledgment. Existing local-only
leases retain their current lifecycle. Selective retirement
covers hosted owners, in-process sessions and pending starts; a peer-specific
epoch fences late lease creation. Do not reuse blanket local-API revocation. Models receive only
their normal local connection/env bootstrap, discover authorized hosts through
`servers`, and inspect each target's access/help/schema. They never carry peer
secrets or need to choose LAN/Tailscale/relay plumbing.

Retirement names the revoked grant generation through the provider host and
worker RPC. A delayed retirement cannot affect a newer generation. A launch
without management authority remains local-only even when the peer option is
enabled. Disabling the feature at startup retires the durable lease generation while
preserving the configured agent-use option; later re-enablement cannot revive
the previous generation.

The source checks current peer and launch authority before persisting a remote
reply. Revocation before that check leaves the outbound outcome uncertain;
accepted native work at the target remains. An authorized receipt/follow read
can enrich an already correlated outbound record with its canonical destination
session ID. It cannot confirm an unrelated uncertain intent by retry key alone.

One relay transport serializes its pairing handshakes, because the existing
relay offers one waiting connection per target. Waiters consume the existing
32-slot profile admission and original connection deadline; cancellation removes
them before submission. Mutual proof releases the gate, allowing HTTP work and
following to overlap. This is no retry or failover policy. Independent sources
can still contend for the same waiting registration and receive an explicit
unavailable response.

## Qualification and review

Before implementation, independently review ceremony, credential storage,
management admission, target pinning, first-frame dispatch, native lease
propagation and revocation. Existing fixture evidence is insufficient.

Retain real private-profile restart/corruption/permission tests and in-process
management authorization. Test manual A-to-B enrollment with create/message/
follow, wrong profile and reverse access, rotation, revocation, lost replies and
old worker/lease behavior. Qualify direct SRP and an owned real encrypted relay
with canonical helpers; no public relay or primary YA settings required.
Run a light opt-in agent trial only after deterministic fixtures are stable.
Qualify Windows through actual multi-device enrollment when an authorized host
is available; do not infer Windows from POSIX transports.

## Optional identity-service login remains separate

The optional [Identity Service](identity-service.md) implements local account
login, key-bound enrollment and directional proposals. The identity-service consumer adds
owner acceptance, signed/source-encrypted SRP delivery and an additional
short-lived issuer token at protected admission. Its independent integration
review is complete; external OIDC now feeds the same key-bound enrollment,
with a browser-only confirmation code and live initiating-owner checks. A
central service never receives manual peer secrets or becomes a prerequisite for manual grants.
Identity Service credentials have an explicit stored origin and advertise identity-service support
in the authenticated SRP metadata before the source sends a request. They
require both current SRP possession and matching issuer/account/client/profile/
credential-generation claims. An identity-service secret never enters manual admission.
The reviewed ceremony, target ceilings and offline revocation bounds are owned
by the identity-service topic; SRP remains the existing authenticated transport.

## Owner UI direction: relay pairing and audit

Maintainer-agreed direction, 2026-10-31. This section describes the next UI
slice and future topology options; the owner HTTP and transport implementation
above does not yet provide these screens or guided browser orchestration.
Authentication, a durable directional grant and a route remain distinct under
[principals and grants](principals-and-grants.md).

### Connect using an existing owner login

On A, the owner chooses Connect to another server and supplies B's direct or
relay locator and owner credentials. A's backend performs a short-lived owner
SRP login to B, creates the dedicated A-to-B peer grant through B's owner API,
and saves only the peer credential. The browser is the settings form; pairing
does not switch its current host or create a separate browser connection to B.
B's owner password is used transiently for setup and is not saved in A's
settings, peer store, or audit records. There is no separate approval request
on B: authentication as B's owner already authorizes that administration.

The first UI focuses on trusted server control. Read-only invitations and
project/session scope selection are useful future UI work; the existing API's
project/action filters do not confine unrestricted execution. The subsequent
peer connection remains restricted to v0 and cannot create grants for itself.
Server UUIDs and the dedicated credential bind the pair; neither the human
relay username nor a display name becomes server identity. Peer credentials
keep their existing expiry/revocation rules. Human SRP resume persistence is
independent of these durable peer credentials.

### Inspect both directions on both servers

Both A and B need a peer detail view that distinguishes This server can use
this peer from This peer can use this server. Show stable IDs, useful names,
each direction's projects/actions/expiry, configured route, credential origin
and status. Distinguish recent observed connectivity from untested or stale
route information; listing peers must not probe every host continuously.

Audit views should explain who initiated pairing and changed access, when it
changed, which direction was affected, and the outcome. Connect the existing
session creation/provenance records to sessions created through that peer.
Additional durable audit fields/events and retention remain part of the UI
implementation design; a current-policy listing alone is not a change history.
Secrets and owner passwords are excluded from these views and audit records.

### Preserve pairs across human login changes

Changing the browser relay username or SRP password should preserve established
peer grants by default. Pairing creates independent authority, not an ongoing
use of the human login. Offer an explicit choice to also revoke servers allowed
to control this server, with the affected incoming directions visible. Do not
silently remove the opposite outgoing directions or equate password rotation
with disconnecting every pair. Existing browser-login invalidation and live
owner checks still apply to unfinished enrollment work.

The current peer credential store and dedicated peer relay registration already
have this separation. Changing the actual peer relay locator is a separate
reachability change: a retained grant can be valid while its old route no longer
works. Any future route-update mechanism must authenticate the same server and
respect explicit relay configuration; it must not silently repoint a peer.

### Optional bidirectional connection and later changes

Connect offers an explicit bidirectional option. It creates A-to-B and B-to-A
as two independent grants using the owner's authority on both servers. Neither
direction is inferred from the other. The same peer detail view allows changing
either direction later, including upgrading a one-way relationship or removing
one leg while retaining the other. Reuse valid owner logins; require owner
reauthentication only where needed to apply the change, without introducing a
second-person approval ceremony or promoting peer execution rights to owner
administration.

Writes across two servers are not atomic. If only one leg succeeds, show the
actual one-way result and let the owner finish or remove it. Do not label a
partial connection bidirectional or silently re-create a revoked grant.

### Future discovery sharing and full mesh

Retain opt-in sharing of newly discovered hosts and possible automatic mesh
formation as future work, separate from this first UI. Distinguish sharing
contact/identity information, authorizing new direct grants, and forwarding
calls transitively. A newly advertised host does not by itself authorize access.
An optional trusted-group policy could authorize targets to issue new pairwise
grants as members join; group membership, sharing and revocation semantics still
need design and must not require a mandatory central service.

Existing grants and secrets are bound to their named source and target; copying
A's credential to C does not enroll C. Current peer requests remain immediate,
directional and non-transitive. No onward-routing or automatic grant propagation
is enabled by this proposal. See the [multi-machine discussion](multi-machine-architecture.md)
for the broader topology choices.

This non-transitivity describes the API's routing and recorded immediate peer,
not confinement of unrestricted agents. If A can execute as B's YA OS account,
A can use B's credentials and access to C while acting as B. If that access also
allows unrestricted execution on C, A can arrange persistent direct access
there too. Project/action grants do not isolate full OS-account execution.
Within such a trusted set, discovery sharing and full-mesh setup can automate
access already practically available. Separate direct credentials still make
connections inspectable, attributable and individually revocable; they do not
prove that authority stops at each recorded edge. Audit should distinguish
the immediate authenticated peer from the attested original initiator and
record how a new direct relationship was created.

## Independent design review closure

Sol 6.1 high and GPT-6 Sol high with Daybreak Blue independently accepted the
direction conditionally, before production code. This revision closes their
requirements: owner proof independent of auth-off, unforgeable SRP-only ingress,
sessionless authenticated target metadata before mutation, generation-fenced
persistence/preflight, concrete pre-auth/framing/rate/expiry limits and symmetric
old worker/controller behavior with selective lease retirement. The separate
peer relay registration (selected after their initial reviews) removes the original shared-channel dispatch assumption
and lets YA enforce its peer parser bound without a browser compatibility cut.
A focused recheck precedes production edits.

The focused recheck added two closure requirements: hand off all data after
relay registration, so invalid/control-shaped first messages cannot strand a
claimed route; and fit replies within the initial no-chunk wire contract. This
revision sets a 256-KiB JSON reply bound and requires explicit oversize errors.
Both are acceptance requirements with focused transport cases before
production enablement. Each reviewer confirmed these closures with no material
remaining design blocker; implementation and live qualification are still pending.

Native cryptography has a separate 32-job ceiling, including jobs whose channel
has already retired. Cancellation ends a caller's wait and releases its channel;
the crypto slot remains occupied until native work actually settles. Initial
source SRP setup races the original deadline before entering relay pairing.
No cancelled setup may later send an HTTP request.

Run one YA process per data directory. Concurrent instances use separate
profiles, as in the local development guide; profile state is not a shared
multi-controller database. Protected-route qualification owns its processes
and verifies their exit before restarting a profile.


## Server Connections settings

Owners see Settings → Server Connections beside the access settings. A distinct
`peer-connections` capability advertises support independently of whether peer
routing is enabled. Older servers hide the category and its search results;
a typed URL shows update guidance without calling peer routes. A local install
without owner authentication first configures its existing Local Access owner
password and signs in. Desktop owner credentials and established owner SRP
connections also work; open loopback and legacy agent tokens do not authorize
pairing.

The main page identifies this profile by hostname and icon, then shows two
compact lists: **Devices you can access** and **Devices with access to this
server**. A bidirectional device appears in both lists. Rows show the friendly
name, hostname, OS and host icon; routine authentication/verification details
stay out of the main lists. Sign-in and connection problems remain visible.
Clicking a device name opens its details: stable UUID, credentials, rename,
connection test, renewal/reverse setup, audit and recent sessions. Manual refresh
lives under collapsed **Connection settings**.
Friendly names are local labels.
Host reports are authenticated data, not independent machine attestation.
A saved browser host and a server connection remain separate records.

Connect accepts the other server's existing Remote Access username/password,
and either its direct HTTP/WebSocket address or its owner relay registration.
Direct setup uses `/api/ws`; subsequent dedicated peer traffic uses `/peer/ws`.
The browser remains on the source server: its backend performs ordinary SRP-6a,
verifies M2 and the encrypted session/nonce/protocol proof, then reads the target
UUID before peer mutation. Later changes pin that UUID and refuse self-pairing
or a changed identity. The password and owner resume key are never persisted on
the source. There is no additional approval on the target after owner login.

The temporary client uses the target's **ordinary** owner-session lifecycle.
The normal five-session limit and disk-persistence preference apply; setup can
evict the oldest login. Cleanup is bound to the authenticated setup session ID,
returns before closing that socket, and cannot revoke a caller-selected session.
A lost reply/crash may leave its target-side saved session until ordinary expiry
or revocation. Setup reports unconfirmed cleanup separately; closing a socket
alone does not prove revocation. No new SRP purpose or cryptographic protocol
is introduced. Credential changes and connection teardown fence pending proofs.

A new trusted-control connection includes all current and future projects and
resource operations. Automatic sign-in is the normal pairing choice, using the
90-day inactivity policy below. An explicitly unchecked automatic sign-in choice
creates a fixed 30-day grant and is recorded on both ends; it never qualifies as
an inferred legacy default. This permits YA
OS-account execution; project filters are not a sandbox. Global native session
command settings and provider permission/sandbox policy remain ceilings.
Renewal preserves an existing scoped/read-only manual credential's projects and
operations; it never silently upgrades that credential. Identity Service policy ceilings
and explicit credential selection remain unchanged. If a different identity-service
credential is selected, setup asks the owner to resolve selection first rather
than falsely reporting the new manual grant as the active route.

The two directions are independent. Initial setup can request both; later
**Set up access from this device** preserves the working outgoing credential.
Each manually paired direction has an × with a confirmation explaining which
access changes and which reverse connection remains. Incoming removal is
locally enforced immediately; outgoing removal deletes
only this manual outgoing credential, preserves identity-service records/selection and
leaves the target's incoming grant visible there. Its success message explicitly
says that remote grant remains; local removal does not claim remote cleanup.
A confirmation binds the exact credential ID and generation observed when it
opened. A concurrent rotation fails visibly rather than removing the new
credential; cancellation sends no mutation. A failed removal keeps its dialog
open. Identity Service-managed directions show **Managed**, with manual credential removal
available in details and an explicit warning that identity-service access remains.
Accepted native agent work continues after access is revoked. Fresh target
owner login is required for later pairing-secret or authentication-policy changes;
routine automatic refresh uses only the existing pair proof.

There is one dedicated peer relay registration per profile. Relay setup creates
one only when absent, using the explicitly selected relay URL and a new random
name distinct from the browser registration. An existing registration is never
silently repointed. A disabled or unavailable relay fails before credential
issuance/rotation. Direct reverse access requires an explicit reachable return
address when this server has no enabled peer relay. Never infer that localhost
or a hosted-client origin is reachable from the other machine.

Setup admits at most four concurrent clients, with a 45-second whole-operation
limit, 10-second handshakes/requests, bounded crypto work and bounded frames.
It never reconnects or automatically resends a mutation. Live initiating owner
proof and the originally observed policy revision are rechecked after waits,
before dispatch and inside queued publication. Target policy preconditions span
bootstrap, grant/prepare and reverse import; a concurrent disable, removal,
selection change or renewal cannot be undone by stale setup. Failure after
remote dispatch is explicitly uncertain, or partial if the first leg was
confirmed. Inspect both ends before renewing a lost one-time invitation.

Owner management remains available while routing is disabled. Disabling closes
incoming channels, outgoing owner/native routing and the peer relay, and retires
peer-enabled native leases. Re-enabling retained credentials does not revive
old launch grants. Disabling server connections preserves the configured
agent-use option while rotating its lease generation. Agent use defaults on and
is configurable through the owner API, without a separate Settings control.
New eligible sessions still need Local Access Agent API discovery/session-command
settings; existing local-only leases do not acquire peer access.
No peer is probed merely by opening Settings. Test connection is explicit;
listings describe configured directions and last observed verification.

The private policy retains at most 128 host metadata records and 512 audit
events. Policy and its successful audit event publish together. Both ends record
owner setup, immediate server identity, credential/generation and operation ID;
source identity/session assertions are not stronger than source attestation.
Owner listings paginate server metadata, show recent nonsecret audit and at most
20 recorded session creations per direction, and link locally created sessions.
No password, invitation secret, verifier, owner resume key or prompt body enters
these projections. Changing human Remote Access credentials keeps independent
peer credentials; Remote Access links to the incoming-control revocation view.
Read-only UI, richer scopes, route discovery, full mesh and identity-service/OIDC settings
remain separate follow-ups.


### Agent-visible server details

The existing server-addressed API now exposes the same nonsecret recorded host
facts to agents: optional label, hostname, OS, architecture and icon. See the
[server description contract](http-api-v0.md#server-names-and-host-details).
Peer lists use saved facts without network probes; detail requests contact only
the selected peer. Friendly labels remain local to the access server. This
adds no onward routing, incoming-peer directory or administrative authority.

### Automatic peer authentication

Refreshable manual pairings use a distinct `peer-v1` SRP protocol. The retained
per-pair secret proves transport/refresh identity; it is not an ordinary v0 API
bearer. Ordinary requests require a one-hour random access credential bound to
the verified source, target, pair and permission generation. Targets persist
only access hashes. Legacy fixed-expiry and identity-service credentials keep `peer-v0`.
Browser owner login and its saved sessions are unchanged.

Only verified peer-v1 channels can reach `GET /peer/v1/auth/identity` or
`POST /peer/v1/auth/refresh`; neither grants owner administration. Identity
preflight returns the existing pair's scope and operations. Refresh requires
the exact durable pairing proof and can change authentication only. Successful
new refresh extends inactivity by 90 days. Reads, failed attempts, heartbeats
and replay of an existing refresh do not extend it. Target inactivity expiry,
revocation, replacement or disablement denies new authentication.

The source durably saves a proposed access secret, request UUID and increasing
sequence before dispatch. The target atomically saves its hash and receipt.
An exact retained retry returns the original deadlines; conflicting candidates
and sequences older than retained receipts fail. Two access slots/receipts are
retained. An unresolved candidate must be recovered before another is generated;
recovery of an expired access receipt commits that sequence then refreshes again.
A lost reply and stale source deadline do not block bounded peer-v1 recovery.

One profile owns the scheduler, with one unreferenced timer, at most two refresh
jobs and a 30-second attempt deadline under the existing SRP budgets. Quiet
connections refresh around 45 minutes, with two minutes of target-selected
jitter. Offline attempts back off from one minute to six hours, persisting the
cooldown, with a bounded in-memory floor if publication is busy. Test connection
explicitly rechecks a failed refresh or previously unsupported target after an
upgrade; sign-in-required still needs fresh owner login. A transport endpoint
or unconfirmed SRP rejection remains temporary; update-required needs an authenticated legacy
capability response without refresh support. Ambiguous recovery is
bounded by the last confirmed possible acceptance deadline plus one inactivity
window and one minute of margin. A caller can cancel its wait without cancelling
another caller's refresh. Disablement, removal, replacement and close fence publication; removed
connections are never recreated. Normal refresh changes neither policy revision
nor launch authority and does not replace transports or abort admitted reads.
Admitted reads keep their original short deadlines even when access slots turn
over. Authentication expiry never deletes connection identity or audit history.

Old UI defaults qualify for automatic migration only with matching retained
pairing operation UUIDs on both ends, generation one, the complete original
all-project control scope, and a deadline matching the historical 30-day default.
Each end checks its own evidence against the exact credential and opposite
server. Missing evidence, changed scope, renewed generations and expired grants
require owner sign-in. A protected migration refusal leaves the original fixed
grant usable and discards its unaccepted candidate. Explicitly time-limited manual grants and identity-service policy
are never silently extended. New explicit fixed choices carry a durable false
marker in both target policy and the source invitation, excluding them from the
historical heuristic. Renewing both directions preserves an existing reverse
direction's authentication mode; change that direction through its own renewal.
A new reverse direction uses the chosen initial mode. An incoming last-refresh
time appears only after a refresh is accepted, not merely after issuance.


The optional `peer-authentication-refresh` capability gates new owner pairing
and status semantics independently of `peer-connections`. Older source builds
keep their original behavior. A new client on an older source keeps existing
directions visible but disables new pairing with update guidance; it sends no
new pairing fields. A new source refuses an unsupported target before changing
peer policy, cleaning up its temporary owner login through the normal lifecycle.
Saved host details and history remain visible after sign-in expires, with a
fresh-login action for the outgoing direction. Browser passwords remain blank
when opening that action.

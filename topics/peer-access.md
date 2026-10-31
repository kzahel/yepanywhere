# Directional peer enrollment

Status: opt-in implementation, step 2 of
[plan 168](../docs/tactical/168-peer-access-and-enrollment.md). Independent design
and code reviews precede this slice's commit. Normal startup leaves it disabled;
`YEP_PEER_API_ENABLED=true` enables the management and protected routing surfaces.
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
SRP-6a and NaCl helpers. A subsequent fleet-issued, device-key-bound credential
is a separate authenticator into the same identity/grant boundary; no new
signature/challenge protocol is introduced by this slice.

## Manual owner ceremony and management API

Peer access and agent use are separately default-off. No enrollment is inferred
from existing browser logins, remote-access setup or relay registration.

Owner-only `/api/peers` operations initially precede UI. They independently
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
| `PUT /api/peers/agent-access` | Separately enable/disable peer access for new eligible native launches; default off, with a fresh durable grant generation after re-enabling |
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
with up to 128 credentials so manual and fleet access can coexist per pair.
Private v2 profile storage caps at eight MiB and uses durable atomic replacement;
v1 migrates preserving IDs, manual policy and selected routes. Unknown versions
fail closed. A separate selection maps each target UUID to one credential;
importing fleet access never replaces a selected manual credential. Owner
selection is explicit, and denial/removal never falls back automatically.
Mutation serialization prevents lost
updates. Invalid/corrupt/unknown-version state fails closed rather than resetting
and granting access. Publish a new policy only after persistence succeeds. Increment credential
generation on rotation. Bind pending SRP challenges, verification and encrypted
HTTP admission to the same active generation, checking it again after async
crypto. A source import captures a state revision before preflight and checks
that revision in its serialized durable commit; a delayed import cannot undo
removal or replacement. Failed preflight never publishes or stores a new route.
There is at most one manual and one fleet incoming record per source UUID. If a create or
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
enabled. Disabling the feature at startup durably disables stored agent access;
later re-enablement cannot revive its previous generation.

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

## Optional fleet login remains separate

The optional [fleet service](fleet-authentication.md) implements local account
login, key-bound enrollment and directional proposals. The fleet consumer adds
owner acceptance, signed/source-encrypted SRP delivery and an additional
short-lived issuer token at protected admission. Its independent integration
review is complete; external OIDC now feeds the same key-bound enrollment,
with a browser-only confirmation code and live initiating-owner checks. A
central service never receives manual peer secrets or becomes a prerequisite for manual grants.
Fleet credentials have an explicit stored origin and advertise fleet support
in the authenticated SRP metadata before the source sends a request. They
require both current SRP possession and matching issuer/account/client/profile/
credential-generation claims. A fleet secret never enters manual admission.
The reviewed ceremony, target ceilings and offline revocation bounds are owned
by the fleet topic; SRP remains the existing authenticated transport.

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

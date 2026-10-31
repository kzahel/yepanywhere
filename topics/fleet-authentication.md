# Optional fleet accounts and enrollment

Status: independently reviewed design for plan 168 steps 3–4. The standalone
basic service/client is implemented and independently code-reviewed; target
consumption and OIDC are subsequent implementation units. Sol 6.1 high and
Daybreak Blue high confirmed
the pre-session, lifetime, rate, trust and coexistence conditions before source
edits. Manual [peer access](peer-access.md) remains independent. Fleet accounts
are not a requirement for ordinary YA.

## Scope and first-key trust

A separate constructible Hono service and standalone entry point introduces
accounts and enrolled clients. It imports no provider registry/scanner or main
YA app, has no hosted default and coordinates no agent workflow. Joining an
account grants no execution or legacy operator API access. The first consumer
is a YA server; profile UUID, client UUID, account, keys and route are distinct.
This one service owns authentication, directory, issuance and the opaque mailbox;
"broker" names that mailbox component, not another required deployment or the
relay/push broker. Opaque-only concerns invitation payloads; the service still
knows account, public-key and relationship metadata.

Owner configuration chooses an exact HTTPS issuer and account UUID. Initial
client introductions trust that issuer; target acceptance and source import
persist the exact introduced client/profile and signature/encryption keys.
Fingerprints are inspectable. Independently comparing fingerprints is a stronger
ceremony, not something this flow claims. An actively malicious issuer can
substitute a first-introduction key; opaque delivery protects credentials only
when encrypted to the intended accepted recipient. Manual peers are unaffected.

Each profile generates separate P-256 signature and encryption key pairs in
owner-only storage. No key, password, refresh capability or peer secret enters
agent environments. Changed/lost keys never replace a pin transparently. Recovery
revokes the old enrolled client, requires fresh owner login/enrollment and
explicit reacceptance at peers. No automatic key rotation in this slice.

## Basic accounts and common account result

Provide a real administrator-provisioned username/password backend. Local
accounts have immutable UUIDs, normalized local names and bcrypt hashes. Reuse
maintained hashing and private-file publication/permission primitives. Passwords
are 12 or more characters and at most 72 UTF-8 bytes, without normalization or
silent truncation. Unknown users perform a dummy comparison; failures are
generic. Password changes increment an authentication generation and invalidate
sessions and pending enrollment. No signup, email, self-service reset or MFA UI.

Offline administrator add/change-password commands read passwords from private
stdin and refuse concurrent directory ownership. Service and commands acquire
an exclusive transaction in a separate private SQLite ownership file, released
on process exit. It guards the atomic state file without heartbeat timers or
PID-based stale-lock recovery. Failed acquisition publishes nothing. Publication
failure/corruption closes admission until recovery; never regenerate missing
signing keys over an existing identity.

Basic and OIDC adapters return the same internal account UUID, authentication
generation and absolute session lifetime. Local and `(issuer, subject)` identities
have separate namespaces. No email/name matching or implicit linking. Basic
session families have a 30-day absolute lifetime. OIDC families default to one
hour, requiring a new upstream login afterward. This is not continuous upstream
logout/account-disable detection; no fresh MFA assertion is invented.

This small account-session API is not an OAuth/OpenID provider for arbitrary
applications. Use `jose` for JWS/JWT/JWE and `oauth4webapi` for DPoP resource
request construction/validation. Signatures accept ES256 only; envelopes use
ECDH-ES/A256GCM. Explicit HTTPS public origin and TLS termination are required
for network deployment; plain HTTP is an explicit loopback fixture option.
Do not infer authority from proxy headers, token-supplied URLs or relay names.

## Pending login, enrollment and refresh

Basic password login creates a 90-second outstanding pending enrollment and a
sender-constrained bootstrap JWT. Pending state binds account/auth generation,
profile UUID, complete signature/encryption public keys and thumbprints, nonce,
audience, purpose and expiry. No client binding is published by password login.

A subsequent DPoP-protected enrollment proves the signing key and matching
pending encryption key. After asynchronous verification, one serialized mutation
rechecks account state, consumes pending authority and publishes client/session
atomically. Repeated consumption is refused. Pending logins are invalid after
restart, so recovery is fresh login with the same keys/profile; that reuses the
existing client identity. Different keys require explicit recovery, not a new
binding under a familiar profile UUID.

Client revocation also advances an account enrollment generation. All outstanding
enrollments for that account become invalid, including login/signing already in
progress; unrelated enrolled session families retain their own authority.
Enrollment compacts revoked clients and their dependent retired records, so the
256-client limit bounds current identities rather than lifetime enrollments.
Client disconnect aborts HTTP admission immediately, drains any in-progress
credential publication and then removes durable credentials. Failed removal
keeps that client closed; callers await completion before treating removal as
durable.

Control-plane tokens use RFC 9068 access-token shape (`typ=at+jwt`) with exact
issuer/fleet-service audience, `iat`, `exp`, `jti`, `cnf.jkt` and explicit purpose.
Required identity and ledger fields depend on the purpose:

| Purpose | Subject and client ID | Applicable authority before dispatch |
| --- | --- | --- |
| Basic enrollment | Account UUID; pending-enrollment UUID as `client_id` | Outstanding pending ID, account/auth generation, exact profile and both keys, expiry; no published client/session is required |
| OIDC redemption/status | OIDC-flow UUID for both `sub` and `client_id` | Outstanding flow, provider/profile/key binding and expiry; no account/session exists before callback. Redemption additionally requires its ready account result and current auth generation |
| Enrolled control | Account UUID; enrolled-client UUID | Current session ID, account/auth generation, active client and exact profile/key binding |
| Refresh only | Account UUID; enrolled-client UUID | Same current-session checks plus exact current refresh-token hash and absolute family expiry |

Bootstrap and OIDC tokens include their pending/flow ID and profile/key bindings;
session tokens require session ID and auth generation. A pre-session token never
uses a fabricated active session or account. Nonce admission validates the
applicable pending authority for pre-session purposes. Bootstrap scope authorizes
only enrollment. Five-minute control tokens authorize only enrolled-client
control operations. A rotating refresh-only JWT authorizes only the refresh
resource and never reads, proposals or peer access. It has the family's absolute
expiry; rotation cannot extend that deadline. The service stores only its current
hash/identity and session generation. This JWT capability lets the maintained
resource validator verify DPoP on refresh without a custom opaque-token proof
validator. It is not advertised as an interoperable OAuth refresh grant.

Refresh is serialized and generation-fenced. A consumed old capability cannot
rotate twice. Lost refresh response or failed client publication requires fresh
login; no recovery/grace protocol or saved password is introduced. Client key
bindings and manual peers survive. Account/client/session revocation also fences
pending enrollments, in-flight signing and late refresh/import publication.
Fresh enrollment with the same client binding replaces its previous session
family, retiring inaccessible old refresh capabilities. There is one active
family per client. Every issued control/refresh token is capped at that family's
absolute expiry, including tokens minted immediately before the deadline.

## Control-plane nonce admission

DPoP is used on actual fleet HTTP resources, not synthetic peer URLs. The library
validates signature, token hash, method and URI. YA additionally checks token
purpose, account/client/profile/session generation, nonce and authorization.
A proof has a 60-second maximum age and five-second future allowance.

An otherwise authenticated request missing a usable nonce gets an explicit
`use_dpop_nonce` challenge before mutation. Issued random nonces are bound to key
thumbprint and token identity, expire after 60 seconds and consume atomically
once before application dispatch. At most 256 exist, with eight per token;
expired entries are removed on demand. No nonce is issued before proof/token and
applicable pending-authority or current-session validation. Challenge admission is bounded per authenticated
key and globally. Restart invalidates outstanding nonces.

Rate policies use elapsed-time token buckets, bounded before expensive work:
basic login is 64/minute globally (burst eight) and six/minute per normalized
username (burst three). Unauthenticated OIDC initiation is 64/minute globally
(burst eight) and eight/minute per actual admitted remote IP (burst four).
Nonce challenges are 256/minute globally (burst 32) and 60/minute per verified
key (burst eight). Never trust forwarded IP headers implicitly. A depleted
bucket returns 429 with `Retry-After`; no mutation or nonce issuance occurs.
At 1,024 limiter keys, reclaim only entries inactive for ten minutes; otherwise
refuse a new key rather than evicting an active/blocked identity. Existing keys
retain their limits. No retry loop or timer is attached to a denied request.

Successful authenticated responses supply the next single-use nonce. A serialized
client therefore does not need a challenge for every operation; replay still
fails because each nonce is consumed once. Lost replies can require a new
rate-limited challenge.

The client may retry one explicit pre-admission nonce challenge. It never retries
an ambiguous application mutation automatically. Fleet calls are serialized per
profile with at most eight waiters and retain caller deadlines. Token renewal
is demand-driven/coalesced; no idle polling or per-session timer is added.

## Directional proposals and opaque delivery

An account proposes one client/profile to another, with exact bounded projects,
operations and expiry. A complete policy is limited to 12 KiB of JSON, in
addition to its individual field limits, before publication; this leaves room
for token and envelope identity bindings. Expired/revoked proposals are retired
on new proposal admission, allowing the same pair to propose again without
accumulating historical generations. Issuance derives identity from the authenticated session,
not request-supplied account or source fields. The target owner separately trusts
the exact issuer/account and accepts the exact introduced source keys within a
local project/action ceiling, acknowledging server-account execution authority
for create/message. Initial acceptance/sync is explicit, not account-wide mesh
permission. Human UI can follow these owner-only HTTP operations.

The target creates a distinct fleet SRP credential. A signed invitation binds
issuer/account, both client/profile IDs and accepted public keys/generations,
relationship ID/generation, credential ID/generation, policy, owner-selected
route and validity. Use `typ=ya-peer-invitation+jwt`, exact source-client audience
and target-client subject. Encrypt that JWS to the source encryption key as JWE.
The target durably publishes its incoming credential and ciphertext outbox in
one local state change before uploading. It never retains a re-exportable plain
secret. Upload retries reuse the exact envelope ID and ciphertext.

The broker stores bounded opaque ciphertext and indexing metadata only. It
receives no manual peer secret or plaintext invitation. Only the authenticated
target publishes/replaces its generation and only the bound source fetches it.
Broker metadata alone never grants peer authority.

Source adoption trusts the issuer's first target introduction and pins it
explicitly. Decrypt untrusted JWE first, then verify the inner target JWS before
trusting content. Validate every binding, policy/route/expiry and pinned key;
perform protected SRP preflight and commit with the existing revision fence.
Acknowledge the exact envelope/generation only after durable import. Fetch may
repeat before acknowledgement; identical imports are idempotent. Superseded,
expired or conflicting generations are rejected. Acknowledged ciphertext can be
removed; recovery after lost local keys/state needs target reissuance, not secret
export. Outboxes survive restart and are retired by revocation/disconnect.

## Per-request peer authority

Keep the existing SRP/NaCl channel as credential-possession and target proof.
The first slice omits peer-side DPoP and synthetic logical HTTP URIs. Fleet
service key proof controls token renewal, and the SRP secret is delivered only
to the accepted source encryption key. A fleet peer request additionally carries
a short-lived issuer-signed token bound to that exact SRP credential/generation.
A token alone or SRP secret alone cannot enter a fleet record.

Use `typ=ya-peer-grant+jwt`, `iss=trusted issuer`,
`aud=urn:yep-anywhere:peer:<target-profile-uuid>`, source-client `sub`, `iat`,
`exp`, `jti`, and a strict versioned YA claim containing account, both
clients/profiles, accepted source signature/encryption thumbprints, relationship
ID/generation, credential ID/generation, project IDs and operation IDs. The
issuer derives these from the active session and published accepted relationship.
No arbitrary audience, account or credential supplied by a caller is signed.

Retain encrypted `Authorization: Bearer <peer-secret>` and add the fleet token
in a separate bounded header. A durable credential-origin discriminator makes
fleet records require both proofs; missing/invalid tokens never fall through to
manual auth. The unforgeable SRP handoff and bearer credential must identify the
same current record/generation. Intersect token authority, accepted relationship
and current local ceiling; preserve source launch/outgoing-record checks.
Construct the existing immediate-peer principal only after these checks.

Peer tokens last at most 290 seconds, with at most five seconds future issuance
accepted and no observation/admission beyond token expiry. The conservative
advertised issuer-revocation bound remains five minutes. Target local revocation
is immediate. Account refresh never extends a target relationship or its
30-day maximum SRP credential lifetime; reissuance is an explicit owner action.
Recheck generations/authority after async verification and before admission or
reply. Accepted native work remains. Issuer outage permits only still-valid
cached authority with sufficient request budget, never stale tokens or manual
fallback. No auth refresh resubmits an ambiguous native mutation.

Every peer token's expiry is also capped at the originating account family's
absolute expiry and the relationship, credential and target acceptance/grant
expiries. A last-moment refresh cannot carry authority past any of these bounds.

JWKS comes only from configured issuer trust: at most four ES256 public keys,
ten-minute cache, one in-flight fetch per issuer, at most one unknown-key refresh
per minute, 64-KiB response and five-second timeout. Unknown issuer/key fails
closed. This slice persists one issuer signing key and supports explicit offline
rotation with bounded retained public keys; no automatic key-rotation service.
The five-minute offline revocation bound covers account, client and relationship
revocation by stopping renewal. It does not cover compromise/removal of an issuer
signing key: cached trust can last ten minutes. Emergency local issuer distrust
immediately retires its fleet grants/channels and cache; manual peers survive.

## Coexistence and versioned peer state

Peer state v2 explicitly migrates v1 credentials as manual, preserving all
existing IDs, meaning, retry scopes and source attestations. Incoming uniqueness
becomes `(source profile, origin)`; manual and one fleet relationship may coexist.
Each outgoing credential has its own ID/origin and policy. A separate map selects
one credential per public target UUID. Existing v1 selections stay manual.

Fleet import never changes an existing manual selection. An owner selects a
new/standby credential explicitly. Deleting/disconnecting fleet access removes
only fleet credentials and clears a removed selection; surviving manual records
remain inspectable and can be explicitly selected. There is no silent fallback
after denial, expiry or an ambiguous mutation, and topology never duplicates the
same public target. `DELETE outgoing/<target>` deliberately removes all its
credentials; origin-specific operations support narrower removal.

Atomic migration leaves either complete v1 or complete v2 state; repeated
migration derives the same IDs. Unknown versions fail closed and older code
refuses v2 rather than interpreting fleet credentials as manual. Manual wire
messages remain unchanged. Fleet invitations/metadata advertise their distinct
version; unsupported targets/importers fail explicitly before credential release.
Both sides preserve current receipt/retry identity across credential changes.

YA enrollment/disconnect has its own durable generation. Removing it retires its
local fleet records/keys first and aborts pending work; late refresh/sync cannot
recreate them. Manual records survive. If the optional service is unavailable,
report remote revocation unconfirmed without restoring local authority.

## OIDC into the same enrollment

Use existing `openid-client` authorization-code OIDC with PKCE/state/nonce,
exact configured issuer/client/callback and one-use pending flows. External
accounts must be administrator-provisioned by exact `(issuer, subject)`; a login
at an arbitrary account of a configured provider does not create fleet membership.
No implicit local/external account linking is offered.

The initiating YA owner creates a pending flow bound to its profile, both keys,
local enrollment generation and the authenticated owner-session binding. The
service stores that binding with provider, callback, state/nonce/verifier and
five-minute expiry. A key-bound, enrollment-only redemption JWT is returned to
YA, never placed in browser URLs. It conveys no account authority before OIDC
completion. Callback consumption is single-use before exchange; completion
stores the authenticated account result against that exact flow, not a browser
refresh capability. Browser output contains status only.

The same originating owner session then completes through YA. YA checks local
flow/generation/session binding and redeems with DPoP using the initiating key.
The service atomically consumes the ready flow, rechecks account generation and
calls the same enrollment/session path as basic login. A detached/changed owner,
wrong profile/key or expired/restarted flow cannot redeem it. Missing stable
owner-session binding refuses initiation rather than weakening that check.

Configured Keycloak/Dex-compatible and Clerk OIDC providers share this adapter.
Upstream owns MFA/recovery. One-hour absolute OIDC fleet sessions bound later
refresh without asserting continuous upstream logout detection. Protocol tests
use an owned local issuer, real code exchange/JWKS and verified tokens; live
vendor qualification remains distinct. Existing artifact OAuth/email policy is
not fleet account authority.

## Resource and verification gates

### Standalone service surface

The service can be constructed with `createFleetService(FleetStore)` without a
listener. Its HTTP resources are under `/fleet/v0`; this version remains
unstable. `GET /fleet/v0` explains the authentication boundary and `GET
/fleet/v0/jwks` publishes only signing public keys. `POST /login` accepts local
credentials and a profile introduction, returning pending authority rather than
membership. DPoP-protected `POST /enroll` publishes membership; `POST /refresh`
rotates refresh authority. `GET /me`, `GET /clients[/:id]`, `DELETE /clients/:id`,
`GET|POST /relationships`, `GET|DELETE /relationships/:id`, `PUT
/relationships/:id/envelope`, `POST /relationships/:id/token`, `GET
/mailbox[/:id]` and `POST /mailbox/:id/ack` expose the bounded control plane.
Mailbox list responses omit ciphertext; fetch one envelope explicitly.
Lists accept `cursor` and `limit` (default 20, maximum 50). Oversized replies
fail with a request for a smaller page. Responses contain no password hashes,
private keys or another client's refresh capability.

After building the server package, run `node
packages/server/dist/fleet/main.js --directory PRIVATE_DIR --issuer
https://HOST:PORT local-account USERNAME`, supplying the password through private
stdin. This creates or changes that account, invalidating its session families.
`oidc-account ISSUER SUBJECT NAME` provisions an exact external identity;
`revoke-client UUID` supports administrator recovery. Revocation keeps old
sessions/relationships retired; fresh login may create a new client identity for
that profile and replacement keys, requiring new peer acceptance.
`rotate-signing-key` retains the previous public key, up to three; explicitly
`forget-signing-key KID` before exceeding that bound. Cached trust can outlive
removal as described above.

`serve --tls-cert CERT_FILE --tls-key KEY_FILE` runs the independent HTTPS
service. An explicit `--fixture-http` permits only loopback HTTP for owned tests.
There is no forwarded-header trust or implicit TLS proxy deployment mode.
Administrator commands and serving refuse concurrent directory ownership. No
listener is started by importing the fleet modules, and the main YA server
does not start this service automatically.

Bounds apply before expensive work: 64 accounts, 256 clients, 1,024 proposals,
256 sessions (one family per client), 128 pending basic logins, 64 OIDC flows, 256
nonces, 128 ciphertext mailbox items and 64 target outbox items; each ciphertext
is at most 32 KiB as an encoded wire value. Expired transient records are removed on demand, acknowledged
mail deleted, retired generations limited to current state. Limiters retain at
most 1,024 keys. Keep at most four bcrypt, eight JWT/key verification/signing
jobs, four service preflights and one coalesced JWKS fetch per issuer. Abandoned
native crypto still owns its slot until settlement. Mutation queues cap at 16.
Service/peer state files cap at eight MiB, service HTTP bodies at 64 KiB, JWTs at
32 KiB, HTTP replies at 256 KiB and request lifetime at ten seconds. Peer channel
limits remain unchanged. Refuse capacity instead of evicting active authority.
Measure the final encoded JWE, not just its plaintext or inner JWS; envelope
construction that exceeds the cap fails before credential publication. Metadata
lists are paginated (default 20, maximum 50); ciphertext fetch is per envelope.
Explicit source adoption handles one envelope per bounded request, not an
unbounded fleet scan or batch of preflights.

Implement after independent design closure: real local accounts and sessions;
key-bound enrollment/proposals; target acceptance, mailbox and source adoption;
per-request credential-bound tokens and revocation; then OIDC into that same flow.
Native agents keep their existing private `/me`, discovery and v0 workflow.
No scheduler, cloning/worktree policy, roles or custom delegation lifecycle.

Completion requires real password and OIDC consumers each performing protected
create/message/follow/revoke, same-pair manual/fleet coexistence with explicit
selection, and manual access with the fleet service stopped. Cover ownership,
restart/corruption, one-use login/nonce races, lost refresh/delivery replies,
wrong issuer/audience/key, local ceiling reductions, downgrade and disconnect
races. Run light opt-in model evidence only after deterministic boundaries pass.

[oauth4webapi](https://github.com/panva/oauth4webapi/blob/main/docs/functions/validateJwtAccessToken.md)
leaves nonce and authorization semantics to the application.
[Clerk's SSO guide](https://clerk.com/docs/guides/configure/auth-strategies/oauth/single-sign-on)
describes its OIDC-provider mode with the `openid` scope; this is not live
qualification of a particular configured issuer.

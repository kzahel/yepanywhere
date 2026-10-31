# Directional peer access and optional fleet enrollment

Status: implementation authorized, 2026-10-31. Design review precedes code.

The maintainer wants agents to discover authorized YA hosts and use the same
HTTP operations there. YA should expose topology, identity and provenance;
native agents retain checkout, worktree, polling and workflow decisions.
Manual enrollment must work without a central login. An optional fleet service
may use real basic local accounts or external authentication interchangeably.

## Existing work and constraints

Build on [HTTP v0](../../topics/http-api-v0.md), especially the outstanding
[two-peer and secure-route slices](165-http-api-v0.md#5--exercise-two-direct-peers-before-grant-ui),
and [the completed local workflow](167-agent-session-commands-and-following.md).
Use [principals and grants](../../topics/principals-and-grants.md)' vocabulary:
authentication identifies a server; target-side grants authorize operations;
transport chooses a route; a newly launched unsandboxed agent has the target
OS account's authority. Project restrictions are API selection, not isolation.
The [roadmap](../roadmap/README.md) still defers general delegation policy,
scheduling, session migration, PTYs and command execution.

Adjacent defects remain distinct: [legacy tools under password auth](../../gaps/agent-tools-lose-ya-api-under-local-password.md),
[password minimum disagreement](../../gaps/local-password-minimum-disagrees.md),
and [Rendez watcher flakiness](../../gaps/rendez-nested-watch-event-after-restart.md).
Do not broaden existing read-only launch leases, copy browser credentials, or
restart/reconfigure the primary server or provider host during verification.

## 1 — Route a complete session workflow between two isolated peers

Complete: independently constructed router/receiver, distinct peer principal,
revocable grants and durable outbound SQLite ledger. Normal startup remains
unchanged; fixture enrollment is not production enrollment.

Evidence, 2026-10-31: 47 core tests pass, including ten new peer integration
cases and two owned ephemeral TCP listeners. Workspace checks pass (6,631 server
and 7,062 client cases, plus remaining packages); known client jsdom navigation
diagnostics remain [tracked](../../gaps/client-unit-navigation-diagnostics.md).
Lint, format and types pass. A durable intent/remap/foreign-alias probe passes
on Node 22.23.3 and desktop's pinned Bun 1.3.14. One opt-in Sol 6.1 medium local
workflow regression succeeds in 31.6 seconds, 14 requests, zero errors and 14,863
fetched documentation bytes; processed input is 152,408 tokens, including
130,432 cached, not unique context. This is local workflow regression evidence,
not peer or protected-route model qualification.

Independent Sol high and Daybreak Blue high code reviews found five bugs:
stalled-body revocation, conflict privacy, target canonical retries, late
source remap confirmation and old-lease outbound history. All have fixes and
integration regressions; both reviewers rechecked and found no remaining
material issue in those paths before this slice's commit.

Add a small independently constructible peer directory, authenticator and v0
router around the existing application API. Two profiles have separate public
server UUIDs, credentials, grants, receipt stores and native owners. Bind an
incoming credential to the immediate source server; never trust identity headers
from an unauthenticated caller. Do not add peers to legacy superuser principals.

For this development slice provision independent random opaque fixture tokens.
The receiving adapter uses the real HTTP authentication boundary, even with an
in-process fetch transport. It is unavailable in normal production startup.
Tokens are configured out of band; they never appear in schemas, listings,
provenance, errors or committed examples. Actual HTTP is loopback only.

A configured peer id selects an injected transport, never an arbitrary URL in
request JSON. Only registered v0 operations may cross it. Remote incoming calls
cannot route onward or discover the receiver's other peers. Incoming and
outgoing access are independent, default-deny and non-transitive. Unknown,
unreachable, unauthorized, unsupported and wrong-target outcomes are explicit.
Do not automatically retry or change transport after an ambiguous mutation.

Target grants contain explicit projects and operations. Enforce reads, creation,
message submission, receipt observation and provenance at the target. Restrict
receipt reads to their authenticated originating peer and currently authorized
project. Revocation blocks further admission/observation; accepted agent work is
not implicitly cancelled. Enforce source launch management authority too.

Forward immutable authenticated launch attribution separately from user JSON.
Label a source session as source-attested, not locally authenticated at the
target. Scope retry keys to source server/session and destination operation.
Record both outbound intent/outcome and target receipt without claiming a shared
transaction. A lost response stays uncertain until the same key recovers it.
Remote session IDs must never collide with local alias mappings or local
relationship queries. Preserve existing local and limited-user behavior.

Retain fast real SQLite plus Hono tests for directional permissions, resource
filtering, spoofing, no onward forwarding, retry conflicts, lost responses,
revocation and cancellation. Add one owned TCP smoke with OS-assigned ports.
Exercise creation, messaging and compact following through the same boundary.
Import/construction must start no corpus scan, provider registry or listener.

### Design review acceptance requirements

Independent Sol 6.1 high review identified four implementation requirements:
separate peer authority, protect every receipt/replay/provenance path, qualify
identities on both servers (including native metadata), and fence revocation
across async admission and observation. These are acceptance criteria for step
1, not defects in a shipped peer API. Retain races and same-ID collision cases.
Independent GPT-6 Sol high with Daybreak Blue confirmed the same boundaries
and additionally required durable outbound intent before transport dispatch.
Both design reviews completed before source edits; neither saw the other's findings.

## 2 — Enroll real peers and qualify protected routes

Complete, 2026-10-31: default-off production wiring, independently validated
owner management, durable private credentials/policy, sessionless SRP direct
and separate encrypted-relay ingress, and immutable native peer leases with
generation-scoped retirement. Normal local leases retain their authority.
The owning [peer contract](../../topics/peer-access.md) describes limits and
explicit failures; no UI, scheduler or delegation lifecycle is introduced.

Independent Sol 6.1 high and Daybreak Blue high code reviews found read-only
lease retirement, delayed retirement affecting fresh generations, late receipt
observation after revocation, and a setup-crypto cancellation gap. Fixes include
exact generation matching, authority checks before ledger writes, deadline
racing and bounded still-running crypto. Both reviewers rechecked the fixes.

Current workspace checks pass: 6,645 server and 7,062 client cases, plus other
packages; lint, formatting and types pass. Protected fixtures exercise actual
private profiles, direct SRP, an owned real relay, poisoned handoffs, parallel
pairing, cancelled crypto, rotation, revocation, lost replies, native private
HTTP and durable destination bindings. Test work remains isolated from the
primary YA server and provider host.

Owned runtime probes complete create/message/compact-follow/revoke in both
directions between Node 22.23.3 and desktop's Bun 1.3.14. A native Windows ARM64
Node 22.23.3 profile also completes Mac-to-Windows relay and Windows-to-Mac
direct workflows, separately granted reverse access, retry/consumption,
provenance and independent revocation through its private loopback API.
This qualifies these adapters and private credential storage, not packaged
Windows providers, desktop UI or the complete network matrix. Earlier Windows
probe failures came from leftover owned test children sharing a profile and
unrestored test relay startup; the final run has one fresh owner process.

One opt-in Sol 6.1 medium relay workflow initially passed in 46.9 seconds with
19 requests and four transient errors from parallel pairing against a single
waiting registration. A bounded pairing gate and six-request regression fix
that shared-transport path; independent sources can still contend. A subsequent
trial passes in 35.1 seconds, 15 requests, zero errors, 1,124 bootstrap bytes and
15,163 fetched help bytes. Reported processed input is 174,725 tokens including
152,064 cached, not unique context. Model calls remain outside CI.

The [reviewed production contract](../../topics/peer-access.md) now specifies
manual SRP credentials, independently validated owner management, sessionless
protected ingress, a separately bounded peer relay registration and native
launch ownership. Sol high and Daybreak Blue high independently reviewed it;
all design conditions are closed before source edits. Implementation order:
owner admission/durable records, restricted direct/relay acceptor, native peer
leases, then protected-route qualification. Keep production access disabled
until the complete boundary is verified.

Before production code, write down and independently review the credential
ceremony, storage, renewal, expiry, target binding and revocation contract.
Prefer existing SRP/NaCl and client-key continuity mechanisms where their actual
contracts fit; continuity on an already authenticated connection is not a new
unattended login proof. Do not implement a new cryptographic handshake.

Start with an owner-authorized manual ceremony and inspectable directional
relationships. A reverse grant is a second explicit decision. No browser
password, browser resume credential or relay installation credential becomes a
peer credential. Add public key binding only with a defined proof and lifecycle;
IDs and possession of a public key alone grant no authority. Expose authenticated
management APIs before depending on UI. Grant management is operator-only and
not inherited by session API leases.

Reuse the request abstraction for protected direct and encrypted relay access.
A loopback fixture pass is not SRP/relay qualification. Retain focused transport
integration for identity, reconnect, revocation and ambiguous outcomes. No
Tailscale dependency. Qualify Windows after real multi-device enrollment is
available, using the common machine-control interface if a testbed is available.

## 3 — Offer an optional fleet service with real local accounts

The first implementation unit is complete: independent Hono service, real
offline-provisioned bcrypt accounts, key-bound DPoP enrollment, absolute-lived
session families, refresh rotation, client revocation/recovery, bounded issuer
directory/proposals/mailbox and short-lived peer token issuance. It imports no
main YA server or provider discovery. Sol high and Daybreak Blue high closed
all material code findings. Thirteen focused integration scenarios cover real
JWT/DPoP, durable ownership, restart/corruption, nonce and independent-proof
commit races, revocation across signing, lost refresh replies, cross-account
isolation, publication uncertainty and disconnect across a real file write
(about 3.3 seconds test time). Root lint/format/typecheck pass; workspace tests
pass with 6,658 server and 7,062 client cases. The current dependency audit also
passes after the separately committed patch/triage. This unit does not yet
consume fleet authority at a peer target: state v2, protected token admission,
opaque enrollment delivery and YA owner endpoints remain the next unit. OIDC
follows that integrated consumer.

The [concrete fleet design](../../topics/fleet-authentication.md) has completed
independent Sol high and Daybreak Blue high review before source edits. It separates real basic login
from device-key binding, target-enforced proposals and protected peer access;
manual enrollment remains independent. Its token/envelope protocol is not
accepted merely because the manual transport has passed qualification.

Keep this service separate from the YA execution core and optional for manual
peers. Its first backend is a real administrator-provisioned username/password
database, not a test mock: no signup, email or password-reset requirement.
Use existing audited password hashing and session primitives with bounded
sessions and login attempts, private storage and explicit administrator recovery.

Accounts introduce enrolled device/server identities and propose directional
grants. Targets explicitly trust an issuer and intersect its proposals with
local ceilings; joining an account does not silently grant execution on every
host. Define signed/key-bound grant issuance, audience, expiry and offline
revocation semantics before enabling consumption. Do not expose fleet signing
secrets to sessions or conflate login with target authorization.

Use the same local account adapter in deterministic isolated integration tests.
Exercise enrollment, grant acceptance, removal and independent manual access.
An implementation is complete only when an authenticated consumer can perform
the peer workflow and revoke it, not merely when configuration accepts fields.

## 4 — Attach external login without changing peer authority

Add a real OIDC adapter through the existing audited openid-client dependency.
Support compatible self-hosted providers (such as Keycloak) and a managed
provider (such as Clerk) by configuration; no vendor is mandatory. External
identity is (issuer, subject), never email-based account linking. Both external
and local login feed the same enrollment and grants. Delegate MFA/recovery to
the configured upstream without inventing an assertion of fresh MFA.

Test the OIDC protocol boundary with a local standards-compliant issuer fixture,
not live paid accounts in CI. Keep native/manual enrollment working with the
fleet service absent. Record any provider-specific qualification still needed.

## Reviews, evidence and commits

Launch independent read-only Sol 6.1 high and Codex Daybreak Blue reviews before
step 1 code, after the working two-peer slice, and before production enrollment.
Use YA sessions, bypass permissions, without changing the primary profile.
Each reviewer receives the contract/code before seeing the other's findings.
Record actual model/access-program evidence; a fallback is not a Daybreak review.
Reconcile and fix material findings before advancing. Repeat focused reviews
between subsequent steps. Commit coherent reviewed slices with model trailers.

Run deterministic tests first; opt-in light subscription evals may exercise
host discovery, create/message/follow and lost-response recovery once fixtures
are stable. Record instruction bytes, fetched help bytes, requests, errors and
outcome, distinguishing repeated token usage from unique context. Model calls
stay out of CI. Run required lint/format/typecheck/workspace tests on final
source; report known unrelated failures without retrying them away.

Owning topic contracts and roadmap status must distinguish implemented behavior
from later slices throughout. Keep local coordination and reviewer artifacts in
ignored tasks/peer-access. Do not claim remote or Windows qualification from
in-process tests. No deployment or publication is implied.

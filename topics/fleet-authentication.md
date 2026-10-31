# Optional fleet accounts and key-bound enrollment

Status: candidate for independent design review before plan 168 steps 3–4.
Manual [peer access](peer-access.md) remains independent. This is not an
implemented authentication service or a new requirement for ordinary YA.

## Boundary

The fleet service introduces authenticated accounts and enrolled clients. It
proposes directional relationships; targets accept them within explicit local
ceilings. It never becomes the relay or an agent workflow coordinator. Joining
an account does not grant execution, legacy `/api` access or the YA operator
principal. Browser/mobile clients can later use the same identity vocabulary;
the first consumer is a YA server with its own persistent profile UUID.

The implementation remains a separate constructible Hono service and standalone
entry point under the server package. It imports no provider registry, scanner
or ordinary YA app. It starts only when invoked explicitly, with a private data
directory and configured issuer URL. There is no hosted default endpoint.

## Real local accounts first

The minimal backend has administrator-provisioned local username/password
accounts with immutable account UUIDs. Reuse bcrypt and existing private-file
publication/permission helpers. Provide offline administrator add/change-password
commands reading passwords from private stdin. No public signup, email delivery,
self-service reset or local MFA UI. Password changes invalidate existing account
sessions. Account names are not portable identities and do not merge external
identities. OIDC is a later adapter into the same authenticated account result.

The service is not an OAuth/OpenID authorization server for arbitrary clients.
Its small account-session API uses standard JOSE JWTs and RFC 9449 sender
constraints, rather than implementing an OP and requiring all backends to do so.
Network deployment requires an explicit HTTPS public origin and TLS termination;
plain HTTP is an explicit loopback testing configuration only. Bind behind that
TLS boundary, preserve exact origin/host admission, reject redirects and never
infer proxy headers as authority. Password and token bodies are not logged.

Use a bounded login limiter, a fixed dummy bcrypt comparison for unknown users,
a small concurrent-hash ceiling, and generic failure responses. Persist at most
64 accounts, 256 enrolled clients and 1,024 relationship proposals. Refuse excess
state instead of evicting revocations or active identities. Atomic private state
has an eight-MiB limit and one serialized owner; uncertain publication fails
closed. One service process owns its data directory.

## Enrolled client identity and account sessions

Each YA profile generates two separate P-256 key pairs: one for signatures and
DPoP, one for JWE encryption. Private keys remain in owner-only profile storage,
never agent environments. Profile UUID, enrolled client UUID, key thumbprint,
account UUID and route stay distinct. A lost or changed key requires explicit
re-enrollment/recovery; a familiar profile UUID cannot replace a pinned key.

Basic login authenticates the account and accepts public key thumbprints. It
returns a 90-second, one-use enrollment bootstrap JWT bound to the signature key,
not a durable enrolled identity. No server/profile binding is published until a
subsequent DPoP-protected enrollment proves that key. Its recorded encryption
key must match the bootstrap's encryption-key thumbprint. Concurrent or changed
profile/key bindings conflict rather than silently replacing an enrolled client.

Enrollment returns a five-minute access token and a 30-day refresh capability,
both sender-constrained to the enrolled key. They use RFC 9068 access-token
shape with strict purpose/scope separation; a refresh capability authorizes
only refresh, not fleet reads or grant issuance. The service retains revocable
session identity/generation, rotates refresh capabilities and rejects superseded
ones. Refresh is demand-driven and coalesced by the YA client, without idle
polling or automatic mutation replay. Password change and explicit account,
client or session revocation apply at the service immediately.

Use `jose` for JWT/JWS/JWE and `oauth4webapi` for RFC 9449 resource request
construction/validation. These are cryptography/protocol dependencies, not new
handwritten primitives. Pin accepted algorithms to ES256 for signatures and
ECDH-ES/A256GCM for envelopes. No symmetric token key or issuer signing key is
shared with YA targets or agent sessions.

The resource validator still needs application checks: expected issuer,
account, audience, client/profile identity, token purpose, scope and current
session generation. It does not validate these meanings for the application,
and explicitly does not validate DPoP nonces. Control-plane requests therefore
also use a bounded, one-use nonce/replay policy. Do not treat successful JWT
parsing or a public key alone as authentication.

## Directional proposals and protected credential delivery

An authenticated account may propose source-client to target-client access with
bounded projects, operations and expiry. Targets separately configure the exact
trusted issuer/account and their local project/action ceiling. An owner accepts
a proposal through the existing strongly authenticated `/api/peers` management
boundary, with the existing execution-authority acknowledgment. No account-wide
implicit execution grant is introduced.

The target creates a distinct fleet SRP credential, using the current canonical
SRP verifier machinery. It signs an invitation with its enrolled signature key,
then encrypts that signed value to the source's separate encryption key using
JWS inside JWE. The broker carries only that opaque envelope, associated with
the exact source, target, relationship and generation. It receives no manual
peer secret, browser password/resume credential or target registration secret.

The source verifies the target's issuer-attested, explicitly pinned enrolled key
and all invitation bindings before decrypting/importing it. A changed target
key is not a transparent route update. Enrollment supplies inspectable key
fingerprints. Replay, expiry, generation and stale-preflight fences apply as in
manual enrollment. Importing fleet access never silently replaces an existing
manual grant or route. Manual and fleet credentials remain independently
revocable and usable when the other mechanism is absent.

Publish only target-owner-selected routes, signed with the invitation. Source
adoption explicitly accepts the configured fleet route policy; do not repoint
an existing configured relay or infer Tailscale. A target can advertise its
separate peer relay route. Source and target still address the profile UUID,
and the existing SRP target metadata proof precedes any token or mutation.

## Fleet authorization on each peer request

SRP continues to authenticate and protect the channel; it is not replaced by a
new public-key challenge protocol. A fleet credential additionally requires a
fresh issuer JWT with target audience, account, source profile/client,
relationship ID, key thumbprint, expiry and allowed projects/operations.
Intersect it with the current target-local record and ceiling on every request.
Manual credentials keep their existing separate authenticator.

Inside the encrypted HTTP request use standard `Authorization: DPoP <token>`
and a DPoP proof. The source signs the canonical logical v0 method/URI, token
hash and the authenticated channel's transport nonce. The logical HTTPS URI is
stable across direct and relay routes and includes the target UUID in the
resource path. The receiver validates RFC 9449 with `oauth4webapi`, then requires
that exact channel nonce and local identity/grant bindings. One HTTP request
per channel and its unique single-use nonce prevent proof reuse across
channels. The internal SRP handoff remains unforgeable by HTTP headers.

Only after both proofs may the receiver construct the ordinary immediate-peer
API principal. Do not place fleet callers in the legacy superuser/limited-user
classes. Session attribution remains source-attested. Audit records may add
issuer/account/client/relationship identity, never raw tokens or keys.

Issuer peer tokens live at most five minutes. A target uses its explicitly
trusted issuer and bounded JWKS cache; an unknown issuer/key never falls back
to manual authentication. Existing cached tokens can work during an issuer
outage only until expiry. Issuer revocation stops renewal, with a stated maximum
five-minute offline delay; local target revocation is immediate. In-flight
observations also stop at token expiry. Already admitted native work remains.
No auth refresh, reconnect or route fallback resubmits an ambiguous mutation.

Removing a local fleet enrollment first retires its local incoming/outgoing
credentials and private key/session material. Manual peers survive. Report
external revocation as unconfirmed if the optional service is unavailable;
never restore local authority to hide that partial outcome.

## Owner API and source runtime

Add owner-only fleet login/status, proposal acceptance, explicit sync/import,
revocation and disconnect operations under `/api/peers`. Return sanitized
identity/direction/expiry/status to normal inspection; never re-export keys,
refresh tokens or decrypted peer secrets. A minimal local backend is real and
usable through HTTP, not a test adapter or a CLI prerequisite.

Native agents retain their existing private connection, `/me`, `servers`, access
and schema discovery. The source owns fleet token renewal, key use and routing.
Existing immutable peer leases and outgoing `allowAgentSessions` still apply;
fleet login does not upgrade an old local-only lease. No scheduling, cloning,
worktree policy, task roles or workflow lifecycle enters this layer.

## External login slice

Use the existing `openid-client` dependency for actual authorization-code OIDC
with PKCE, state and nonce, exact issuer/client/callback binding and bounded
one-use pending flows. The service maps `(issuer, subject)` to its account UUID;
no email/name linking. Upstream owns password recovery and MFA. A normal
successful login does not assert fresh MFA.

Provide the same enrollment/session result as the basic backend, including key
proof and local target ceilings. Support compatible providers by configuration,
including self-hosted Keycloak/Dex and Clerk's OIDC-provider configuration.
Qualify the protocol with an owned local issuer fixture; do not require paid
accounts or public services in CI. Record provider-specific live qualification
separately. Existing artifact OAuth policy is not reused as fleet authority.

## Implementation and review gates

Before source edits independently review the exact token/envelope binding,
replay/nonce policy, refresh/recovery, trusted-target key discovery, local ceiling
intersection, offline lifetime, persistence/cancellation bounds and basic-login
admission. Reviewers may simplify or reject this candidate; merely choosing a
library does not establish a safe protocol.

Implement and test in these units: constructible real account/session service;
key-bound client enrollment and directional proposals; target acceptance and
opaque credential delivery; per-request peer authorization and independent
revocation; then OIDC login into the same flow. Commit coherent reviewed slices.
An implementation is complete only after actual authenticated consumers complete
create/message/follow and revocation with both login backends, while independent
manual access works with the fleet service stopped.

Keep deterministic account/core tests isolated. Retain real password/session,
DPoP/JWS/JWE, SRP/owned-relay, corruption/restart, wrong-key/issuer/audience,
expired/revoked grant, refresh race and manual-survival integration boundaries.
Use a light opt-in subscription workflow after those pass; model calls stay out
of CI. UI and Windows packaged-provider qualification remain separate.

## Protocol references

The [oauth4webapi resource validator](https://github.com/panva/oauth4webapi/blob/main/docs/functions/validateJwtAccessToken.md)
implements RFC 6750/9068/9449 while leaving nonce and authorization semantics to
the application. [Clerk's SSO guide](https://clerk.com/docs/guides/configure/auth-strategies/oauth/single-sign-on)
describes Clerk acting as an OIDC identity provider with the `openid` scope.
Neither statement is live qualification of a specific configured issuer.

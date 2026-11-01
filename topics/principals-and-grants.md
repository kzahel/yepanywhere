# Principals and grants

> Architectural coordination sketch for authentication and authorization work:
> keep who or what is acting, how it proved that identity, what authority it
> received, and how it reached the server as separate concepts. This aligns the
> limited-user, hosted-issuer, session-guest, and peer-delegation proposals
> without approving a shared protocol or implementation.

Topic: principals-and-grants

Status: **shared vocabulary and general grant architecture remain proposals.**
Local limited users and their project grants are implemented; exact-session
collaboration, hosted issuance, and a general delegation lifecycle remain
proposals. The narrow [peer API](peer-access.md) implements immediate
server identity and directional project/operation grants without those broader
contracts. This
document does not select an identity provider, require a hosted service, approve
a grant format, or make the related proposals roadmap commitments. Its purpose is to
make their relationship visible before one of them establishes a feature-local
identity or authorization model that the others cannot reuse.

## Why these proposals meet here

Several proposed features need to answer the same questions even though their
product shapes differ:

| Existing slice or proposal | Authentication or introduction | Authority the target must enforce |
| --- | --- | --- |
| [[limited-users]] | Local username with password, cookie, or SRP proof | Selected projects and actions, with execution restrictions |
| Session guests / participatory Live Share | Invitation/client proof initially; local or hosted account credentials later are candidates | One session with separate discussion, suggestion, send, queue, and steer actions |
| Optional account-based discovery and grant issuance in [[multi-machine-architecture]] | Local or external account plus a device-key-bound issuer grant | Enrolled-server policy and the grant's target/action scope |
| [[cross-host-delegation]] | A distinct peer credential established during pairing | Directional worker/controller permissions and local ceilings |

The hosted issuer is potentially a more general way to introduce people and
devices, but it does not replace target-side authorization. Conversely, a
local limited-user account can exercise target-side authorization without any
hosted dependency. They are possible credential sources and policy profiles
around a shared conceptual seam, not necessarily one delivery sequence.

## Shared vocabulary

- **Principal** — the person, device, YA server, or narrowly scoped guest on
  whose behalf a request acts. A principal has a stable server-understood id;
  a display name or email address alone is not that id.
- **Credential** — proof accepted by an authenticator, such as the existing
  owner cookie, an SRP proof or resume credential, a local password, a peer
  credential, or a signed issuer statement bound to a device key.
- **Authentication context** — the principal plus the credential method and
  relevant provenance established for one request or connection. Current YA
  distinguishes superuser and limited-user acting principals; the broader
  proposals need additional credential and issuer provenance.
- **Membership** — a principal's association with a particular collaboration
  or project. Membership identifies the audience/relationship; the applicable
  grants determine which actions are allowed. This distinction is proposed,
  not a new implementation schema.
- **Grant** — inspectable, bounded authority for a principal to perform actions
  against named resources. Candidate bounds include server, project, session,
  provider, action, time, and concurrency.
- **Local policy** — limits chosen and enforced by the target YA server. Trust
  in an external issuer may help establish a grant, but cannot widen the local
  policy ceiling.
- **Route or transport** — direct HTTP, LAN, Tailscale, or an encrypted relay
  circuit. Reachability carries no authority by itself.
- **Execution boundary** — the OS and provider restrictions that constrain
  work after an authorized request starts an agent. It is separate from API
  authorization.

The intended relationship is:

```text
credential authenticates principal
    -> target resolves applicable grant and local policy
    -> route authorizes the requested resource and action
    -> execution boundary constrains any resulting provider work
```

## Candidate shared properties

Any later proposal that turns this sketch into a contract should consider these
properties together. They are coordination criteria, not an approved wire or
storage schema:

- Authentication method and authorization policy remain separable, so adding
  hosted issuance does not require a second project-membership system and
  adding a local user does not define the hosted trust protocol.
- External identities are issuer-namespaced and sensitive grants are bound to
  proof of a device or peer private key. A mutable email address, display name,
  relay username, or URL is not sufficient identity.
- The target server computes effective authority from the grant and its local
  policy, and performs server-side checks on every affected route. Client-side
  filtering is presentation, not enforcement.
- Grants can be inspected and revoked where they are enforced. Expiry,
  credential renewal, issuer-key rotation, offline behavior, and revocation
  delay are explicit parts of any selected design.
- Authentication credentials, transport encryption keys, relay registration,
  and authorization grants remain distinct even when one flow establishes
  several of them.
- Authorization does not overstate execution isolation. A grant that permits
  agent input must still account for the session sandbox and the authority of
  the operating-system account running YA.

## Replaceable authentication and a basic local configuration

Maintainer-agreed sketch, 2026-10-31: authentication is replaceable; OIDC is
one optional adapter. YA's enrollment and grant services consume an
authenticated identity and authentication context, without requiring every
backend to implement an OAuth/OIDC server. This selects an architectural
boundary and supported configuration direction, not a wire protocol, vendor,
library, implementation schedule, or change to current authentication.

| Intended configuration | Login and account ownership |
| --- | --- |
| Built-in local accounts | Administrator-provisioned username/password accounts, with local password administration. No external account, OIDC service, public signup, email delivery, or self-service password-reset flow is required. |
| External OIDC provider | Login through Google, a self-hosted Keycloak/Dex instance, or another configured compatible provider. The provider owns its account lifecycle and authentication policy. |
| Managed authentication | An optional service such as Clerk, integrated through its supported protocol or adapter. No managed vendor is mandatory. |

```text
local password ----+
OIDC provider -----+--> authenticated identity/context --> YA sessions and grants
managed service ---+
```

The basic local backend is an intended production-usable configuration, not a
development mock or a forced stepping stone to external login. Minimal means
a small feature surface; reuse maintained password, session and protocol
implementations rather than inventing authentication or cryptography. Existing
local-password and limited-user services are relevant starting points, not an
automatic migration of their current principal or permission semantics.

The same separation applies to an optional hosted or self-hosted fleet
enrollment service: it may use basic local accounts while managing access to
several YA servers. Local account storage does not imply single-machine scope.
Each target still explicitly enrolls and trusts an issuer within its local
policy. Manual peer enrollment and existing local/SRP access remain usable
without an account service; a relay does not gain issuance authority.

Keep server identities, client-key bindings, resource grants and revocation
semantics independent of the login backend. Provider changes must not widen
authority or merge accounts by matching username/email. External identities
are issuer/subject scoped; local identities need their own namespace. Linking
identities or migrating providers requires an explicit verified operation.

Browser, native mobile and YA-server clients should share these concepts while
retaining platform-appropriate key storage. Existing continuity-key proof is
not automatically permission for unattended login. Mutual identity binding
and reverse-direction access grants remain separate decisions; exact
enrollment, key authentication, renewal and recovery are still protocol work.

For external login, the upstream provider owns passwords, MFA and recovery.
Accepting that provider's login does not by itself assert a fresh MFA event;
explicit assurance/step-up requirements need a separate policy. The basic
configuration need not add email or MFA management merely to share the same
enrollment/grant services.

The basic backend should also exercise real login, session issuance,
enrollment and grants in isolated tests without external services. Keep core
identity/grant tests in-memory where practical, with focused real local-auth
and provider-protocol boundary tests. A fake OIDC server is not a prerequisite
for testing the common authorization layer.

## Relationship to current YA

YA has one full-authority superuser plus optional, default-off local limited
users. Superuser local-password, desktop, and Remote Access SRP sessions reach
the ordinary operator API. Limited users authenticate with their own direct
cookie or SRP identity and receive server-enforced per-project view, join, and
new-session grants, with sandbox and freshness checks. See [[limited-users]]
for the delivered subset and [[security]] for the current trust boundary.

The relay server name routes a connection; it is not a person's identity.
Limited-user SRP identities are distinct from that routing name. Paired devices
and browser profiles provide continuity and audit identity, but do not by
themselves confer project membership or session participation. Existing local
limited-user policy is useful infrastructure, not an implemented universal
principal/grant format or temporary exact-session invitation system.

Existing public session shares and private app links are bearer grants with
their own bounded surfaces. They are relevant precedent for expiry,
revocation, and inventory, but do not yet form a general principal-and-grant
system.

## Session collaboration and future accounts

Maintainer direction, 2026-09-30: design trusted-colleague collaboration so an
initial session invitation can eventually converge on local or hosted accounts,
including URL and email invitations. The
[Participatory Live Share sketch](relay-origin-and-share-gating.sketches.md#participatory-live-share)
owns the product actions; [session notes and discussion](session-notes-and-discussion.md)
owns human-only content. Neither adds project-wide authority or requires a
hosted identity provider.

Candidate reusable boundaries:

- Give a participant a stable server-understood identity. Keep display names,
  enrolled client/device keys, membership, and credentials distinct. A chosen
  seat name or per-tab public viewer id cannot authenticate shared writes.
- Attach membership to the collaboration and grants to exact resources/actions.
  Chat, suggest, send, queue, and steer are separate from approvals, session
  settings, interruption, files, and publishing. Adding a login method must not
  silently widen an existing grant.
- An invitation introduces a recipient and is redeemed under the selected
  admission policy; it is not permanent identity. One-time, client-key-bound
  redemption with owner approval is a candidate first flow, not an approved
  protocol. Email delivery is a future option; an email address alone does not
  establish the authenticated principal that receives membership.
- Record discussion/suggestion authorship against the admitted principal.
  Preserve the suggestion author and applying owner separately. Linking an
  invitation-based participant to an account should preserve those references
  through an explicit, verified linking step, never name/email matching alone.
- Keep grant lifetime, credential/authentication-session lifetime, client-key
  lifetime, and record retention separate. Revocation and expiry need target
  enforcement for both requests and ongoing subscriptions; changing credentials
  must not resurrect a revoked membership.
- For external login, identify accounts by issuer and stable subject identity.
  Hosted issuance requires explicit server enrollment and a local policy ceiling
  as described in [[multi-machine-architecture]]. The relay's forwarding role
  does not become admission authority implicitly.

"Lose access when signed out of Google" is a desired future policy, not a
consequence guaranteed by federated login. A selected provider must support a
usable session/logout signal or access must use bounded reauthentication leases
with a stated detection delay. [OpenID Connect Back-Channel Logout](https://openid.net/specs/openid-connect-backchannel-1_0.html)
is one standard mechanism, not a promise of support by every identity provider.
Third-party cookie checks are not selected as the authority mechanism. Provider
outage, offline behavior, revocation delay, and renewal policy remain design
questions before account-backed admission ships.

## Coordination for future work

Before implementing named users, project or session membership, hosted grant
issuance, or peer authorization, review this sketch and state how the proposed
slice relates to its vocabulary. An incremental implementation may deliberately
support only one credential source or grant shape; it should identify which
seams are reusable and which questions it is deferring.

In particular, avoid assuming that:

- a local username must become the universal principal id;
- a hosted account automatically has authority on every enrolled server;
- successful relay or direct connection implies admission;
- a peer should reuse a browser password or resume credential; or
- a narrower UI establishes a server-side or execution boundary.

This coordination note does not prescribe whether local limited users, hosted
discovery, or a narrow guest/peer proof should be the first useful slice. That
ordering remains a product and implementation-plan decision.

## Open design questions

- Principal identifiers, issuer namespaces, persistence, and migration of the
  existing implicit owner.
- Extending the implemented acting-principal and route-authorization boundaries
  for session guests, credential provenance, and external issuers.
- Grant resource/action vocabulary and whether policy profiles such as editor,
  viewer, or session guest are stored roles or compiled grants.
- Enrollment, key possession, rotation, recovery, outage behavior, and
  revocation latency for an optional hosted issuer.
- Credential and session lifetimes across cookie, SRP/resume, device, and peer
  flows.
- Audit and grant inventory shared by named principals and existing bearer
  links.
- Which authorized agent actions require a stronger execution boundary than
  the currently implemented sandbox provides.

## See also

- [[security]] — the current superuser/limited-user authority and trust boundaries.
- [[limited-users]] — delivered local-user policy and remaining proposals.
- [Participatory Live Share](relay-origin-and-share-gating.sketches.md#participatory-live-share)
  and [[session-notes-and-discussion]] — proposed session participation.
- [[multi-machine-architecture]] — optional hosted discovery and grant
  issuance.
- [[cross-host-delegation]] — directional server-to-server trust and grants.
- [[mobile-server-pairing]] and [[security-client-audit]] — device continuity,
  resume credentials, audit, and revocation.
- [[relay-origin-and-share-gating]] and [[active-content-security]] — existing
  bearer-authority surfaces.
- [[session-sandboxing]] — the current execution boundary and its limits.

# Rename fleet terminology to Identity Service

Status: implementation authorized, 2026-11-02. The maintainer requested all
three phases end to end, committing reviewed slices and using Sol 6.1 high
with bypass permissions through YA localhost:3400. Preserve concurrent
provider/session-identity changes; this rename does not implement that work.

## Purpose and existing work

Use **Identity Service** for the optional account, client-enrollment and
delegated-access component. Use **Account**, **Devices** and **Server
Connections** in the UI. “Fleet” began as descriptive planning shorthand and
became a component prefix; it does not clearly communicate the component's job.

Build on the implemented [fleet authentication contract](../../topics/fleet-authentication.md)
and [plan 168](168-peer-access-and-enrollment.md), not another authentication
implementation. [Peer access](../../topics/peer-access.md) continues to own
manual/server connections. [Principals and grants](../../topics/principals-and-grants.md)
keeps identity, authentication, grants, routes and execution boundaries distinct.
The local coordination record `tasks/peer-access/CURRENT-FLEET.md` confirms that
the basic service, consumer and OIDC adapter are already implemented; enrollment
UI and live external-provider qualification remain follow-ups. No matching
rename defect/plan was found in `gaps/` or the existing tactical plans.

This is terminology work. It does not add account-wide automatic access,
enrollment UI, new authentication providers, a CLI client, mesh policy or
changes to credentials, expiry, defaults, local ceilings or owner proof.

## Proposed naming map

| Current | Target | Scope |
| --- | --- | --- |
| Fleet service | Identity Service | Component and documentation name |
| `packages/server/src/fleet/` | `packages/server/src/identity-service/` | Source/build entry point and imports |
| `createFleetService` | `createIdentityService` | Service construction |
| `FleetHttpClient` | `IdentityServiceClient` | Server's HTTP consumer |
| `FleetAccount` | `IdentityAccount` | Account type |
| `FleetAuth` | `IdentityServiceAuth` | Service authentication implementation |
| `FleetIssuer` | `IdentityIssuerVerifier` | Configured-issuer trust, JWKS retrieval and peer-token/introduction verification |
| `FleetStore` / `FleetState` | `IdentityServiceStore` / `IdentityServiceState` | Service storage implementation/types |
| `FleetOidc` | `OidcLogin` | External login implementation |
| `FleetOidcProvider` | `OidcProviderConfig` | Configured upstream provider type |
| `FleetRelationship` | `AccessRelationship` | Proposed/accepted/revoked directional relationship |
| `FleetPolicy` | `AccessPolicy` | Projects, operations and expiry |
| `FleetPeerAccess` / `manager.fleetAccess` | `DelegatedPeerAccess` / `manager.delegatedAccess` | YA-server consumer |
| `FleetError` | `IdentityServiceError` | Typed service error |
| `FLEET_*`, `fleet*` helper names | Corresponding scoped `IDENTITY_SERVICE_*`, `identityService*`, or role name | Symbols; audit each rather than replacing arbitrary words |
| `/api/peers/fleet` and descendants | `/api/peers/identity-service` and descendants | Owner HTTP route family; see boundary decisions below |
| CLI usage label `fleet` | `identity-service` | Existing standalone service/admin entry point; no new CLI product |
| “Fleet-managed access/credential” | “Access through your account” or “Account-managed credential” | Choose wording appropriate to access versus credential details |
| `topics/fleet-authentication.md` | `topics/identity-service.md` | Owning contract, with incoming links updated |

Keep `EnrolledClient`: an enrollment is not necessarily one physical device,
and a YA server is currently its first consumer. Keep account UUIDs, client
UUIDs and server UUIDs distinct. Keep `profileId` unchanged in this pass;
clarifying future browser/mobile versus server identity is separate design.
Do not rename a proposed access relationship into a grant that appears already
accepted. The UI's word “Devices” does not change these internal identities.

## Boundary decisions before implementation

A symbol rename is not permission to rewrite private state or authenticated
messages. Inventory each occurrence as a code name, public route/representation,
persisted key/value, signed/encrypted discriminator, UI text or historical record.

The current supported stable corpus in `scripts/capability-releases.json`
(v0.8.0 through v0.11.0) was inspected locally on 2026-11-01. None of its nine
tags contains `fleet/service.ts`, `peer-api/routes.ts` or shared
`peer-connections.ts`. This is source-corpus evidence, not a claim about every
running source checkout. Recheck that corpus and current consumers before
changing the owner route family. The current client does not expose enrollment;
Server Connections uses the separate `/connections` routes.

Preferred boundary for this naming pass:

- Rename the owner route family and its documented/tooling consumers together
  if the recheck still establishes it as unreleased. Do not introduce permanent
  old/new route aliases without an actual compatibility consumer. If that
  evidence changes, retain the old route until the supported-client contract
  is explicitly settled; do not repurpose `peer-connections` to imply new routes.
- **Defer the earlier candidate `origin: "fleet"` → `"identity-service"`.**
  It is a shared serialized discriminator, also present in private peer state;
  changing it is more than changing a label. Keep its bytes/meaning in this pass
  and give consuming code clearly named identity-service constants/helpers.
- Keep existing serialized state keys/versions, JWT purpose/type/audience
  literals, encryption/signature domain strings, configured issuer URLs,
  callback URLs, the standalone `/fleet/v0` service routes and their audiences,
  signing/encryption keys and credential bindings unchanged.
  Where a legacy key contains `fleet`, record the exception in one compact
  ledger beside the owning contract. Do not build a codec/migration system
  merely to hide an old storage key.
- CLI display/source paths may change; never infer a new configured issuer or
  callback from a component rename. Existing OIDC callbacks and token-bound
  HTTP paths need individual audit before any externally visible path change.
- No credential reset, re-enrollment, new default or silent regeneration is an
  acceptable rename shortcut. Malformed/unknown state still fails closed.

This deliberately refines the brainstorming table: formalize names in code,
UI and owner administration while retaining legacy protocol/storage literals
that would otherwise require a separate compatibility change.

## Three implementation phases

### 1 — Rename the service and consumer internals

Move the source module and rename constructors, classes, types, properties,
helpers, tests and imports according to the map. Include standalone build/tool
entry references. Preserve the current external routes, representations,
private storage and cryptographic inputs during this phase. Avoid unrelated
import sorting, architecture refactors and broad edits in ignored task evidence.

Use an occurrence inventory to enumerate remaining `fleet` names. Each remaining
runtime occurrence must be an intentional boundary literal or a named phase-2/3
item, not an accidental partially renamed subsystem. Commit a buildable slice.

Validation: typecheck and meaningful existing basic-account, OIDC, enrollment,
protected peer workflow and revocation tests. Reuse the existing isolated
core/HTTP fixtures; do not start providers, scanners or paid model evals to
verify spelling. Review the phase before advancing.

### 2 — Rename owner administration and audit external boundaries

Recheck the release/consumer evidence, then apply the selected owner-route and
standalone command-label changes. Update consumers, help, errors, scripts and
fixtures together. Leave signed requests at their actual authenticated URI;
never redirect a signed/DPoP request to make a cosmetic route alias work.

Test owner admission through the renamed HTTP path, including basic/OIDC
ceremonies, exact owner-session binding and revocation. Restart an existing
isolated enrolled profile/service directory and verify stable IDs, keys,
manual/identity-service coexistence, selected credentials and continuing
protected access. Raw state keys and protocol discriminators remain unchanged;
this is evidence against accidental credential loss, not a new migration.

Retain existing lost-response, concurrent disconnect/refresh and local-ceiling
coverage; a rename must not duplicate a consumer, service instance, mutation
queue or nonce/replay budget. Commit and review this boundary slice separately.

### 3 — Finish UI wording, docs and integrated verification

Replace user-visible fleet labels with account/access wording. Keep the two
Server Connections lists and existing details flow; do not add enrollment UI.
Rename the owning topic and update current links/runbooks, roadmap wording,
examples and architecture references. Preserve historical commit names, private
evidence paths and prior verification facts where changing them would misstate
history. Document retained protocol/storage literals once.

Run lint, formatting, typecheck, full workspace tests and focused Server
Connections browser checks. Typecheck/shared builds and tests run sequentially.
Retain real sequential typing under populated/concurrent updates with the
100 ms requirement, plus mixed manual/identity-service removal and credential
selection behavior. Capture/inspect desktop 1000×600 and phone 375×812 through
the artifact facility when UI copy changes. Check touched CSS ownership and
console diagnostics; reuse existing coverage instead of adding spelling-only
unit tests. Finish with a reviewed commit and list any intentionally retained
legacy names. No primary-server/provider-host restart is required.

## Review and completion

The requested planning reviewer is actual **Sol 6.1, high reasoning,
bypassPermissions**, launched through YA localhost:3400. Its task is read-only:
check the naming map, phase boundaries, compatibility choices and security
invariants, then amend this plan for material findings. Planning does not
require live provider deployment, browser captures or the implementation suites.

During implementation, use a read-only Sol 6.1 high
review between phases and at completion. Reports must distinguish mechanical
naming findings from authority/compatibility changes. Resolve material findings
before advancing, and commit only this workstream's files/hunks. Do not disturb
concurrent session-identity work. This plan does not reprioritize release work
or authorize the larger identity-service enrollment UI workstream.

Planning review completed through YA session
`01a196f6-e074-7333-a614-a382f87708ae`: actual `gpt-6.1-sol`, high reasoning,
`bypassPermissions`. One P2 corrected the proposed issuer name: `FleetIssuer`
verifies configured-issuer tokens/introductions and fetches JWKS; it is not the
token-signing implementation. The map now uses `IdentityIssuerVerifier`.
No other material planning findings were reported. The reviewer independently
confirmed the nine-tag source audit. Only this plan and documentation pointers
were changed by this task; no implementation or implementation tests ran.

## Implementation progress — 2026-11-02

Phase 1 is implemented: source/test modules and code symbols use Identity
Service names; the consumer is `DelegatedPeerAccess`, and issuer verification
is `IdentityIssuerVerifier`. Internal incoming-grant binding names are explicit.
The audit checked 1,439 source string/template values; only module specifiers,
private type indexes and Hono context keys changed. Wire/storage literals did
not change. Typecheck, lint/format and 48 tests in five focused core files pass
(18.53 s). Read-only Sol 6.1 high/bypass review through localhost:3400 reported
no actionable findings. Evidence is in ignored `tasks/identity-service-rename/`.

Phase 2 is implemented: owner administration uses `/api/peers/identity-service`,
and the standalone admin usage label is `identity-service`. Human diagnostics
and eval command naming are updated. The repeated nine-tag release audit found
no affected stable routes. Protocol/storage literals remain unchanged, including
standalone `/fleet/v0`; no aliases or migrations were added. Existing native
workflow coverage now restarts the same service directory, reloads both peer
profiles, checks continuity via safe canonical digests and continues protected
access before exercising outage/revocation. Typecheck and all 48 focused cases
pass (18.64 s); CLI usage smoke and scoped lint/format pass. Sol's recheck closed
all three initial fixture/route findings. Whole-tree format at this point also
reports concurrent provider-runtime edits; those files remain outside this task.

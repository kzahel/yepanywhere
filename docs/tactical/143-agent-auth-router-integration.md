# Agent Auth Router integration and account balancing

Status: manual and recovery slices verified; Manual/Round robin pools and quota
overview implemented, 2026-10-03. This plan
covers changes to both Yep Anywhere (YA) and the separate
[Agent Auth Router repository](https://github.com/kzahel/agent-auth-router)
(AAR). The maintainer requested this plan after discussing local pairing,
account pools, balancing policies and stable session routing. The maintainer
approved implementation in both repositories, commits on main,
and live provider tests using temporary YA profile directories. This does not
establish a shipped contract or prove credential renewal.

## Router-listed policies and per-session choice (2026-10-11)

At the maintainer's request a pool's AAR policy became a default. AAR lists
its policies with English labels and no longer requires clients to name them;
YA passes the list through, and New Session offers the pool default, the
router's other policies and each account (an account pins with Manual). This
delivers the policy-or-account choice described under
[account pools](#account-pools-policies-and-selection). See the
[owning contract](../../topics/agent-auth-router.md#most-remaining-and-admission-refresh).

## Most remaining follow-up (2026-10-04)

The approved next slice adds Most remaining, bounded quota/catalog refresh at
new automatic admission, and additive capability 117. See the
[owning contract](../../topics/agent-auth-router.md#most-remaining-and-admission-refresh)
for exact ranking, compatibility and freshness behavior. Earliest reset and
Auto/task-size hints remain proposals in AAR's
[routing research](https://github.com/kzahel/agent-auth-router/blob/main/docs/routing-policies.md).

## Subsequent ownership correction and desktop direction

The maintainer agreed on 2026-10-03 that pools must belong to AAR itself, with
clients granted access, and that account enrollment and grant changes must be
live without restart or re-pairing. The
[AAR ownership and desktop plan](https://github.com/kzahel/agent-auth-router/blob/main/docs/router-owned-pools-and-desktop.md)
supersedes integration-owned pools and fixed pairing snapshots as the target
design in this plan. It preserves existing pool/binding identities during
migration and selects Tauri, Mac-first delivery and Windows platform boundaries,
using Desktop Release Kit for signing/update acceptance. Implementation is
pending; descriptions of the implemented first slice below remain historical
and current-state evidence. Advanced policies and inheritance stay deferred.

## Implemented first slice

The [owning topic](../../topics/agent-auth-router.md) records setup, behavior,
limits and evidence. Implemented: private local pairing, account catalog and
quota reads, manual native Claude/Codex selection, durable per-session pins,
transport overrides, revocation and owner-only controls. Native adapter live
turns, continuation and resume passed using temporary YA profiles; the full
YA HTTP path also passed restart/resume and tool approval.

The recovery follow-up adds on-demand status and explicit recovery before
pools: saved pairing versus reachability, disabled-account guidance, durable
failed-launch cleanup retry, and pending-disconnect recovery. The
[owning recovery contract](../../topics/agent-auth-router.md#status-and-recovery)
records the additive capability and older-server fallback. AAR now owns the
SHA-pinned synthetic cross-repository regression suite. OAuth renewal and
advanced routing policies remain deferred.

The scoped follow-up adds integration-owned pools, Manual and Round robin,
cached model-aware quota/eligibility metadata, explicit refresh, pool editing and
new-session selection in YA. Atomic reservations, durable pins and revisioned
edits are implemented in AAR. The [owning topic](../../topics/agent-auth-router.md#pools-and-quota-overview)
records exact freshness, exclusion and compatibility behavior. Most remaining,
Earliest reset, Auto, standalone HTML, and renewal remain later phases. The
first slice explicitly refuses clone/fork and YA auxiliary helper launches,
project-queue selection, remote executors and YA project-write sandboxes for
routed sessions. Inheritance and constrained sandbox grants below describe
future work. No downgrade support is required. Do not interpret the later
verification matrix as coverage already established by this manual slice.

The maintainer deferred further pool refresh/admission UX, Most remaining, and
clone/helper inheritance on 2026-10-03. The owning topic's
[deferred follow-ups](../../topics/agent-auth-router.md#deferred-follow-ups)
records their motivation, boundaries and suggested sequence for later review.
They are not currently scheduled for implementation.

## Objective and existing evidence

Connect a YA server to AAR once, select explicitly enrolled accounts for a
provider pool, choose its balancing policy, and start sessions without handling
provider credentials in YA. AAR chooses the upstream account; YA records and
displays the binding. Resuming a session preserves its account.

Pre-implementation evidence (historical baseline, not current feature status):

- AAR has a headless Node/TypeScript prototype with no runtime dependencies,
  loopback HTTP inference, revocable gateway credentials, dedicated provider
  profiles, credential readers and official-CLI renewal helpers.
- One authorized native Codex CLI interaction and one Claude Code CLI
  interaction streamed through AAR. These are CLI proofs, not YA SDK,
  approval, multi-turn, resume or cross-account continuation proofs.
- On-demand `aar account quotas [id]` reads Codex's official app-server
  `account/rateLimits/read` and Claude's internal OAuth usage endpoint. Live
  metadata reads succeeded with Codex 0.159.0 and Claude Code 2.1.280 on
  Node v26.7.0. The AAR fixture suite passed 65 tests at this baseline.
  Account identities, credential paths and quota values are not recorded here.
- Real durable renewal remains unverified for both providers. Forced Codex
  renewal did not succeed; that does not establish that its ordinary login is
  unusable. Claude has no proven auth-only renewal command. Keychain reads and
  successful inference do not prove renewal.
- AAR currently assigns one account per provider to each gateway credential.
  It has no control socket, control API, pairing, pools, allocator or durable
  session-binding abstraction. WebSocket inference upgrades are refused.
- YA already has native Claude SDK and Codex app-server adapters, gateway
  service configuration and normalized subscription-usage UI. The Claude
  gateway path currently supplies a dummy token, its catalog expects
  `/v1/models`, and CodexOSS's gateway path assumes a `/v1` base. These are
  reference seams, not a working AAR integration.

Related work checked before defining this plan:

- [Provider profile directories](133-provider-profile-directories.md) remains
  the direction for direct CLI accounts. Its separate-home design and rejection
  of automatic profile switching remain intact. This plan adds an explicit,
  optional router route whose account pool is owned by AAR.
- [Subscription switching](../../gaps/sketches/provider-subscription-switching.md)
  records the account-switching/continuation question. This plan does not
  implement credential replacement in a native home or silent account switches.
- [Gateway services](../../topics/gateway-services.md) owns endpoint lifecycle,
  model catalogs and launch overrides; preserve its existing behavior.
- [Subscription usage](../../topics/provider-subscription-usage.md) owns YA's
  normalized windows and model-scoped binding percentage. The
  [Claude meter sketch](../../gaps/sketches/claude-usage-meters-read-by-name.md)
  records additional model and spend fields that neither an account-wide
  percentage nor today's AAR reader fully represents.
- [Clone/fork settings inheritance](140-clone-session-settings-inheritance.md)
  owns successor launch snapshots. Router bindings must compose with it.
- The local t3code checkout demonstrates separate provider-instance launch
  configuration and CLIProxyAPI usage-source configuration. Its hub adapter
  uses management `auth-files` and `api-call` with token substitution. Adopt the
  separation; AAR should expose its own narrow metadata operations rather than
  an arbitrary provider-request tunnel or a shadow-home overlay.

This is planned opt-in work; it does not reprioritize the
[release roadmap](../roadmap/README.md).

## Ownership and integration boundary

| Owner | Responsibilities |
| --- | --- |
| Official provider CLI | OAuth login, authoritative credential storage and renewal |
| AAR | Account enrollment, credential reads, provider access, quotas, client grants, pools, allocation, durable bindings and inference forwarding |
| YA server | Router connection and private integration credentials, project/session authorization, native agent launch, retained route/binding metadata and client-facing normalization |
| YA client | Connection/pool settings, policy choice, account/health display and explicit user actions |

The browser and phone never connect directly to AAR. Their existing YA
HTTP/WebSocket or encrypted relay connection reaches the YA server; that server
connects to AAR locally, or over HTTPS to a hosted router (see
[Hosted router](#hosted-router-2026-11-15)). Remote use of YA does not expose
AAR administration.
Keep AAR headless and independently usable; do not make it depend on YA's
desktop shell, browser, relay or provider host.

YA keeps its client-side Claude/Codex homes and native transcripts. AAR's
authenticated provider profiles are separate. Do not point a YA coding process
at an AAR account profile, copy credentials, modify the normal CLI login or
build a shared-home symlink overlay. Ordinary skills/settings stay under the
native client configuration, with transport overrides applied at launch.

## Transport, authentication and local pairing

### Local control connection

Use versioned, bounded JSON HTTP request/response operations over an owner-only
Unix-domain socket in AAR's private state directory. HTTP is the protocol;
the Unix socket is its local transport. Check directory/socket ownership and
permissions, handle Unix path-length limits, and do not unlink an arbitrary
existing socket during startup or shutdown. Never advertise control operations
on the inference listener. AAR's opt-in public listener satisfies this rule:
it is a separate dispatcher that routes `/control/` and the inference paths to
separate handlers with separate credential classes, and the inference listener
itself still serves no control operations.

Use the existing loopback HTTP inference listener for official agent clients.
Control and inference use separate credential classes and authorization paths;
neither credential is accepted on the other's surface. No control WebSocket is
needed initially. Cached reads and explicit refresh are sufficient; an SSE
metadata feed is a later capability if measured demand justifies it.

macOS/Linux local sockets are the first transport. Windows named pipes require
verified owner access controls and supported HTTP transport before claiming
parity; do not silently fall back to unauthenticated loopback control. Remote
control uses the same operations over HTTPS with explicit pairing, normal
certificate verification and a deliberate network bind. AAR now implements its
side; see [Hosted router](#hosted-router-2026-11-15). Private-network or
SSH-tunnel deployment is separate scope, not a new public service default.

### Identity and authority

Follow YA's [principals and grants](../../topics/principals-and-grants.md)
vocabulary: the YA installation is AAR's integration principal; the control
credential proves that identity; its grant names allowed accounts, pools and
actions; the socket provides reachability. This does not introduce a hosted
identity provider or implement the broader proposed universal grant protocol.

The integration grant can read allowed account health/usage, manage its own
pools and allocate/inspect/release its bindings. It cannot export provider
credentials, run arbitrary commands, make arbitrary authenticated upstream
requests, enroll/logout accounts or administer another integration. Editing a
pool cannot widen the integration's account grant. Initial account enrollment
and official login remain router-owner operations through its CLI.

YA authenticates its human operator through existing direct/relay mechanisms.
Connection and pool administration are owner-only initially. YA rechecks
project/session/provider authorization before allocating or launching. Limited
users cannot administer the router or inherit the owner's account inventory;
supporting their sessions requires an explicit allowed-pool policy and existing
host sandbox/firewall enforcement. Until that path is covered, refuse router
launches for limited users rather than bypass confinement. See
[security](../../topics/security.md) and
[session sandboxing](../../topics/session-sandboxing.md).

### Connect and disconnect

An explicit **Connect local router** action asks the YA server to discover a
configured/default socket, verify router identity/version/capabilities and run
an owner-only pairing operation on that socket. Directory permissions are the
local bootstrap boundary; do not assume portable native peer-UID APIs exist in
Node. Reject insecure endpoints. Same-user malicious processes are outside
this filesystem trust boundary.

Pairing registers a stable YA installation id and issues a revocable, scoped
control credential. AAR retains its hash; YA stores the secret privately in
app data, outside project directories and client-readable settings. The browser
receives only connection metadata. Make pairing retry/recovery idempotent and
bounded: a lost acknowledgement must not accumulate orphan grants or require
printing a secret. Credentials, challenge values and authentication headers
never enter logs or browser responses. Do not pair automatically at server boot.

Use persistent router and connection ids; socket addresses and display names
are not identity. A moved socket may reconnect to the same verified router;
a different router at the old address cannot inherit its bindings.

Disconnect revokes the integration and its derived inference credentials without
deleting account profiles, native transcripts or session metadata. New control
operations and subsequent inference requests fail closed. Already accepted
streams may finish; stopping coding processes is a separate explicit action.
Reconnection must not restore a revoked credential or silently select a new
account for an existing session. Surface which sessions have lost access.

## Account pools, policies and selection

Each pool belongs to one integration and one provider, names an allowed account
subset, and carries a default policy. Keep provider pools separate; no protocol
translation or cross-provider failover. Session creation can explicitly select
a policy or an account within the permitted pool.

| Policy | New-session selection |
| --- | --- |
| Auto | A documented heuristic using applicable quota headroom, upcoming resets and current load to reduce unused allowance and crowding |
| Manual | The explicitly chosen account, without substituting another when it is unavailable |
| Earliest reset | Among available accounts, the soonest reset of the current limiting window |
| Most remaining | Greatest remaining percentage in the most constrained applicable window |
| Round robin | Durable fair rotation among eligible accounts, advanced only by successful allocation |

Use **Auto**, not an assurance of mathematical optimality. Percentages do not
establish absolute account capacity, equal entitlements, session token demand
or total pooled throughput. Do not sum them into an unqualified capacity value.
Before implementing Auto, specify deterministic ordering, tie breaks and score
version in tests; return a concise selection reason with its evidence timestamp.
Use synthetic reset/headroom/load scenarios to choose the initial heuristic
rather than inventing predicted token costs.

Filter by current account grant, provider, enabled/auth health, established
model entitlement and observed cooldown. A reported exhausted applicable
window blocks automatic admission; checking only a five-hour window is not
sufficient. Preserve model-scoped windows and permission/availability signals
when reported; percentages alone do not establish access. Extend AAR's current
normalizer before relying on model-scoped selection. Do not infer native
program enrollment, credits or billable-overage permission from quota percent.
Automatic use of paid overage/reset-credit redemption is outside this plan.

Freshness is explicit. Coalesce bounded on-demand quota reads and retain checked
timestamps/errors. Specify a freshness budget and expire cooldowns conservatively
with provider evidence. Failed/stale/unknown usage is not zero used. In the first
allocator, automatic policies do not select accounts with insufficient quota
evidence; expose Refresh or explicit Manual selection. Manual still enforces
auth, model eligibility and known rejection/cooldown. Do not fabricate capacity
when a reported reset time passes; refresh before declaring it restored.

Selection, persistence and short startup reservations are atomic across clients.
Concurrent starts cannot all observe an unreserved preferred account. Count
current admission reservations and active work, not every historic/idle binding,
as load. Reservations are scheduling hints, not provider quota debits. Failed
launches and crashed clients release bounded leases without erasing a committed
session's account pin. Provider-host survival across Hono reload must not release
a running worker's lease simply because its controller disconnected.

Changing a default policy affects new sessions only. Account/grant removal or
disablement makes affected bindings visibly unavailable rather than silently
rebalancing them; pool editing shows affected sessions. Unknown models and all-
unavailable pools yield structured reasons and reported next-reset information.
Do not replay accepted or ambiguous provider work on another account. An explicit
account-switch action and narrowly proven pre-generation failover are later work
after cross-account continuation and rejection semantics are verified.

## Durable session allocation and inference credentials

Prefer an allocation that issues a **per-session inference credential** pinned
to one provider/account. This extends AAR's existing credential-to-account
assignment and works even if a native session header is absent or changes.
Native `x-claude-code-session-id` may be corroborating telemetry, not the
authority to change a binding. Never accept an arbitrary account-selection
header as a permission grant.

The allocation key is router identity, integration identity and an immutable
allocation UUID that YA persists before launching a provider. YA currently
remaps provisional session ids after provider initialization; that remap must
retain the allocation UUID and secret reference without allocating again.
Canonical YA and native thread/session ids are associated metadata. An idempotent
allocation request includes pool, provider, model, policy/manual selection and
an operation id. A repeated request returns the same durable binding or a
conflict; changing parameters cannot overwrite a running session's assignment.
Return opaque binding/account ids, applied policy/version, reason, quota
freshness and a private inference credential through the server-only channel.

Persist the pin in AAR and the router connection/pool/binding/account reference
in YA's retained session launch metadata. Store inference secrets only in YA's
private server credential store and hashes in AAR. Define credential recovery
or rotation for a lost response without issuing orphan active credentials;
the recovered binding must retain its account. Do not write secrets into
provider config files, transcripts or ordinary launch-setting payloads.

Allocation is provisional until YA persists its session and admits its provider
launch. Specify commit/cancel/reconciliation so a failed launch neither consumes
round-robin position indefinitely nor leaks reservations. Router restart and
YA restart recover committed pins; an unknown or revoked binding refuses launch
with a useful recovery action. Never fall back to the user's normal provider
login when AAR is unavailable.

Resume, restart and worker reattachment reuse the pin. Ordinary fork/clone
inherits the parent's account into a distinct child binding/credential, subject
to current grants; it does not rerun Auto. Explicit fresh sessions can rebalance.
Helpers, titles, recaps, subagents and auxiliary launches inherit the relevant
binding where their native operation supports it; unsupported paths must be
disabled or clearly refused rather than leaking to a direct subscription.
Model changes validate the pinned account's eligibility; they do not change
accounts implicitly. Preserve existing permission, effort, sandbox and
successor-setting precedence.

## YA product surfaces and compatibility

The integration is configurable and default-off, following
[vanilla defaults](../../topics/vanilla-defaults.md). Direct sessions and CLI
profiles remain the default. Enabling a router connection is explicit; creating
a pool explicitly chooses its default policy, with Auto offered as the
recommended choice inside the opted-in feature.

- **Settings → Providers:** local connection status, router identity/version,
  reconnect/disconnect, permitted account health and last-checked usage; pool
  membership and default policy. Missing/unready accounts show the official
  owner login action/command, not a YA credential upload flow.
- **New Session:** choose a routed provider/pool and `Account: Auto`, another
  policy or a permitted account. Show applicable window percentages/reset
  times and stale/unknown status. Request a committed selection at creation;
  a preview cannot promise that account before atomic allocation.
- **Session:** a compact provider/account label opens binding details,
  selection reason and quota freshness. Account unavailable, disconnected,
  exhausted and unsupported-model states have explicit actions. No account
  switch during an active turn in the first version.
- **Subscription usage:** reuse the existing normalized model-aware meters,
  keyed by router connection, account and provider rather than provider alone.
  Fetch the selected scope lazily, single-flight and explicitly refreshable.
  No inference-based effort/capability probes or indefinite all-account polling
  as a side effect of opening settings. Describe known windows rather than
  claiming every spend/model limit is represented.

The YA server makes authorization and routing decisions; browser choices only
request them. Existing remote/relay access, desktop and bundled mobile UI use
the same server operations. A different machine's YA source cannot reinterpret
another server's local socket address or session binding.

Add an exact optional YA capability for router connections/pool selection and
binding metadata. Also negotiate AAR's protocol major version and optional
capabilities independently. Older YA servers expose no router controls or new
requests; missing binding fields retain direct behavior for genuinely legacy
sessions, never for a known routed session. Older AAR versions report unsupported
operations rather than guessed behavior. Downgrading YA against router-enabled
app data is unsupported and outside this work, by maintainer decision. No
claim is made that previously shipped YA builds understand routed metadata.

Before implementing wire changes, inspect the release corpus required by
[server capabilities](../../topics/server-capabilities.md) and
[hosted compatibility](../../topics/remote-hosted-compatibility.md), document
the proposed bit/fields and absent-capability fallback. The maintainer approved
the optional, hidden-when-absent integration approach; record the checked
release corpus alongside the implementation. No existing capability changes
meaning and no remote protocol level changes.

## First implementation slice

Prove a local, owner-operated Manual route end to end before automatic balancing.
The first slice includes private pairing, account metadata/catalog discovery,
manual account selection, durable per-session pins, native Claude/Codex launches,
continuation/resume/restart, revocation and the minimal YA controls to use them.
Automatic policies and their scheduling reservations remain follow-on work;
manual allocation creates no round-robin position or load-balancing lease.

Catalog discovery is a narrow authenticated control operation scoped to an
allowed account, available before allocation. It returns model metadata, never
an inference token or an arbitrary upstream-request tunnel. A catalog entry is
availability evidence, not a guarantee of entitlement to every native feature.
The selected model must occur in the account catalog; provider rejection remains
a truthful error, never a reason to switch accounts or enable paid overage.

Only local, unsandboxed owner sessions are supported initially. Refuse remote
SSH executors, YA project-write/network-isolated sessions and limited users
before allocation; never relax their existing confinement for router access.

Define allocation prepare/commit/cancel with an idempotent client-generated
secret persisted privately before prepare (only its hash reaches AAR). Lost
responses can repeat the same operation without rotating a running worker's
credential. Prepared bindings have bounded admission lifetime; committed pins
survive restart and idle periods. Commit is durable before provider work starts.
A failed launch retains its committed pin for an explicit retry, avoiding any
claim that native startup and two local stores form a distributed transaction.

Disconnect succeeds only after AAR durably revokes the integration. When AAR
is unreachable, report revocation pending, block new YA launches locally and
retain the private credential needed to finish revocation on explicit retry.
Do not claim that existing workers lost access until revocation is acknowledged.

## Implementation sequence across repositories

### 1 — Freeze the control and binding contracts

In AAR, define version/capability discovery, owner-only local pairing,
integration grants, own-pool operations, scoped metadata/usage reads,
allocate/commit/cancel/inspect binding operations and credential revocation.
Use bounded schemas, stable errors and deadlines. Prefer a narrow allocation
surface over arbitrary admin or authenticated upstream requests. Document the
observable router contract beside its existing architecture/prototype docs.

In YA, define connection and retained route/binding models and map them to the
existing authorization, session identity and launch-settings owners. Complete
the release-corpus compatibility review before changing shared wire contracts.
Keep exact endpoint names and pairing recovery mechanics here as implementation
decisions to settle, not invented already-supported APIs.

### 2 — Add the local control socket and scoped pairing

In AAR, implement socket ownership/lifecycle, separated control authentication,
hashed credentials, restricted pairing and integration inventory/revocation.
In YA, add a server-side connector and private credential persistence with
explicit owner Connect/Disconnect operations and structured health failures.
No UI/browser-to-router path, no automatic provider login and no remote bind.

### 3 — Prove manual allocation and native routing

Implement durable Manual bindings and lost-response/restart recovery first.
Expose scoped account catalogs before allocation, then route the ordinary Claude
SDK and Codex app-server adapters with launch-only transport overrides. No
CodexOSS substitution, native config rewrites or provider credential copies.
Carry the pin across session-id remapping and provider-host handoff; explicitly
refuse auxiliary paths that cannot yet preserve it. Validate settings precedence
and no direct fallback using fake providers before authorized live proofs.

### 4 — Prove continuation, restart and revocation

With temporary YA/client homes, prove streaming, approvals, continuation, resume,
restart/reattachment and account pin retention for each supported native provider.
Exercise response loss and revocation with fixtures. Keep real renewal failures
visible; do not repeat forced refresh experiments as part of ordinary smoke tests.

### 5 — Add scoped quotas, pools and automatic selection after proof

First expose on-demand account quota metadata and the minimal manual UI. After
the manual slice is proven, extend model-scoped normalization, pool configuration,
Most remaining, Earliest reset, Round robin and versioned Auto. Freeze scoring,
freshness, reservation ownership and atomic scheduling before adding those policies.

### 6 — Add connection, pool and session controls

In YA, build the opted-in Settings → Providers connection/pool controls,
New Session policy/manual selector, existing-session binding details and
model-aware usage display. Use existing components and settings conventions,
with practical touch targets and explicit failure/recovery states. Verify
typing during quota/config updates under realistic account/session volume;
each key must appear within 100 ms. Follow
[UI design](../../topics/ui-design.md) and [UI testing](../../topics/ui-testing.md).

### 7 — Prove native behavior and publish the supported slice

Run fixture integration checks first, then separately authorized live proofs
for each provider through YA: streamed turn, approval, continuation, resume,
restart/reattachment and routed auxiliary paths. Record exact installed
CLI/SDK/router versions, paths, headers, usage and remaining uncertainty without
tokens, emails or account inventory. Live provider sessions are authorized for
this implementation task; use isolated temporary YA/client profiles and stop
test processes afterward. Official upstream account stores remain authoritative.

Update durable contracts in the owning YA topics (provider routing, gateway
services, subscription usage, successor launch behavior) and AAR docs, then
user/operator setup guidance. Publish explicit provider/platform coverage.
Windows parity, metadata SSE, cross-account continuation, automatic failover
and a router desktop installer remain later extensions. HTTPS remote control is
the [hosted router](#hosted-router-2026-11-15) follow-up.

## Verification and completion criteria

| Boundary | Required proof |
| --- | --- |
| Pairing/control | Private socket lifecycle; insecure paths rejected; retry/lost-ack recovery; no orphan grants; control/inference credentials cannot cross surfaces; another integration cannot read/mutate resources; revoked grants stay revoked after restart |
| Secrets | No provider credential returns or YA copies; control/session secrets excluded from UI, settings exports, launch metadata, logs and transcripts; private persistence and bounded redacted errors |
| Pools/policies | Model-scoped exhaustion, unequal/unknown/stale windows, reset boundaries, disabled/revoked accounts, Manual failure, deterministic tie breaks, fair rotation, Auto explanations and concurrent allocation across clients |
| Binding lifecycle | Duplicate allocation, failed admission, crash at each persistence boundary, credential response loss, router/YA restart, provider-host survival, fork/clone inheritance, changed pool/grants and no accidental direct fallback |
| Native launch | Fake official processes/local upstreams establish paths, auth substitution and settings precedence; no normal credentials or inference probes used by automated tests; approved live proofs retain approvals, streaming, continuation and cancellation |
| UI/access | Owner-only administration, limited-user refusal or proven constrained support, cross-source isolation, desktop/phone layout, settings typing under updates, disconnected/all-exhausted states and explicit refresh |
| Compatibility | Current hosted/root/bundled clients against the required stable-server corpus; older AAR refusal; unknown/new fields; unsupported downgrade documented; current-build routed launch fails closed |

Keep executable checks appropriate to the changed repositories; AAR's normal
suite remains synthetic, and YA follows its required lint/format/typecheck/test
workflow plus focused browser coverage. Documentation-only changes need content
and link review, not a provider run.

The first slice is complete only when a locally paired YA server can configure
an allowed manual account selection, start each supported native provider
through AAR, show its account and quota metadata, and recover the same pin after restart with
fixtures and the separately authorized live proofs recorded. Allocation does
not prove OAuth renewal or cross-account continuation; surface unavailable
renewal as a supported limitation instead of hiding it with credential copying.


### Router ownership follow-up (2026-10-03)

The new owner/use boundary supersedes integration-owned pool editing for routers
advertising `router-owned-pools-v1`. YA capability 116 projects explicit
`canManagePools`; consumers see pool selection and usage, while AAR manages
accounts, memberships and grants. Older router editing remains scoped to its
legacy contract. See the [durable compatibility contract](../../topics/agent-auth-router.md#router-owned-pool-compatibility).
The desktop implementation and signed-candidate acceptance belong to AAR's
[owning plan](https://github.com/kzahel/agent-auth-router/blob/main/docs/router-owned-pools-and-desktop.md).

### Hosted router (2026-11-15)

AAR now has an opt-in public listener (`aar serve --public-origin https://HOST`)
on a loopback port that a TLS reverse proxy exposes. On one origin, it routes
`/claude` and `/codex` to inference, `/control/v1/*` to integration control,
and everything else to the AAR dashboard. Owner administration is not
reachable there. Network pairing is code-approved: `POST /control/v1/pair` with
`{id, name, tokenHash}` returns a pending `userCode`, `verificationUri`,
`expiresAt` and `interval`. The owner types that code in AAR's dashboard or CLI
and chooses pool grants in the same step. Until approval, authenticated
operations, including `GET /control/v1/pair/status`, answer 403
`pairing_pending`. `/control/v1/info` reports the public origin as
`inferenceOrigin` and adds `remote-pairing-v1`. The contract and limits are in
[AAR's hosted router document](https://github.com/kzahel/agent-auth-router/blob/main/docs/remote.md).

The separate public dispatcher satisfies the
[local control connection](#local-control-connection) rule: control and
inference keep separate handlers and credential classes, and the inference
listener serves no control operations. One router can therefore serve YA
servers on several machines without a private network, while each YA keeps
full pool selection, quotas, pinning, switching and recovery.

Remaining YA work, not implemented:

- A remote connection kind (HTTPS base URL plus a control credential that YA
  generates and keeps in server-side private state) next to the socket kind.
  Pairing uses the code flow and polls `pair/status`.
- An HTTPS transport for the single router request path, with normal
  certificate verification and no plain-HTTP fallback. Router ID and protocol
  checks are unchanged.
- For remote connections, the inference-origin check requires `https:` and the
  configured host instead of loopback.
- Settings UI for the URL, Pair, and the pending code, as specified below.

#### Hosted router settings (agreed 2026-11-15)

Extend the existing **Settings → Providers → Agent Auth Router** card. After
pairing, accounts, pools, the New Session selector and binding details behave
exactly as with a local router.

1. **Choose the router.** The card offers **On this computer** (today's socket
   flow, unchanged) or **Hosted**. Hosted asks for an HTTPS URL and a **Name**.
   The name defaults to `Yep Anywhere on <hostname>`, can be edited before
   connecting, and is what the owner sees in AAR's approval list.
2. **Connect** runs on the YA server, never in the browser. It reads
   `/control/v1/info` with normal certificate verification, requires protocol 1
   and `remote-pairing-v1`, then creates the control credential and sends only
   its hash to `POST /control/v1/pair`. Failures are specific and plain:
   unreachable host, certificate not valid for the host, protocol mismatch, or
   no hosted pairing support.
3. **Code screen.** It shows the `userCode` prominently, the instruction to
   open the router's dashboard (Connections → Pair a device), type the code and
   choose pools, an **Open router dashboard** link to `verificationUri`, an
   expiry countdown and **Cancel**.
   - The YA server polls `GET /control/v1/pair/status` at the returned
     `interval`. The pending request (URL, integration ID, credential, code,
     expiry) is kept in YA's private server state, so closing the tab or
     restarting YA resumes waiting. Starting from a phone over the relay works
     the same way.
   - On expiry, or if the router dropped the request (a 401 while pending,
     e.g. after an AAR restart), the screen says the code expired and offers
     **Get a new code**.
4. **Connected.** The card shows "Connected to `<host>`" and the router's
   accounts and pools.
5. **Later failures.**
   - Unreachable router: "Can't reach `<host>`" with **Retry**; sessions keep
     their pins.
   - Revocation by the router owner (401 for an active pairing): the card says
     the router removed this computer and offers **Pair again**.

Decisions:

- **One router per YA installation.** Bindings are tied to the router ID, so
  switching between local and hosted means Disconnect, then pair the new
  router. Existing routed sessions stay with the old router and are not moved.
  Multiple simultaneous routers are out of scope.
- **The owner types the code.** The verification link does not carry the code,
  so an approval always means the owner typed the code shown on this YA. A
  prefilled one-tap link with a name confirmation is a possible later
  convenience, not part of this slice.
- **The control credential stays on the YA server.** It is a long-lived bearer
  credential. It lives only in YA's private server state and never appears in
  browser storage, settings exports, launch metadata, logs or transcripts, in
  line with the [Secrets](#verification-and-completion-criteria)
  verification row.


# Agent Auth Router

YA supports an optional local Agent Auth Router (AAR) connection for pinned native Claude and Codex sessions on macOS and Linux.
Router-owned pools support Manual, Round robin and Most remaining selection for
new sessions. Automatic admission refreshes stale evidence when AAR advertises
that support. Existing sessions keep their chosen account. Earliest reset, Auto
and cross-account continuation remain future work.
The design and deferred work are in [plan 143](../docs/tactical/143-agent-auth-router-integration.md).

## Set up and use

1. Enroll accounts with the AAR app or CLI and start the router. Its default
   private control socket is `~/.agent-auth-router/control.sock`.
2. As the YA owner, open **Settings → Providers → Agent Auth Router**. Use
   **Connect local router**, optionally specifying a different socket path.
   With router-owned pools, pairing initially grants no accounts. In AAR,
   grant this integration permission to use a pool. Its current members become
   available without restarting or pairing again. New Session refreshes discovery
   automatically on opening, provider changes and returning to the visible form.
3. On **New Session**, choose native Claude or Codex, expand advanced options,
   keep the normal Model and Thinking selections and optionally choose a compatible
   Pool. The pool uses its router-configured policy; only multi-account Manual
   pools require an account choice.
   Use a local, unsandboxed launch. Normal direct-provider sessions stay opt-in
   to their existing authentication path; selecting a router never changes a
   native profile's login.
4. Settings lists granted accounts, renewal configuration and explicit usage
   refresh. The session header shows its pinned account. AAR usage snapshots
   include their observation time; these are account windows, not a promise
   that every model has the same budget. Routed session controls suppress quota
   observations from the native login. No background polling is added.
5. Disconnect revokes the integration and its derived inference credentials.
   If AAR is offline, YA persists `revocation-pending`, blocks new routed
   launches locally, and offers **Finish disconnecting**.
   Already-issued capabilities are not claimed revoked until AAR acknowledges.

## Status and recovery

Settings distinguishes a **saved pairing** from an on-demand reachability check.
Opening the panel or choosing **Check status** checks the same router identity
and granted accounts, and reports unavailable, revoked, incompatible or insecure
connections without copying raw router responses or filesystem paths to the UI.
There is no background polling, automatic reconnect or account substitution.
Status reads never retry cleanup or change pairing/revocation state.

- **Pairing incomplete:** Retry connection reuses the saved pairing and socket
  unless the operator explicitly supplies another socket. Identity checks still
  forbid substituting another router.
- **Router unavailable:** Start AAR on the YA server and check again. A saved
  pairing does not establish that existing workers can currently infer.
- **Account disabled:** Settings labels it and disables usage refresh. The new
  session selector retains the selected account on failure; disabled choices
  cannot be selected. Enable the same account in AAR to resume its sessions,
  or deliberately select an available account for a new session.
- **Failed-launch cleanup pending:** The count survives restart. **Retry
  failed-launch cleanup** sends only recorded cancellations, starts no provider
  process, and does not allocate or change an account. Failed acknowledgements
  remain pending. Cancellation remains allowed after an account is disabled.
- **Disconnect pending:** **Finish disconnecting** retries revocation with the
  retained grant. New routed launches stay blocked and the UI does not claim
  existing workers lost access. Connecting a different router or pairing is
  refused until the original revocation is acknowledged.
- **Revoked grant:** Finish disconnecting and pair again for new sessions.
  Retained sessions cannot adopt that new pairing. Missing or cancelled pins,
  unavailable accounts, and mismatched router identities remain explicit launch
  or resume errors with recovery guidance; they never use direct credentials.

Health/account observations are point-in-time evidence, not an inference or
renewal probe. Usage snapshots retain their observation time. Requests and
results belong to the selected YA source; switching hosts cannot apply an old
response or start an old action's follow-up request against the new host.

Owner-only `GET /api/agent-auth-router/recovery` reports connection state,
reachability, a check timestamp, granted accounts, pending cancellation count
and an optional safe issue. `POST /api/agent-auth-router/retry-cancellations`
explicitly retries recorded failed-launch cancellations under the saved grant.
Limited-user default-deny applies to both routes. No provider credentials,
inference/control tokens or socket/profile paths appear in these responses.

The separate optional `agent-auth-router-recovery` capability (ID 114) gates
these routes and controls. The 2026-10-03 optional release review checked
v0.9.0 (September 22), v0.9.1 (September 24), and v0.9.2 (September 26); all
lack AAR routes. Without the recovery bit, a client with the original
`agent-auth-router` bit uses only the original status/account/connect/disconnect
routes and omits cleanup retry. Without either bit the original router UI stays
hidden. The original capability retains its meaning; no protocol floor rises.
Recovery routes live in their own route module so the capability audit checks
their contract independently of the original pairing and discovery routes.

The browser communicates only with YA. Socket paths refer to the YA server's
machine, even when its UI is viewed remotely. This does not route an agent
running on a remote executor back through the owner's loopback listener.

## Pools and quota overview

Settings → Providers offers **Pools and usage** when the YA server advertises
`agent-auth-router-pools` (permanent optional capability 115) and AAR supports
`pools-v1`. AAR owns named single-provider pools with up to 16 accounts
and a Manual, Round robin or Most remaining default. Manage pools and grants in AAR. YA lists
only pools granted to its integration. Older AAR versions retain their scoped
editor; this fallback grants no global administration authority. In New Session, choose a pool, catalog model
and policy; Manual also requires an explicit account. The session header displays
the chosen account and policy. Pool selection is only for new owner sessions;
continuation, remote executors, limited users and sandboxes cannot change a pin.

The overview shows each account's windows, usage bars, remaining percentages,
reset times, observation freshness and model/policy-specific eligibility reasons.
Opening or reloading it reads cached AAR evidence without provider I/O. Quota
bars show percentage remaining (100% is full). **Refresh
usage** explicitly refreshes that account's catalog and quotas. There is no
background polling. Failed refreshes retain the last successful windows with a
stale label. A reset passing does not establish restored quota.

Round robin and Most remaining require fresh catalog membership and fresh applicable quota with
headroom; unknown, stale, exhausted, disabled or blocked accounts are excluded.
Manual permits unknown quota with validated catalog membership, but cannot ignore
known applicable exhaustion or observed authentication/rate-limit blocks. Neither
mode enables paid overage. Catalog evidence expires after 60 seconds and quota
evidence after 120 seconds. Restart requires fresh evidence for new automatic
allocations; existing committed pins can resume without rerunning selection.

Owner pool saves in AAR use optimistic revisions. Name/default-policy edits affect future
selection. Removing an account or deleting the pool blocks affected retained
bindings; they never migrate to another account. The AAR editor displays affected
binding counts and this consequence. Lost prepare/commit responses reuse the
persisted allocation and token; definitive rejection records durable cancellation.

Owner-only POST `/api/agent-auth-router/overview`, `/overview/refresh`,
`/pools/save` and `/pools/remove` (all under the same prefix) proxy the scoped AAR
control API. Overview is reusable metadata, not HTML scraped from a CLI. The
browser never receives credentials or contacts AAR directly. A standalone AAR
HTML dashboard is deferred.

The optional release review for this follow-up uses v0.9.0, v0.9.1 and v0.9.2;
none has AAR routes. Without capability 115, the client keeps the original manual
controls and makes no pool/overview requests or pool launch fields. Existing
capability meanings and the protocol floor are unchanged. An older AAR reports
an explicit upgrade requirement for pool operations.

## Most remaining and admission refresh

Optional capability 117 (`agent-auth-router-most-remaining`) gates the new policy
in YA. AAR must also advertise `most-remaining-v1`. YA projects `supportedPolicies`
and `admissionRefresh` from the connected router's capabilities, and sends its
supported policy list during allocation. Legacy AAR keeps Manual/Round robin;
a client connected to legacy YA hides Most remaining and disables unsupported pool defaults with update
guidance. AAR refuses an unnegotiated Most remaining default before provider I/O.
Existing capability meanings and the protocol floor do not change. The
2026-10-04 optional release review checked stable v0.9.0, v0.9.1 and v0.9.2;
all lack AAR routes. This follows the maintainer-approved additive policy plan.

Most remaining maximizes the lowest remaining percentage among all applicable
reported windows. It first spreads unexpired startup reservations within the
pool; final ties use the durable commit cursor and membership order. It does not
estimate tokens or count idle retained sessions as active load. The cached
preview shows the tightest-window percentage, while the pinned session header
names the policy and exposes the saved reason in its tooltip. AAR persists the
ranking evidence and policy version. YA retains the pin and reason before commit.

With `admission-refresh-v1`, a new automatic allocation refreshes missing, stale,
failed or elapsed-reset evidence on enabled pool members. Reads coalesce per
account with a four-account concurrency ceiling and a 12-second admission
deadline. Failed members stay excluded; healthy members can still be selected.
Retry-After and observed cooldowns prevent immediate repeated reads. Permission,
pool revision and eligibility are rechecked after reads and before commit. A
cancelled/deadline-expired admission cannot publish a late allocation. Already
running shared metadata reads retain their bounded provider deadlines; cancelling
one caller does not cancel another caller's read. There is no idle polling.

Fresh evidence is reused. Continuation/restart/resume of a committed pin does not
rerun ranking or quota refresh. A changed default affects only new sessions.
The initial model picker still needs catalog observations; explicit account
refresh remains available for initial discovery and troubleshooting.

Verification on 2026-10-04: focused server/component tests cover older-router
refusal and both capability gates. Browser fixtures exercise 48-account updates,
sequential typing under 100 ms, Most remaining selection, remaining bars and
1000×600 / 375×812 layouts. AAR owns the SHA-pinned native integration cases for
both providers; fixtures use synthetic credentials and upstreams, not live OAuth.

## Ownership and lifecycle

AAR owns provider credential reads, official-CLI renewal coordination,
account-scoped catalogs/quotas and inference forwarding. YA owns its control
credential and per-session inference tokens in the private
`<dataDir>/agent-auth-router/private.json` (directory 0700, file 0600).
Provider credentials are never copied into YA. Existing native client homes
retain ordinary settings, skills and transcripts.

YA persists a random allocation identity and token before sending its hash to
AAR. Only the hash crosses the control socket. AAR prepares and commits the
binding durably before YA launches the provider. Retries use the same identity,
token hash and account. Ordinary session metadata contains only the public
binding/router/account/provider IDs and optional pool/policy/reason/observation metadata. It survives provisional-to-canonical ID
remapping, restart and resume; a retained worker must have the same binding.
A missing/revoked pin, unavailable account/router, protocol mismatch or changed
router identity causes an error, never direct-provider or different-account
fallback. Failed fresh provider starts request cancellation; failed cancellation
is retained privately and retried before the next allocation.

Claude receives per-launch environment and flag-settings auth overrides;
Codex receives a named Responses provider with WebSockets disabled and its token
in a dedicated environment variable. Neither adapter rewrites native auth or
configuration files. Routed Claude spawn diagnostics omit arguments and stderr
because SDK flag settings can contain the inference token. Control responses,
REST payloads and public runtime metadata do not include tokens.

The private Unix socket is the owner bootstrap boundary. Its directory/socket
must be private, owned by the YA user and not symlinks. AAR control is separate
from loopback inference, with distinct credential namespaces. New control
routes are denied to limited users by the existing default-deny route policy;
their enforced YA sandbox also excludes routed launches. Credentials authorize
provider access, not a tool sandbox, and a same-OS-user coding process is not
an isolation boundary against that user's own local files.

## Supported slice and limits

- Manual native Claude/Codex creation, streaming, tool approvals, continuation,
  termination and same-account resume. Direct and message-less creation use
  the same pin before provider launch.
- Local macOS/Linux owner launches only. Windows control transport, remote
  executors and YA project-write sandboxes are refused.
- Clone/fork, YA recap/title helper sessions and project queue selection are
  refused for routed sessions in this slice. Native child work stays inside
  its routed provider process. One-turn Codex effort modifiers are refused
  until their effort catalog is account-scoped; they must not probe the direct
  account. The new-session form uses provider-default reasoning; explicit
  API effort values remain subject to provider support.
- Cross-account continuation and advanced balancing are not implemented. Re-pairing creates
  a new integration; old sessions do not migrate to it.
- Successful inference does not verify durable OAuth renewal. Accounts without
  a configured helper report manual renewal; configured helpers remain
  unverified until separately proved. No credential exchange or refresh is
  implemented in YA. Catalog and quota upstreams are not a stable public API.
- The `agent-auth-router` optional server capability gates controls and request
  fields. Older servers show no router UI. Protocol v1 is required. Downgrading
  a YA data directory containing routed sessions is unsupported.

## Agreed ownership and desktop direction

On 2026-10-03, the maintainer selected
[router-owned pools, live account management and a Tauri desktop app](https://github.com/kzahel/agent-auth-router/blob/main/docs/router-owned-pools-and-desktop.md)
as the next architectural direction. YA now implements the owner/use capability
boundary described below. AAR owns migration, live management and desktop
packaging; its document records their implementation and acceptance status.

AAR owns accounts, pools, membership and policy independently of YA. Clients
receive explicit permission to use pools; using a pool does not confer pool
administration. A grant follows current pool membership, so deliberate owner
membership edits become available without re-pairing. Newly enrolled accounts
remain unassigned until explicitly added. Disconnecting YA revokes its access
and bindings while preserving router-owned accounts and pools.

Enrollment, login observation, enable/disable, membership and grants will update
the running router without restart. Existing sessions retain their pins and
current revocation checks. Migration must preserve pool and binding identities,
prevent unintended access expansion and avoid changing old capability meanings.
YA's owner UI must distinguish its own authorization from AAR administration;
exact protocol/capability changes require the normal compatibility review.

The chosen desktop stack is Tauri with the independent TypeScript core and a
bundled Node runtime. Ship Mac first while designing Windows platform adapters
from the start. Machine Control supplies the operator/lifecycle reference,
Desktop Release Kit supplies update/release contracts and acceptance patterns,
and Lid Awake supplies the compact menu-bar UX reference. AAR owns its app
identity, update route and updater key. Signed GitHub candidates and real
installed upgrade acceptance precede release claims.

The linked AAR plan owns sequence, migration and acceptance details. This
revisits the desktop administration shell; the separate browser-served HTML
dashboard and the advanced routing/inheritance follow-ups below remain deferred.

## Deferred follow-ups

On 2026-10-03, the maintainer deferred the following useful extensions to this
workstream. They are recorded candidates, not an approved implementation queue;
the supported behavior above is authoritative. On 2026-10-04, Most remaining
and bounded admission refresh were implemented as described above; an explicit
whole-pool refresh button, Auto, earliest-reset selection and inheritance remain
follow-ups. The original candidate descriptions below are historical.

1. **Pool refresh and admission flow.** Add an explicit **Refresh pool** action
   and consider bounded, coalesced catalog/quota refresh when a new session needs
   fresh evidence. Show checking progress and actionable exclusions. Keep
   overview reads passive, preserve allocation identity across retries, and
   retain conservative handling of failed or unknown observations. Before admission refresh, the
   60-second catalog and 120-second quota budgets can require manual per-account
   refresh before a Round robin start. Prove the eventual flow with synthetic
   failure/concurrency coverage and live pool sessions for both providers using
   isolated temporary profiles.
2. **Most remaining policy.** Rank eligible accounts by remaining percentage in
   their most constrained applicable window, with deterministic tie breaks and
   a visible selection explanation. Preserve model scopes, freshness checks,
   atomic startup reservations and existing session pins. Percentages describe
   relative headroom, not absolute token capacity or equal account entitlements.
3. **Clone and helper inheritance.** Extend supported fork/clone, title and
   recap paths to inherit the parent's account through distinct, separately
   revocable child bindings. Recheck current grants and compose with
   [successor settings inheritance](../docs/tactical/140-clone-session-settings-inheritance.md).
   Prove cancellation, restart and revocation without account reselection or
   direct-provider fallback. Unsupported paths remain explicitly refused until
   their native lifecycle can preserve the binding.

If resumed, the suggested sequence is refresh/admission first, Most remaining
second, then inheritance. This is a dependency recommendation within the
workstream, not a change to the product roadmap's priorities. Combined Auto
scoring should wait for evidence about headroom, reset timing and concurrent
activity. Renewal, cross-account continuation and a separate browser-served HTML
dashboard remain deferred. The Tauri administration app is covered by the agreed
ownership and desktop direction above.

## Verification

Pool service and component tests cover lost-response recovery, durable rejected
allocation cleanup, capability fallback, source switching and cached reads versus
explicit refresh. The 48-account browser fixture covers the actual pool editor,
policy selector and 32 sequential keystrokes during concurrent updates (all under
100 ms), with separately inspected desktop 1000×600 and phone 375×812 captures.
It substitutes API responses; the AAR suite owns real cross-repository proof.


AAR owns a SHA-pinned cross-repository suite exercising real YA HTTP routes,
supervisor and native adapters with synthetic CLI peers and loopback upstreams.
It covers both providers' continuation, restart, streaming interruption, durable
failed-launch cancellation, disconnect recovery and refusal of direct fallback.
See [AAR integration tests](https://github.com/kzahel/agent-auth-router/tree/main/integration/yepanywhere).

Recovery-specific service/component tests cover read-only observations, explicit
retry, safe errors, disabled-account refusal, older-server fallback and stale
source responses. A narrow browser component fixture checks sequential socket
typing during status refresh with 48 synthetic accounts and concurrent rendering,
plus desktop/phone recovery controls. It uses synthetic API responses; actual
control/credential boundaries are covered by the server and cross-repo suites.

Synthetic coverage exercises private socket permissions, cross-integration
isolation, pre-commit refusal, lost response/retry, disabled accounts, durable
revocation/cancellation, identity mismatch, metadata remapping, same-token resume,
limited-user denial, native Claude settings precedence and provider-host binding
checks. Existing provider adapter tests continue to cover their protocol paths.

On 2026-10-03, Claude Agent SDK 0.3.283 and Codex CLI 0.159.0 on macOS/Node
26.7.0 with isolated temporary YA/client homes completed live native Claude
and Codex creation, continuation and resume through AAR. A full YA HTTP Codex
session also resumed after both servers restarted with the same pin; a tool
approval paused and continued through YA. These prove the tested transport and
lifecycle, not refresh-token rotation, arbitrary upstream versions, Windows or
cross-account continuation. Test logs and private profiles remain outside Git.

The browser flow also passed native Claude and Codex creation with a rendered
reply and visible account pin, explicit pairing/quotas, and sequential socket
path typing (under 10 ms per keystroke in the measured run). Desktop 1000×600
and phone 375×812 captures were inspected. The test browser blocks service worker
registration; Node 26 reports the existing tsx loader deprecation. Neither is
an assertion failure. The original default-thinking regression is superseded by unified selection
coverage below.


## Router-owned pool compatibility

Optional capability 116 (`agent-auth-router-owned-pools`) promises explicit
`canManagePools` overview metadata and optional `directAccountAccess` account
metadata. Pool-only accounts are omitted from standalone manual allocation
choices; they remain visible in their pool and usage overview. YA checks AAR's `router-owned-pools-v1`
capability, reports false, and refuses integration pool mutations before sending
them. Pool use continues through `pools-v1`. AAR independently enforces owner
credentials for administration; YA never reads that owner credential.

The 2026-10-03 review rechecked stable v0.9.0, v0.9.1 and v0.9.2; none has AAR
routes. Without capability 116, clients retain the older pool editor, except
that explicit `canManagePools: false` always hides it. With capability 116,
missing permission metadata fails closed. Older clients may display an editor
against a new router, but writes fail with guidance to manage pools in AAR.
Original capabilities and the protocol floor keep their previous meaning.

Pool membership, account enrollment/enablement and integration grants are live.
New accounts remain unassigned until the owner grants them directly or adds them
to a granted pool. Direct-account allocation requires a direct grant; pool use
does not authorize bypassing pool membership. Shared pool allocation state
arbitrates across integrations. Disconnect/revocation leaves router pools and
other integrations intact. Existing pins cannot switch accounts; revoking a
grant blocks subsequent requests while accepted streams may finish.


## Unified session selection (2026-10-04)

The maintainer confirmed this integration is unshipped. Its new discovery and
unified launch UI use the existing overall `agent-auth-router` capability; no
additional feature bit or legacy launch UI is introduced. The plan is
[AAR unified selection](https://github.com/kzahel/agent-auth-router/blob/main/docs/unified-session-selection.md).

The ordinary provider/model/thinking controls remain visible. One Pool selector
uses compatible granted members and the router's configured policy. Model family
aliases resolve to a concrete catalog model before allocation. An unavailable
selection remains selected and cannot silently fall back to direct login.
Explicit thinking travels through allocation, persistence, native launch and
resume. Native adapters use the pinned account's model metadata, including
Codex Max-to-ultra mapping, instead of querying the direct login's catalog.

`POST /api/agent-auth-router/selection` performs catalog-only discovery through
the private control socket. Requests coalesce by connection/provider. The client
revalidates on mount, provider/source changes, focus/visibility and connection
changes, discarding obsolete results. There is no idle polling; quota admission
still happens when starting a session. Recovery and usage diagnostics remain in
Settings. Browser tests cover desktop/phone layouts and sequential prompt typing
during discovery; synthetic AAR integration tests prove the native boundaries.

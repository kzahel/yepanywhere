# Agent Auth Router

YA supports an optional local Agent Auth Router (AAR) connection for pinned native Claude and Codex sessions on macOS and Linux.
Router-owned pools offer every selection policy the connected AAR lists
(currently Manual, Round robin, Most remaining and Weekly pace) for new sessions.
A pool's policy is its default; New Session can choose another router policy or
a specific account. Automatic admission refreshes stale evidence when AAR
advertises that support. Existing sessions keep their chosen account. Auto and
cross-account continuation remain future work.
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
   Pool. The pool uses its router-configured default policy unless the Router
   account dropdown chooses another router policy or a specific account; a
   Manual default with more than one fitting account requires a choice.
   Use a local, unsandboxed launch. Normal direct-provider sessions stay opt-in
   to their existing authentication path; selecting a router never changes a
   native profile's login.
4. Settings lists granted accounts, renewal configuration and explicit usage
   refresh. The session header shows its pinned account. AAR usage snapshots
   include their observation time; these are account windows, not a promise
   that every model has the same budget. Routed session controls suppress quota
   observations from the native login and show the pinned account's cached
   AAR windows instead. Available allowance weights are shown in USD 200-plan
   units, with unknown amounts left unknown. No background polling is added.
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

A healthy pairing shows the check time and whether it uses AAR's default
socket (named, since that path is fixed) or a custom one. The status and
recovery responses carry only a `customSocket` boolean, never the saved path;
servers before 2026-10-24 omit it and the line is hidden. The socket field and
Retry connection appear when the pairing is incomplete or unhealthy, or after
**Change socket**. **Check status** also rereads Pools and usage, so a pool
granted in AAR appears without a separate reload. Each account's **Refresh
usage** locks only its own button, since a refresh starts the provider CLI and
can take several seconds. A failed refresh shows AAR's reason, which AAR
scrubs of secrets and paths.

- **Pairing incomplete:** Retry connection reuses the saved pairing and socket
  unless the operator explicitly supplies another socket. Identity checks still
  forbid substituting another router.
- **Router unavailable:** Start AAR on the YA server and check again. A saved
  pairing does not establish that existing workers can currently infer.
- **Account disabled:** Settings labels it and disables usage refresh. The new
  session selector retains the selected account on failure; disabled choices
  cannot be selected. Enable the same account in AAR to resume its sessions,
  or deliberately select an available account for a new session.
- **Account login lapsed:** A Claude login lasts a fixed time from sign-in, and
  renewals do not extend it. AAR (2026-11 and later) refuses a lapsed or
  cleared login with a 409 `login_required` code; launch and resume then fail
  with "The pinned router account (name) needs to sign in again" and keep the
  pin. Sign the same account in again in AAR and retry. The send-failure toast
  shows that message; only a resume refused with `recovery: handoff-required`
  shows handoff guidance. A new session refused at its router step, before
  any provider starts, ends as a failed creation with failure
  `router-login-required` (any other router refusal: `router-refused`); the
  notice says nothing was sent, and the creation can be retried. Every router
  refusal is logged as `agent_auth_router_refused`.
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
and a default policy. Manage pools and grants in AAR. YA lists
only pools granted to its integration. Older AAR versions retain their scoped
editor; this fallback grants no global administration authority. In New Session, choose a pool and catalog
model, and optionally another router policy or an account. The session header shows a
compact chip with the pin's saved pool and account names, never the raw account
id; it falls back to the policy (AAR's label captured at launch, else its id) for
pins saved without names and is hidden on narrow screens. Its tooltip lists
pool, account, policy and reason. The chip is a shortcut to the **Account** tab
in the model/session dialog, with no separate dropdown. On phones, tap the
model pill and select Account. With `agent-auth-router-session-switch`, that
pane offers Pool and Router account dropdowns plus an explicit Apply action,
using the same owner, executor and sandbox restrictions at every width. Without switching support it
shows the saved account read-only. Session Info retains the detailed pin ids.
The pin keeps AAR's names as display labels captured at
launch, so an AAR outage or removed account still shows which account to restore;
a resume refreshes a renamed account and backfills a missing pool name, and the
unavailable-account error names the saved account. Identity remains the ids.
Pool selection is only for new owner sessions;
continuation, remote executors, limited users and sandboxes cannot change a pin.

**Switching an existing session's account**
([plan 185](../docs/tactical/185-switch-session-router-account.md)). The
Account tab shows the current binding separately from the draft selection.
Choose a Pool and Router account, or **This computer (direct login)** in Pool.
Changing either dropdown has no server-side effect. Changing pools clears the
account choice; Apply stays disabled until a different, available account is
selected (or Direct is selected for a routed session). Discovery refreshes do
not silently substitute another account. A refusal preserves the draft for
retry and leaves the saved binding unchanged. Controls lock while applying.
An older binding without a pool shows a distinct current-account placeholder
and can still switch to Direct or to a pool account.
The explanation beside **Apply account change** states that applying stops the
provider immediately, interrupts an active turn, and resumes this conversation
on the selected account only when the next message is sent. There is no queued
switch at the end of the current turn.

A direct session's header shows a "Direct" chip only when the router has a
pool with an enabled account for that session's provider; a connected router
serving only the other provider shows nothing.

Applying calls `POST /api/agent-auth-router/sessions/:id/switch`
(`{routerPoolId, routerAccountId}` or `{direct: true}`), which:

1. allocates, prepares (policy `manual`, the picked account) and commits the
   new pin, after resolving the session's model against that account's
   catalog and checking its thinking and tier. A refusal returns the
   router's message and changes nothing;
2. saves the new binding, or removes it for Direct; a router pick saves the
   concrete model as the requested model, since the router refuses aliases;
3. kills the provider process whatever its state, as Kill does (not
   `/terminate`), because it holds the old credential. It does not wait for
   an in-flight turn or background work
   ([gap](../gaps/router-switch-kills-in-flight-work.md));
4. cancels the old allocation (best effort; cleanup stays retryable).

A process that obtained the old token just before the switch and registers
after the kill is refused at registration ("send the message again"). A
failed switch cancels its new allocation whatever the failure, including a
lost reply. A session whose hosted runtime has not reattached yet is refused
until it has. With no live process, the model falls back to the saved
requested model, then the current pin's model.

The next message resumes the same transcript on the new account; only the
prompt cache is lost. Claude accepts thinking signatures from another account
on resume (tested 2026-11-08). The page reloads after a switch. Remote
executors, project-write sandboxes and other providers are refused; limited
users cannot reach the route. There is no automatic failover.

The overview shows each account's windows, usage bars, remaining percentages,
reset times, observation freshness and model/policy-specific eligibility reasons.
Opening or reloading it reads cached AAR evidence without provider I/O. Quota
bars show percentage remaining (100% is full). **Refresh
usage** explicitly refreshes that account's catalog and quotas. There is no
background polling. Failed refreshes retain the last successful windows with a
stale label. A reset passing does not establish restored quota.

Automatic policies require fresh catalog membership and fresh applicable quota with
headroom; unknown, stale, exhausted, disabled or blocked accounts are excluded.
For Codex, fresh account-verified ordinary-usage permission takes precedence
over general display percentages, which can read 100% while usage is allowed.
Owner ceilings and observed authentication/rate-limit blocks still apply.
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

Optional capability 117 (`agent-auth-router-most-remaining`) originally gated
this policy. Since 2026-10-11 YA no longer knows individual policies: it passes
AAR's own `supportedPolicies` and `policies` (`{ id, label }`, English labels)
through unchanged, shows the router's label (or the id from a router without
labels), sends the router's list during allocation for AAR versions that still
require it, and accepts any policy id the router accepts. A pin keeps the
policy label captured at launch as `policyLabel`. See
[server capabilities](server-capabilities.md#most-remaining-router-policy).
The protocol floor does not change. The
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

Routed Claude sets `ENABLE_TOOL_SEARCH=true`. Claude Code otherwise disables
tool search for any non-Anthropic `ANTHROPIC_BASE_URL` and sends every tool
definition in full. AAR forwards the request body and `anthropic-*` headers, and
a live pool session on 2026-10-06 deferred and loaded MCP tools through it.
By default claude.ai connectors do not load in routed sessions: the flag
settings set `disableClaudeAiConnectors`, and Claude Code also skips them
whenever the routed auth token takes precedence over the claude.ai login. A
Claude session can opt in; see
[claude.ai connectors](#claudeai-connectors-in-routed-claude-sessions).
User-scope MCP servers in the native `~/.claude.json` load either way.

### claude.ai connectors in routed Claude sessions

A routed Claude session can keep this computer's claude.ai connectors (Claude
Docs, Drive and the rest) while its pool account runs inference. The connector
account is the claude.ai login Claude Code uses for YA's sessions, the one
`claude auth status` reports in YA's `CLAUDE_CONFIG_DIR`; the inference account
is still the pin. They can be different accounts.

- **Availability.** Claude discovery (`POST /api/agent-auth-router/selection`)
  adds `claudeAiConnectors: { login }` when AAR advertises
  `gateway-token-header-v1`. `login` holds the login's email, or is null when
  `claude auth status` reports no claude.ai login. Absent means unsupported,
  and New Session then shows no control.
- **Choice.** Advanced options show **claude.ai connectors** under Pool for a
  Claude pool selection: Off, or On as the login's email (disabled without a
  login). It defaults to Off, and an explicit choice is saved per host as
  `newSessionDefaults.providers.claude.routerClaudeAiConnectors` with the pool.
  Creation sends `routerClaudeAiConnectors: true` only when on; only the
  owner may send it, only with a pool or account, and only for Claude.
  Continuation refuses it like the other router fields.
- **Launch.** The allocation records the choice, so resume, restart and
  copies keep it, and the binding shows it in Process Info. At each launch,
  if AAR still advertises the capability and a claude.ai login exists, the
  gateway token travels in `ANTHROPIC_CUSTOM_HEADERS` as `x-aar-gateway-token`
  (after any custom headers the launch environment already sets),
  `ANTHROPIC_AUTH_TOKEN` is empty and the flag settings omit
  `disableClaudeAiConnectors`. Claude Code without a claude.ai login refuses to
  start in that mode, so otherwise the launch uses the token-only transport
  without connectors. Inference still never falls back to the direct login.
- **Traffic.** Claude Code fetches the connector list and calls connectors
  directly at Anthropic with the login's own token, outside AAR. On inference
  requests it also sends that token to AAR, which ignores it for
  authentication, never forwards it and never logs it. Claude Code may refresh
  the login as it does for any session using it.
- **Compatibility.** The control depends on a response field older servers
  never send, so it needs no capability bit. Older servers ignore the request
  field and settings key, keeping the token-only transport.
- **Verification (2026-11-04).** Claude Code 2.1.312 (Agent SDK 0.3.312) with
  AAR's `gateway-token-header-v1`, run directly and through a disposable YA
  profile: with a work and a personal claude.ai account swapped between
  inference and connectors, each session read only the private Claude Doc its
  connector account owns; AAR attributed every request to the pinned account,
  and the same YA session with the option off had no Claude Docs connector.
  Claude Code loads these connectors in the background, so a session's first
  turn can in principle start before they are ready; the verified YA sessions
  found them on their first turn.

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
- Clone and fork copy the parent's account. Menu Clone, turn forks, and
  /btw and question asides make the transcript copy as before, then give the
  copy its own binding: a separate allocation and token for the parent's
  account, prepared with the Manual policy at the copy's first launch, never a
  reselection. A copy is refused before any transcript is written when the
  parent's binding is cancelled, missing, from another router or still has no
  account. If inheritance fails after the copy exists, the copy's transcript is
  deleted and the request returns 409, logged as `routed_copy_binding_failed`;
  the copy's metadata is written before its allocation, so a copy that
  survives a failed deletion refuses to launch. A router rejection at the
  copy's first launch stays retryable, like any pinned resume. Only a crash in
  the moment between writing the transcript copy and writing its metadata can
  leave a copy without a pin. Verified live on 2026-10-11 through a Claude
  pool; Codex copies follow the same path, and `thread/fork` itself needs no
  network, though see
  [`gaps/routed-codex-calls-chatgpt-with-direct-login.md`](../gaps/routed-codex-calls-chatgpt-with-direct-login.md).
- A launch whose selection, saved default or source session names a pool or
  account produces a routed session or a visible refusal, never a silent
  Direct launch (plan 183). Project Queue new-session items carry the
  selection (`project-queue-router-selection`) and allocate when they
  dispatch, so a pool picks against quota at that time; a router refusal
  retries and then pauses the item, and the retry allocates afresh on the
  same admitted session because a fresh allocation refused before commit
  never ran. Template preparation sessions send the form's selection with
  the routed model. A new session derived from a routed session (the session
  composer's New session, Agent API `createSession`, a Source Review
  session) gets a fresh policy pick from the source binding's pool with its
  policy (a Manual pool pin names its account), or the source's explicit
  account through a new pin; it never shares the source's allocation or
  token. Such a derived session on another provider is refused for the
  Agent API and Source Review; the composer starts it Direct only when the
  user explicitly picks another provider. Older servers that would drop the
  selection are refused client-side.
- Restart/handoff, fork with summary and YA recap/title helper sessions
  are refused for routed sessions in this slice,
  because they start a fresh session, or call the provider directly as the
  fork summary's generator does, without the pin, on the owner's direct login.
  The restart, stale-handoff, fork-summary and retitle routes return 409 with
  that reason before doing any work. The session view hides fork with
  summary, title generation and both Handoff entries (session menu and turn
  notch); a routed Claude session whose
  transcript needs handoff to continue gets a toast to start a new session
  instead of the handoff dialog. Carrying the pin into a replacement session
  is a separate decision.
- Native child work stays inside its routed provider process. One-turn Codex
  effort modifiers are refused
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
3. **Clone and helper inheritance.** Fork and clone inheritance shipped
   2026-10-11 (above). Remaining: fork summaries, title and recap helpers
   (summary generation must accept a router launch), and whether
   restart/handoff replacements keep the pin. Extend them to inherit the
   parent's account through distinct, separately revocable child bindings. Recheck current grants and compose with
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
other integrations intact. A pin never switches accounts on its own; only
the owner's explicit switch above replaces it. Revoking a
grant blocks subsequent requests while accepted streams may finish.


## Unified session selection (2026-10-04)

The maintainer confirmed this integration is unshipped. Its new discovery and
unified launch UI use the existing overall `agent-auth-router` capability; no
additional feature bit or legacy launch UI is introduced. The plan is
[AAR unified selection](https://github.com/kzahel/agent-auth-router/blob/main/docs/unified-session-selection.md).

The ordinary provider/model/thinking controls remain visible. One Pool selector
uses compatible granted members and the pool's default policy. It is laid
out like the other New Session options: a Pool dropdown listing Direct first and
then every granted pool for the provider, each with its policy and how many of
its accounts offer the selected model. A provider with no granted pool shows no
Pool control, so granting only Codex pools routes Codex alone; a held selection
still shows as unavailable. A pool no account can serve is listed
with the reason (no enabled accounts, no model chosen, no account offers the
model, or no account supports the effort) but cannot be chosen. Choosing a pool
adds a Router account dropdown (since 2026-10-11): the pool's default policy,
marked Pool default, then the router's other automatic policies, then every
account. A policy overrides the default for this session; an account pins it
with `routerPolicy: "manual"`. A Manual default selects its only fitting
account, or asks for a choice. Accounts that cannot run the selection are disabled with the
reason (disabled in AAR, no model chosen, model not offered, effort
unsupported), and otherwise compatible accounts note cached auth rejection,
cooldown or exhausted quota without being disabled, because AAR decides at
launch. Each account row also shows every cached quota window as a short
line (window, remaining percent, reset time or date), when it was observed
once that is ten minutes or more ago, a note when AAR's last refresh of the
account failed, or "no quota observed"; AAR's two-minute `freshness` flag is
not shown, since it gates automatic admission rather than informing a person.
An AAR advertising `quota-inference-headers-v1` records quota from the
rate-limit headers of every successful proxied response and marks the
snapshot `quota.source: "inference"`; YA words that age as "from a request"
rather than "checked". Routers without the capability omit `source`, which
YA reads as a probe. Nothing in YA polls or refreshes quota on discovery.
The row's dot is green when
selectable, amber when selectable with a note, grey when not selectable. A
pool row adds the best remaining percent among its compatible accounts,
measured in the tightest window that bounds the selected model. These are
the last observation, not a promise; AAR confirms quota at launch. All of it
derives from the overview YA already holds; no extra router call is made.
Discovery progress, discovery failure with Retry, and an unavailable
selection appear as a status line under the Pool control. A selection
resolves to a concrete catalog model before allocation. When AAR advertises
`catalog-cli-models-v1`, each Claude account carries its own CLI's model rows
(`initialize.models`); YA's server bounds them and maps them through the same
pipeline as the direct Claude list, so a pool shows the direct picker's names
and descriptions. Each row launches the `resolvedModel` the members' CLIs
report (a `[1m]` suffix is dropped for admission). A row with no reported
target, conflicting targets, or a target absent from every member's catalog
stays listed but disabled with the reason; catalog models no row launches
follow under Other models. Older routers keep the family guess (newest
`claude-<family>-*`). The model status line shows the oldest member catalog
age, and Refresh re-reads each member. An unavailable
selection remains selected and cannot silently fall back to direct login.
Explicit thinking travels through allocation, persistence, native launch and
resume. Native adapters use the pinned account's model metadata, including
Codex Max-to-ultra mapping, instead of querying the direct login's catalog.

`POST /api/agent-auth-router/selection` performs catalog discovery through
the private control socket; with `catalog-cli-models-v1` AAR also re-reads
Claude CLI rows older than an hour, which starts the account's CLI but makes no
inference request. Requests coalesce by connection/provider. The client
revalidates on mount, provider/source changes, focus/visibility and connection
changes, discarding obsolete results. There is no idle polling; quota admission
still happens when starting a session. Recovery and usage diagnostics remain in
Settings. Browser tests cover desktop/phone layouts and sequential prompt typing
during discovery; synthetic AAR integration tests prove the native boundaries.

## Session account display during startup

Saved-session detail and metadata responses include the current public
`routerBinding` when allocation has recorded it, even before a native
transcript exists. The client reconciles that pin through its existing,
coalesced metadata refresh when the provider binds its native session. The
header and Account tab update without reloading or replacing the transcript,
newer title, model or composer draft. No additional polling is introduced.

This correction reuses the existing optional field and endpoints, with no new
capability or version gate. A missing field leaves the client's known pin
unchanged; older servers can retain their startup display until a full detail
read supplies the pin. Older clients ignore the additive startup field. The
existing router capability and allocation, failure and direct-login rules keep
their meanings.

## New Session defaults

Since 2026-10-13, explicit Pool and Router account selections automatically
save `routerPoolId`, optional `routerAccountId` and optional `routerPolicy` in
server-owned `newSessionDefaults.providers[provider]`. Choosing Direct clears
all three. Preferences belong to the connected YA host and provider, shared
across its clients. They do not change existing session pins or API-created
sessions, and no credential is stored in these defaults.

Later visits and provider switches restore the choice after discovery. Initial
discovery holds immediate Start while a saved pool is being checked; background
refresh with existing data does not block it. Restoration requires an available
router control, a granted pool for this provider, a compatible enabled account
for the selected model/thinking, a compatible explicit account when saved, and
a supported policy override. A Manual default with several fitting accounts
and no saved account falls back to Direct. A restored choice silently falls
back to Direct on missing pools/accounts, incompatible catalogs, unavailable
policies, disconnection, discovery errors, sandboxed/remote/limited launches
or specialized fixed launches. The saved preference remains intact. A model
known only to the router is not sent directly on fallback. Explicit pool picks
keep the existing launch refusals when they cannot be used.

Project Queue and template creation submit a restored or picked selection
with the routed model, thinking and tier, as a direct start does (plan 183,
replacing plan 147 § 6). A server without `project-queue-router-selection`
is refused Queue while a pool is shown, restored or picked.

The maintainer explicitly approved silent compatibility without a new
capability or explanatory note. The existing settings route receives the
additional fields: updated parsers retain them; older parsers discard unknown
keys and keep the established non-remembering behavior. Accepted response
settings remain authoritative for future restoration, while discarded fields
do not replace a current explicit form selection. Current launch capability
gates remain unchanged. Release review checked v0.9.0, v0.9.1 and v0.9.2, whose
provider-default parsers preserve speed and discard the new router fields.

## Codex speed selection

Codex pools support explicit Standard/Fast/other account-advertised tiers when
both integrations advertise tier-aware selection. Allocation, pinned resume,
live changes and older-version fallback follow [service tiers](service-tier.md#aar-account-pools).
The router remains the owner of account eligibility and credentials; YA never
borrows speed availability from its direct login. This is an additive optional
feature, not a change to the existing routing or process-configuration capabilities.

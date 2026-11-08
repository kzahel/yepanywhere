# Router pool selection and defaults in New Session

Topic: agent-auth-router

Status: partially implemented, updated 2026-10-13. The maintainer approved
server-saved UI defaults with silent compatibility; remaining proposal items
need separate approval. See the current router topic and open questions.

## Existing evidence and boundaries

Builds on [the router integration plan](143-agent-auth-router-integration.md)
and the [agent-auth-router topic](../../topics/agent-auth-router.md). AAR's
contract lives in `~/kzahel/agent-auth-router/docs/control.md`, `pools.md` and
`unified-session-selection.md`. The task/gap search found no existing entry for
pool persistence or pool UI consistency.

Maintainer requests:

- The pool controls look different from the other New Session options.
- Remember the last pool so it need not be picked for every session; fall back
  to Direct when the pool no longer applies, the router is disconnected or
  unavailable, or the selected account no longer exists.
- Choosing a model only available directly (for example a Codex model) and then
  a pool that cannot serve it should warn at the model and block creation.
- With a pool selected, block creation while discovery is still loading.
- Show every pool and account, with the reason any cannot be selected.
- Agents creating sessions through the YA API should get the preferred pool
  without being told to use one.
- Understand how YA and AAR share their protocol.

## Initial behavior (2026-10-05 audit)

- `RouterPoolSelector.tsx` rendered native `<select>` elements with its own
  CSS while every other option used `NewSessionOptionSection` with
  `FilterDropdown`, and Pool and Account shared one grid cell (fixed by item 1).
- `routerSelection` is plain component state, cleared on provider change and
  never persisted.
- Pools with no account compatible with the current model and thinking were
  disabled without a reason, and Manual pools hid the Account control for a
  single compatible account and omitted incompatible accounts (fixed by item
  2). With a pool selected the model list still contains direct-only models;
  picking one empties the compatible members and disables Start, with only a
  generic "selection unavailable" line under the pool.
- Under a pool, effort and thinking mode are not resolved against supported
  options (`effectiveEffortLevel` / `effectiveThinkingMode`).
- `newSessionDefaults` is server-persisted (`ServerSettingsService`) and
  auto-saved by the form, but session-create routes never read it.
  `parseNewSessionDefaults` copies known keys, so unknown fields appear to be
  dropped rather than rejected; confirm for provider-scoped fields.
- The pool selector is hidden for limited launches, remote executors,
  sandboxing and providers other than Claude or Codex.
- Project queue launches reject any router selection (`routerQueueUnsupported`);
  templates send no router fields; fixed launches refuse router selection.
- The session page showed the binding with `routerBinding.accountId`, not the
  account display name or pool name (item 9 fixes this).

### API flow

Discovery is optional: `POST /api/agent-auth-router/selection` with
`{ provider }` returns pools and enabled accounts with catalogs, quota windows,
`blocked`/`cooldownUntil`, or `null` when disconnected. Launch is one call: the
normal session-create route plus `routerPoolId`, optional `routerAccountId` and
`routerPolicy`. The server persists an allocation, calls AAR
`/v1/pools/prepare`, verifies the pinned account's catalog against model and
thinking, then starts the provider; failure cancels the allocation. Resume and
restart reject router fields.

Ergonomic gaps: the server does not resolve model aliases (`resolveRouterModel`
runs only in the client), so `model: "opus"` fails under a pool; pool ids are
opaque UUIDs with no lookup by name; Manual pools need the caller to supply
`routerAccountId`.

### Protocol sharing

No machine-readable schema or shared package. AAR documents protocol 1 in prose.
`GET /v1/info` returns `protocol: 1`, router id, inference origin,
`supportedPolicies` and capability strings (`manual-bindings`,
`account-catalogs`, `account-quotas`, `pools-v1`, `router-owned-pools-v1`,
`most-remaining-v1`, `admission-refresh-v1`). YA checks protocol and
`manual-bindings` on every operation (`AgentAuthRouter.info()`) and gates
features on capabilities. Types are hand-written on each side. AAR's
`integration/yepanywhere` suite runs pinned YA (`pin.json`) against current
AAR; nothing in YA tests against a real AAR. `/v1/selection` was deliberately
added without a capability because the feature is unshipped and both repos
update together.

AAR's pool eligibility does filter by model and records reasons: `disabled`,
auth `blocked`, `model-required`, `catalog-unknown`, `catalog-stale`,
`model-unavailable`, `exhausted`, `quota-unknown`, `quota-stale`,
`scope-unknown`, `reset-unverified` (`src/pools.ts` `eligibility`).

## Proposed work

### 1 — Match the other New Session options

Done 2026-10-05. Pool and Account are separate helper-section grid items using
`FilterDropdown`: dot icon, descriptions (policy, compatible account count),
Direct first. Checking, unavailable, and discovery failure with Retry are a
status line under the Pool control; captions follow the form's caption toggle.
Pools no account can serve stay disabled without a reason; reasons are item 2.

### 2 — Show every pool and account with its reason

Done 2026-10-05, derived entirely from the overview YA already receives.
Pools: "{n} of {total} accounts offer {model}", or when none can, "No enabled
accounts", "Choose a model first", "No account offers {model}" or "No account
supports {effort} effort". Manual pools with more than one account list every
account; "Disabled in AAR", "Doesn't offer {model}" and "Doesn't support
{effort} effort" disable the entry, while auth rejection, cooldown and
exhausted quota are advisory notes from the last check because cached quota
cannot promise an account is free at launch. Follow-up the same day: account
rows show every cached quota window (5h and weekly, remaining percent, reset),
the observation age once it is ten minutes old (AAR's two-minute `freshness`
flag reads "stale" almost always and is not shown), a failed-refresh note, or
"no quota observed"; AAR now records quota from the rate-limit headers of
every proxied response (`quota-inference-headers-v1`, `quota.source`), so a
recently used account reads "from a request N min ago" instead of hours-old
probe data; dots encode selectable, selectable with
a note, or unselectable; pool rows add the best remaining percent among
compatible accounts. The browser fixture gained a Manual pool so this is
captured at desktop and phone widths. Per-account eligibility from AAR itself
(open question 8) is not used.

### 3 — Warn on model or thinking conflicts

With an explicitly chosen pool, mark models and thinking levels the pool cannot
serve inside their dropdowns, show an inline warning under the model, and give
the disabled Start a reason. Never change the model or pool automatically.

### 4 — Remember the last pool

Implemented 2026-10-13 following maintainer approval: server-saved per-provider
pool/account/policy, silent fallback, no new capability or explanatory notes.
The current contract is in [router defaults](../../topics/agent-auth-router.md#new-session-defaults).
API-default work remains deferred. The original proposal below is historical
where it differs from that contract.

Store `routerPoolId` and `routerAccountId` in
`newSessionDefaults.providers[provider]` (shared type, `newSessionDefaults.ts`,
server parser, auto-save effect). Choosing Direct saves a cleared value.
Since 2026-10-11 the Router account dropdown can also choose a policy override
(`routerPolicy`) for any pool, and an account in any pool; a remembered
choice should cover the policy too, and the Manual-only conditions below now
apply to an explicitly picked account.

Keep the saved preference separate from the effective selection. Until the user
changes the pool in this form, derive the effective value: the saved pool
applies only when the selector would be shown, discovery has data without
error, the pool exists for the provider, it has an account compatible with the
current model and thinking, and for Manual the saved account is still
compatible (or is the only one). Otherwise use Direct and leave the preference
unchanged. A restored pool never blocks launch. When falling back, also check
that a router-only saved model is not sent Direct. Show a quiet note that the
saved pool was not used.

### 5 — Wait for discovery before a pool launch

When a pool is chosen or pending restore and no discovery data exists yet,
show "Checking pool…" on Start and block. Background refreshes with existing
data never block. Discovery failure keeps an explicit pool blocked with Retry;
a restored pool falls back to Direct.

### 6 — Launch paths without pool support

Project queue, templates and fixed launches either gain pool support or ignore
a restored pool. A restored pool must not make queueing fail.

Resolved 2026-11-08 by
[plan 183](183-launch-paths-respect-router-selection.md): ignoring the pool
launched those items on the direct login. Queue and templates now carry the
selection; a server that cannot is refused rather than silently Direct.

### 7 — Explain hidden pools

Replace hiding with a reason when sandboxing, a remote executor or a limited
launch rules pools out, so a saved pool falling back is visible.

### 8 — Recover from router refusals

When AAR refuses at prepare (exhausted, blocked, busy), offer "Start without
the pool" alongside the router's reason.

### 9 — Show the pool and account on the session page

Done 2026-10-05. The pin saves AAR's account display name and pool name as
labels (`accountDisplayName`, `poolName`; identity stays the ids) so they
survive AAR outages and removed accounts. The header shows a compact
"pool · account" chip, never the raw id, hidden below 700px; its tooltip
lists pool, account, policy and reason, and a click opens Session Info,
which has a Router section with names and ids. A resume refreshes a renamed
account label and backfills a missing pool name. The unavailable-account
error names the saved account. Pins saved earlier show the policy until a
resume backfills them.

Follow-up, not started: an explicit account switch or "use Direct" action
in that Session Info section, reusing `RouterPoolSelector`, which the resume
error could open. Plan 143 defers it until cross-account continuation is
verified. Research on 2026-10-05 found that Codex replays org-bound
`encrypted_content` reasoning and compaction items, which another
organization rejects with `invalid_encrypted_content`. Codex therefore needs
those items stripped, plus an explicit `modelProvider` on resume. Claude
Opus 5.5 signatures are not documented as account-bound, but Sonnet 5.5
thinking is silently dropped on another account. Fable 5.1, Opus 5.5 and
Sonnet 5.5 apply a conversation-prefix check for accounts created on or
after 2026-08-31. Prove each direction live before building it.

### 10 — Resolve model aliases on the server

Apply `resolveRouterModel` server-side for routed launches so API callers can
send aliases.

### 11 — Apply the saved pool to API launches

Behind an opt-in server setting (vanilla defaults), session-create applies the
saved pool when a request carries no router fields. Requests need an explicit
Direct opt-out, since omission now means "default". Use the same fallback
rules; explicitly named pools still fail loudly. Report the outcome in the
create response (`router: { poolId, accountId }` or `routerFallback: <reason>`).
Never apply to limited launches, which `limitedLaunchPolicy` forbids from
using router fields.

### 12 — Strengthen the protocol contract

Give each protocol addition a capability string once the feature ships.
Consider a machine-readable schema or shared types, and a YA-side test against
a pinned AAR so the contract is checked from both directions.

### 13 — Verification and documentation

Tests in `NewSessionForm.test.tsx` and `RouterPoolSelector.test.tsx`: restore
after discovery, each fallback (pool deleted, router error or disconnected, no
compatible account, Manual account gone, provider switch), explicit Direct
saved, preference kept after fallback, conflict warnings, loading block. A
typing-latency regression check while discovery refreshes (AGENTS.md). Update
the topic contract, plan 143 status, the roadmap and AAR's `pin.json`.

## Open questions

1. Scope of the saved pool: per provider, per project (work versus personal
   repositories), or per project with a provider-wide fallback?
2. Queue, templates and fixed launches: add pool support, or fall back to
   Direct for a restored pool?
3. Restored-pool wait: block until discovery answers, or fall back after a few
   seconds? No client-side discovery timeout was found.
4. API default: setting name and scope; pool only, or the rest of
   `newSessionDefaults` (model, thinking, permission mode) too; the form of the
   explicit Direct opt-out.
5. Should agent-created sessions inherit the calling session's pool instead of
   the saved default? Requires the API to identify the caller.
6. How visible should a restored-pool fallback be in the form?
7. "Selected profile" was read as the Manual pool's account. Should CLI
   provider profiles (plan 133) follow the same fallback rule?
8. Which reasons need AAR changes rather than YA derivation, such as per-account
   eligibility from `/v1/pools/prepare` or the overview `selection.decisions`?
9. When does capability gating start for each addition, and does a
   machine-readable schema belong in AAR, YA or a shared package?
10. Do older servers silently drop unknown provider-scoped default fields, and
    does that need a capability so the client knows the pool was not saved?

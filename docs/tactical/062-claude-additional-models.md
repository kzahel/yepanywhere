# Opt-In Previous Model Catalog

Status: implemented; all slices complete.

Topic: older-claude-models

This plan turns the findings in
[`topics/older-claude-models.md`](../../topics/older-claude-models.md) into a
bounded, default-off provider feature. It covers the server-owned catalog,
persisted selection, hosted-client compatibility, provider model projection,
and compact Providers-settings UI.

## Authorized Outcome

Users may opt individual previous Claude models into YA's model choosers
without changing the first-run model list.

The maintained registry contains:

| Model id | Label | Why retained |
|---|---|---|
| `claude-opus-4-8` | Opus 4.8 | Immediately displaced Opus generation |
| `claude-opus-4-6` | Opus 4.6 | Meaningfully different pre-4.7 token behavior |
| `claude-sonnet-4-6` | Sonnet 4.6 | Previous Sonnet generation |

The registry intentionally omits 4.7, 4.5, and earlier models. Registry
membership is a maintained product judgment, not a complete historical model
archive.

## User-Visible Contract

- No previous or custom model is enabled by default.
- Providers > Claude contains one compact **Additional models** row. Its
  summary says **None selected**, **1 enabled**, or **N enabled**.
- Activating the row opens a checklist of server-maintained entries plus an
  advanced custom-model-id input. The empty selection is the off state; there
  is no redundant master switch.
- Enabled entries appear in model choosers under a separate **Other models**
  group. They do not enter the primary curated group.
- Disabling an entry removes it from future choices. It does not rewrite an
  existing session, a running provider process, or a saved default that already
  names that model.
- A saved or live selection that is not in the current visible catalog remains
  displayable until the user changes it.
- Provider rejections, access restrictions, deprecations, and upstream
  remapping remain provider outcomes. YA never silently substitutes another
  model id.

## Persistence And Registry Contract

`server-settings.json` owns the selected entries because they change the
server's provider catalog and session-start behavior. Each saved item retains:

- the exact provider model id;
- whether the entry originated in the maintained registry or from custom
  input; and
- a display-label snapshot for graceful rendering if a registry item is later
  removed.

The current registry metadata wins while an id remains registered. If a later
server release removes a selected registry entry, loading settings preserves
that entry as selected and projects it as unlisted/custom instead of deleting
it. This is the grandfathering boundary: removal stops offering the entry to
new opt-ins but does not confiscate an existing choice.

Validation bounds the saved list and individual id/label lengths, rejects
duplicates, and preserves exact ids. Custom ids are an expert escape hatch,
not a server-side claim that the provider accepts or honors them.

## Provider Projection

The Claude provider continues to own one primary catalog composed from YA's
stable fallbacks and the SDK handshake. A second server-owned optional catalog
describes opt-in choices.

At every catalog surface:

1. Build the primary catalog as today.
2. Resolve persisted opt-ins against the optional registry.
3. Append only enabled entries that do not duplicate a primary id.
4. Mark appended entries as additional so clients can group them separately.

This projection applies both to `GET /api/providers` and to the live
`supportedModels()` callback used for in-session model switching. Provider
catalog caching must not cache a user's old setting value.

## Hosted Compatibility

This feature adds one exact transitional server capability. The client hides
the setting when the connected server does not advertise it.

| Combination | Behavior |
|---|---|
| New client + new server | Full settings and grouped-catalog behavior |
| New client + older server | Additional-model control is absent |
| Older client + new server | Optional metadata is ignored; enabled entries remain ordinary model rows |

The setting remains source-aware through `useServerSettings`, so a hosted
client edits the connected server rather than browser-global state. This
additive field and optional control do not justify a
`remoteCompatibilityLevel` increase.

## Registry Lifecycle And Refresh Runbook

Every provider refresh must compare the live/provider-maintained catalog with
the optional registry:

1. Record models removed from discovery or displaced by aliases.
2. Add only a still-usable model with a concrete reason to preserve it.
3. Review provider lifecycle status and published retirement timing.
4. Mark a deprecated entry in display metadata before retirement when useful.
5. Remove an entry when the provider retires, rejects, or silently remaps it.
6. Keep already-selected removed entries grandfathered; never auto-replace
   them.

Read-only SDK catalog checks are routine. Paid model turns require explicit
approval and are not part of this feature's tests.

## Implementation Slices

### Slice 0 — Contracts and plan

- Add this tactical plan.
- Convert the findings note into an implementation contract.
- Record settings placement, refresh, and compatibility decisions.

### Slice 1 — Shared and server behavior

- Add the persisted setting shape and bounded validation.
- Add the server registry and pure catalog projection.
- Advertise the exact capability.
- Project selected entries through provider and live-process model catalogs.
- Cover loading, grandfathering, de-duplication, cache freshness, and route
  behavior.

Completed 2026-07-25. The shared wire parser bounds and validates exact-id
selections without consulting registry membership. The server registry and
pure projection cover maintained, custom, removed-registry, and duplicate
cases. Claude's provider catalog and live `supportedModels()` path read the
current server setting, while provider-route caching uses a settings-derived
key. `/api/version` advertises the transitional capability.

Focused shared/server coverage passes 128 tests, including settings route and
restart persistence, provider route cache invalidation, provider projection,
the existing Claude catalog suite, and version advertisement. Root lint and
typecheck are warning-free. No live model turn was run.

### Slice 2 — Client settings and model grouping

- Add the capability-gated Providers-settings row and editor.
- Add i18n-ready copy in `en.json`.
- Group enabled entries under **Other models** wherever users choose a
  model.
- Preserve missing saved/current selections visibly.
- Cover compact summary, add/remove/custom flows, capability absence, and
  picker grouping.

Completed 2026-07-25. Providers settings now presents a capability-gated
summary row with a maintained checklist and advanced exact-id entry. Saves use
the existing source-aware settings path, then refresh the connected server's
catalog without forcing a provider rediscovery. Removed maintained entries
remain selected and removable, while custom entries preserve their exact ids.

New-session, restart, and in-session switch controls group additional entries
under **Other models** and synthesize a visible row for saved or current ids
that are absent from the catalog. Focused client coverage passes 61 tests
without runtime warnings. Root lint and typecheck are warning-free; the client
production build completes; the console scan remains at its 110-site baseline
(+0); and the advisory i18n scan reports only its three pre-existing dev-server
strings.

### Slice 3 — Closeout

- Reconcile this plan's status and evidence.
- Run focused tests, full lint/typecheck/tests, `pnpm i18n:scan`, and
  `pnpm console:scan`.
- Confirm every touched-area test run is warning-free.

Completed 2026-07-25. `pnpm test` passes in every participating workspace,
including 424 shared tests, 2,802 server tests with 6 skipped, and 2,379 client
tests. `pnpm build`, root lint, and root typecheck pass. The aggregate Vite
build retains the repository's existing browser-crypto and chunk-size
advisories.

All focused touched-area runs are warning-free. The advisory i18n scan remains
at its three pre-existing dev-server strings, and the console scan remains
within its 110-site baseline with a +0 delta. No paid or live provider turn was
run.

## Acceptance Gates

- Empty settings produce byte-for-byte equivalent visible model membership.
- The three maintained entries are all opt-in and individually selectable.
- A custom exact id survives restart and reaches session/model-switch
  requests unchanged.
- Removing a selected registry fixture preserves it as an unlisted choice.
- Cached provider catalogs reflect setting changes without waiting for cache
  expiry.
- New clients do not expose a broken write path against older servers.
- Existing defaults and current selections remain legible when an entry is
  disabled.
- No test performs a paid provider turn.

## Non-Goals

- Exhaustive historical model discovery.
- Automatic model replacement or alias migration.
- Proving account access before saving an entry.
- Changing model pricing, glyph, or context-window inference.
- Repairing unrelated alias/canonical-id duplication.
- Adding previous models to the default first-party-style catalog.

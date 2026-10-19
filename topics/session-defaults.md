# Session Defaults

> Session defaults are the standing choices used to seed new YA sessions;
> some apply across all providers, while provider/model economics controls
> must be stored per provider rather than shared as one global value.

Topic: session-defaults

See also: [permission-mode](permission-mode.md) for the `Auto` permission-mode
fallback contract when a selected model cannot honor provider-decided approval.

## Contract

Session defaults are not one flat bucket. A default either answers "what should
new sessions generally do?" or "how should this provider/model spend work?".
Those scopes must stay separate in storage, UI grouping, and migration.

### All-provider defaults

All-provider defaults apply no matter which provider is selected. Provider
capabilities may decide whether a choice has an effect at launch. Except for a
security boundary whose current execution host cannot enforce, the UI should
not hide or rewrite the user's standing preference merely because the
currently selected provider lacks the feature.

- **Default AI provider** — the provider chosen when opening a new-session form.
  The floating composer's informational chip resolves this plus the provider's
  preferred model through `useDefaultNewSessionModel`, which must keep matching
  the New Session form's initial seeding (same `getProviderSessionDefaults` and
  preferred-model pick).
- **Permission mode** — the requested approval policy. A model may hide or
  ignore unsupported modes such as provider-decided `Auto`, but the saved
  default is not a provider/model economics choice.
- **Sandbox new sessions** — the default-off launch-time host-confinement
  toggle. The saved value is provider-independent and each New Session may
  override it before process creation. The control is rendered and sent only
  when the server reports a currently available host backend; see
  [session-sandboxing](session-sandboxing.md). Selecting it also selects the
  subordinate **Network firewall** default, which preserves public IPv4 egress
  while blocking the YA host and local networks. Explicit firewall opt-out is
  retained; an absent firewall value defaults on only inside a project-write
  sandbox. See
  [session-sandbox-network-boundary](session-sandbox-network-boundary.md).
- **Recaps** — recap mode and away threshold belong together. They are standing
  session-helper choices, not properties of whichever provider button happens
  to be selected. In New Session's linear control stack, they follow the core
  launch choices so an infrequently changed helper does not sit next to the
  composer.
- **Prompt suggestions** — expose `Off` / `Native` unconditionally. Launch code
  only enables native provider suggestions when supported, but the default UI
  must not show provider-specific "unsupported" copy in the all-provider area.
- **Show thinking** — display policy for already-produced thinking rows. This
  is not provider spend; it belongs outside the AI-provider-specific region and
  may keep the existing per-install/live-toggle persistence pattern.
- **Forked sessions** — fork-after-summary display/opening behavior, such as
  whether to open the forked session in a new tab when ready. This is a
  session-UI preference, not a provider/model economics choice.

### Provider-specific defaults

Provider-specific defaults depend on provider/model capabilities, cost, latency,
and naming. They must be keyed by provider, and model-sensitive values should be
resolved against that provider's available model metadata.

- **Model** — model ids are provider-local and cannot be shared across providers.
- **Service tier / speed tier** — provider-visible economics and latency knobs.
  New Session remembers explicit choices on the server per provider; an
  unconfigured provider starts Standard ([service tier](service-tier.md)).
- **Router pool, account and policy** — server-owned choices keyed by provider,
  restored only when currently usable. Choosing Direct clears them. See
  [router defaults](agent-auth-router.md#new-session-defaults).
- **Thinking mode** — `off` / `auto` / `on` changes provider work requested.
- **Effort level** — effort labels are not comparable across providers; `high`
  on one backend is not a portable meaning or cost on another.
- **Effort per model (Claude)** — an optional model id → effort map that
  defines what Thinking **Auto** requests for each Claude model. With Auto and
  no explicit effort, a Claude launch requests the selected model's saved
  effort, else the catalog's `defaultEffortLevel`, else no effort (Claude
  Code's own default). An explicit effort always wins and disabled thinking
  requests none. The server reports a supported saved effort as that model's
  `defaultEffortLevel`, so the level a client shows for Auto is the level
  launched. Unsupported saved levels are ignored. Claude Gateway and Ollama
  launches are unaffected. Without the `model-effort-defaults` capability the
  setting is hidden and never sent.
- **Tailed Recap Model** — tailed recap model ids, costs, and availability are
  provider-local. The selector is intentionally lower-priority than thinking
  mode and effort. OpenAI-compatible helper targets stay hidden until
  [openai-compatible-helper-sessions](openai-compatible-helper-sessions.md)
  exists.

Switching AI Provider should restore that provider's provider-specific defaults
without disturbing all-provider defaults. Changing an all-provider default should
not overwrite per-provider model/thinking/effort choices.

### Provider catalog readiness

The first authenticated or remotely connected YA visit in a browser tab primes
provider status and model catalogs through the same source-scoped request/cache
used by New Session, settings, and restart surfaces. A consumer mounted during
that primer joins its in-flight request rather than repeating provider probes.
Catalogs and in-flight work from one local or remote host never satisfy a
consumer viewing another host. Primer failure remains advisory: the first
consumer retries through its normal loading/error path.

Readiness is client-presence-driven. YA does not periodically probe provider
catalogs while no browser is visiting it. The standing provider/model choice is
durable settings state, not a dynamic catalog answer: New Session renders the
exact saved provider and provider-local model in its final control region, then
revalidates installation, authentication, alternatives, and capabilities in
place. An unselected provider's discovery does not delay or clear that choice.

Provider, model and effort positions exist before their data arrives. Hidden,
inert copies of the controls reserve their dimensions; they expose no choices
or launch authority. Each populated control replaces its own placeholder
independently. Authentication copy reserves a second provider-label line, and
the model placeholder includes the badge's geometry. Catalog status occupies
a separate row below all three controls and reserves its wrapping height before
the response, so it cannot push the effort picker or advanced-options button.
Refresh remains available for static or unavailable model lists, using the
same explicit selected-provider discovery action.

New tabs restore a seven-day, source-scoped browser snapshot of provider,
provider-local model, thinking mode and effort while settings load. Only these
display fields are retained; permissions, sandbox policy, paid tiers, helper
targets, credentials and the rest of the settings document are excluded. They
are server-wide defaults already readable by every authenticated principal,
not a cached identity or grant. Project snapshots need a separate account
boundary and are not part of this cache.

The settings owner writes the snapshot only when it accepts a response or
mutation, preserving its request-order rules. Cached display defaults never
populate the authoritative settings object or mark its query complete. Start,
Project Queue and automatic preference writes wait for current settings when
the display was restored from storage. Typing and selecting controls remain
available. Current settings reconcile untouched controls; an explicit user
selection survives. A failed settings read retains the display and offers a
retry. Missing, malformed or expired storage falls back to normal acquisition.

The local `/new-session` entry starts current settings acquisition before its
React runtime loads. It uses canonical same-origin HTTP, the same query identity and
snapshot publication as `useServerSettings`; a mounted consumer joins pending
work or reuses its accepted response. A failed primer does not mark settings
ready and leaves retry/error presentation with the mounted owner. It neither
populates settings from display storage nor relaxes launch or identity checks.

After those current settings resolve, the local entry starts the named provider
read for a recognized URL preference, otherwise the saved provider or ordinary
Claude default. It shares the form's row cache and pending request instead of
waiting for the form's seeding effect. Settings failure starts no provider read.
This is an acquisition hint: the mounted form still reconciles current provider
availability and principal locks. The primer does not select or authorize a launch.

The provider chooser separates identity enumeration from dynamic readiness:

- Capability-gated `GET /api/providers/descriptors` returns exposed `name` and
  `displayName` pairs immediately, applying the same enabled-provider filter
  as the other provider routes without running installation, auth or model
  probes. Descriptor acquisition uses the source-bound retained query owner;
  refresh and reconnect revalidate it. Unknown/older servers receive no such
  request and keep the aggregate-only chooser.
- New Session can offer descriptor choices before the complete catalog. Unknown
  installation is not displayed as missing or unauthenticated. Selecting a
  choice starts its named read; an explicit selection cannot enable Start or
  Queue until its row confirms an installed runtime. The existing implicit
  server-default launch remains available when no provider was selected.

- `GET /api/providers` returns the exposed provider-card collection and remains
  the complete-response compatibility path.
- `GET /api/providers/:name` resolves and refreshes one selected provider without
  probing unrelated providers.

The server retains one provider row per registered provider for its lifetime,
including unavailable-provider results. Ordinary reads from any client reuse
that result without time expiry or size eviction; opening a tab does not
schedule a background probe. Explicit Refresh or a changed model-catalog
configuration key starts discovery again. The fixed provider set bounds the
number of retained rows, rather than a shared byte budget that could make a
large catalog rediscover itself on every read.

One source-versioned owner coordinates acquisition. Ordinary callers join current work, concurrent forced
callers coalesce, forced work supersedes older ordinary work, and late old
success or failure cannot replace or delete the newer row. The provider's model
catalog key participates in generation identity. Aggregate `Promise.all`
failure behavior is unchanged.

A provider row reports the provenance of its models as `modelCatalog`:
`live` with the time the provider was read, `fallback` when YA substituted its
built-in list because the live read failed or the provider is signed out, or
`static` when the provider has no live list. An `error` records why the last
live read failed. A provider that caches its own catalog discards that cache on
`refresh=1`; Claude also re-probes after an hour and keeps its last live list,
with the error, when a re-probe fails. The field is optional: a client shows no
provenance for a server that omits it and makes no additional request.

Below the model picker, New Session shows a muted "Models updated Xm ago" line
with Refresh for a live list, and a warning-toned line with Refresh for a
fallback list or a failed refresh. Refresh is the named `refresh=1` probe for
the selected provider. Pool launches omit the line until the router catalog
carries its own provenance.

The client persists a versioned, source-scoped browser display snapshot without
age expiry.
An explicit allowlist retains provider/model display metadata and capabilities;
identity, expiry, login commands, credentials, authorization material, raw
provider output, and unknown configuration are excluded. Hydration marks the
snapshot expired immediately: it is an opening guess, never a probe result.
Consumers still report loading, the rendered group stays busy, and current
server rows replace the snapshot in place. Aggregate and named rows share one
request-admission sequence and publish accepted responses to every mounted
source consumer: a later aggregate settings reload supersedes an older named
cache entry, while a late older aggregate cannot displace newer named facts or
reintroduce an old error.

Accepted named rows also persist independently, using the same non-expiring
allowlist and source boundary. A sibling tab can restore the selected model
and capabilities while the complete catalog is still waiting on unrelated
providers. A named snapshot never becomes a partial provider collection or a
current probe result. Newer accepted aggregate responses retire older named
snapshots; late older aggregates preserve newer named displays. Current named
or aggregate runtime status is required to authorize an explicit launch;
persisted installation status alone does not enable Start or Project Queue.

Display validity and launch authority are separate. A stale selected row may
remain visible while a named read is pending or failed. Claude Gateway uses
the ordinary server cache after the selection becomes current; opening a tab
does not force discovery. Start and Project Queue launch remain blocked until
a current server response advertises the
required model. Actual new-session process creation repeats the Gateway-only
advertised-model check, so deferred Project Queue and internal worker-queue
launches cannot reuse enqueue-time authority. A Project Queue item held by the
worker queue remains in durable `dispatching` state until launch starts; a
validation failure moves it to `failed` with the catalog error rather than
removing its prompt. At worker capacity, a direct Gateway caller without that
durable failure channel receives the existing `queue_full` response instead of
a queued acceptance whose later failure would discard its prompt. Retry
refreshes Gateway alone. Other providers retain ordinary server-row reuse
and exact unlisted model-id behavior.

For ordinary local providers, `installed` is the New Session selection and
launch gate: it means YA has a runtime to start. `authenticated` is a separate
readiness signal and does not disable that launch attempt, because a harness may
discover, refresh, or request credentials only after startup. New Session marks
the selection as needing authentication and lets the real provider startup
either succeed or return the actionable authentication error. A coarse desktop
`applicationDetected` signal alone never authorizes launch. Claude Gateway's
current-catalog rule above remains the narrower exception.

New Session's initial subscription-usage read is admitted as supplementary
startup work after earlier route tiers. Direct-demand usage consumers and every
explicit Refresh remain immediate.

There is no persisted server provider/model snapshot. A clean browser on a
capable server can enumerate choices immediately through descriptors; dynamic
installation, auth and model facts still come from provider rows. Generic Gateway
model discovery can still start its configured runtime, and aggregate failure
is not isolated by row. The descriptor capability removes that aggregate from
identity enumeration, preserving its complete-response failure semantics for
existing clients. Server persistence and broader failure isolation remain in
[`docs/tactical/094-new-session-provider-catalog-readiness.md`](../docs/tactical/094-new-session-provider-catalog-readiness.md).

## Recap fallback semantics

`Forked` is a preference for the higher-fidelity recap path. **Tailed Recap
Model** is the provider-scoped helper model for the tailed path, so it is shown
with provider-specific defaults when `Tailed` is selected and hidden for `Off`,
`Native`, and `Forked`.

`Native` remains a valid internal/future recap mode, but no current backend
offers a meaningful way to request native recaps. Do not show it in the UI until
a provider capability makes it real.

## Per-session live picks vs global defaults

The rest of this doc is about *defaults that seed a new session*. A separate
concern is what happens when a user changes model/effort/thinking **inside an
existing session** and then reloads or the server process is torn down: the live
pick must survive as a server-owned per-session choice, not silently reset or
depend on one browser's storage.

`SessionMetadata.effectiveLaunchSettings` stores the last successfully applied
permission mode, exact requested-model token, service tier, thinking mode, and
effort with a session-local monotonic revision. A process lifetime is not a
settings lifetime: every replacement process for an existing session starts
from that record. A replacement process resolves an explicit validated request
first, then this complete durable record (including intentional null/provider-
default values), then applicable pre-snapshot evidence, and finally the
conservative server/provider default. Existing YA requested-model metadata
precedes provider transcript inference because it records the user's exact YA
selection token.

A live change is saved to that record as it is applied. When the process stops
before that save has run — Stop, a rewind, an idle reap, a turn interrupt that
falls back to aborting, a provider exit — the stop completes the save, so the
next replacement process starts from the settings last applied rather than
the ones saved before the change. A requested abort (Stop, a rewind, the
interrupt fallback) waits for the save before returning; a failed save is logged and does not fail the stop. A save for a
stopped process never overwrites a successor process that already owns the
session.

For a Codex session that predates the complete snapshot, the first later cold
launch lazily reads the latest valid transcript `turn_context`. Its non-empty
model and supported effort are recoverable. `none` recovers disabled thinking;
a supported named effort recovers adaptive summarized thinking with that
effort. Exact `never` plus danger-full-access recovers Bypass, and exact
`on-request` plus read-only recovers Plan. Ask and Accept Edits both produce
`on-request` plus workspace-write, so that pair and every incomplete or unknown
pair recover as conservative Ask. Legacy absence or ambiguity never grants
Bypass. Unsupported/absent effort remains unknown rather than being coerced.

Recovery is read-only until process launch succeeds. The complete effective
settings actually used by a successful launch then become authoritative and
are written as revision 1 through the ordinary snapshot path; failure or
cancellation writes nothing, and later cold launches use the snapshot instead
of reinterpreting the transcript. Merely listing, rendering, scanning, or
indexing old sessions does not migrate them.

A live configuration response is successful only after the provider applies
the selection and the metadata writer flushes a snapshot containing it.
Explicit reactivation metadata changes for provider, executor, recap, prompt
suggestion, and sandbox selection flush in that same serialized transaction.
If a write fails, YA retains the actual live state as pending and retries it
without repeating an already-applied provider change.

Authenticated session-detail and metadata responses optionally include
`session.effectiveLaunchSettings`, the complete last-applied snapshot above.
Its presence makes server-owned settings authoritative for dormant controls,
including permissions on a browser or phone with no local history. Merely
opening a session does not activate a provider or create a missing snapshot.

When the snapshot is present, ordinary resume, process-disappeared retry, and
existing-session Project Queue submissions omit unchanged permission, model,
and thinking overrides. Server cold-launch resolution therefore retains the
exact model token, service tier, thinking and effort, including intentional
null/default choices. A deliberate Ask or Off selection is still an explicit
override, even when it happens to equal the browser's default.

Browser-local permission/model state remains the fallback when the optional
snapshot is absent, and global thinking/effort remain defaults for new or
legacy sessions. Older servers receive only the established request fields
and retain their previous, less exact resume behavior. This is field-presence
detection, with no new capability flag or handshake. The 2026-09-29 maintainer
review covered stable v0.8.0, v0.8.1, v0.9.0, v0.9.1 and v0.9.2; all lack the
complete response snapshot, and the approved fallback remains available.

Once Activate owns a process, process-info and the live stream are authoritative;
the composer and model panel adopt that process's restored configuration.

When retained thinking settings are available, the stopped-session composer
shows those settings before the next message, including High/other effort
levels and an intentional Off. The visible selection and submitted selection
must agree. Changing thinking while stopped stages a session-local override
for the next message; it does not change the browser's new-session defaults.
Metadata refreshes preserve that unsent override. Switching sessions discards
it, and a newly owned process becomes authoritative again.

An effort selection accepted while a turn is active is authoritative pending
state: process info reports the selected next-turn effort so a browser refresh
does not replace it with the last provider-observed value. The durable launch
snapshot continues to report the last applied effort until the provider reaches
the idle boundary and accepts the pending selection.

**Show thinking** remains a browser display preference. It is deliberately not
part of the provider launch snapshot and does not move with a session.

Clone and prefix forks preserve the source's current settled launch settings,
with explicit successor overrides taking precedence. A child receives its own
complete snapshot before creation succeeds, so opening it in a browser with
different new-session defaults cannot reset its first send. Legacy aside clones
use the same rule. Historical transcript cutoff does not rewind configuration;
see [provider fork support](provider-fork-support.md#launch-settings-inheritance)
for recovery, helper overrides and creation failure behavior.

## UI placement

The session-defaults settings panel follows the launch decision order through
sandboxing, then uses the wider explanatory layout efficiently: AI Provider,
model, thinking/effort, permission mode, sandboxing, a paired **Show thinking**
and **Suggestions** row, recaps, and the conditional **Tailed Recap Model**.
**Show thinking** and **Suggestions** share the available row on a wide panel
and stack on a narrow panel; recaps retain their full-width row. A **Related
behavior** divider follows that core launch sequence; fork-opening, compaction,
and prompt-cache keepalive controls live below it. The visible order is for
comprehension and does not change persistence scope: provider/model economics
remain provider-specific, while permission, sandbox, recap, suggestions,
show-thinking, and fork-opening keep their established all-provider or
client-local ownership.

When recap mode is enabled, its away-duration control occupies a full-width row
attached to the recap choices and before the conditional helper model. The
slider, numeric seconds input, and unit remain visible as one control and never
share or overlap the paired Show thinking / Suggestions grid row.

New Session prioritizes project, AI Provider, model, and thinking/effort. On a
narrow viewport they follow the composer in that order; on a wide viewport the
project chooser sits beside the composer and the three provider controls share
the next row. The model dropdown shows its provider/model badge, and the
composer has no duplicate model selector. The provider dropdown lists every
known provider with descriptive status: an uninstalled provider is disabled,
while an installed provider whose authentication is unconfirmed remains
selectable.

Permission mode, Show thinking, recaps, conditional **Tailed Recap Model**,
suggestions, sandbox and its conditional network firewall, available computer
control, and configured remote execution hosts live in **Advanced options**.
These choices use compact dropdowns; recap away duration remains attached to
an enabled recap mode. Advanced options starts collapsed for a browser that has
never chosen, then remembers its expanded or collapsed state in browser-local
storage across form mounts and reloads. When collapsed it summarizes active
non-default choices. Expanding the project chooser temporarily hides the
advanced controls so its overlaid, scrollable history remains unobstructed.
Placement does not change a setting's all-provider or provider-local ownership.

New Session hides explanatory captions by default, while desktop hover
tooltips expose the same text. The `?` button reveals captions below their
dropdowns, keeping control rows aligned when descriptions wrap; this choice
lasts only for the mounted form. Settings always shows captions because
explanation and searchability matter more there than fitting the launch form
on one screen.

Both surfaces take each control's base title and description, plus optional
Settings-only search terms and label overrides, from one declarative control
copy definition. A description that depends on the selected value, such as the
active recap or suggestion mode, must appear as compact-mode tooltip text and
as expanded caption text below the control.

Permission-mode descriptions stay short in the Settings card grid and New
Session dropdown:

- `Ask` — `Ask every time`
- `Edit` — `Ask to run commands`
- `Plan` — `Do not attempt edits`
- `Bypass` — `Auto-approve all actions`
- `Auto` — `Provider decides`

## Storage and migration direction

Use a shape that preserves existing top-level fields while adding a scoped
provider-default map, for example:

```ts
interface NewSessionDefaults {
  provider?: ProviderName;
  permissionMode?: PermissionMode;
  sandboxLevel?: SessionSandboxLevel;
  recapMode?: RecapMode;
  recapAfterSeconds?: number;
  promptSuggestionMode?: PromptSuggestionMode;
  providers?: Partial<Record<ProviderName, ProviderSessionDefaults>>;
}

interface ProviderSessionDefaults {
  model?: string;
  serviceTier?: string;
  thinkingMode?: ThinkingMode;
  effortLevel?: EffortLevel;
  helperSideModel?: string;
}
```

Backward compatibility rule: top-level legacy `model` / service-tier-like
fields, and legacy `useModelSettings` thinking/effort values, seed the selected
provider's first provider-specific entry. Do not discard configured values on
read; normalize into the scoped shape on the next save.

## Implementation plan

Session sandboxing follows the separate backend-integration gate in
[session-sandboxing](session-sandboxing.md); it is not part of the
UI/storage sequence below.

1. **Pin this contract.** Create this topic, add the glossary/topic index row,
   and use it as the commit topic for the UI/storage changes.
2. **Recap UI.** Group recap controls with all-provider defaults in the settings
   panel; keep **Tailed Recap Model** provider-specific; make `Forked` available
   whenever the provider can generate recaps.
3. **Prompt suggestions.** Show `Off` / `Native` unconditionally in the
   all-provider defaults area; remove provider-specific unsupported copy; keep
   launch-time native enablement capability-gated.
4. **Provider-specific defaults.** Add `newSessionDefaults.providers` and wire
   selected-provider model, thinking mode, effort, and tailed recap model
   through it. Preserve legacy fields and existing saved preferences by seeding
   the selected provider on read/next save.
5. **All-provider placement.** Keep permission mode, show-thinking display
   policy, and forked-session behavior outside provider-scoped persistence.
   Session Defaults and New Session may interleave these controls with
   provider-specific choices by launch relevance without changing their
   storage scope.
6. **Permission captions.** Shorten equal-width permission-mode card captions to
   the text above.
7. **Tests.** Cover provider switch persistence, all-provider recap/suggestion
   persistence, fork-to-tailed fallback, and the new ordering/label invariants in
   focused client/server tests before typecheck.
8. **Layout verification.** Verify the defaults panel is efficient and sensible
   in a modest 1200×1000 options content area: the core defaults should be
   usable without unnecessary scrolling, with recap/suggestion/provider/model/
   thinking/permission controls packed by their scope rather than stretched into
   a long vertical list.

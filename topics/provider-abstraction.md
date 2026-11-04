# Provider abstraction seam

When provider- or model-specific behavior belongs on the `AgentProvider`
interface instead of as inline `if (provider === "claude")` / `if (model
matches …)` branches in generic callers (routes, the Supervisor, shared
helpers).

See also: [`provider-state-machine.md`](provider-state-machine.md),
[`provider-context-economics.md`](provider-context-economics.md),
[`provider-refresh.md`](provider-refresh.md). Global aesthetic: the
"shared-facility contract" rule and agent-design's "promote to a dedicated
surface when you need to gate/render/audit".

## Status: NOT yet systematically applied

This is a forward-looking guideline, adopted incrementally. Existing
provider/model conditionals have **not** all been migrated.
`yaModelIdForReported`, native compact-threshold support, and launch-scoped
compact-percent support and native steering urgency (below) adopt this seam.
Don't treat the presence of remaining inline conditionals as a bug to sweep;
migrate them when they next hit a trigger below.

### Candidate next surfaces

- **Requested ↔ reported model-name mapping.** The UI keys per-model settings
  by the alias the user picked ("opus"); a running session reports the resolved
  id ("claude-opus-4-8"). The provider is the one component that knows its own
  resolution, so a `provider.canonicalModelKey(model)` (or
  `aliasForReportedModel`) belongs there rather than as family-regex
  canonicalization scattered across the route, settings, and client. Pending a
  parked design decision on which identity is canonical (alias vs resolved id —
  the latter lets distinct aliases that resolve to the same model *share*
  settings, but "default" is subscription-dependent and resolvable only at
  runtime).

### Provider input queues

Shared delivery metadata expresses user intent; native urgency belongs at the
adapter ingress, before batching can combine messages. Claude's
`prepareClaudeInput` maps steer/Now to `next`/`now` and deferred/patient to
`later`; generic `Process` does not choose Claude priorities. Preserve each
input's identity and authoritative consumption evidence through that mapping.

`ProviderInfo.steering` describes native modes and selection scope. A
`per-message` provider may offer immediate steering beside Send; a `launch`
provider configures new owners through capability-gated settings. Do not
pretend a launch flag is a per-message API, or simulate immediate steering
with interrupt-and-resend. Keep regular/patient scheduling separate from
native urgency. A gentle-only adapter such as Grok can advertise the same
contract without exposing an immediate control.

Codex captures the YA choice at owner creation, applies it at native launch,
and emits mode/source evidence in init. The worker retains that evidence in
attach state after init is acknowledged; a replacement server must use it
rather than reconstructing mode from today's settings. Native configuration
that YA cannot resolve is reported as `native-config`. See
[the steering contract](steer-queue-provider-differences.md#shared-steering-contract)
and [plan 174](../docs/tactical/174-shared-steering-and-native-urgency.md).

Every provider session supplies its input queue, including scripted/mock
providers and provider-host proxies. `Process` uses that queue for submission,
depth, cancellation, draining and consumption observations; it has no separate
mock-only input scheduler. Provider consumption, rather than an artificial
Process transition, owns delivery observations. Test fixtures must supply the
same queue surface as production sessions.

### Legacy SDK delegation

The compatibility Claude SDK bridge declares its canonical `providerName`.
When no provider override is supplied, Supervisor resolves that name through
the configured AgentProvider registry. Omitted-provider Claude requests thus
use the same launch/creation owner as explicit Claude requests, including
saved startup intent and caller-chosen identity. This changes no provider,
endpoint, account or model selection; existing configured adapter settings
remain authoritative. Provider-visible `clientName` is passed through on
both provider creation paths.

An explicit provider override wins, including `null` disabling registry
discovery. An independent SDK with no canonical name keeps its established
SDK path. The declaration is an internal bridge contract, not a browser
capability or a new provider-specific lifecycle framework. See
[session identity](session-identity.md#managed-dispatch-boundary) for rollout
limits; routing, sandbox, hosting and remaining input shapes stay gated there.

### Scoped native continuation

`ProviderSessionSource` carries one proven native reference, physical transcript
path when one exists and original project. `ProviderForkSource` requires the
physical path for copy/helper operations; a fileless continuation does not
invent one. The trusted `StartSessionOptions.nativeResumeSource` is resolved
at the server/provider boundary; it is never accepted from client JSON.
Adapters opt into `supportsNativeResumeSource` only after validating storage
selection and exact native continuation. Native ids remain in provider-facing
resume/control fields; `publicSessionId` owns bridges, child authority and
AgentSelf. Supervisor keeps the original YA Process identity and checks the
returned native id independently. The shared `resolveNativeSessionSource` callback supplies authoritative source
acquisition; the fork boundary additionally requires a physical file; this adds no catalogue, registry or conversation store.
See [session identity](session-identity.md) for current enabling limits.

Claude, Gateway and Ollama share one native-environment/source validation
boundary. Gateway validates a scoped continuation before readiness or service
autostart, then revalidates at actual SDK launch after that await. Validation
preserves the configured account-home spelling and native project selector;
the common bridge and observations retain YA identity.

### Retained ACP continuation and teardown

Grok and frozen Gemini ACP opt into scoped native continuation. Their actual
launch namespace and original physical project must match the proved source
before CLI discovery, helper execution or bridge allocation. A reader-only
directory override cannot select another launch store. Grok uses
`GROK_HOME/sessions`; Gemini uses `GEMINI_CLI_HOME/.gemini/tmp`, with the existing
native home defaults when those overrides are empty or absent. Scoped overrides
must be absolute. A changed working-project overlay refuses continuation;
historical reads remain available at that overlay.

The existing ACP methods remain unchanged: Grok loads with `_meta.noReplay`,
and Gemini uses its retained resume method. A rejected or unsupported resume
fails explicitly; neither adapter creates a replacement conversation. The
provider's JSON-RPC error message survives even when the SDK rejects with a
plain object. Grok's native RPC id is separate from YA's tool-environment id,
including shells started after native attachment.

The shared client retains its actual child handle after requesting termination.
Its owned POSIX process group (Windows process tree) is terminated together;
launcher exit alone does not certify closure of a respawned native worker.
Shutdown escalates after two seconds and joins inherited stdio closure. The
native Gemini cancellation scenario exercises a real launcher/worker and held
model connection. A typed, locally generated closed-transport rejection during
requested abort is normal shutdown; other errors remain failures.
Logical connection closure cancels pending requests and idle input waits; it
does not certify OS process death. Abort/iterator cleanup waits for actual child
closure, and liveness follows the child's exit evidence. Closing before startup
prevents a late connect. A completed request removes its pending close handler,
so successful calls do not accumulate per-conversation listeners. These are
ownership/teardown guarantees for the pinned SDK, not an ACP protocol refresh.

### Provider-wide session and process discovery

Accepted 2026-08-05; successful-use eligibility, the gated watcher owner, the
retained catalog coordinator and Pi/Grok/OpenCode native catalog adapters are
implemented. Project-discovery convergence, remaining focused observation and
exact external-process reconciliation are still incomplete. The implementation handoff is
[`docs/tactical/093-provider-session-reconciliation.md`](../docs/tactical/093-provider-session-reconciliation.md).
Generic collection and boot code knows too much about provider storage. Host
process command recognition is now its own module,
`services/providerProcessClassifier.ts`, reusable without the host process
inventory, but it is still a fixed table of names and package paths rather than
a provider capability. Its native PID-record lookup currently correlates Claude
sessions; other families still need exact native evidence before process roots
can be joined to particular sessions.

These are two separate provider-owned projections:

- **Native session catalog.** Enumerate a provider's storage once in complete or
  recent-window mode and return native session ids, canonical project identity,
  and a bounded activity summary. Full transcript detail remains an explicit
  per-session read. The generic coordinator groups catalog rows into projects;
  it never calls a provider-global reader once per project.
- **Native process discovery.** Recognize the provider's exact harness command
  or generic-runtime entrypoint from a minimized same-user process snapshot.
  When argv, a pid/lock record, or a provider protocol exposes a native session
  id, return that exact correlation before discarding raw process text. A
  recognized but uncorrelated root remains a provider process, not a guessed
  session.

The projections join through native session id and exact YA Supervisor/runtime
ownership. They do not join through cwd, transcript mtime proximity, CPU, or a
single-candidate heuristic. The provider adapter owns command-name evolution,
native id syntax, storage layout, and the cheapest faithful activity read; the
generic coordinator owns scheduling, install-history eligibility, bounded
concurrency, retained snapshots, and project grouping.

Provider-store discovery is opt-in through observed YA use. The install keeps a
durable, alias-normalized set of native catalog families for which it has
successfully started a session. Boot does not ask an unused provider whether it
may have sessions and does not scan or watch its native store. Migration seeds
this set from existing YA-owned launch/session metadata, never by probing native
provider stores. A first successful YA launch durably records its actual
provider and family before registration and queues eligible watcher activation;
failure aborts the unregistered process. The separate host
process snapshot may still classify an active external harness from any known
provider without opening that provider's store. A durable completion marker
makes the legacy metadata seed pass one-time rather than recurring at every
restart.

The existing `mayHave*Sessions(project)` predicates are only coarse storage
eligibility. They do not inspect `ps`. Returning `true` for every project and
then filtering a provider-global store by cwd is not an acceptable
implementation of the catalog at 10,000-project scale.

## When to promote to a provider surface

Promote an inline provider/model conditional to an **optional**
`AgentProvider` method (default: no-op / identity / `undefined`) when any of:

1. **It recurs.** The same provider/model conditional appears in 2+ places.
   (The reported→alias model-id mapping had spread across the threshold lookup,
   the quick-edit, and enrichment — the tell that drove `yaModelIdForReported`.)
2. **A generic caller has to know provider internals.** A route should not
   "know" that Claude opus runs at 1M or which provider accepts an automatic
   compaction threshold.
3. **Adding a new provider would require editing the generic code** rather
   than just implementing the interface.

## When NOT to

A single, localized, one-off conditional stays inline. Don't abstract on first
sight — indirection has its own cost. The **default-does-nothing** property is
exactly what makes the surface cheap to add *later*, so there is no penalty for
waiting until a trigger above actually fires.

## The default-no-op contract (low blast radius)

Make the method optional with a default that preserves current behavior:

- Window/identity resolvers: return `undefined` to defer to the generic
  heuristic, so non-implementing providers are unaffected.
- Policy hooks (e.g. preemptive compaction): default to "no policy", so the
  generic path runs exactly as before.

A new optional method touches only the providers that opt in; every other
provider and caller is unchanged. That is the property that lets this be
adopted one surface at a time.

## First instance: `yaModelIdForReported`

`AgentProvider.yaModelIdForReported?(reported): string | undefined` — maps a
provider-reported model id back to a YA model id (launch alias), default-no-op
(returns `undefined`). Used by the per-model-settings keying below; see that
section for the contract.

## Second instance: native compact threshold

`AgentProvider.supportsNativeCompactThreshold` declares that
`StartSessionOptions.compactAtContextTokenLimit` is meaningful for that
provider. Absence preserves the original YA-orchestrated behavior.

The user setting remains provider-neutral: a per-model percentage of the full
context window. The Supervisor derives an integer token limit only when the
provider advertises native support. Codex maps that to its app-server thread
config:

- `model_auto_compact_token_limit: <tokens>`
- `model_auto_compact_token_limit_scope: "total"`

The explicit scope is load-bearing: the user chose a percentage of the full
active context, so an unrelated Codex config must not reinterpret the limit as
only growth after a carried compaction prefix. Codex does not expose these
fields through `thread/settings/update`; changing or clearing the setting on a
loaded thread therefore resumes that same thread with new launch config.

Off is canonical omission. With no per-model percentage, YA sends neither
compaction config key and does not invent a model-specific default. The global,
default-off `clientDefaults.forceYaOrchestratedCompaction` switch bypasses a
native capability and runs the same idle-boundary usage check plus manual
compact-command path used for providers without native threshold support.

## Third instance: launch-scoped compact percentage

`AgentProvider.supportsLaunchCompactPercentOverride` declares that
`StartSessionOptions.launchCompactPercentOverride` is meaningful at provider
create/resume time. This capability is deliberately separate from
`supportsNativeCompactThreshold`:

- the native threshold takes a derived **token count** representing the user's
  percentage of the model's full context window;
- the launch override takes a **percentage** whose denominator and
  applicability belong to the provider.

Claude is the initial and only implementation. YA's single global
`claudeAutoCompactPercentOverride` setting maps to
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`; the environment key is absent when the
setting is off. Claude Code documents that this percentage is of its own
auto-compaction window, can only lower its default, and only takes effect where
Claude proactively compacts. Claude Gateway and Claude + Ollama explicitly do
not advertise the capability.

No live setter is assumed. A changed launch-scoped value requires restarting
and resuming the same provider session before the next ordinary turn. See
[resume-compaction](resume-compaction.md#claude-global-automatic-threshold-override)
for the observable contract and compatibility fallback.

### Removed: `contextWindowFor`

An earlier surface, `contextWindowFor` (Claude returned 1M for any opus so the
reported `claude-opus-4-8` wouldn't read as the base 200K), was **removed** when
we adopted kzahel's observation-based context windows (a kzahel-merge decision,
2026-06-17). `ModelInfoService` now resolves windows as `observed → ingested →
getModelContextWindow`: the real window is learned from the SDK's `modelUsage`
and persisted, which is more robust than a hardcoded override (it self-corrects
when an account only gets 200K, the same credits caveat that applies to sonnet).
Current Opus still runs at 1M without a launch rewrite: SDK 0.3.280 resolves
bare `opus` to Opus 5.5 with its native 1M window. The SDK then observes and
reports the real value. The lesson remains: prefer observing a real value over
hardcoding it in a provider quirk when the value is observable.

## Per-model settings keying

Decided and **implemented** for the core path (task 029, 2026-06-16). Configs
key by the **YA model id**; the over-split prefix tree, `off`=0 tombstone, and
provider split override remain parked (see *Still parked* below). This is the
home of the requested↔reported model-name candidate surface named above.

**Decision:** configs are split by **YA model id** (the requested name), and
where YA **owns** the session the config is looked up by that same YA model id.
The reported→requested mapping is still worth keeping with some fidelity (for
external sessions and display), but it is **not** the storage key.

### Implemented (task 029)

- **Owned sessions key by the requested id.** `Process` tracks `_requestedModel`
  (the launch alias, following mid-session switches; the readonly `model` stays
  at the original) and exposes it as `Process.requestedModel` /
  `ProcessInfo.requestedModel`. The `/messages` threshold lookup keys by
  `body.model ?? process.requestedModel ?? <persisted> ?? <helper>`.
- **Survives restart.** `SessionMetadata.requestedModel` persists the launch
  alias (`persistLaunchMetadata`); the `/resume` route recovers it into
  `options.model` when the client sends none, and `enrichProcessInfo` falls back
  to it. The old vestigial `SessionMetadata.model` (reported, never read) was
  removed.
- **Helper for non-YA-started sessions.** `provider.yaModelIdForReported`
  (Claude: a fixed family-substring table, `claude-opus-4-8`→`opus`, etc.) is the
  last fallback when no requested id exists. Imperfect and one-to-(0+) by design.
- **No family fallback in the lookup.** `resolveCompactPercent` is now a direct
  single-id lookup; the canonicalization that used to need family matching now
  happens once, upstream, via the helper.

### Still parked

The over-split prefix tree (`-`/`.`/alpha↔digit) with longest-match inheritance,
`off`=0 tombstone semantics, and a provider-overridable split. The fixed helper
table is the interim stand-in for the prefix tree; it covers current Claude
families but won't inherit across unseen minor versions the way the tree would.

### The core type mismatch

"The model" is one `string` doing double duty for two different things:

- **requested model** — what YA config / the user chose (the YA alias, e.g.
  `opus`); and
- **reported model** — what the harness says it's running (the SDK-resolved id,
  e.g. `claude-opus-4-8`).

They differ, and because both are `string` the compiler can't catch
substituting one for the other. That is the actual bug class: `Process.getInfo()`
returns `model: resolvedModel ?? model`, i.e. it hands back the **reported**
model at the read boundary and discards the **requested** one, and that reported
string then gets used as a per-model config key it was never meant to be. The
status-quo *intent* was to key per-model settings (`compactAtContextPercent`) by
the **YA name** (the Settings slider does); the context quick-edit storing the
**reported** id was the deviation that fragmented the same model across two keys.

Fix the distinction nominally — a `RequestedModel` / `ReportedModel` brand (or at
minimum two separately-named fields surfaced at that boundary) so they can't be
swapped silently, with exactly one resolver where they cross. The two-field
minimum is now in place (`requestedModel` alongside the reported `model` on
`Process`/`ProcessInfo`/`LiveModelConfig`); the nominal brand is not yet.

**When the reported model is known (2026-09-28).** A process reports the served
id from launch, not the alias. The supervisor hands each process its provider's
`resolveLaunchModel` (the catalog's current id for a selection, never probing),
which resolves the launch selection immediately and each later switch. Every
main-thread reply then names the served model and keeps it current; subagent
replies are ignored, since they may run another model. Each change is published
as a session update carrying the model, so an open page moves off the alias
without a reload. Before this, the reported model was the alias until the first
reply, was captured from that reply only, and a switch pinned the new alias
for the rest of the session. Displays drop the vendor name
(`displayModelId`: `claude-opus-5-5` reads `opus-5-5`); records keep the full
id, because the same model through another harness may bill differently.

### Rejected: probe-and-store-under-the-resolved-name

Initial idea: probe what each alias currently resolves to (`opus →
claude-opus-4-8`) and store config under the resolved name, so a non-owned
session (which reports the resolved name) is a direct lookup — no mapping,
search, or win-order. **Rejected because the resolution is not stable**: it
drifts with model versions and is subscription-dependent (`default` resolves to
different models per plan). Baking an unstable mapping into storage is brittle —
the stored key would silently stop matching when the resolution moves.

### Chosen shape

- **Owned sessions (YA-launched): key by the requested model** (the YA
  alias), which YA already tracks (`process.model`, persisted
  `SessionMetadata.model`). Don't key by `getInfo()`'s reported model.
  Distinct-by-choice: `opus` ≠ `best`, no forced sharing — max flexibility.
- **External sessions (attached/viewed, not YA-launched): no requested model**,
  so fall back to the **reported** name, canonicalized:
  - **provider-prefixed** (prepend the YA provider name if the reported name
    doesn't already start with it), so the namespace is provider-rooted;
  - **over-split into a prefix tree** — split on `-`, `.`, and alpha↔digit
    boundaries. Deterministic and applied identically at write and read;
    internal only, never user-facing. Over-splitting only makes prefixes *more*
    specific, so it can't cause wrong inheritance — it just adds harmless nodes
    and gives nicer minor-version grouping.
  - **longest-stored-prefix read.** Writing a setting writes the value at every
    prefix; an explicit node beats any inherited shorter prefix.
- **Inheritance survives resolution drift** — the robustness the rejected
  approach lacked: a bumped version (`claude-opus-4-9`), never configured, still
  reads `claude-opus-4`. Setting one model also populates broad prefixes, so an
  unconfigured sibling inherits the last-changed family value (accepted: an
  explicit per-model node always wins).
- **`off` is a stored 0, not a deleted key** — `{1–99 = percent, 0 = explicit
  off / don't inherit, absent = inherit}`. (Today the slider deletes at 0 and the
  validator drops 0; both flip.)
- **`default` is the holdout** — subscription-dependent, no reported name until a
  session runs; only learnable at runtime.

### Caveats / where the provider must override

The prefix family-default assumes a **stable component order** (family before
version). Provider naming doesn't always cooperate — Anthropic flipped it
(`claude-opus-4-8` is `{family}-{version}`, the older `claude-3-5-sonnet` was
`{version}-{family}`), so `claude-sonnet-4-6` yields a `claude-sonnet` prefix and
`claude-3-5-sonnet` yields none. For current models it's a non-issue, but it's
the reason the **provider may override the split / canonicalization** — default
is the universal over-split (no-op), a provider overrides only when its naming
needs re-ordering or to resolve an alias it has learned. This is the
requested↔reported / split surface, same default-does-nothing contract as
`yaModelIdForReported`.

### Recorded tension

Owned-by-requested gives distinct-by-choice (no sharing) and contradicts the
earlier "set opus, see it on best". You can't get both "distinct by choice" and
"shared by underlying model" from one key; owned-by-requested picks distinct. If
an owned setting should also apply when later *viewing an external* session of
the same model, owned would additionally write the resolved-name prefixes — but
that reintroduces the collapse. Owned-by-requested is the chosen default.


## Exact historical reader selection

A caller that knows a session's provider selects that provider's reader through
`getSessionSourceForProvider`; provider aliases share their native family.
An unavailable reader never falls through to another provider. Child-session
lookups omit children when no reader exists; vocabulary collection fails that
session's read, leaving its checkpoint unadvanced. A stored native binding
continues to select the exact original store and native ID before legacy lookup.

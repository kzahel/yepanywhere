# Exposing Older Claude Models

> How yepanywhere lets users opt previous Claude versions into model choosers
> while keeping the provider-native latest catalog primary, and how that
> interacts with model discovery and context-window machinery.

Topic: older-claude-models

Related topics: [claude-1m-context](claude-1m-context.md),
[claude](claude.md), [provider-refresh](provider-refresh.md),
[provider-model-glyphs](provider-model-glyphs.md).

Status: implementation authorized 2026-07-25. Tactical plan:
[`docs/tactical/062-claude-additional-models.md`](../docs/tactical/062-claude-additional-models.md).

## Implementation contract

- Previous models are individual, default-off choices in Providers > Claude,
  not members of the default curated catalog.
- The maintained server-owned registry contains `claude-fable-5`,
  `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-opus-4-6`,
  and `claude-sonnet-4-6`. It intentionally omits Opus 4.7, Haiku 4.5, 4.5,
  and earlier models; the custom exact-id input still reaches them.
- Since Claude Code 2.1.283 the live catalog lists concrete previous versions
  (`claude-opus-4-8`, `claude-sonnet-5`, …) beside the aliases. The
  direct catalog treats every concrete `claude-*` row the stable aliases do
  not fold as a previous model: marked additional and hidden until opted in,
  registry or custom. A selected live row keeps its live capabilities under the
  registry's label, description and context window. The router pool picker
  receives the same marked rows and, as with its other account-catalog models,
  lists them under **Other models** without an opt-in.
  <!-- verified: Claude Code 2.1.293 / SDK 0.3.293 handshake 2026-10-08 -->
- The compact settings row opens a checklist plus an advanced custom exact-id
  input. An empty selection is the off state.
- Server settings retain the exact id, registry/custom origin, and a label
  snapshot. Registry metadata takes precedence while present.
- Removing a selected registry entry from a later release stops offering it
  for new opt-ins but preserves the saved selection as unlisted/custom. YA
  never silently deletes or remaps it.
- Enabled entries are marked and grouped as **Other models** in choosers.
  Disabling one affects future choices only; a current session or saved default
  remains legible until changed.
- Current clients offer these settings on the v0.8.0 server baseline. The
  fixed client capability gate was retired on 2026-10-28; persisted selections
  remain unchanged. The identity stays advertised for older clients.
- Provider refreshes own registry additions, deprecations, retirement, and
  remapping review. Paid model probes still require explicit approval.

## Why this doc exists

YA hardcodes a small alias list (`opus`, `sonnet`, `opus[1m]`, …) and merges in
whatever the Claude SDK handshake reports. Concrete older versions
(`claude-opus-4-6`, `claude-sonnet-4-5`, …) are neither in the alias list nor
returned by the handshake, yet they remain selectable and useful upstream. This
records what was actually measured about discovering, selecting, sizing, and
labeling those versions, so a future exposure feature starts from evidence.

Everything below was verified against CLI `claude` v2.1.175 and SDK
`@anthropic-ai/claude-agent-sdk@0.3.170` on this machine/account
(`getModelContextWindow` traced in `packages/shared/src/app-types.ts`; live
`claude -p … --model <X>` probes; the SDK `supportedModels()` handshake; and
the interactive `/model` picker). Account/CLI behavior is account- and
version-specific; probe commands are at the bottom so claims can be re-checked.

## Finding 1 — Older versions are NOT discoverable; they must be injected

The SDK `supportedModels()` handshake (what YA's probe calls — `probeModels`
at `packages/server/src/sdk/providers/claude.ts:838`, mapped at `:490`) returned
**only three alias entries** on this account:

| `value` | `displayName` | `description` |
|---|---|---|
| `default` | Default (recommended) | Sonnet 4.6 · Efficient for routine tasks |
| `opus` | Opus | Opus 4.8 · Best for everyday, complex tasks · ~2× usage vs Sonnet |
| `haiku` | Haiku | Haiku 4.5 · Fastest for quick answers |

No `sonnet`, no `[1m]` variants, no `fable`, and **no concrete versions** like
`claude-opus-4-6`. The interactive CLI `/model` picker shows a *different,
larger* set — Default (Sonnet 4.6), Sonnet, Opus (4.8), Haiku, and **Fable
(disabled)** — and explicitly states:

> "For other/previous model names, specify with `--model`."

So three lists are in play and none contains older versions:

- **SDK handshake** ⊂ **CLI `/model` picker** ⊂ "anything `--model` accepts".
- Older/previous versions live only in that third tier — reachable by passing
  the concrete id, never surfaced by discovery.

This is why `CLAUDE_MODELS_FALLBACK`
(`packages/server/src/sdk/providers/claude.ts:380`) is load-bearing rather than
a mere offline fallback: `mergeClaudeModels` (`:505`) unions it with the probe,
so the aliases YA shows (`sonnet`, `sonnet[1m]`, `opus[1m]`, `fable`,
`opusplan`, `best`) are mostly added back *by YA*, not the SDK. **Exposing
older concrete versions is the same kind of injection** — add entries the
discovery path will never produce.

## Finding 2 — A concrete id already flows through; the CLI honors most, resolves some, gates others

The model id is a free string: client `NewSessionForm` `selectedModel`
(`packages/client/src/components/NewSessionForm.tsx:375`, picked via
`availableModels.find` at `:525`) → server → SDK `query({ options: { model }})`
and mid-session `setModel` (`Process.setModel`,
`packages/server/src/supervisor/Process.ts:1242`; route
`POST /api/processes/:processId/model`,
`packages/server/src/routes/processes.ts:372`). Nothing validates the string
against the offered list, so an arbitrary concrete id can be sent **today**.

What the CLI does with each (tiny-prompt `--model` probes, reading
`modelUsage[model].contextWindow` and the resolved key):

| Requested `--model` | resolved model key | contextWindow | disposition |
|---|---|---|---|
| `claude-opus-4-7` | `claude-opus-4-7` | 1,000,000 | honored, auto-1M |
| `claude-opus-4-6` | `claude-opus-4-6` | 200,000 | honored, 200K default |
| `claude-opus-4-5` | `claude-opus-4-5` | 200,000 | honored, 200K |
| `claude-sonnet-4-6` | `claude-sonnet-4-6` | 200,000 | honored, 200K default |
| `claude-sonnet-4-5` | `claude-sonnet-4-5` | 200,000 | honored, 200K |
| `claude-opus-4-1` | **`claude-opus-4-8`** | 1,000,000 | **silently resolved up** (per [claude-1m-context](claude-1m-context.md)) |
| `claude-fable-5` | — | — | **error**: "may not exist or you may not have access" |

Three behaviors, all account/version specific:

1. **Honored as distinct** — opus 4.5–4.7 and sonnet 4.5/4.6 each run under
   their own id and report their own window. These are the real "older models"
   to expose.
2. **Silently resolved up** — `claude-opus-4-1` becomes `claude-opus-4-8`. The
   transcript then says opus-4-8 (1M) even though the user asked for 4-1. The
   boundary observed here is opus-4-5-and-newer honored, 4-1/4-0-and-older
   resolved; do not assume an arbitrary legacy id stays itself.
3. **Account-gated** — `claude-fable-5` errors here (the `/model` picker shows
   it "(disabled)" / "currently unavailable"). The SDK returns an `is_error`
   result with that text, *not* a thrown exception — any exposure UI must
   surface that gracefully. `fable` already ships in YA's fallback, so this
   gating risk exists in the product right now, not just for older models.

## Finding 3 — The static window map is already correct for the older 200K models, and wrong only for the auto-1M latest ones

`getModelContextWindow` (`packages/shared/src/app-types.ts:247`) parses
`claude-{family}-{version}` down to the **family** and looks up the family
window (`MODEL_CONTEXT_WINDOWS`, `:212`), losing the version. The only 1M signal
it reads is a literal `[1m]` substring (`:259`). Replicating the exact regex:

| model id | CLI actual window | `getModelContextWindow` | correct? |
|---|---|---|---|
| `claude-opus-4-8` | 1,000,000 | 200,000 | ✗ understates |
| `claude-opus-4-7` | 1,000,000 | 200,000 | ✗ understates |
| `claude-opus-4-6` | 200,000 (default) | 200,000 | ✓ (✗ if run `[1m]`) |
| `claude-opus-4-6[1m]` | 1M-capable (CLI `KF`); may be credit-gated | 1,000,000 | ~✓ where account allows |
| `claude-opus-4-5` | 200,000 | 200,000 | ✓ |
| `claude-opus-4-1` | 1,000,000 (resolved→4-8) | 200,000 | ✗ understates |
| `claude-sonnet-4-6` | 200,000 (default) | 200,000 | ✓ |
| `claude-sonnet-4-5` | 200,000 | 200,000 | ✓ |
| `claude-fable-5` | 1,000,000 (where available) | 1,000,000 | ✓ |

The reconciliation that matters: **the static map is already right for every
older model we'd actually expose** (opus-4-6 at its 200K default, opus-4-5,
sonnet-4-5, sonnet-4-6). The wrongness is concentrated in the **auto-1M latest
models** (`gy()` upgrades opus-4-7/4-8 — see
[claude-1m-context](claude-1m-context.md)), which YA already exposes via the
`opus`/`default` aliases, plus the resolved-up `opus-4-1` case. So exposing
older 200K versions does **not** introduce new static-window error.

Caveat — note the API/CLI split. The Models-API capability for opus-4-6 and
sonnet-4-6 is 1M (`max_input_tokens`), but Claude Code only *provisions* 1M for
the `gy()` auto set (fable/mythos/opus-4-7/opus-4-8) or when `[1m]`/beta is
requested on a `KF`-capable model. "Capable of 1M" (API) ≠ "runs at 1M" (CLI
default). The window to trust is always the SDK-reported one, never the id.

The robust answer is therefore the one already open in
[claude-1m-context](claude-1m-context.md): **don't hardcode — persist the
SDK-reported per-session window** (tracking mid-session model changes), and keep
the static map only as a cold-start guess. Exposing older models does not change
that conclusion; it raises the stakes (next section).

## Finding 4 — Exposure UX: keep older models out of the default picker

Mirror the CLI's own posture. Its picker is the curated latest set; older names
require `--model`; opus-4-6/4-7 are tagged internally as "Legacy … previous
Opus version" (per [claude-1m-context](claude-1m-context.md)). Recommendation:

- Default `getAvailableModels()` list stays the curated aliases (latest-first).
- Concrete legacy versions appear only behind an opt-in: a developer-mode /
  settings toggle, an "advanced / older models" expander, or a free-text
  "specify model id" field. The plumbing already accepts an arbitrary id
  (Finding 2), so this is a surfacing decision, not new transport.
- Label them as legacy and carry a per-entry window that comes from the live
  SDK value when known, falling back to the static map (right for these, per
  Finding 3) otherwise.
- Handle the account-gated `is_error` launch result (Finding 2) as a first-class
  "model unavailable on this account" state, not a generic failure — `fable`
  already needs this.

## Finding 5 — Glyph/badge layer can't currently distinguish 1M from 200K for concrete ids

`modelIndicatorText.ts` rules are keyed by alias substrings; the generic
`{ patterns: ["opus"], glyph: "◐" }` rule matches any `claude-opus-*`, and only
the explicit `opus[1m]`/`sonnet[1m]` aliases get a `1m` suffix. So a 1M
`claude-opus-4-7` and a 200K `claude-opus-4-6` would render with the same badge
and no window cue. If exposure should communicate the window, the suffix must be
driven by the *resolved/SDK-reported window*, not parsed from the id (the id
omits `[1m]` even when running 1M — see [claude-1m-context](claude-1m-context.md)).
See [provider-model-glyphs](provider-model-glyphs.md) for the badge contract.

## Finding 6 — Window persistence prerequisite is satisfied

Exposing more models multiplies the window-mapping surface — more
`ModelInfoService` keys to warm (`packages/server/src/services/ModelInfoService.ts:67`,
model-keyed and in-memory only), more idle/cold-cache reads falling back to the
static map, and more chances for the known reporting bugs to show
(metadata-vs-detail endpoint disagreement, unclamped >100% surfaces; all
catalogued in [claude-1m-context](claude-1m-context.md)). The auto-1M latest
models are where the static map is wrong, so the more a user flips between
models, the more often a wrong cold-cache window appears.

The per-session SDK-window persistence work from
[claude-1m-context](claude-1m-context.md) landed before this feature. The live
window is persisted and tracks mid-session `setModel` changes, so catalog
exposure does not add a new static-window ownership path.

## Remaining operational questions

- Exact account/version boundary for "honored vs resolved-up" concrete ids
  (here: opus-4-5+ honored, opus-4-1/4-0 resolved). Worth a periodic re-probe
  under [provider-refresh](provider-refresh.md).
- Whether `claude-opus-4-6[1m]` (and `sonnet-4-x[1m]`) actually provision 1M on
  this account or credit-gate like `sonnet[1m]` did (429 in
  [claude-1m-context](claude-1m-context.md)). Not re-probed here.
- Which currently accepted concrete ids should remain in the maintained
  registry as upstream lifecycle status changes. This is decided during each
  provider refresh rather than by a permanent historical cutoff.

## How to re-check

```bash
# What the SDK handshake actually offers (subset of the /model picker):
#   node a small script calling query(...).supportedModels() from packages/server,
#   or read the merged list the client receives:
curl -sk https://localhost:3400/api/providers | \
  python3 -c 'import json,sys;[print(p["name"], [m["id"] for m in p.get("models",[])]) for p in json.load(sys.stdin).get("providers",[])]'

# Window + resolved id the CLI provisions for a concrete legacy id (account-specific):
for m in claude-opus-4-7 claude-opus-4-6 claude-opus-4-5 claude-sonnet-4-5; do
  claude -p "say ok" --output-format json --model "$m" | python3 -c \
   'import json,sys;d=json.load(sys.stdin);mu=d.get("modelUsage") or {};print({k:v.get("contextWindow") for k,v in mu.items()}, "err" if d.get("is_error") else "")'
done
```

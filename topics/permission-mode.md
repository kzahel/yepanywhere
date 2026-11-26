# Permission Mode

> Permission mode is YA's per-session approval policy: a saved standing
> preference is provider-independent, while each selected model's capabilities
> determine which modes can be used for a particular launch or live session.

Topic: permission-mode

See also:

- [session-defaults](session-defaults.md) — why permission mode lives with
  all-provider session defaults rather than provider/model economics.
- [codex-permission-mode](codex-permission-mode.md) — Codex's coupled approval
  and native-sandbox mapping and live turn boundary.
- [session-sandboxing](session-sandboxing.md) — the independent optional outer
  filesystem boundary.

## Auto mode and provider capability

`Auto` means provider-decided approval: the provider/model classifies each
permission prompt and may approve it or ask the user. In current YA code this
is exposed through model metadata, `ModelInfo.supportsAutoMode`, which Claude
and Antigravity populate today. Within Claude, support is model-specific: live
Claude SDK metadata or YA's fallback catalog must mark a model with
`supportsAutoMode: true` before the UI offers `Auto` for that selected model.
Antigravity marks every model when its runtime offers the native `auto` session
mode (`agy` 1.5.18 does; see [Antigravity](antigravity.md)).

This makes the user's observation accurate with one precise wording: choosing
`Auto` is an all-provider standing preference, not a provider-scoped default,
but a selected model that lacks `supportsAutoMode` must resolve that preference
to `Ask` (`default`) for display and launch. Switching from a Claude model that
supports `Auto` to Codex, Grok, or a Claude model that lacks the flag should
therefore show `Ask` as the effective selection while preserving the saved
preference as `Auto`.

The fallback is sensible because `Auto` is not "never ask". It means the
provider decides whether to ask on each permission request. A provider/model
without that classifier cannot faithfully run `Auto`; the conservative
equivalent is `Ask`, not `Bypass` and not a hidden provider-specific setting.

## Storage and launch rules

- Store `permissionMode` once in `newSessionDefaults`; do not add provider-keyed
  permission defaults merely because `Auto` is currently Claude-only.
- Filter the visible/effective mode by the selected model's capability. If the
  saved value is unsupported, render/use `default` (`Ask`) for that selection.
- Preserve the raw saved value across provider/model switches. A provider switch
  may change the effective selection, but it must not rewrite `Auto` to `Ask`
  unless the user explicitly chooses `Ask`.
- New-session launch must send only a mode the selected provider/model can
  honor. For unsupported `Auto`, send `default`.

## Provider Adapter Invariants

- A provider adapter must translate the effective YA mode into every
  provider-native field needed to preserve its meaning. If approval and
  confinement are separate native fields, they must be updated atomically.
- A live mode change has two application clocks. Provider-native policy changes
  use the provider's next-turn boundary and must not be forced into an active
  turn whose sandbox or approval policy cannot change in-flight. YA's approval
  bridge follows the selected standing mode immediately. Every input enters
  the provider's queue carrying a mode: its own, or else the standing mode
  when it was queued, so an adapter applying a mode per turn reads it from
  the input rather than from its launch options.
- While a turn is active, the UI must distinguish its current effective mode
  from a different mode selected for the next turn.
- Selecting `Accept edits` immediately allows pending and newly arriving Edit,
  Write, and NotebookEdit permission requests. Selecting `Bypass` immediately
  allows every pending and newly arriving permission request. Provider
  interviews, choices, and questions still require the user's answer in every
  mode.
- Approval callbacks may retain the request turn's provider-native mode for
  diagnostics, but YA's decision must use the current selected standing mode,
  not a launch-time or turn-frozen mode captured by a long-lived provider
  process.
- Plan completion follows the standing permission choice. In `Bypass`,
  `ExitPlanMode` is already authorized and must complete without a prompt or a
  transition to `Edit`; `AskUserQuestion` still surfaces because it requires the
  user's answer. An explicitly selected `Plan` mode still prompts for plan
  approval.
- Tightening a mode is never less important than loosening it. A UI that says
  Ask must not leave the next turn running under a sticky Bypass policy.

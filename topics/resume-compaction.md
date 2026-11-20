# Resume Compaction

> Resume compaction is YA's provider-neutral compact-before-resume
> contract for old or context-heavy sessions, preserving the same
> provider session when upstream supports it instead of silently starting
> a YA handoff.

Topic: resume-compaction

Related topics: [claude](claude.md),
[session-context-actions](session-context-actions.md),
[compact-and-handoff](compact-and-handoff.md),
[provider-refresh](provider-refresh.md),
[provider-state-machine](provider-state-machine.md),
[session-liveness](session-liveness.md),
[cost-efficiency](cost-efficiency.md),
[injected-message-visibility](injected-message-visibility.md)

## Motivation

Claude TUI exposes a useful old-session choice: resume the full long
session, or resume from a provider-created summary when the transcript is
large enough that full resume may consume substantial budget. YA currently
does not model that choice directly. In old or disconnected Claude sessions,
the user can instead see a new-session or handoff-shaped dialog even when
the desired behavior is still same-session continuation after compaction.

This concern is initiation and control. YA already has credible read/render
support once compaction boundaries exist.

## Current Ground Truth

As of 2026-06-08, checked evidence supports these starting assumptions:

- Claude transcript `compact_boundary` messages already preserve DAG
  continuity and context-usage accounting in YA's reader/render path.
- Codex app-server `compaction` / `context_compaction` items already
  normalize into the same visible system boundary.
- The shared provider interface has no explicit `compact()` method.
  Existing generic control is slash-command discovery plus sending a
  prompt such as `/compact` when the provider advertises it.
- The Claude Agent SDK documents `/compact` as a slash command, session
  resume through a provider resume id, `system` compact boundary messages,
  and failure cases when the conversation is already too full to compact.
- The user has observed at least one YA-visible compaction attempt fail with
  a "context too full" style error. That supports treating compaction as
  constrained by provider context limits, not as an unlimited external
  summarization service.
- OpenAI documents `POST /v1/responses/compact`. The pinned Codex app-server
  protocol also exposes `thread/compact/start`; YA uses that provider-native
  request when it must initiate a manual Codex compact and continues to
  normalize the resulting compaction item into the shared visible boundary.

Evidence anchors:

- Claude commands: <https://code.claude.com/docs/en/commands>
- Claude Agent SDK sessions:
  <https://code.claude.com/docs/en/agent-sdk/sessions>
- Claude errors: <https://code.claude.com/docs/en/errors>
- OpenAI Responses compact:
  <https://platform.openai.com/docs/api-reference/responses/compact?api-mode=responses>

Do not infer from the Claude TUI wording or the "context too full" failure
that Anthropic uses the same model, a cheaper model, a special atomic
"resume from summary" SDK call, or a budget-free operation. Treat the
cheaper path as a user-visible cost/context tradeoff until upstream
documents a stronger claim.

## Product Contract

When a stopped provider session is old or context-heavy and the provider
can safely compact before the next user turn, YA should offer an explicit
choice:

- Full resume: keep today's semantics and ask the provider to load the
  full conversation history.
- Compact then resume: resume the same provider session, run provider
  compaction first, and submit the user's queued turn only after a compact
  boundary or equivalent success signal arrives. The same order applies when
  a stopped session waits in the server's worker queue.
- Handoff/new session: remain an explicit fallback for providers or states
  that cannot compact the same provider session safely.

The YA URL session id remains canonical. Provider-native ids may be used as
resume handles, but compact-first resume must not silently replace the
YA-visible session id in URLs, persisted metadata, REST or WebSocket
payloads, or UI copy.

Compaction is a bounded user-initiated operation. It may take minutes on a
large transcript, may spend provider budget, and may fail if the upstream
conversation is already too full. YA should show progress and preserve the
provider state-machine rules while it is running instead of presenting the
session as idle.

## Implementation Gates

Gate 0, evidence refresh: Before code changes, re-check current Claude SDK
types/docs, OpenAI compact docs, and the local Codex protocol surfaces. The
known path may have moved, and provider-refresh rules require YA-facing
assumptions to be verified against the current upstream.

Gate 1, read/render audit: Confirm existing compact boundary rendering and
history continuity still work for Claude and Codex. In particular, parse
both persisted camel-case and current SDK snake-case Claude compact metadata
if both shapes can appear in local transcripts. Keep
`local_command_output` display separate from the actual compaction boundary.

Gate 2, provider contract: Add a first-class resume mode or capability
surface before wiring UI. A conservative starting shape is a provider
capability such as `compactBeforeResume` plus a resume option like
`resumeMode: "full" | "compact-first"`. Do not add a generic `compact()`
method unless at least one provider implementation has a real callable
operation and the failure semantics are specified.

Gate 3, Claude same-session prototype: For compact-first resume, start or
resume the same Claude provider session, send the native `/compact` command
only when advertised, wait for `compact_boundary` or an equivalent compact
success status, then submit the user's turn in the same provider process.
On failure, timeout, or unsupported command, surface a controlled decision
instead of silently falling back to handoff.

Gate 4, old-session UI choice: When YA detects a stopped old or
context-heavy session and the provider supports compact-first resume, show
the user a clear choice before the next turn is attempted. Copy should say
that full resume may consume more context/budget, compact-first summarizes
older context and can fail, and handoff starts a replacement session.

Gate 5, Codex initiation probe: Treat Codex as a separate provider-specific
gate. YA currently observes Codex compaction items; initiating compaction
requires selecting an upstream mechanism, reviewing credential and cost
behavior, and adding tests around local app-server or API protocol drift.

Gate 6, rollout and verification: Keep the feature prompt-gated or
configuration-gated until Claude same-session resume, failure handling,
queue ordering, and UI state have tests. Log enough provider-phase detail
to debug slow compactions without dumping transcript content.

## Failure Posture

If provider compaction fails because the conversation is too full, offer a
full resume or explicit handoff; do not retry compaction in a loop.

That failure mode is evidence about provider constraints, not a license to
invent a separate YA-side summarizer as a silent fallback. A separate
summarizer would be a different feature with its own model, privacy, cost,
and quality contract.

If the provider does not advertise a compaction command or callable compact
surface, keep the current full-resume or handoff behavior and explain the
missing provider capability in debug surfaces.

If no client is actively requesting the resume, do not start background
compaction. A closed tab or idle provider session must not indefinitely
consume server resources.

If the provider documents a model choice for compaction, model it
explicitly. Otherwise do not silently switch to a different or allegedly
cheaper model on the user's behalf.

## Test Plan

- Provider-interface unit tests for `full` versus `compact-first` resume
  mode selection and unsupported-provider failure.
- Claude fake-provider tests where `/compact` emits compacting status,
  a compact boundary, and then accepts the queued user turn in the same
  resumed session.
- Claude failure tests for command-not-advertised, compact timeout, and
  upstream compact failure.
- Reader tests that preserve continuity and metadata for both old persisted
  and current SDK compact boundary shapes.
- Client tests for the old-session choice and busy/progress state.
- Codex regression tests proving existing compaction item normalization
  remains intact before any Codex initiation work is added.

## Live threshold trigger (task 029)

Distinct from resume-time compact-first above: a **live, in-session**
preemptive compaction, configured per model as "compact at X% of that model's
full context window" (`clientDefaults.compactAtContextPercent[model]`). The
percentage is an explicit user hint, not a YA recommendation: performance
degradation at long context and the quality cost of compacting earlier are both
task-specific empirical questions. With no value, YA makes no threshold request
and leaves the provider's automatic behavior unchanged.

The provider capability determines who owns timing:

- A provider with `supportsNativeCompactThreshold` receives the derived integer
  token limit. Codex expresses it in `thread/start` or `thread/resume` config as
  `model_auto_compact_token_limit`, paired with
  `model_auto_compact_token_limit_scope: "total"`. Both keys are absent when
  the setting is off. Because Codex's live `thread/settings/update` request does
  not carry config overrides, a changed or cleared threshold resumes the same
  thread with the new launch config before delivering the turn.
- Providers without that capability retain YA orchestration. YA checks live
  usage at the first idle boundary after assistant output and immediately calls
  the provider's manual compact command. The same path is forced for any
  provider by the global, default-off
  `clientDefaults.forceYaOrchestratedCompaction` setting. Codex dispatches that
  command out of band as `thread/compact/start`; Claude receives its hidden
  `/compact` turn.

The YA path reuses `Supervisor.tryResumeCompaction`, so it drives the native
compaction boundary (same result + render contract), and an injected textual
`/compact` carries no user echo (`metadata.hidden`; see
[injected-message-visibility](injected-message-visibility.md)). The pure
decision is `crossesCompactThreshold(percent, contextWindow, inputTokens)`;
the orchestration is `Supervisor.maybeCompactAfterIdle`, called once when a
completed assistant turn makes the process idle.

User-visible context usage is always the provider-reported total. YA does not
add `compactMetadata.preTokens` or another inferred amount to the meter. Only
the YA-orchestrated manual-compaction check requests a conservative internal
reading: for Claude transcripts, it may add the positive difference between a
boundary's `preTokens` and the preceding reported total. This preserves the
gateway/OpenAI-model safety heuristic without presenting the estimate as
provider usage. Provider-native compaction receives no such adjustment.

Design intent and invariants:

- **Voluntary, momentum-preserving.** It is a "do it when the user won't be
  bothered" compaction, not a needed one. It starts speculatively at the first
  idle boundary after assistant output, so a later user request does not pay
  compaction latency. Delivery intent is recorded before any asynchronous
  slash-command discovery; if new input arrives during the usage read or
  compact-command lookup, that input wins and the speculative compact is
  skipped even if the process still formally reports `idle`.
- **Harness-enforced compaction is untouched and remains the backstop.** This
  trigger is purely *earlier and additive*; nothing about the harness's own
  auto-compaction changed. When the setting is off, provider behavior is
  exactly the provider default.
- **No double compaction.** Each assistant-output version is considered once,
  and one attempt at a time: a second threshold compaction never starts for a
  process while an earlier one is still waiting on the provider. The compact
  operation's own idle boundary cannot recursively trigger another compact even
  if the durable usage summary has not caught up.
- **Context size after a compaction is unknown until the next real turn.** The
  durable usage summary keeps reporting the pre-compaction token count until a
  turn is recorded under the rewritten context, so a settled compaction latches
  the threshold check off until the assistant-output version advances past it.
  Reading the stale total back and acting on it is what produced the 2026-09-10
  storm: roughly three thousand `/compact` turns in fourteen minutes, each
  answered "Not enough messages to compact."
- **A slash command's own output is not agent activity.** Claude Code answers
  every slash command with an assistant-shaped echo carrying the command's
  output (`model: "<synthetic>"`, `is_meta`, `local_command_source`);
  `isLocalCommandEchoTurn` in the shared SDK guards identifies it. No model
  produced it and no context was added, so it advances neither the
  assistant-activity counter nor the recap buffer. Counting it re-armed the
  once-per-turn gate on every no-op compact, which is what let the loop run.
- **Conservative YA fallback (task 002).** Idle only, only when usage is known,
  and best-effort: the turn is delivered regardless of the compaction outcome,
  with no retry loop; failure is logged, never blocks the turn.

Scope boundary: the trigger belongs to the process idle transition, not a REST
route. Deferred turns promoted at that same boundary still take precedence:
`Process` promotes eligible deferred work before publishing idle, so YA never
starts speculative compaction in front of an already-queued turn.

The idle timing deliberately leaves a theoretical compute saving unimplemented:
YA does not wait for composer activity or other evidence that another user turn
is coming. The simpler unconditional idle check minimizes user-facing latency;
an occasional compact after the user was actually finished is acceptable.

## Claude global automatic threshold override

Claude Code's `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is a third, distinct facility.
It is not the per-model percentage of full context above and it does not issue
an immediate `/compact`. It changes the percentage of **Claude Code's own
auto-compaction window** at which Claude may compact proactively:

- YA stores one global, optional
  `claudeAutoCompactPercentOverride` provider setting. There is no per-session
  or new-session override.
- Claude advertises `supportsLaunchCompactPercentOverride`; Claude Gateway and
  Claude + Ollama do not. The Providers UI is hidden when an older server's
  provider response lacks the capability, so that client makes no unsupported
  settings write.
- A value from 1 through 100 is passed to every regular Claude create/resume as
  the exact decimal environment value
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<percent>`. Off is canonical omission: YA
  does not set the variable and preserves any operator-owned ambient
  environment/default.
- The override can only lower Claude's default. Values above the effective
  default have no effect, and the variable only takes effect in the Claude Code
  cases where proactive auto-compaction is active. For the plain Claude
  provider YA does not set `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; therefore this
  option does not redefine Claude's effective window or the status line's
  full-context `used_percentage`. Claude Gateway is the one exception, below.

## Claude Gateway runtime context and compaction windows

Claude Code cannot discover a proxied model's context limits through an
Anthropic-compatible gateway. The gateway's `/v1/models` catalog is therefore
the authority, but it describes two different limits:

- `max_context_window_tokens` is the total prompt-plus-output envelope.
- `max_prompt_tokens`, when present, is the prompt-only ceiling inside that
  envelope.

Claude Code 2.1.223 resolves two independent launch controls. For a gateway
model whose normalized ID does not begin `claude-`,
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` sets the effective model envelope used by
local request-size checks, usage reporting, and context status.
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` only bounds Claude Code's automatic
compaction operating window; setting it alone does not enlarge the effective
model envelope. The environment value has precedence over the corresponding
settings/client/experiment/default sources and is still capped to the
separately resolved maximum. Claude Code then reserves output capacity inside
that automatic window before deciding when to compact.

`ClaudeGatewayProvider` retains catalog membership independently of optional
window metadata and derives each create/resume launch from the last successful
catalog read:

- A launch before any successful catalog read, without a selected model, or for
  a model absent from that catalog sets no context-policy variables. It does not
  infer limits from an earlier gateway or from Claude Code defaults.
- A catalog-known model with a usable total limit receives
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`; its prompt ceiling becomes
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` when Claude Code can express it. The total
  is rounded to a positive integer without a 1M cap. The automatic window never
  exceeds the total, is capped at 1M, and is omitted below Claude Code's 100K
  minimum rather than rounded above an advertised hard limit.
- A catalog-known model without a usable total limit receives only
  `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`. YA does not invent
  a fallback capacity. For models Claude Code considers unknown, the opt-out
  changes the automatic-window source from `unknown-model` to `auto`, restoring
  reactive wait-for-the-API handling where the runtime supports it. It does not
  change the numeric maximum or `modelUsage.contextWindow`.
- The default Copilot catalog for `gpt-5.6-sol` therefore launches with a
  400,000-token effective envelope and a 272,000-token prompt/automatic window.
  If that catalog later advertises the 1,050,000/922,000 long tier, the same
  mapping preserves those distinct limits.

A gateway ID is not unknown merely because it came through a custom base URL.
Claude Code first canonicalizes the ID against its built-in registry and model
overrides. YA deliberately does not duplicate that private recognition logic:
the metadata-less opt-out affects only models Claude Code itself classifies as
unknown and is inert for recognized rows.

The distinction was diagnosed 2026-08-05 from a wedged `gpt-5.6-sol` session:
context climbed to 200,935 tokens with no compaction in its transcript, and the
next request failed synthetically as "Prompt is too long" before reaching the
gateway. The earlier automatic-window-only mapping still left Claude Code's
effective gateway envelope at 200K. YA's optional early-compaction threshold
could not have covered that turn because it fires only at an idle boundary.

Runtime acceptance on 2026-08-06 used the SDK-bundled Claude Code 2.1.223 and
the live gateway. The init and assistant records both selected `gpt-5.6-sol`,
the result reported a 400,000-token `modelUsage.contextWindow`, and one request
succeeded with 205,104 active input/cache tokens without a local synthetic
prompt-too-long failure or compaction event. This crosses the former 200K
runtime boundary while remaining below the catalog's 272K prompt ceiling. An
earlier 2.1.220 session had also carried a 231,052-token input/cache prefix;
the 2.1.223 result confirms the package/runtime refresh did not regress the
corrected two-window mapping.

The metadata-less opt-out is source- and launch-policy-verified rather than a
claim about a guessed numeric capacity. A disposable opaque-model adapter could
not isolate its enforcement branch because the compatible endpoint revealed a
400,000-token runtime window after the request, with or without the opt-out.
YA therefore continues to emit no numeric limit for that state; the next real
metadata-less endpoint remains a useful runtime recheck.

A remaining Claude Code limitation applies when a gateway model ID normalizes
to `claude-*`: the ordinary resolver ignores
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` behind a custom base URL and normally uses its
built-in maximum unless a recognized extended-context mechanism applies. Do
not claim that a Copilot `claude-opus-5` long tier is effective merely because
the gateway catalog advertises it or YA supplied the generic override; that
path still needs its own verified mapping.

YA uses the SDK-bundled executable before a standalone `claude` on `PATH`, so
the 2.1.223 behavior requires Agent SDK 0.3.223 in ordinary launches. Anthropic
documents manual `/compact`, but no interactive SDK/command setter for these
launch-scoped controls. A gateway catalog change takes effect on a new or
restarted/resumed process; active steering never interrupts a turn to change
the current process environment.

Anthropic documents that the environment override applies to main
conversations and subagents. Its applicability is provider behavior, not a YA
promise that every Claude model/session compacts proactively:

- Claude environment variables:
  <https://code.claude.com/docs/en/env-vars>
- Claude Agent SDK slash commands:
  <https://code.claude.com/docs/en/agent-sdk/slash-commands>

Compatibility corpus checked 2026-07-31 for this optional setting: stable
server releases `v0.7.0` and `v0.6.2` lack both
`settings.claudeAutoCompactPercentOverride` and
`providers[].supportsLaunchCompactPercentOverride`. The absent-capability
fallback above makes no unsupported request and preserves all existing
provider-capability meanings.

## Open Questions

- Does Claude TUI use only the documented slash command path, or does it
  have an additional internal resume-from-summary affordance? YA should not
  depend on an undocumented answer.
- Which signal should trigger the prompt: elapsed inactivity, transcript
  token count, provider resume failure, or a combination? The first rollout
  should prefer explicit user choice over fragile prediction.
- Should compact-first resume be available from the ordinary stopped-session
  composer, the restart/handoff dialog, or both? The provider contract
  should be decided before UI copy spreads.

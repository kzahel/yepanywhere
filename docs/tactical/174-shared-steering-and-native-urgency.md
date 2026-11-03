# Shared steering and native urgency

Status: implemented, standalone experiments and final validation complete,
2026-11-03. Implementation: `4dcf2a45b`.

## Outcome

Use Claude and Codex steering as the first concrete provider-consolidation
slice. The UI expresses delivery intent through shared controls; adapters own
native translation and capability facts. Preserve regular/patient queue policy,
existing defaults, exact input identity and uncertain-delivery protections.
Expose an opt-in native Codex immediate-steering trial without pretending its
launch-scoped feature is a per-message selector. Do not restart an active owner
or emulate this with hard-interrupt-and-resend.

The maintainer explicitly authorized real Claude/Codex runs in standalone
profiles and an audit/experiment of Pi, Antigravity and other retained providers.
Do not turn that audit into mandatory all-provider implementation. Preserve
concurrent Antigravity work and unrelated edits in the shared checkout.

Related contracts: [provider abstraction](../../topics/provider-abstraction.md),
[delivery intent](../../topics/message-control-steer-queue-btw-later-interrupt.md),
[provider differences](../../topics/steer-queue-provider-differences.md),
[cache accounting](../../topics/cache-miss-accounting.md),
[provider ownership](../../topics/provider-host-api.md), and
[version support](../../topics/provider-version-support.md).
This follows completed [queued compaction](173-queued-compact-delivery.md),
not the archived general core program. Existing receipt and provider-identity
work remains authoritative; no replacement conversation store or runtime.

## 1 — define steering intent and provider translation

Represent gentle/immediate support and selection scope as provider capability
facts. Reuse the current Steer/Now UI and server-side delivery metadata.
Move Claude priority translation out of generic Process policy into the adapter
boundary. Keep the single provider queue and its exact consumption observations;
retain cancellation, interruption, regular/patient and queued-compact behavior.
Avoid a provider superclass or parallel submission scheduler.

## 2 — expose the native Codex experiment

Add a capability-gated shared steering settings surface for launch-scoped
providers. Codex gentle remains the YA default; immediate is explicit opt-in.
Honor explicit native configuration and describe its precedence. Apply settings
only to newly started provider owners, including workers; existing owners keep
their launch facts. Report the configured mode/source honestly, including when
native configuration prevents YA from establishing the effective value.
Do not advertise per-message urgency for Codex or silently restart/fork a turn.

Review the supported stable-server corpus before contract edits. Older servers
receive no new setting/control requests. Preserve current Claude Now defaults,
provider-native APIs, stable capability IDs and the pinned Codex target.

## 3 — verify the contract and compare real behavior

Use owned standalone YA profiles, private provider roots and separately
identified test Chromium. Cover native launch arguments and configuration
precedence, worker snapshots, unchanged live owners, no duplicate input,
gentle versus immediate behavior and shared UI controls. Run sequential typing
under concurrent updates and representative history. Capture desktop/phone
through the repository facility and keep any unrelated layout finding separate.

Run controlled actual CLI/SDK experiments before paid/live comparisons. Then
use authorized owned Claude/Codex sessions with warm context and a comparable
held or long-generation task. Distinguish accepted input, observed consumption,
interrupted output, next response and final tool effect. Compare reported
cached/uncached input, output, timing and discarded-generation evidence.
Do not infer a cache flush from interruption, or zero cost from absent usage.
Interrupted-response usage may be incomplete; record that limit.

Audit Pi, Grok and the concurrently developed Antigravity adapter against native
protocols. Record which semantics are actually supported and their scope;
incorporate an adapter only when its real contract fits without extra policy.
Use no production profile, primary browser, global config rewrite or hidden
provider upgrade. Reap owned processes and revoke temporary account grants.

## 4 — finish the slice

Update owning topic contracts and roadmap, retain useful interaction/race
coverage, run required lint/format/type/workspace and focused browser checks,
and commit task-owned changes separately from concurrent work. Record measured
results, unsupported provider/platform cells and remaining follow-ups here.

## Selected compatibility and UI contract

The November 3 core stable corpus is 0.8.1, 0.9.0, 0.9.1, 0.9.2,
0.10.0, 0.10.1, 0.10.2 and 0.11.0. The optional-feature corpus is
0.10.0, 0.10.1, 0.10.2 and 0.11.0. None provides the new launch-mode
setting. New capability 149, `provider-steering-modes`, gates the settings
surface and its writes. Existing `supportsSteerNow` semantics are not broadened.
Older servers keep their existing controls and receive no new settings write,
including through Undo. New provider metadata describes modes and selection
scope; the UI has no Claude/Codex protocol switch.

`steeringModes` stores qualified launch-scoped provider choices; Codex is the
initial implementation. Gentle is the absent-setting default, immediate is
explicit opt-in, and a native configuration mentioning `instant_interrupt`
continues to win. When that configuration is opaque to YA, report native-config
rather than inventing its value. Settings shows running owners' captured modes.
Owner init and attach evidence preserve those facts across Hono replacement.
Claude keeps per-message Now selection and native priority translation moves
into its queue ingress, before native input batching.

The first live comparison warms synthetic context in owned Claude/Codex
sessions, starts a long numbered response, then sends one correction during
visible generation. It compares gentle/immediate completion, observed partial
output, elapsed time and reported usage. This controlled task tests generation
interruption rather than claiming every running-tool behavior or a universal
cache effect. Private raw results stay in ignored `tasks/steering-unification/`.

## Standalone experiment results — November 3

Real Claude Code 2.1.312 (`claude-haiku-5-5`) and Codex CLI 0.165.0
(`gpt-6.1-sol`) used owned YA profiles, private HOME/provider roots and
temporary AAR grants revoked during teardown. No native upgrade or primary
profile was used. Controlled app-server tests use the pinned 0.166 protocol.
Each trial read synthetic context, generated 180 numbered lines, then received
one correction after raw text deltas exceeded 120 characters. Session live
subscriptions were active, including Codex's delta opt-in. Warm-up, generation
and correction retained the same owner. Timing is correction submission to
observed idle with the acknowledgement, including persistence/polling overhead.

| Provider | Mode | Text observed before correction | Correction to idle | Outcome |
|---|---|---:|---:|---|
| Claude | Gentle | 201 chars | 10.134 s | Finished 180 lines, then correction |
| Claude | Immediate | 137 chars | 0.813 s | Partial response marked aborted, then correction |
| Codex | Gentle | 157 chars | 21.583 s | Finished 180 lines, then correction |
| Codex | Immediate | 149 chars | 3.787 s | Partial generation discarded; final correction only in durable transcript |

One trial per cell establishes the mechanism, not a latency distribution.
These are text-generation trials, not a claim about stopping an already
executing tool. Earlier harness trials were excluded: REST history observed
output too late, then an incorrect metadata field failed to request Claude
Now. Retained raw inputs and final corrected results distinguish those runs.

Reported correction-request usage:

| Provider | Mode | Input / cache read | Cache write | Output |
|---|---|---|---:|---:|
| Claude | Gentle | 2 fresh + 20,406 read | 3,965 | 16 |
| Claude | Immediate | 2 fresh + 20,208 read | 126 | 16 |
| Codex | Gentle | 31,103 total / 9,088 cached | 0 reported | 12 |
| Codex | Immediate | 27,435 total / 9,088 cached | 0 reported | 11 |

Claude's fields separate fresh/read/write; Codex cached input is a subset of
total input, so these columns must not be summed the same way. Both providers
reported cache hits after immediate steering. This contradicts an inherent
whole-cache-flush explanation for these runs. Prefixes, generated history and
warm-up counts differ, so the figures are not a provider cost comparison.
Claude reported zero usage for its aborted generation despite visible text;
Codex repeated its previous usage before reporting the correction. Neither is
evidence of zero cost for discarded generation. Native output interruption
and prompt-cache retention are separate observations; see OpenAI's
[prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

## Other-provider audit

| Adapter | Evidence | Disposition |
|---|---|---|
| Grok | Existing `x.ai/interject` path, queued acknowledgement and native echo/attribution tests | Advertise gentle-only, per-message capability; no immediate claim or new scheduler |
| Pi | Upstream RPC `steer` / `follow_up` documented; `set_steering_mode` means all vs one-at-a-time batching, not interruption | YA remains queue-only until native input identity/consumption and cancellation are qualified; no installed Pi binary, no live model trial |
| Antigravity | Real standalone ACP initialize, version 1.4.5; advertised capabilities contain no steering extension | Keep concurrent adapter queue/cancel behavior; no model call or undocumented interrupt-and-resend emulation |
| Gemini ACP, OpenCode, Codex OSS | Retained adapters currently advertise no steering | No speculative parity controls |

Pi evidence is its primary [RPC commands](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc-commands.md)
and [RPC lifecycle](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md):
steering is consumed before the next model call after the current tool batch;
accepted/queued is distinct from consumed, and `agent_settled` is the completion
boundary. A future Pi implementation can use the shared gentle-only contract,
but enabling it is separate work. Antigravity capability absence is only an
advertisement observation, not proof that no undocumented native API exists.

## Final verification and remaining boundaries

- Root `pnpm test`: 6,925 server / 7,091 client / 950 shared cases pass;
  relay, push broker and Node harness checks also pass. Server reports 74
  skipped cases in six skipped files. The suite still emits existing negative
  fixture diagnostics documented in
  [the diagnostics gap](../../gaps/full-suite-timing-and-diagnostics.md);
  this is not a claim of warning-free output.
- Root typecheck, lint and format checks pass. Capability audit reports zero
  errors/warnings and no expired fixed-version gates.
- Controlled native tests cover launch-time capture despite a changed getter,
  both flag values, native config precedence, init mode/source, rejection of
  unsupported immediate-mode CLI versions, Claude batching/cancellation/input
  identities, and atomic settings validation.
- Owned bundled Chromium passes the shared steering workflow: save/Undo,
  gentle and immediate native launches, unchanged active owners, retained native
  PIDs and modes across Hono crash/replacement, and masked older-server controls
  with no new-field Undo writes. Desktop 1280×900 and phone 375×812 captures
  were presented through the artifact capture facility and inspected separately.
- The retained queued-compaction browser case also passes with 1,000 history
  rows and 43 sequential keystrokes during native completion and concurrent
  metadata updates. Every prefix is acknowledged within the 100 ms limit.

Browser verification found an adjacent Undo defect: absent Rendez delivery
was serialized as null by the settings writer, which the server correctly
rejected. Restoring the semantic `auto` default fixes the request without
loosening the server parser. The full save/Undo browser interaction covers it.

Private reproducibility files are under ignored `tasks/steering-unification/`:
`live-experiment.ts`, `live-corrected.log`, `live-results.json`, the latest
`live-raw-*/sdk-raw.jsonl`, `agy-probe.mjs`, `agy-initialize.json`, and final
workspace/static/browser logs. Accepted UI captures are under
`.artifacts/ui-testing/2026-11-03-provider-steering-accepted/`. Each test owns
and disposes its servers, browser contexts and provider roots; the real trial
also verifies its AAR integration was revoked. Concurrent Antigravity, glyph
and transcript/storage work remains outside this commit.

No default-mode change follows from these single samples. Real Codex 0.166,
other models/tool-generation workloads, Pi input attribution, additional
Antigravity native capabilities and cross-platform live/release qualification
remain separate follow-ups. There is no selected all-provider urgency rewrite
or new shared submission scheduler to finish for this slice.

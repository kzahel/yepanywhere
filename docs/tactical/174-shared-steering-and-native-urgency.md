# Shared steering and native urgency

Status: selected for implementation and standalone experiments, 2026-11-03.

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

# ACP integration and shared provider behavior

Topic: acp

Reviewed 2026-11-05. Status: current implementation inventory and recommendation,
not an approved implementation plan, provider rollout or priority change.

## Recommendation

Consolidate YA's ACP integrations through composition: one bounded transport,
then shared session/event machinery where actual provider behavior agrees,
with explicit provider-specific hooks. Use Grok and Antigravity to establish
the common boundary; use native Copilot CLI support as a concrete next
consumer if selected. Do not build a universal agent framework or adopt T3's
implementation wholesale.

Extend the existing
[Antigravity consolidation discussion](antigravity.md#gemini-retirement-and-optional-acp-consolidation),
rather than opening an unrelated provider rewrite. Discovery, reader selection
and provider-session command ownership have their own owners; ACP sharing
must not become a prerequisite for their remaining work. The
[roadmap](../docs/roadmap/README.md#active-maintenance-focus-core-house-cleaning)
continues to own priority and Gemini's freeze/retirement decision.

## Current YA support

ACP means Agent Client Protocol: the frontend supervises an agent through a
protocol, while the native agent retains its harness, tools and continuation
behavior. Access to a model through another harness is a different integration.

| YA provider | Native interface | Shared implementation today |
| --- | --- | --- |
| Antigravity | Official `agy_acp_server.par` / `antigravity-acp` distribution | Local `AntigravityRuntime` transport and `AntigravityTranscript` projection |
| Grok Build | `grok agent … --no-leader stdio` | Shared `ACPClient`; separate Grok session loop and conversion |
| Gemini CLI, frozen | `gemini --experimental-acp` | Shared `ACPClient`; separate Gemini session loop and conversion |

`gemini` and `gemini-acp` select the same retained adapter, not two ACP
integrations. Antigravity remains explicitly opt-in and has separate platform,
history and shared-host limits in its [contract](antigravity.md).

The [shared client](../packages/server/src/sdk/providers/acp/client.ts) owns
connection setup, request failure/closure, new/load/resume calls, prompts,
permissions and extension callback plumbing. It also retains actual child
ownership through process-tree termination. The
[retained continuation contract](provider-abstraction.md#retained-acp-continuation-and-teardown)
and [plan 171](../docs/tactical/171-durable-session-identity-and-creation.md)
record existing scope/refusal and teardown work; sharing must preserve it.

Above that layer,
[Gemini](../packages/server/src/sdk/providers/gemini-acp.ts) and
[Grok](../packages/server/src/sdk/providers/grok-acp.ts) separately implement
input iteration, notification queues, prompt lifecycle, approvals, text/tool
assembly and conversion into YA `SDKMessage`s. Some approval mappings and
session-loop structure are repeated. This is transport reuse, not a shared
ACP-to-YA session implementation.

[Antigravity's transport](../packages/server/src/sdk/providers/antigravity-runtime.ts)
is deliberately separate because the retained shared SDK predates notifications
it needs, including usage updates. Its bounded local transport avoided changing
the older consumers. That containment is useful evidence for a later merge,
not proof that the implementations can already be substituted.

YA has no generic ACP Registry/local-command provider or native Copilot CLI
adapter. Copilot-backed models already work through
[Pi](pi-provider.md), [OpenCode](opencode-backend.md) and
[Claude Gateway](copilot-oauth-claude.md). Those retain Pi, OpenCode or Claude
Code as the harness. A direct Copilot ACP adapter would retain Copilot's harness;
GitHub documents `copilot --acp --stdio` as an integration interface.
[GitHub ACP reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)

## What T3 shares

Source comparison: clean local T3 checkout at
[`6d46336476941257d774be7c7733e9caf201fec2`][t3-revision]; YA baseline
`d0c58e02807e69c74edef85a8a62e7c20224b401`, inspecting the ACP files and owning
contracts. No live cross-project reliability or performance comparison was run.
The broader [T3 provider architecture comparison](../docs/competitive/t3code-provider-architecture.md)
owns application orchestration and persistence; this topic compares ACP reuse.

T3 registers ten driver kinds: Codex, Claude, Cursor, Grok, fx, OpenCode,
Antigravity, Pi, Muse and ACP Registry. Of those, Grok, Antigravity and fx are
dedicated ACP integrations. ACP Registry is a fourth integration path which
supports registry agents or a configured local command. Copilot uses that path,
along with agents such as Devin and Mistral Vibe. Catalog membership and a
working generic launch do not establish full feature or platform qualification.
The catalog changes independently of T3, so there is no fixed total of
individually supported ACP agents. [Drivers][t3-drivers] · [Registry settings][t3-settings]

T3 uses factories and configuration hooks, not provider subclass inheritance:

- `AcpSessionRuntime` owns native process/protocol/session mechanics, including
  initialization, authentication, loading, cancellation and teardown.
- `makeAcpAdapterV2` owns the shared application adapter: prompts, streaming
  text/reasoning, tools, approvals, configuration and subagent projection.
- `AcpAdapterV2Flavor` supplies capabilities and provider differences, including
  runtime construction, permission policy, model selection, event/tool
  normalization and proprietary extension handlers.

Grok, Antigravity, fx and ACP Registry call the same adapter factory with their
flavors. Copilot adds subagent attribution and disables interrupt/restart
steering because cancelling its prompt also kills background agents.
[Shared adapter][t3-adapter] · [Runtime][t3-runtime] · [Registry composition][t3-registry]

This is stronger reuse than YA's connection-only sharing: common fixes can
reach all ACP consumers without copying session loops. It is also substantial
machinery: the shared adapter is about 8,700 lines and its runtime about 2,900
at this revision. Those counts describe scope, not quality or a size target.
The flavor interface has many specialized hooks, and the registry adapter
contains agent-ID checks despite the contributor guide recommending dedicated
flavors for nonstandard behavior. Borrow the separation, not an idealized claim
that every ACP agent behaves identically. [Adding a provider][t3-adding]

## Proposed YA boundary

Keep the existing `AgentProvider` / `AgentSession` interface toward the rest of
YA. A small ACP session component can implement common mechanics underneath
provider adapters, taking explicit functions/capabilities instead of a base
class with override-dependent lifecycle rules.

| Candidate common responsibility | Remains provider-owned |
| --- | --- |
| Framing, request correlation, bounded pending work, closure and child teardown | Executable selection, arguments, environment and supported platforms |
| Notification delivery and session operation plumbing | Exact new/load/resume methods, native scope/project validation and replay semantics |
| Prompt observation and queue wake/closure plumbing | Native input acceptance evidence, turn completion, steering and background-work semantics |
| Text/thinking accumulation and tool-state assembly where verified equivalent | Native IDs, tool meanings, proprietary metadata, usage interpretation and durable-reader reconciliation |
| Approval callback lifecycle and response transport | Native permission enforcement, offered option IDs and provider-specific questions |

ACP does not by itself prove that a prompt reply means input acceptance, that
all background work ended, or that usage counters have identical semantics.
No generic cancellation/retry layer may replay uncertain input, substitute a
new session after failed resume, or manufacture native steering support.
Keep YA public IDs distinct from native continuation handles and preserve
per-input identity through queue and protocol boundaries.

## Suggested implementation sequence, if selected

1. **Share Grok and Antigravity transport ownership.** Inventory the two
   implementations against their actual notifications and failure behavior.
   Choose one bounded transport only after both native/process cases pass.
   Preserve closure versus actual child-death evidence, pending-call failure,
   permission responses and existing limits. Retire the superseded active
   transport for migrated consumers; an unused common wrapper is not progress.
   Gemini remains frozen: retaining it requires compatibility evidence, while
   retiring execution requires its separate selected scope and historical reads.

2. **Extract shared ACP session behavior.** Move only demonstrated common
   notification, text/tool assembly and prompt-loop mechanics. Use Grok and AGY
   together so the abstraction is not just one provider's implementation with
   renamed types. Preserve native storage/readers, identity, owner exclusion and
   shared-host availability. Do not introduce a second supervisor, scheduler,
   transcript store or per-session polling policy.

3. **Add native Copilot as a bounded consumer.** If requested, start with an
   explicit provider/flavor using the documented CLI ACP interface and a
   deliberate credential/model boundary. Confirm model discovery and employer
   policy with the actual account rather than inferring access from a model
   catalog. Scope auth UX separately; do not replace the working Pi/OpenCode/
   Gateway paths implicitly. The existing [Copilot topic](copilot-provider.md)
   retains the SDK alternative and broader integration context.

4. **Consider generic ACP configuration after real consumers.** A registry,
   installer, arbitrary local commands and multi-account management are separate
   product surfaces. Add them only for a concrete need. Report unsupported
   operations explicitly; registry presence must not advertise unqualified
   fork, rollback, steering, permission or persistence capabilities.

The existing AGY discussion places consolidation after its qualification and
Gemini retirement assessment. This recommendation refines the extraction
boundary; it does not silently change that sequence or authorize retirement.

## Qualification and remaining evidence

Use the existing [native provider suite](native-provider-testing.md): real
executables against scripted local model APIs where supported, plus controlled
protocol peers for faults that are difficult to induce. Preserve meaningful
integration/race cases rather than adding wiring-only tests or duplicate
provider suites. Authenticated subscription routing needs separate scoped
evidence; scripted endpoints cannot establish billing or employer access.

A migration needs evidence for sequential queued turns, cancel-before-start and
cancel-during-work, native refusal and process loss, actual child-tree exit,
pending approval cleanup, cold continuation without replacement allocation,
tool lifecycle and live/durable identity. Qualify supported runtime/platform
and hosted/in-process shapes explicitly; sharing code does not widen support.
Any changed UI/input path also needs real sequential typing under concurrent
updates, preserving the project's 100 ms input acknowledgement requirement.

Existing open evidence limits remain:

- [Tool display native coverage](../gaps/tool-display-native-provider-coverage.md)
  does not establish parity for every ACP conversion.
- [Grok live assistant duplication](../gaps/grok-live-assistant-double-echo.md)
  records an unresolved live/durable merge symptom, not proof of a transport bug.
- [User-turn durable identity](../gaps/provider-user-turn-durable-identity.md)
  forbids replacing authoritative native receipts with text matching.

The measured [Linux native qualification](native-provider-testing.md#linux-native-qualification-and-ci-gate)
now covers Antigravity's reader-then-resume sequence with attributed startup,
replay and teardown costs; it does not establish parity for other ACP runtimes.

Preserve [resource quiescence](architecture-mandates.md), native transcript
ownership and the existing provider-host boundary throughout. This source
assessment favors composition for maintainability and expansion; it does not
establish that T3 is more reliable than YA in live use.

[t3-revision]: https://github.com/pingdotgg/t3code/tree/6d46336476941257d774be7c7733e9caf201fec2
[t3-drivers]: https://github.com/pingdotgg/t3code/blob/6d46336476941257d774be7c7733e9caf201fec2/apps/server/src/provider/builtInDrivers.ts
[t3-settings]: https://github.com/pingdotgg/t3code/blob/6d46336476941257d774be7c7733e9caf201fec2/packages/provider-acp-registry/src/settings.ts
[t3-adapter]: https://github.com/pingdotgg/t3code/blob/6d46336476941257d774be7c7733e9caf201fec2/packages/provider-acp/src/server/adapter.ts
[t3-runtime]: https://github.com/pingdotgg/t3code/blob/6d46336476941257d774be7c7733e9caf201fec2/packages/provider-acp/src/server/AcpSessionRuntime.ts
[t3-registry]: https://github.com/pingdotgg/t3code/blob/6d46336476941257d774be7c7733e9caf201fec2/packages/provider-acp-registry/src/server/adapter.ts
[t3-adding]: https://github.com/pingdotgg/t3code/blob/6d46336476941257d774be7c7733e9caf201fec2/docs/internals/adding-a-provider.md

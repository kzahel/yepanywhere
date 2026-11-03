# Core house cleaning

Topic: core-house-cleaning

Status: **active maintenance focus; cleanup and provider direction**, updated
2026-10-27. The maintainer selected a substantial reduction of unused and
unfinished YA features before restarting the session-core refactor. This
document records removal recommendations, retained boundaries, completed
removals and remaining scope decisions.

## Purpose

YA should concentrate on supervising provider sessions: create and resume,
send and queue input, observe progress and transcripts, handle approvals,
interrupt and stop, and reconnect through direct or encrypted-relay access.
Same-host provider ownership can survive replacement of the web server.

Every additional way to inject a turn, resurrect a session, fork a helper,
select a checkout, or place execution elsewhere adds lifecycle and concurrency
obligations. A hidden or default-off feature still has a maintenance cost when
its settings, metadata, services and branches remain in those shared paths.
House cleaning is a product-scope reduction, not another general core rewrite.

The intended core outcome is reliable **queued `/compact` followed by queued
message delivery**, with sound local lifecycle, input ownership and
concurrency handling. The earlier refactor accumulated execution placements
and compatibility obligations without completing that user flow. These
removals reduce that prerequisite chain before a smaller core plan is chosen.
[Queue survival across compaction](queue-across-compaction.md) records related
queue-loss findings; its older investigation is background, not a claim that
the archived implementation or its provider matrix must be restored.
Antigravity integration and relay/API delegation are separate work, not
requirements for this outcome.

The maintainer reports no remaining personal use for SSH executors and wants
YA-managed parallel checkout lanes removed. The Hosts placeholder is also
selected. Legacy Gemini is frozen, future Google agent support targets
Antigravity, and the alternate Conversation API/preview remains deferred. The
current pass focuses on Kyle/kzahel-led features. Work led by
`graehl@gmail.com`, including synthetic heartbeat automation, is deferred.
This supersedes the initial ordering that prioritized heartbeat removal.
Recommendations below do not claim that nobody uses a feature.

Subsequent row-specific decisions supersede that initial contributor-based
deferral. On 2026-10-27, row 4's dormant helper targets were authorized for
removal and are now removed. A provider-server-managed, no-tool
in-house provider for prompted UI-helper/text-processing-only access is a
candidate to add upon first need, not replacement work required by this cut.

## Current pass and contributor attribution

The implemented removal set is **rows 1, 2, 3 and 11**: managed checkout
lanes, released SSH executors, managed SSH executors and the YA Hosts
placeholder. Row 12 was deferred on 2026-10-26; on 2026-10-27 the maintainer
selected a legacy Gemini freeze and future Antigravity direction, with removal
still an option if retaining Gemini impedes the core work. Row 10
(Conversation API/preview) also remains deferred from implementation. Other
Kyle-led surfaces remain follow-up candidates; finding another candidate does
not automatically enlarge these first deletions.

The table uses these contributor labels:

- **Kyle**: Kyle Graehl / kzahel, `kgraehl@gmail.com`, the requesting maintainer.
- **graehl**: the separate Git author identity `graehl@gmail.com`.
- **Mixed**: a row combines features introduced by both identities; its
  contributor cell identifies the individual parts.

Lead attribution is inferred from the introducing implementation or design
commits linked in each row, checked against the current Git history. It is
feature provenance, not exclusive authorship, current ownership, a line-count
ranking or evidence of present usage. In particular, shared files and later
repairs often include both contributors. Removing a Kyle-led feature does not
mean reverting another contributor's shared safety fixes. Mixed rows must be
split by actual consumer boundaries rather than deleted wholesale.

The row numbers are stable discussion handles, not implementation-order codes.
Keep them when recommendations change. The earlier technical recommendations
for deferred rows remain recorded so they can be revisited separately; they
are not part of this pass's deletion scope.

## Provider usage and replacement candidates

The maintainer reports on 2026-10-27 that Claude Gateway is actively used to
consume work Copilot tokens, and Grok Build is also actively used. Preserve
both paths. The maintainer also uses Pi at times and reports Pi and Grok work
well enough: retain both on that basis. Pi is additionally a possible future
replacement for the Claude Gateway use case, not a selected migration or
evidence of equivalent behavior. Evaluate that workflow before proposing to
retire the gateway.

The maintainer personally uses neither Ollama nor Gemini. That informs review
of Claude + Ollama and the existing conditional Gemini freeze; it is not a
claim that nobody uses them or a new removal authorization. Codex OSS usage
has not been established in this discussion.

These are not one ACP implementation family. Grok Build and current Gemini
use ACP. Claude Gateway and Claude + Ollama use the Claude SDK agent loop with
different model endpoints. Removing an unused adapter must not remove shared
ACP support needed by Grok Build or shared Claude support needed by Gateway.

## Baseline and preserved experiment

Local `main` was restored to freshly fetched remote `main` at `c00368add` on
2026-10-26. No part of the expanded session-core experiment was carried back
automatically. The investigation remains available under:

- `archive/session-core-original-main-2026-10-26` at `ca192285b`: the exact
  original local-main tip, including the 55-commit core series.
- `archive/session-core-expanded-2026-10-26` at `f0ef2546f`: the rebased
  experiment, unfinished SSH stop snapshot and scope-reset report.
- A separately verified local Git bundle containing both refs and complete
  history.

The expanded experiment did not complete queued compact followed by message
delivery end to end. Its extracted policies, storage adapters and race findings
are reference material. They are not an accepted implementation baseline, a
requirement to restore its abstractions, or authorization to continue its old
slice sequence.

## Frozen Gemini and future Antigravity support

The maintainer selected this direction on **2026-10-27**:

- **Freeze legacy Gemini.** Keep its current execution mapping for now; no
  feature work, CLI/SDK refresh or protocol expansion is required for the core
  refactor. Both `gemini` and `gemini-acp` currently select the same ACP
  adapter. The older stream-JSON adapter and its exclusive event parser/tests
  are removed as of 2026-11-03. Discovery retains `gemini` as an alias of the
  same ACP adapter, including `ENABLED_PROVIDERS=gemini`; it no longer probes a
  different implementation from the one used for launch. Historical session
  readers and their normalization remain. Freeze does not certify
  current compatibility. Failed or unsupported ACP resume now fails explicitly
  without issuing `session/new` or sending input to a fresh conversation; a
  controlled failed-resume peer verifies this ownership boundary. Scoped cold
  continuation validates the actual native home/store and original physical
  project before CLI effects. This adds no protocol support or target refresh;
  see [retained ACP ownership](provider-abstraction.md#retained-acp-continuation-and-teardown).
- **Retention is conditional.** If either Gemini implementation forces extra
  core branches, lifecycle machinery, compatibility shims or qualification
  work, reconsider removing Gemini execution entirely. Do not finish or
  modernize it just to preserve it. This records a removal option, not a source
  deletion in this documentation change.
- **Require demonstrated abstraction value.** Gemini may justify retention if
  it cheaply exercises a useful multi-provider boundary, such as differing
  compact capabilities, input ownership, cancellation or session identity.
  Keeping a second provider name or passing a mocked wiring test is not that
  evidence. A useful regression can survive in a controlled adapter test even
  if the Gemini runtime is removed. Retained Claude, Codex and other providers
  also supply real boundary cases; Gemini-specific behavior must not dictate
  the general core contract.
- **Move future Google agent support toward Antigravity (`agy`).** Evaluate
  Google's official Antigravity ACP runtime as a separate, bounded provider
  integration. Prove create/resume, approvals, cancellation and identity in
  that slice. Neither shipping AGY nor refreshing shared ACP infrastructure is
  a prerequisite for cleanup or reliable queued compact/message delivery.
  The [2026-11-03 opt-in preview](antigravity.md) establishes local macOS
  creation and cold resume using native credentials; broader qualification
  remains separate from cleanup.
- **Keep retirement and migration explicit.** Preserve readable histories and
  refuse unsupported execution if Gemini is later removed. Never silently
  resume a Gemini record as a fresh session, another provider or Antigravity.
  Keep shared ACP code needed by retained consumers such as Grok.

Research supporting this direction: [Google's Gemini CLI transition](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/),
the [official Antigravity ACP distribution](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json),
and [T3 Code's dedicated Antigravity integration](https://github.com/pingdotgg/t3code/blob/28286d523f/docs/user/providers-antigravity.md).
The ACP runtime is distinct from scripting the `agy` terminal UI. The managed
Interactions API runs in a Google-hosted sandbox; it is a separate execution
and workspace decision, not a drop-in replacement for a local provider.

## Feature recommendations

These recommendations distinguish known unfinished implementations from
working features whose value may no longer justify their complexity. A
recommendation to remove a feature is not a claim that its implementation is
broken. Open usage decisions should be resolved before the corresponding
implementation slice, without blocking unrelated selected removals.
The last column describes the potential cut if selected; it does not override
an explicit deferred recommendation for the current pass.

| # | Surface | Lead contributor (Git evidence) | Current state and evidence | Recommendation for this pass | Potential deletion scope and retained boundary |
| --- | --- | --- | --- | --- | --- |
| 1 | YA-managed workstreams, lanes and parallel checkout creation | **Kyle** ([45c32b0f7](https://github.com/kzahel/yepanywhere/commit/45c32b0f7)). | [Workstreams retirement](workstreams.md): lane owners, UI, scanner grouping and launch plumbing are removed; explicit stale-client lane targets receive HTTP 410 before launch. | **Removed, 2026-10-26.** See [plan 160](../docs/tactical/160-remove-managed-checkout-lanes.md) for verification. | Remove lane service/routes/types, creation and `.worktreeinclude` seeding, gate/settings, UI and launch metadata plumbing, plus dedicated tests. Preserve existing user checkouts and files. |
| 2 | Released Claude SSH/rsync executors | **Kyle** ([eb97a951b](https://github.com/kzahel/yepanywhere/commit/eb97a951b)). | [Retirement contract](../docs/project/remote-executors.md): released SSH/rsync execution, configuration and selector are removed; historical labels remain read-only. | **Removed, 2026-10-26.** Explicit requests fail; saved remote-session execution actions return 410. Verification: [plan 161](../docs/tactical/161-remove-ssh-executors.md). | Remove SSH launch/resume, executor selection and dedicated sync/recovery code. Historical sessions must never silently resume in a local checkout. |
| 3 | Operator-only managed SSH executors | **Kyle** ([2da0bb622](https://github.com/kzahel/yepanywhere/commit/2da0bb622)). | [Managed executor retirement](managed-remote-executors.md): the injected runner, workspace/auth/mirror stack, dedicated stdio protocol, probes and placement types are removed. | **Removed, 2026-10-26.** Same-host provider ownership remains; verification is recorded in [plan 161](../docs/tactical/161-remove-ssh-executors.md). | Delete the dedicated runner/target/workspace/auth/mirror/diagnostic stack, probes and build commands. Retain generic worker or stdio code only where a retained consumer needs it. |
| 4 | OpenAI-compatible helper targets | **graehl** ([9ffa55aa4](https://github.com/kzahel/yepanywhere/commit/9ffa55aa4)). | [Helper sessions](openai-compatible-helper-sessions.md) documents configuration, model discovery and a hidden editor without working target execution. | **Removed, 2026-10-27.** See [plan 164](../docs/tactical/164-remove-retired-session-automation.md). Consider a provider-server-managed, no-tool in-house provider for prompted UI-helper/text-processing-only access upon first need. | Remove unused registry/editor/discovery/selector plumbing. Preserve provider-local model selection used by retained features; do not build the missing runtime to justify the configuration. The future provider is not a prerequisite for removal. |
| 5 | Synthetic heartbeat turns, forced nudges and heartbeat auto-resume | **graehl** ([58e9f85ec](https://github.com/kzahel/yepanywhere/commit/58e9f85ec)). | [Heartbeat](heartbeat.md) owns configured injected user turns, quiet-period scheduling, project/session overrides, doubtful-liveness steering and unowned-session resurrection. Graehl reports neither he nor Kyle currently uses synthetic heartbeat turns as harness/model-native continuation capabilities have improved. | **Removed, 2026-10-27.** Periodic synthetic turns, forced nudges and heartbeat-driven resurrection are retired; [plan 164](../docs/tactical/164-remove-retired-session-automation.md) records verification. This row supersedes its earlier graehl-led deferral; other deferred rows remain separate decisions. | Remove feature-owned generation, settings/UI, candidate indexing, resume and scheduling branches, plus dedicated tests. Preserve transport/status heartbeats, provider-liveness evidence, ownership/cleanup fences and delayed actions after confirmed activity or verified idle where retained consumers need them, including patient-queue delivery currently sharing the heartbeat sweep. Keep event-driven wake, recaps and cache keepalive as separate decisions; do not retain unused machinery solely for possible future automation. |
| 6 | Event-driven session wake turns | **graehl** ([ff029de3a](https://github.com/kzahel/yepanywhere/commit/ff029de3a)). | [Session wake](session-wake.md) currently uses a YA-server endpoint to queue input or resume an eligible recipient. Addressed event delivery has lasting value for multi-session coordination beyond the original job-completion workaround. | **Resolved, 2026-10-27: keep or redesign; do not remove.** The ability belongs at the provider API boundary, not in the YA web server. | Preserve authorized addressed delivery, busy-session queueing and eligible resumption through the sole provider owner. Move ownership to the provider server/runtime; YA may be a transport adapter. Retire superseded server plumbing only as callers migrate. No periodic heartbeat machinery is required; redesign is not yet implemented. |
| 7 | Post-compaction continuation and prose replay | **graehl** ([30a2c0178](https://github.com/kzahel/yepanywhere/commit/30a2c0178)). | [Post-compact replay](post-compact-replay.md) injects a hidden continuation turn, optionally quoting recent conversation. Explicit `/goal` supplies sustained-task intent. | **Removed, 2026-10-27: replay message policy; capabilities retained.** See [plan 164](../docs/tactical/164-remove-retired-session-automation.md). | Remove replay configuration/UI, prose collection and generation of the specific quoted-history/`continue.` message; make saved enablement inert. Preserve post-compact hooks/dispatch and their safety gates, general hidden injected-message support, historical replay recognition, native compaction and ordinary queued input. |
| 8 | YA-generated away recaps, including forked/tailed helpers | **graehl** ([af6bce7fa](https://github.com/kzahel/yepanywhere/commit/af6bce7fa), [9682c7687](https://github.com/kzahel/yepanywhere/commit/9682c7687)). | [Recaps](recaps.md#house-cleaning-disposition) and [fork recap](fork-recap.md) provide valuable many-session UI, with generation, lifecycle safeguards and durable overlays. Cheap local/cloud model tails are the likely economical choice; measured Codex helper forks had large cache misses. | **Resolved, 2026-10-27: retain implementation; UI refinement only.** | Keep generation and lifecycle plumbing. Make configuration concise and click-to-expand; warn beside Forked about current provider-specific cache economics. Timely economical forks remain a direction to verify, not a reason to delete the option or promise cache reuse. |
| 9 | Prompt-cache keepalive | **graehl** ([5404e0dab](https://github.com/kzahel/yepanywhere/commit/5404e0dab)). | [Prompt-cache keepalive](prompt-cache-keepalive.md) has viewer leases, one-shot provider operations and cadence/logging. Current Claude default-on behavior lacks the newly required budget and net-savings controls. | **Resolved, 2026-10-27: retain; default off with bounded cost.** Useful for a frequently used session with brief breaks; long absences can lose money. | Require explicit opt-in, at most ten refreshes between real uses, a running net-savings UI log, and persistent per-session disablement at a configured net-loss threshold. Keep live-viewer and no-context-pollution safeguards. New safeguards and default change remain unimplemented; loss threshold/accounting details need selection. |
| 10 | Alternate Conversation preview and experimental API | **Kyle** ([0a8af0963](https://github.com/kzahel/yepanywhere/commit/0a8af0963), [89356dbb9](https://github.com/kzahel/yepanywhere/commit/89356dbb9)). | [Simple Client API](simple-client-api.md) and [plan 130](../docs/tactical/130-simple-client-api-and-three-client-demo.md) include `/-/preview`, a separate client state machine, schemas and server subscriptions. The original native Compose presentation was retired in favor of the full bundled web UI. | **Deferred from this implementation pass.** Earlier removal recommendation remains for later consideration. | Remove the unused alternate client/API, dedicated code generation and tests together. Inventory remaining native/shared consumers first. Keep the normal web transcript compiler and transport code they actually use. |
| 11 | YA Hosts delegation preview | **Kyle** ([77fc0fa1b](https://github.com/kzahel/yepanywhere/commit/77fc0fa1b)). | [Cross-host delegation](cross-host-delegation.md) records retirement of the nonfunctional preview, its routes, preload entry and Developer setting. | **Removed, 2026-10-26.** Preserve actual host switching and delegation design. Verification: [plan 162](../docs/tactical/162-remove-hosts-preview.md). | Small direct core savings, but removes a misleading unfinished surface. Preserve the target-owned relay/API delegation direction and actual host identity/pairing used elsewhere. |
| 12 | Gemini ACP execution path | **Kyle** ([3f58e0172](https://github.com/kzahel/yepanywhere/commit/3f58e0172)). | The registry currently maps both `gemini` and `gemini-acp` to ACP; the separate stream-JSON adapter is deprecated. ACP is therefore the current ordinary Gemini execution path, not merely an unused alternative. | **Frozen, 2026-10-27.** Future Google agent support targets Antigravity; Gemini retention is conditional on low cost or demonstrated provider-boundary test value. | Keep the mapping unchanged now. Consider removing both legacy Gemini execution paths if they impede the core refactor; preserve useful boundary regressions and historical readability. AGY integration is separate work, not a core prerequisite. |
| 13 | Legacy Claude + Ollama and other overlapping provider variants | **Mixed:** Kyle — Claude + Ollama ([fa5124fba](https://github.com/kzahel/yepanywhere/commit/fa5124fba)), Codex OSS ([7e3f6225c](https://github.com/kzahel/yepanywhere/commit/7e3f6225c)); graehl — Claude Gateway ([2d570447c](https://github.com/kzahel/yepanywhere/commit/2d570447c)). | The [provider registry](../packages/server/src/sdk/providers/index.ts) retains distinct paths. The maintainer uses Claude Gateway for work Copilot tokens, does not personally use Ollama, and has not established Codex OSS usage here. | **Retain Claude Gateway; review other variants separately.** Pi is a possible replacement to evaluate, not an approved migration. | Preserve the active Copilot workflow until a replacement is selected and verified. Personal non-use of Ollama informs review but does not authorize deletion or establish other users' needs. Gateway/Ollama use the Claude SDK, not ACP. |
| 14 | `/btw` asides and Quick Question cards | **graehl** ([22580999d](https://github.com/kzahel/yepanywhere/commit/22580999d), [d9e24be17](https://github.com/kzahel/yepanywhere/commit/d9e24be17)). | [Asides](provider-agnostic-btw-asides.md#selected-disposition) include Quick Question's Continue /btw transition, which continues the answered child without another fork. | **Revised, 2026-10-27: defer `/btw` removal.** Supersedes the earlier removal selection; retain Quick Question and fork-from-turn. | Preserve Continue /btw, its destination and aside UI/routing/lifecycle. A general split-session browser for forks remains a future option, not a selected replacement. Unfinished report-back follows row 15 independently. |
| 15 | Unfinished `/done` report-back behavior | **graehl** ([e5e139224](https://github.com/kzahel/yepanywhere/commit/e5e139224)). | The [aside contract](provider-agnostic-btw-asides.md#selected-disposition) distinguishes unfinished report-back from the built-in done/archive command lane. | **Removed, 2026-10-27.** Unfinished report-back is retired; built-in `/done` and `/archive` remain. [Plan 164](../docs/tactical/164-remove-retired-session-automation.md) records verification. | Remove aside report-back affordances and pending summary/file report modes; do not finish them. Preserve the ordinary done/archive behavior and Quick Question's explicit Save Q+A. |
| 16 | YA-specific automatic compact/handoff policies | **graehl** ([70bac4a4d](https://github.com/kzahel/yepanywhere/commit/70bac4a4d), [6c7d14212](https://github.com/kzahel/yepanywhere/commit/6c7d14212)). | [Compact-and-handoff](compact-and-handoff.md) is a retired Spark-only plan. Current [resume compaction](resume-compaction.md) includes provider-neutral thresholds, explicit compact-first resume, native controls and Gateway context limits. | **Retire the obsolete Spark plan; defer broader policy removal.** Current runtime thresholds are not Spark-only. | Preserve current manual/native and automatic behavior pending separate decisions. Do not remove shared dispatch, ordinary resume, native thresholds or Gateway limits under the Spark-only authorization. |
| 17 | Other providers: OpenCode, Pi, Grok, ordinary Gemini | **Mixed:** Kyle — OpenCode ([bc3214afe](https://github.com/kzahel/yepanywhere/commit/bc3214afe)), ordinary Gemini ([6b956331d](https://github.com/kzahel/yepanywhere/commit/6b956331d)); graehl — Pi ([0dbe625e3](https://github.com/kzahel/yepanywhere/commit/0dbe625e3)), Grok ([9ecd2a53f](https://github.com/kzahel/yepanywhere/commit/9ecd2a53f)). | The maintainer uses Pi and Grok at times and reports both work well enough. Gemini is not personally used. | **Resolved for Pi/Grok, 2026-10-27: retain both.** OpenCode remains retained; Gemini follows row 12's conditional freeze. | Preserve Pi and Grok on their own merits, including shared ACP support needed by Grok. Pi may separately be evaluated for the Copilot workflow; retaining it does not authorize a Gateway migration or removal. |
| 18 | Boss mode, yacron, broad cross-session orchestration, federated migration and general embeddable core | **Mixed:** graehl — boss ([be9a7a4cc](https://github.com/kzahel/yepanywhere/commit/be9a7a4cc)), yacron ([e25c25489](https://github.com/kzahel/yepanywhere/commit/e25c25489)), agent access ([f8f30a616](https://github.com/kzahel/yepanywhere/commit/f8f30a616)), core API ([f4337a4ed](https://github.com/kzahel/yepanywhere/commit/f4337a4ed)); Kyle — federation ([33d51a825](https://github.com/kzahel/yepanywhere/commit/33d51a825)). | [Boss mode](boss-mode.md), [yacron](yacron.md), [agent access](agent-session-access.md), [federation](federated-super-sessions.md) and [core API](core-service-api.md) are predominantly proposals. | **Keep deferred.** Do not implement or delete graehl-led proposals in this pass. Kyle-led federation remains deferred, outside core acceptance. | Deferring a document does not delete running code. No scheduler, universal grant system, migration engine or package extraction is required to finish house cleaning. |
| 19 | Target-owned delegation over direct API or encrypted relay | **Kyle** ([14a135a90](https://github.com/kzahel/yepanywhere/commit/14a135a90)). | [Plan 144](../docs/tactical/144-relay-peer-session-coordination.md) proposes separate sessions owned by independently installed target YA hosts. | **Retain the direction; defer implementation.** | Future callers submit to the target owner using explicit grants. Do not reintroduce SSH injection, workspace mirroring or same-conversation migration through this plan. |

## Heartbeat removal and retained wake boundary

Row 5 selects synthetic heartbeat removal; row 6 resolves session wake as
**keep or redesign; do not remove**, with provider-API ownership. Row 7 removes
the specific replay policy while retaining post-compact dispatch and hidden
message capabilities. Row 8 retains recap implementation with concise UI and
fork-cost warnings; row 9 retains keepalive with explicit opt-in and bounded
cost accounting. These are scope decisions, not claims that implementation
has changed.

The selected heartbeat removal targets autonomous
provider work: synthetic messages, forced nudges and heartbeat-driven
resurrection of sessions without a live owner. It must not reappear under
another feature name as an implicit replacement.

Keep these independently required mechanisms:

- WebSocket, relay and subscription heartbeats that establish transport health
  or deliver status without prompting the provider.
- Server-owned liveness snapshots, provider-progress evidence and UI activity
  reporting. An open socket is not evidence that the provider is progressing.
- Ordinary deferred/patient queue readiness and delivery, including any shared
  scheduler/deadline infrastructure they still consume.
- Stale-owner detection, process cleanup, shutdown fencing and cancellation of
  admitted background reads. Removing automation is not permission to weaken
  safe termination or leak resources.
- User-requested resume and explicit session continuation. Existing stopped or
  archived sessions must not be resurrected as an accidental fallback.

`autoResumeDisabled` and similar metadata may have consumers beyond heartbeat
turns, including recap and wake paths. Inventory those consumers before
removing a field or its protections. Delete an exclusively owned scheduler,
index or setting when the feature is gone; do not delete shared maintenance
just because its current name contains “heartbeat”.

## Retained product boundary

Retain local provider execution, same-host provider host/workers, ordinary
session queues and single-checkout Project Queue, approvals, manual controls,
stable YA session identity, native transcript/history reading and reconnect.
Keep direct and encrypted-relay transport, authentication, supported client
compatibility and saved-host switching.

The provider host already exists on the restored upstream baseline. Preserve
its actual runtime/platform availability, fallback behavior and the macOS
default-off containment in the [interruption gap](../gaps/macos-provider-host-turn-interruptions.md).
Keeping it does not require expanding its distribution support during cleanup.

Retain ordinary Source Control, project discovery and correct file/source
identity. YA-managed lanes are not the same as read-only recognition of a
user's Git worktrees. The [worktree file-link gap](../gaps/session-worktree-file-links.md)
can remain relevant after lane creation is removed; do not close it merely
because the workstreams feature disappeared. Likewise, Git's use of SSH and
Machine Control's own transport choices are outside the YA executor deletion.

No user checkouts, remote workspaces, branches, credentials, transcripts or
other durable user data should be destroyed as a side effect of source
removal. Obsolete configuration may become inert; it must not enable an
alternative local execution path. Historical feature records may remain
readable without retaining a compatibility runtime for the removed feature.

## Proposed order and stopping conditions

### 1 — settle the feature decisions and map retained consumers

Use the table as the decision ledger. Resolve the conditional usage questions
for each upcoming cut; do not investigate every optional feature before
starting selected removals. Record a concrete keep/remove boundary, the active
consumers and any external caller. No new telemetry service is needed.

### 2 — remove lanes and both SSH executor stacks

Make bounded deletion slices with their own complete outcomes. Remove source,
routes, settings/UI, launch plumbing, dedicated build/probe commands and tests
whose subject no longer exists. Preserve generic facilities with real retained
consumers. Completion means no active launch or recovery path still selects a
YA lane or SSH executor, and historical records cannot execute locally by
accident. This step does not complete lane scheduling or remote recovery first.

### 3 — remove the Hosts placeholder; freeze Gemini

Row 11 is complete in its own pushed commit. The nonfunctional Hosts page and
Developer toggle are removed; actual saved-host selection, identity and the
relay/API delegation design remain. Row 12 follows the conditional freeze
above: preserve both Gemini names and their mapping for now, consider complete
removal if they impede the core, and keep other retained ACP consumers. Future
AGY support remains independent.
Row 10's Conversation API/preview remains unchanged in this implementation pass.

### 4 — review remaining Kyle-led candidates separately

After the completed rows 1, 2, 3 and 11, consider the remaining Kyle-led
variants in row 13 only when separately selected. Preserve the graehl-led portions of mixed rows, including Claude Gateway.
Row-specific selections in the table supersede the initial deferral of rows
4–9 and 14–16. Row 4's dormant helper targets are removed without
building a replacement. Other deferred rows and the graehl-led proposals and
providers identified in rows 17–18 still need separate decisions; the old
broader sequence does not authorize their removal.

Inspect transitive consumers before deleting shared schemas, compiler code or
transport facilities. Do not replace each removed surface with a new framework.

### 5 — verify the smaller product and close each cut

Run the checks required by [development](../DEVELOPMENT.md), with focused
integration evidence for retained lifecycle/queue/ownership interactions and
affected browser flows. Follow [test value and CI cost](../docs/development/testing.md#test-value-and-ci-cost):
retain meaningful regressions, remove tests dedicated to deleted behavior, and
avoid new shallow tests that merely assert wiring disappeared. Preserve real
sequential typing within 100 ms under representative data and concurrent
updates when changing input/navigation paths.

Review hosted-client/server compatibility for affected public surfaces under
[server capabilities](server-capabilities.md) and
[hosted compatibility](remote-hosted-compatibility.md). Define deliberate
unavailability for removed features without weakening ordinary access or
inventing a general migration/compatibility subsystem. Update owning contracts,
this decision ledger and roadmap as behavior actually changes; leave unresolved
defects open until their remaining complaint is gone.

The intended follow-on core outcome is queued `/compact` followed by reliable
message delivery. The maintainer selected
[queued compaction delivery](../docs/tactical/173-queued-compact-delivery.md)
on November 3: existing regular/patient session queues, native dispatch,
completion/readiness and the composer workflow, with one implementation review.
That bounded plan is implemented and independently accepted, with local
Claude, controlled Codex and owned-browser evidence. The archived general core
stays paused.
Do not restore the archived architecture or require Gemini/AGY qualification to begin.
API delegation stays a separate future project.

The subsequent [shared steering slice](../docs/tactical/174-shared-steering-and-native-urgency.md)
keeps shared intent in the UI and native translation in provider adapters.
Claude Now remains per message; Codex's opt-in Immediate trial applies at
owner launch, preserves active owners and native configuration, and defaults
to gentle. Standalone live trials and the other-provider audit are recorded
in that plan. This is an incremental retained-provider improvement, not a
replacement input scheduler or restoration of the archived core.

## Scope control

This effort should be substantial in deletion and modest in new mechanisms.
Each implementation slice must name its deleted behavior, retained behavior,
verification and stopping condition. A discovered requirement for a new
placement, recovery subsystem, public API or generalized runtime returns to
scope discussion rather than silently extending the prerequisite chain.

Useful findings from the archive can inform a specific retained defect. They
do not justify importing the expanded architecture wholesale. Success is a
smaller supported product with fewer execution and automatic-input paths,
working ordinary sessions and clear ownership—not a particular commit count
or a growing set of extracted policy modules.

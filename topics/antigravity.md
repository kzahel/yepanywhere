# Antigravity provider

Status: **experimental and listed by default when installed.** Basic foreground
work is usable. Patient delivery, detached work, scheduled backend reload and
cold history still have reproduced correctness gaps. The primary integration
runs Google's `agy acp` against the user's native login and store. Legacy Gemini
history retains its original provider and identity.

## Support status — 2026-11-22

Evidence below is from YA `eb520d058`. The
[scripted native test target](native-provider-testing.md) is `agy` 1.5.13.
Live Gemini 3.8 Flash Low probes used `agy` 1.5.14 on macOS arm64. Linux has
scripted native coverage. Windows execution remains unavailable pending native
child-tree teardown qualification. YA runs `agy` 1.5.13 or later only; see
[supported runtime](#supported-runtime).

| Surface | Current support and limits |
| --- | --- |
| Foreground delivery | Direct text, real tools, ordinary deferred queueing, cancellation, and cold continuation of short test sessions have native coverage. Steer sends a second native prompt for the next model boundary. YA waits for all submitted foreground prompts to return. |
| Patient delivery | YA saves patient intent durably and waits through retained native work and its root wake. The item's quiet interval starts at verified idle. An ordinary deferred message can deliver at the foreground turn boundary. [YA delivery rules](message-control-steer-queue-btw-later-interrupt.md#delivery-intent-behavior-matrix) · [Overlapping wakes](../gaps/antigravity-overlapping-wake-inbox.md) |
| Detached work | Known shell tasks, schedules and native subagents appear in live work state. An unsettled root wake retains its owner across the last task ending and the root generating a reply. Metadata and the session stream report its activity. [Provider settlement evidence](provider-wait-and-background-work.md#recorded-work) |
| Cold history and resume | Reader and resume keep collecting ACP history after an early load response until they observe the persisted text tail. A missing expected tail fails the operation. |
| Backend reload | `agy` is backend-local. Scheduled reload waits for retained work and checks blockers again at the wrapper handoff. Immediate restart can interrupt the session and records it in the shutdown log. [Reload contract](reload-safe-provider-runtimes.md#reload-ux-and-compatibility) |
| Other controls | Model and effort changes, offered permission choices, and advertised `/compact` are implemented. A verified native checkpoint gates delivery of messages queued after compaction. Inline images/documents, rewind and fork remain unavailable. |

The [native lifecycle tests](../packages/server/test/native-app/app-antigravity-gap-repros.test.ts)
use real `agy` with a scripted model. They cover idle reap and scheduled
reload during detached replies, patient delivery after settlement, and late
foreground admission at the wrapper handoff. One scenario follows a wake
through patient delivery, safe reload, and reopening the final history. The
long native cold replay qualification uses a saved session. The
[upgrade checks](native-provider-testing.md#checking-an-antigravity-upgrade-candidate)
can run with an explicitly selected `agy` version. They check wire order in a
short native replay. A controlled ACP peer verifies that YA handles a final
frame held until after the load response, rejects a truncated stream and
retries without serving a stale cache entry.

## Installation selection

The shared [CLI installation selector](provider-cli-installations.md) can persist
an explicit Antigravity path on the target server/profile. `ANTIGRAVITY_ACP_PATH`
remains authoritative. Every candidate launches as `agy acp`; removed
executables and changed symlink targets are observed on each resolution. A
candidate whose `agy --version` is below the
[supported floor](#supported-runtime) shows that version beside an error naming
the floor and the update path.
Offline execution verification is currently unsupported and is reported as such,
separately from authentication or an execution failure. No Windows support or new
provider authentication/update mechanism is introduced by the selector.

## Native installation and authentication

Install Google's `agy` CLI and sign in with it. Its ACP server (`agy acp`)
reuses the CLI's saved login and its `antigravity-cli` store. YA finds `agy` on
`PATH`; `ANTIGRAVITY_ACP_PATH` names an executable explicitly, and YA launches
whatever it names as `agy acp`. An explicit path never falls back to another
installation. YA launches the resolved target of an executable symlink. YA does
not download, update or reconfigure the runtime.

### Supported runtime

YA runs `agy` 1.5.13 or later, the [native test pin](native-provider-testing.md#checking-an-antigravity-upgrade-candidate)
(`ANTIGRAVITY_MIN_VERSION`). The version comes from the `agentInfo.version`
that ACP `initialize` reports, so the check costs no extra process. YA refuses
a runtime below the floor, and one whose reported version is missing or has no
`major.minor.patch`, rather than assuming it is current. An `agy` before 1.5
has no `acp` subcommand and fails before `initialize`; YA then reads its
`agy --version`, and a version below the floor gets the same refusal. If that
answer is unreadable, the native failure stands.

The refusal names the installed version, the required version and the update
path, for example: "Antigravity requires agy 1.5.13 or later; the installed
runtime reports version 1.4.5. Run \`agy update\`, or install the agy CLI."

- **Provider status** reports the runtime unavailable rather than signed out.
  The refusal is the model catalog's error, and the CLI installation list shows
  the candidate's version with the same text.
- **A refused start** ends the session with the refusal as its error, after
  `initialize` and before any session is created, loaded or prompted.
- **History reads** that need ACP fail with the refusal.

YA dropped the standalone ACP 1.4.x distribution (`agy_acp_server.par`) and
its `antigravity-acp` store. Conversations that exist only in that store are no
longer listed or resumable; their native files are left untouched. Both
decisions are recorded in [plan 195](../docs/tactical/195-antigravity-native-history.md#decisions).

This is one integration interface for Antigravity, not a separate model or
subscription. Google's `agy` terminal CLI also
offers [headless stream-JSON input/output](https://antigravity.google/docs/cli/headless/).
A 2026-11-03 bounded CLI probe successfully reused the CLI's saved login with
`agy -p ... --output-format stream-json`; it did not authenticate again. Direct
CLI integration therefore remains an alternative to ACP, but the YA provider
implemented here still uses ACP. CLI permission round-trips, cancellation,
history and continuation have not been qualified as a replacement adapter.

Sign in through the `agy` CLI or another official Google client. YA starts the runtime with its existing environment, native
`GEMINI_HOME` and settings. Google owns credential storage and refresh. YA never
reads tokens, calls `authenticate` or `logout`, forwards an OAuth callback,
switches accounts, or selects an API-billed method. A missing login fails with
the native error; it does not start YA-managed sign-in.

For an explicitly configured `CLOUD_CODE_URL`, YA passes a configured
`GEMINI_HOME` to `agy acp` as `--gemini-dir` so the runtime and YA's history
reader use the same profile. See the experimental
[AAR Antigravity bridge](https://github.com/kzahel/agent-auth-router/blob/main/docs/antigravity.md)
for the manual subscription gateway setup.

On 2026-11-13, `agy acp` 1.5.8 reused the CLI's login with no further
sign-in. The ACP runtime saved its own `auth.type=oauth-personal` setting;
subsequent native creation and replay reused that saved login without another
auth call. Do not infer ACP readiness from a
successful `agy models` invocation or the old Gemini credential file.

Google's [ACP changelog](https://antigravity.google/docs/changelog) mentions
custom clients, while its [consumer FAQ](https://antigravity.google/docs/faq/)
restricts third-party access. YA identifies itself as `yepanywhere`; it never
impersonates an allowlisted editor or promises models available to that editor.
Account access remains Google's decision.

## Vanilla execution

The provider is listed by default, reports itself not installed without a
runtime or with one below the [supported floor](#supported-runtime), and is hidden by an `ENABLED_PROVIDERS` allow-list that omits it, like
every other provider. Session lists always include its native source, whose
retained-catalog project filter decides membership without starting `agy`. Existing
clients use the normal provider discovery and session routes; older servers
never advertise it, so updated clients send no new unsupported action. No
released capability is broadened and no new route or wire format is required.

The runtime owns tools, permissions, native configuration and session files.
YA sends ordinary text verbatim, adds no context prefix, advertises no client
filesystem/terminal tools and performs no model substitution. The native default
stays selected unless the operator explicitly chooses a model. The dynamic
catalog is the actual account's `session/new` response, not the CLI's catalog
or a static list. When `agy` returns structured ACP `configOptions` for `model` and
`thought_level`, YA projects the base models with per-model supported thinking
levels derived from the paired `availableModels` entries while keeping the
`default` sentinel as the default selection so untouched launches preserve the
runtime's own default model. Separate model and effort controls offer `Auto`
(restoring the level observed before a YA override) and `On` with the model's offered
levels, omitting thinking controls for fixed-effort models; explicit `off` from
API or older callers maps to the lowest offered level because `agy` has no
disabled thinking level. A setup without a `model` config option offers only
the runtime's default, and a request for any other model fails. The v0.12.0
and v0.13.0 server catalogs omit
structured Antigravity effort metadata. Current clients keep those flat
catalogs usable and omit thinking overrides for them. Both startup, resume,
and live mid-session
`setModel` / `setEffort` apply changes in place via `session/set_config_option`,
without restarting the runtime.
In-flight replies remain attributed to the model active when the turn started.
Combined changes hold input and publish the new configuration only after both
settings apply. If restoration fails, queued input waits until a configuration
request successfully reapplies the desired pair.
Legacy effort-suffixed model IDs remain accepted: when no explicit effort is
supplied, YA syncs the embedded effort into session state and persisted launch
settings; when an explicit effort is also supplied, the explicit effort takes
precedence. If catalog discovery is unavailable during launch, the saved ID
stays intact and the native session applies it using its own catalog.
Requesting an explicit thinking level on a model that does not offer
one fails explicitly before mutating active session state. A coalesced, short-lived
blank probe checks readiness without sending a model prompt, then removes only
its proven scratch session files.

YA default, accept-edits and auto select the native `default`, `accept-edits`
and `auto` modes. A requested mode the runtime does not offer fails the start.
Over ACP, `agy` 1.5.13 and 1.5.14 offer `default`, `accept-edits` and `plan`
(observed 2026-11-22), so auto currently fails. `agy` offers no bypass mode, so
bypass-permissions launches that session's server with
`--dangerously-skip-permissions` and keeps the native `default` mode. YA's Plan permission mode is refused; use native `/plan`.
Permission replies use the actual offered option IDs and never promote Allow
once to Allow always. Native fixed-choice questions require an offered answer.
Missing handlers and interrupted requests cancel. Stop requests native
`session/cancel`; hard abort closes the owned process group and waits for exit.

Initial support covers text and file references. Inline image/document blocks
fail explicitly rather than being discarded. Steer sends a second native prompt
to the active session. `agy` applies it at its next model boundary, and YA
keeps the turn open until all submitted prompts settle. The composer
lists native commands as the runtime advertises them, including `/plan`.

When the current session advertises `/compact`, YA supports manual and queued
compaction with optional focus instructions. The queue advances only after
the native command returns and a new completed checkpoint appears in the
native transcript. A missing checkpoint fails the command. An unreadable
outcome stays unconfirmed. Both hold later input under the existing
[queued compaction rules](../docs/tactical/173-queued-compact-delivery.md).
The live session shows a compaction boundary for a verified command. Cold
ACP replay does not supply checkpoint boundaries.

Known active root-session shell commands, schedules, and `invoke_subagent`
children appear in the shared
[background-work view](provider-wait-and-background-work.md). Non-daemon
work that outlives the foreground turn retains the native owner until its
terminal tool event (or, for subagents, until `conversation_summaries.db`
reports the child settled as idle/killed — with a bounded provisional grace
window while `agy` asynchronously flushes a freshly launched child row —
checked at turn settlement, passive updates, and retention queries with no
polling timer). Detached output appears
in the same conversation, including replies to scheduled wakes and subagent
completions. ACP does not guarantee a result notification for those replies. YA
displays them as background output, with steering and verified turn completion
available on submitted prompts.

The v0 API supports direct model discovery, creation, conversation following,
steering, background state, queued compaction and verified Stop using the
existing authority and receipt contracts. Eligible bypass-permissions CLI
launches receive their own private v0 connection when Agent API discovery is
enabled. See [HTTP API v0](http-api-v0.md#local-agent-bootstrap).
The shared subscription usage surface can show quota buckets from the CLI
status line on supported hosts. Rewind, fork and general YA instruction
injection remain outside the current provider scope.
Native skills, hooks, MCP configuration and provider-created workspace files
remain Google's behavior; YA creates no project-local cache or Git exclusions.
Native-only projects now join the shared retained catalog and project list;
Claude history is not required. External-process detection and focused native
history observation remain unqualified.

## Identity and history

The existing YA admission owner retains the public session identity. The
provider-native UUID is a continuation address under the runtime's canonical
store, `antigravity-cli/conversations` in the `--gemini-dir` YA passes or else
`~/.gemini`. Resume
validates the original store, physical database and project before native
effects. Rejected native resume never falls back to `session/new` or replays
queued input into another conversation.

History comes from native file facts and ACP `session/list` and
`session/load`, with no YA shadow transcript or protobuf decoder.
[Native storage](antigravity-native-storage.md) describes each file `agy`
writes and the brain log's record format. `agy` records each conversation's
workspace URIs, title and subagent lineage (`parent_conversation_id`,
`agent_name`, `nesting_depth`) in its `conversation_summaries.db` index; a
conversation without a workspace there is not listed. YA reads only those bounded summary
columns, read-only, rejecting out-of-store symlinks on the database and its
SQLite sidecars. Conversations with a non-empty `parent_conversation_id` are
excluded from top-level catalog scans, `listSessions`, `getSessionSummary` and
`getSession` before any ACP subprocess starts, keeping provider-managed
subagents out of top-level session lists even when their `<uuid>.db` files sit
inside `conversations/`. Durable child relationships flow through the shared
`ProviderChildRelationshipService` via `AntigravitySessionReader.getProviderChildSource`
using bounded read-only `conversation_summaries.db` snapshots; a missing
summaries index stays unknown rather than publishing an authoritative empty set, and running subagents whose
`last_modified_time` is the `0001-01-01` sentinel fall back to local `.db`/`.db-wal`
file mtimes and in-memory activity overlays without churning durable SQL edges.
Authorized descendant transcript reads serve actively running or live-owned
children from a bounded read-only projection of `brain/<id>/.../transcript.jsonl`
(avoiding competing ACP `session/load` writes), and replay settled children
through `session/load` only after revalidating project-eligible lineage. When several workspace URIs are listed
(`/private/tmp/x`, `/tmp/x`), the last is the cwd the client supplied and
matches YA's project binding. Reading never sends a prompt or auth request.
Unknown/foreign project files are not adopted. The native replay API may update
Google's own continuation metadata. The `agy` 1.5.13 ACP stream and replay
report file-read tool identity, location and status, while the file contents
stay in native model context.

The preview uses a local in-process owner, even when the shared provider host
is enabled. Cold resume calls native `session/load` before sending new input.
ACP v1 orders history notifications before the load response. The saved-session
repro on `agy` 1.5.14 observed late history notifications after that response.
When a native brain log supplies recent replayable content, YA requires that
content to arrive before publishing or caching cold history or dispatching the
first resumed prompt. The bounded read prefers the unabridged
`transcript_full.jsonl` when present. YA surfaces an incomplete replay if the
stream closes or its expected tail fails to arrive. YA uses the ACP load
response for stores without a text witness. If a witness is malformed,
abbreviated or unreadable, history remains available with incomplete
coverage. The snapshot is reused for the same native conversation version to
avoid a load and file-change loop. A session reactivated without a prompt
stays idle through replay.
[ACP load ordering](https://agentclientprotocol.com/protocol/v1/session-setup#loading-sessions)
Resume waits for an in-progress history read of the same conversation to
release it and refuses a second live owner. While that owner lives, detail
reads use its bounded native-event projection. This
in-memory view survives YA's short transport replay window, is discarded on
owner exit, and is never persisted as a substitute transcript. Concurrent use
of the same conversation in a separate editor/CLI is not qualified.

App browsing uses the shared catalog and provider-root watcher described below.
Explicit native history and title reads own subprocesses; reader disposal closes
them. Because `session/load` itself rewrites the conversation files, which the
provider watcher reports and viewers refetch, a cold history read is reused
until those files differ from their post-load state (at most four per project
reader). Without this, opening a session could reload it repeatedly. Native title lookups coalesce and cache their ACP list for five seconds,
cap at 2,000 entries and refuse unsupported pagination.
At most eight detail reads per cached reader may run concurrently. YA bounds
the normalized history it retains to 8 MiB and 10,000 messages, and each ACP
frame to 16 MiB. Tool fields that YA does not display do not consume the
history budget or prevent resume. If the retained history exceeds its limit,
YA reports the history-limit error. Larger-corpus/bounded native
replay support is a prerequisite to removing these preview limits.
The live projection has the same 8 MiB/10,000-message limit. It is retained only
for an owned provider session and adds no timers or background history reads.

Text and generic tool records are normalized from actual native notifications.
Live text and thinking blocks publish `_isStreaming` snapshots of one message
id and commit it without the flag when the next block, a tool call or the turn
end closes it, so viewers with response streaming off see only the commit.
Live messages carry arrival timestamps; detail reads of a live owner see
committed content only. `agy` echoes each submitted prompt as
`user_message_chunk` during the turn; YA already published that turn's user
message, so the live projection ignores the echo, while `session/load` replay
keeps native user chunks as history. Detail reads return the complete history
for anchored (`afterMessageId`) requests, leaving the anchor for the detail
route to find; a pre-sliced list would read as an anchor miss and the client
would replace its window with the tail. Native readers report no owner; a live
YA owner, not the reader, establishes ownership.
ACP does not provide YA's durable input UUID, so exact live-to-history user-turn
links are not promised; see the existing
[input-identity gap](../gaps/provider-user-turn-durable-identity.md).
Provider side-effect controls and the wider native tool/media matrix remain
unverified, as described in the existing
[side-effect](../gaps/provider-session-side-effect-controls.md) and
[display-coverage](../gaps/tool-display-native-provider-coverage.md) gaps.

## T3 Code reference — 2026-11-22

Source review of T3 Code `main` at [`122d3bf853`][t3-agy-revision]. The
[T3 provider guide][t3-agy-guide] documents `agy` 1.5 or newer and recommends
1.5.12 or newer. T3 runs `agy acp` with a managed profile and selects the
`antigravity-acp` app-data directory inside it. YA's usual `agy acp` path uses
the CLI's existing `antigravity-cli` store. Native file locations and layouts
need qualification in YA's actual launch mode. This review used T3 source and
its reported tests. Live and scripted reproduction evidence above is from YA.
[T3 launch arguments][t3-agy-launch] · [Shared ACP architecture](acp.md#what-t3-shares)

| Boundary | Reference in T3 | Application to YA |
| --- | --- | --- |
| Steering and Stop | The Antigravity flavor sends a second prompt for native steering and preserves background work on an ordinary follow-up after the prompt settles. Explicit Stop can cancel the native work. [T3 adapter flavor][t3-agy-flavor] | Keep Steer, ordinary deferred delivery, patient delivery and Stop distinct through the native boundary. Test that ordinary input and steering preserve background work unless the user explicitly stops it. |
| Prompt return and pending wakes | T3 can keep an application turn open after the prompt responds. Its wake check looks for unread high-priority messages in the native inbox or a trailing waking `SYSTEM_MESSAGE` in a bounded transcript tail. It also looks for child reports or killed children. Tests cover consecutive wakes, batched reports and a stalled wake. [T3 native readers][t3-agy-work] · [T3 wake fix and evidence][t3-agy-wake-fix] | Treat the inbox and tail as candidate positive evidence that work remains when the last tool or child clears. Check them against live ACP events and the root summary in YA's store. Missing or stale reads leave settlement unverified. Keep the ordinary deferred boundary at foreground completion and apply confirmed root settlement plus the quiet interval to patient delivery. |
| Detached reply completion | T3 uses `usage_update` to close an observed detached reply and checks for another pending wake before finalizing. It bounds how long it waits for quiet. [T3 wake fix and evidence][t3-agy-wake-fix] · [T3 ACP finalization][t3-agy-finalize] | Qualify `usage_update` on the pinned and live runtimes as one input to root settlement. Exercise a quiet end, delayed native publication and a second wake. Use the shared provider observation owner for exact-session reads. |
| Replay and live updates | T3's shared ACP adapter sends `_meta.isReplay: true` updates to history snapshots and skips prompt progress and wake tracking. The reported regression used a scripted ACP peer through the Grok adapter. [T3 replay fix and evidence][t3-acp-replay-fix] · [T3 replay classification][t3-acp-replay-classification] | Check whether `agy` marks the late frames seen in YA. YA currently forwards only the update and session ID to the adapter, so using a replay flag would require carrying notification metadata with them. Replay classification and proof that a cold read reached the saved tail are separate checks. The saved-session marker also exists in YA's bounded native JSONL reader. [YA ACP dispatch](../packages/server/src/sdk/providers/antigravity-runtime.ts#L435-L442) |

The applicable design is a provider-owned report of foreground completion,
detached work and verified root settlement, with YA retaining its delivery
policy. Use the existing scheduler and reload owners to consume that evidence.
The final scheduled-reload admission check still belongs at the YA wrapper
handoff. Shared ACP transport and provider-host continuity remain separately
scoped in their owning contracts. [YA session liveness](session-liveness.md) ·
[Reload ownership](reload-safe-provider-runtimes.md) · [ACP composition](acp.md#proposed-ya-boundary)

The [upgrade checks](native-provider-testing.md#checking-an-antigravity-upgrade-candidate)
keep lifecycle and delivery on real `agy` against a scripted model. The
controlled ACP peer checks late history ordering in both the cold reader and
resume. The original long saved session provides native evidence for the
cutoff. Repeated replies and tool-only tails still need a
[provider completion signal](../gaps/antigravity-acp-replay-completion-signal.md).

[t3-agy-revision]: https://github.com/pingdotgg/t3code/commit/122d3bf853da716652d5066b54d05d7654c46e36
[t3-agy-guide]: https://github.com/pingdotgg/t3code/blob/122d3bf853da716652d5066b54d05d7654c46e36/docs/user/providers-antigravity.md
[t3-agy-launch]: https://github.com/pingdotgg/t3code/blob/122d3bf853da716652d5066b54d05d7654c46e36/apps/server/src/provider/antigravityAuthSupport.ts#L558-L564
[t3-agy-flavor]: https://github.com/pingdotgg/t3code/blob/122d3bf853da716652d5066b54d05d7654c46e36/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts#L236-L251
[t3-agy-work]: https://github.com/pingdotgg/t3code/blob/122d3bf853da716652d5066b54d05d7654c46e36/apps/server/src/provider/acp/AntigravityChildWork.ts#L751-L815
[t3-agy-wake-fix]: https://github.com/pingdotgg/t3code/pull/39989
[t3-agy-finalize]: https://github.com/pingdotgg/t3code/blob/122d3bf853da716652d5066b54d05d7654c46e36/packages/provider-acp/src/server/adapter.ts#L8753-L8783
[t3-acp-replay-fix]: https://github.com/pingdotgg/t3code/pull/40328
[t3-acp-replay-classification]: https://github.com/pingdotgg/t3code/blob/122d3bf853da716652d5066b54d05d7654c46e36/packages/provider-acp/src/server/runtimeModel.ts#L1319-L1322

## Qualification on 2026-11-03

This qualified the standalone ACP 1.4.5 runtime, which YA no longer runs; it
is kept as history. The official macOS arm64 ACP 1.4.5 distribution and CLI
1.4.12 were installed and signed in through Google's native flows. The account's existing storage
plan was sufficient for ACP Gemini 3.8 Flash; no AI-plan upgrade was purchased.
Live native probes covered text and a scratch-file tool action. Production YA
probes covered admission, streaming, distinct public/native IDs, app restart,
native history and cold resume with remembered context. Subsequent idle reads
retained history after the transport replay window expired.

Controlled real child-process tests cover modern notifications, approvals,
native cancellation, process teardown, refused cold continuation, native replay,
live-owner read exclusion and the YA admission boundary. Migration coverage
preserves existing unresolved allocations while admitting the new family.
Desktop 1000×600 and phone 375×812 captures exercised sequential typing during
native streaming: all 100 characters survived in each viewport, with the
slowest input acknowledgement below 12 ms. This does not qualify advanced
operations or another platform. Discovery has separate coverage below.

## Shared discovery first pass — 2026-11-03

Antigravity, Pi, Grok and OpenCode register their native catalog adapters in
`native-catalog-registry.ts`. The existing retained session catalog owns the
acquisition and durable rows; a compact projection contributes native project
paths, provider counts and activity to `ProjectScanner`. File-catalog production
reads the scanner's file layer, so project discovery cannot await itself.
Native project facts are not duplicated in the scanner's persistent cache.
Existing project permissions, hidden directories, ownership metadata and public
session adoption still apply.

Antigravity discovery enumerates at most 2,000 `<uuid>.db` conversations, in
batches of eight, and takes each one's project from the summaries index.
Native database and WAL file facts version rows; conversation databases are
never decoded. A row with a native title has head fidelity; one without has
identity fidelity and no inferred title. Browsing starts no native agent, login or model prompt. Explicit
history reads still use Google's loader and preserve the active-owner guard.
App-owned Antigravity session listings consume accepted catalog rows instead
of repeating native inventories per project. Public catalog projection honors
existing Antigravity bindings, so a discovered native UUID cannot replace an
already allocated YA session ID.

Retained project reads return accepted state while finite discovery runs.
Completeness requires accepted coverage of each eligible native store, including
empty stores; failed acquisition retains the previous generation. Only historically
used families are eligible. Antigravity joins the existing provider-root watcher
owner, watching native conversation database and WAL changes as well
as the sibling `conversation_summaries.db` and its `-wal` sidecar so
lineage-only WAL commits invalidate the retained catalog without rescanning
file-provider projects. Project notifications follow changed project facts,
rather than title changes alone. There is no new polling loop or watcher per
project.

The next cleanup slice shares exact reader selection for child sessions and
vocabulary, and Project Queue title lookups read accepted catalog facts without
provider work. This does not unify all per-project readers, focused history
watches or process-to-session correlation. Grok and OpenCode do not gain
a new root watcher here; their existing invalidation and explicit catalog refresh
behavior remains. Legacy Gemini execution and historical readers remain intact.
Focused Antigravity observation remains unavailable. Database/WAL notifications
alone do not authorize automatic `session/load`, which can update native
continuation metadata. The next slice needs owner-aware history acquisition,
a process budget shared across readers, and WAL-aware source versions before
turning those notifications into automatic history refresh. The local owner
map and per-reader limits do not establish those install-wide guarantees.
The remaining sequence below still applies; this is not Gemini retirement.

## Discovery and cleanup scope — discussion, 2026-11-03

The following records the original scoping discussion. The shared discovery
first pass above implements the catalog registry and project join. A common
reader registry, consumer migration, focused observation and transport sharing
remain proposals, with no approved implementation sequence. Legacy Gemini
history remains readable and never becomes an Antigravity continuation implicitly.

### Existing work to extend

[Plan 093](../docs/tactical/093-provider-session-reconciliation.md) already owns
install-scoped catalogs and exact process reconciliation. Its retained catalog,
successful-use eligibility and Pi/Grok/OpenCode native adapters are implemented.
The [catalog observation contract](session-catalog-observation.md) owns bounded
refresh, fidelity, source versions and publication. This scope extends those
owners; it does not create another catalog or transcript database.

Before the first discovery pass, the concrete splits were:

- [Project discovery](../packages/server/src/projects/scanner.ts) directly
  merges Claude, Codex and legacy Gemini discovery with registered projects.
  Pi/Grok/OpenCode have install-wide native session catalog adapters, but their
  catalog facts are not that scanner's common project-discovery input.
- [Catalog assembly](../packages/server/src/sessions/catalog-adapters/collection-catalog-adapters.ts)
  still chooses families itself and asks ProjectScanner for the
  Claude/Codex/Gemini projection inputs. Therefore making ProjectScanner await
  that same catalog refresh would create a dependency cycle.
- [Source resolution](../packages/server/src/sessions/provider-resolution.ts),
  app reader construction and focused watch resolution separately encode
  provider/family knowledge. The existing
  [three reader-selection rules](../gaps/reader-for-one-provider-has-three-spellings.md)
  gap identifies real consumers whose fallback semantics differ.
- Antigravity's preview reader has its own metadata inventory and per-project
  ACP list cache. It is not an install-wide discovery owner; multiplying that
  reader by project count would multiply native process work.

### Recommended first pass: discovery and source lookup

1. **Separate executable availability from readable native stores.** Keep
   execution adapters on AgentProvider. Establish a small server-side
   registration for a native family's existing catalog adapter and scoped
   reader factory. Instantiate it for the actual configured store, keyed by
   family and canonical storage scope. A historical reader must work without
   an installed or authenticated execution driver. Keep recognized historical
   provider IDs distinct from providers available for new execution.

2. **Join native catalog facts into project discovery.** Add an Antigravity
   NativeSessionCatalogAdapter and use Pi/Grok, with OpenCode as an existing
   database-backed case, to exercise the shared path. Reuse the existing
   retained catalog, eligibility ledger, project metadata and publication
   machinery. Keep Claude/Codex's incremental scanners and their measured
   optimizations intact in the first slice. Specify the dependency direction
   before coding: project refresh may consume accepted native contributions,
   but cannot wait on a refresh which is itself waiting for ProjectScanner.
   First-run completeness, publication-triggered project invalidation and
   source-version checks must cover that staged join explicitly. A newly
   created YA project should use existing app-data registration instead of
   waiting for another provider's files to establish its existence.

3. **Give consumers one exact source lookup.** Reuse native identity and the
   existing exact-provider resolver for reader selection. Route child-session
   and vocabulary consumers through it while retaining each caller's chosen
   missing-source behavior. Provide a bounded lookup of accepted catalog facts
   for collection consumers such as queue titles and focused observation; the
   [queue-title gap](../gaps/project-queue-titles-read-providers.md) is a concrete
   consumer. Unknown catalog membership is not authoritative absence. Detail
   reads retain their explicit provider-native acquisition path.

4. **Share observation policy, preserve native acquisition differences.**
   Use catalog locations and provider-supplied observation facts for file,
   database and protocol-backed sources. Reuse current coalescing, cancellation,
   source-version and disposal owners. Bound native subprocess allocation
   across readers, not just inside each reader. Antigravity's `session/load`
   may mutate continuation state: consult the incumbent provider owner before
   replay, keeping that native constraint explicit. Reusing the existing
   provider-session owner is preferable to expanding the preview's isolated
   in-process ownership map into a second lifecycle system. Shared-host support
   needs its own qualification; a local memory guard is not a cross-process lock.

This pass should remove Antigravity's parallel project-inventory path and
reduce generic provider switches where the common registration is actually
used. Storage decoding, native project-membership proof, exact source versions
and resume validation remain provider-owned. Broad error catches must not
turn an unreadable store into a successful empty enumeration; the
[transient discovery-error gap](../gaps/project-discovery-transient-read-errors.md)
is relevant evidence, not something to close with a factory-only refactor.

Keep the implementation slices smaller than that whole pass. The recommended
starting slice is native catalog registration plus project contributions,
proven with Antigravity and existing Pi/Grok adapters. OpenCode's existing
adapter supplies a database-backed compatibility case without rewriting its
reader. Exact reader/caller cleanup and catalog point lookups form the next
slice; owner-aware history and focused observation follow independently.
Do not add a common path while leaving the old path in active use by the very
consumers being migrated. Each slice should identify which duplicate calls,
switches or caches it removes and verify the surviving behavior.

### Gemini retirement and optional ACP consolidation

The [ACP topic](acp.md) compares current YA and T3 sharing and recommends a
bounded transport/session composition. It refines this discussion without
authorizing implementation or changing the retirement/qualification sequence.

Yep Anywhere retired execution for `gemini` and `gemini-acp` on 2026-11-21.
Both IDs remain valid in historical records, URLs, and collection filters.
Gemini transcripts can be opened without the Gemini CLI. The session page
shows a read-only notice when its server omits the provider from discovery.
Launch, resume, and saved dispatch refuse retired providers explicitly. A
Gemini transcript retains its original provider and identity. Users can
start a separate Antigravity session in the same project.

Retired IDs in `ENABLED_PROVIDERS` match no live provider. Replace the
entries with `antigravity` if desired. Let active Gemini turns finish before
upgrading and fully restart the provider host along with the server.

Then assess a separate, bounded consolidation of Grok and Antigravity's ACP
transport: request correlation, framing limits, pending-request failure,
permission callback plumbing and actual child teardown are candidate shared
mechanisms. Text/thinking/tool-state assembly is another candidate only where
both agents' actual notifications establish the same semantics. The older
shared ACP client and Antigravity's preview transport
currently differ; choose one implementation only after it passes both agents'
real process/protocol cases. Keep session-load methods, native tool meanings,
identity and permission choices in the individual adapters. Do not generalize
Claude SDK, Codex app-server or Pi into ACP, or make this transport work a
prerequisite for discovery. Gemini retirement removes a frozen live consumer;
it does not authorize breaking retained Grok support.

### Acceptance and boundaries

- One bounded native enumeration per eligible store, shared by project and
  session consumers; adding projects or clients does not multiply store walks
  or native processes. Listing performs no full history replay or model prompt.
- Mixed-provider projects merge by canonical directory identity. Identical
  native IDs in different stores remain distinct, and public YA IDs stay stable.
- A project used only by Antigravity appears without seeded Claude history.
  Registered empty projects, cold retained state and first discovery work without
  an await cycle or premature complete-empty publication.
- Known file changes target affected work; title-only and token updates do not
  initiate full project rescans. Incomplete or failed acquisition preserves
  accepted rows and uses bounded retry admission. Unused providers stay unscanned.
- Active-owner history reads never start a competing native loader. Shutdown
  drains owned work and prevents late publication. Native process observation
  and session ownership remain separate: cwd or recent file modification is
  not proof that a particular external process owns a session.
- Queue/title lookups join accepted catalog facts without repeated provider
  reads. Each migrated reader consumer preserves its missing-source semantics.
- With the Gemini executable absent, old histories still open; attempted legacy
  execution is clearly unsupported and never becomes Antigravity execution.

Excluded from the first pass: a new transcript store or application framework,
account/OAuth management, new installers, model-setting unification, universal
tool normalization, proving all CLI/IDE/ACP stores interchangeable, and a full
external-process correlation rollout. Read-only support for old Gemini does
not imply continuing its execution adapter. Existing storage, identity, resource
and compatibility contracts still govern implementation.

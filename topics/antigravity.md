# Antigravity provider

Status: experimental, available by default when a runtime is installed. The
current test target is the ACP server built into Google's `agy` CLI (1.5.13,
run as `agy acp`); the standalone ACP runtime 1.4.5 remains supported. The live
qualification used macOS arm64; Linux
uses the same POSIX process boundary but has not been live-qualified. Windows remains unavailable
until its native child-tree teardown is qualified. This is a separate provider;
legacy Gemini histories and execution settings never migrate implicitly.

## Installation selection

The shared [CLI installation selector](provider-cli-installations.md) can persist
an explicit Antigravity path on the target server/profile. `ANTIGRAVITY_ACP_PATH`
remains authoritative. `agy acp` and standalone ACP share a launch descriptor;
removed executables and changed symlink targets are observed on each resolution.
Offline execution verification is currently unsupported and is reported as such,
separately from authentication or an execution failure. No Windows support or new
provider authentication/update mechanism is introduced by the selector.

## Native installation and authentication

Install Google's `agy` CLI and sign in with it. `agy` 1.5 and later include
an ACP server (`agy acp`) that reuses the CLI's saved login and its
`GEMINI_HOME/antigravity-cli` store; YA prefers it whenever `agy` is on `PATH`.
Otherwise YA uses the standalone
[`antigravity-acp` distribution](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json):
keep `agy_acp_server.par` and its matching `localharness_external` helper
together and put the executable on `PATH`. `ANTIGRAVITY_ACP_PATH` names either
executable explicitly; a file named `agy` is launched as `agy acp`. An explicit
path never falls back to another installation. YA resolves executable symlinks
before launch so the companion stays beside it. YA does not download, update or
reconfigure the runtime.

On Linux, the pinned 1.4.5 bootstrap requires a resolvable `nobody` group name,
even for an unprivileged caller. A missing name aborts before ACP initialization.
The [native qualification prerequisite](native-provider-testing.md#linux-antigravity-bootstrap-prerequisite)
records the Ubuntu alias using that user's existing primary GID. An installed
host needs administrator-provided group configuration; YA never edits it.

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

The November 3 live probe found that CLI 1.4.12 and the standalone ACP 1.4.5
required separate initial sign-ins even under the same home; on 2026-11-13,
`agy acp` 1.5.8 reused the CLI's login with no further sign-in. The ACP runtime saved its own
`auth.type=oauth-personal` setting; subsequent native creation and replay reused
that saved login without another auth call. Do not infer ACP readiness from a
successful `agy models` invocation or the old Gemini credential file.

Google's [ACP changelog](https://antigravity.google/docs/changelog) mentions
custom clients, while its [consumer FAQ](https://antigravity.google/docs/faq/)
restricts third-party access. YA identifies itself as `yepanywhere`; it never
impersonates an allowlisted editor or promises models available to that editor.
Account access remains Google's decision.

## Vanilla execution

The provider is listed by default, reports itself not installed without a
runtime, and is hidden by an `ENABLED_PROVIDERS` allow-list that omits it, like
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
or a static list. When `agy` 1.5+ returns structured ACP `configOptions` for `model` and
`thought_level`, YA projects the base models with per-model supported thinking
levels derived from the paired `availableModels` entries while keeping the
`default` sentinel as the default selection so untouched launches preserve the
runtime's own default model. Separate model and effort controls offer `Auto`
(restoring the level observed before a YA override) and `On` with the model's offered
levels, omitting thinking controls for fixed-effort models; explicit `off` from
API or older callers maps to the lowest offered level because `agy` has no
disabled thinking level. Standalone 1.4.x runtimes (even when they include
`configOptions` with `thinking_level`) keep the flat `availableModels` catalog
with thinking controls disabled. The v0.12.0 and v0.13.0 server catalogs omit
structured Antigravity effort metadata. Current clients keep those flat
catalogs usable and omit thinking overrides for them. Both startup, resume,
and live mid-session
`setModel` / `setEffort` apply changes in place via `session/set_config_option`
(falling back to `session/set_model` on 1.4.x), without restarting the runtime.
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

YA default and accept-edits select the native mode the runtime offers:
`default` and `accept-edits` in `agy` 1.5+, `default` and `auto_edit` in the
standalone 1.4.x runtime. Bypass-permissions selects 1.4.x `yolo`; `agy` 1.5+
offers no such mode, so YA launches that session's server with
`--dangerously-skip-permissions`. A requested mode the runtime does not offer
fails the start. YA's Plan permission mode is refused; use native `/plan`.
Permission replies use the actual offered option IDs and never promote Allow
once to Allow always. Native fixed-choice questions require an offered answer.
Missing handlers and interrupted requests cancel. Stop requests native
`session/cancel`; hard abort closes the owned process group and waits for exit.

Initial support covers text and file references. Inline image/document blocks
fail explicitly rather than being discarded. On `agy acp` 1.5.x, Steer sends a
second native prompt to the active session. `agy` applies it at its next model
boundary, and YA keeps the turn open until all submitted prompts settle.
Standalone ACP and older runtimes use ordinary queued delivery. The composer
lists native commands as the runtime advertises them, including `/plan`.

When the current session advertises `/compact`, YA supports manual and queued
compaction with optional focus instructions. The queue advances only after
the native command returns and a new completed checkpoint appears in the
native transcript. A missing checkpoint fails the command. An unreadable
outcome stays unconfirmed. Both hold later input under the existing
[queued compaction rules](../docs/tactical/173-queued-compact-delivery.md).
The live session shows a compaction boundary for a verified command. Cold
ACP replay does not supply checkpoint boundaries.

Known active root-session shell commands and schedules appear in the shared
[background-work view](provider-wait-and-background-work.md). Non-daemon
work that outlives the foreground turn retains the native owner until its
terminal tool event. Detached output appears in the same conversation,
including replies to scheduled wakes. ACP does not guarantee a result
notification for those replies. YA displays them as background output, with
steering and verified turn completion available on submitted prompts.

The v0 API supports direct model discovery, creation, conversation following,
steering, background state, queued compaction and verified Stop using the
existing authority and receipt contracts. Eligible bypass-permissions CLI
launches receive their own private v0 connection when Agent API discovery is
enabled. See [HTTP API v0](http-api-v0.md#local-agent-bootstrap).
Rewind, fork, the quota dashboard and YA-specific instructions remain outside
the current provider scope.
Native skills, hooks, MCP configuration and provider-created workspace files
remain Google's behavior; YA creates no project-local cache or Git exclusions.
Native-only projects now join the shared retained catalog and project list;
Claude history is not required. External-process detection and focused native
history observation remain unqualified.

## Identity and history

The existing YA admission owner retains the public session identity. The
provider-native UUID is a continuation address under the active runtime's
canonical store (default `GEMINI_HOME` is `~/.gemini`):
`antigravity-cli/conversations` for `agy acp`, `antigravity-acp/conversations`
for the standalone runtime. Sessions in the other store are not resumable
while `agy` is preferred. Resume
validates the original store, physical database and project before native
effects. Rejected native resume never falls back to `session/new` or replays
queued input into another conversation.

History comes from native file facts and ACP `session/list` and
`session/load`, with no YA shadow transcript or protobuf decoder. The standalone
runtime writes a `<uuid>.meta` JSON file holding the project path; `agy` 1.5+
writes none and instead records each conversation's workspace URIs, title and
subagent lineage (`parent_conversation_id`, `agent_name`, `nesting_depth`) in
its `conversation_summaries.db` index. YA reads only those bounded summary
columns, read-only, rejecting out-of-store symlinks on the database and its
SQLite sidecars. Conversations with a non-empty `parent_conversation_id` are
excluded from top-level catalog scans, `listSessions`, `getSessionSummary` and
`getSession` before any ACP subprocess starts, keeping provider-managed
subagents out of top-level session lists even when their `<uuid>.db` files sit
inside `conversations/`. Durable child relationships flow through the shared
`ProviderChildRelationshipService` via `AntigravitySessionReader.getProviderChildSource`
using bounded read-only `conversation_summaries.db` snapshots; missing stores
(including standalone 1.4.x runtimes without a summaries index) stay unknown
rather than publishing an authoritative empty set, and running subagents whose
`last_modified_time` is the `0001-01-01` sentinel fall back to local `.db`/`.db-wal`
file mtimes and in-memory activity overlays without churning durable SQL edges. When several workspace URIs are listed
(`/private/tmp/x`, `/tmp/x`), the last is the cwd the client supplied and
matches YA's project binding. Reading never sends a prompt or auth request.
Unknown/foreign project files are not adopted. The native replay API may update
Google's own continuation metadata. The `agy` 1.5.13 ACP stream and replay
report file-read tool identity, location and status, while the file contents
stay in native model context.

The preview uses a local in-process owner, even when the shared provider host
is enabled. Cold resume uses native `session/load` to restore history before
new input. A session reactivated without a prompt stays idle through replay.
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
committed content only. `agy` 1.5+ echoes each submitted prompt as
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

## Qualification on 2026-11-03

The official macOS arm64 ACP 1.4.5 distribution and CLI 1.4.12 were installed
and signed in through Google's native flows. The account's existing storage
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
batches of eight, with a 16 KiB `.meta` limit where that file exists. Native
database and WAL file facts version rows; conversation databases are never
decoded. Standalone-runtime rows have identity fidelity and no inferred title;
`agy` rows take the native title from the summaries index at head fidelity. Browsing starts no native agent, login or model prompt. Explicit
history reads still use Google's loader and preserve the active-owner guard.
App-owned Antigravity session listings consume accepted catalog rows instead
of repeating native inventories per project. Public catalog projection honors
existing Antigravity bindings, so a discovered native UUID cannot replace an
already allocated YA session ID.

Retained project reads return accepted state while finite discovery runs.
Completeness requires accepted coverage of each eligible native store, including
empty stores; failed acquisition retains the previous generation. Only historically
used families are eligible. Antigravity joins the existing provider-root watcher
owner, watching native conversation metadata, database and WAL changes as well
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

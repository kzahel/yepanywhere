# Antigravity provider

Status: experimental, explicitly opt-in. The initial target is Google's
Antigravity ACP runtime 1.4.5. The live qualification used macOS arm64; Linux
uses the same POSIX process boundary but has not been live-qualified. Windows remains unavailable
until its native child-tree teardown is qualified. This is a separate provider;
legacy Gemini histories and execution settings never migrate implicitly.

## Native installation and authentication

Install the official `antigravity-acp` distribution from the
[ACP Registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json).
Keep `agy_acp_server.par` and its matching `localharness_external` helper
together. Put the executable on `PATH`, or set `ANTIGRAVITY_ACP_PATH` to its
absolute path. An explicit path never falls back to another installation.
YA resolves executable symlinks before launch so the companion stays beside it.
YA does not download, update or reconfigure the runtime.

This is one integration interface for Antigravity, not a separate model or
subscription. Google's `agy` terminal CLI is a different distribution and also
offers [headless stream-JSON input/output](https://antigravity.google/docs/cli/headless/).
A 2026-11-03 bounded CLI probe successfully reused the CLI's saved login with
`agy -p ... --output-format stream-json`; it did not authenticate again. Direct
CLI integration therefore remains an alternative to ACP, but the YA provider
implemented here still uses ACP. CLI permission round-trips, cancellation,
history and continuation have not been qualified as a replacement adapter.

Sign into Google's official ACP integration externally, for example through a
supported editor. YA starts the runtime with its existing environment, native
`GEMINI_HOME` and settings. Google owns credential storage and refresh. YA never
reads tokens, calls `authenticate` or `logout`, forwards an OAuth callback,
switches accounts, or selects an API-billed method. A missing login fails with
the native error; it does not start YA-managed sign-in.

The November 3 live probe found that CLI 1.4.12 and ACP 1.4.5 required separate
initial sign-ins even under the same home. The ACP runtime saved its own
`auth.type=oauth-personal` setting; subsequent native creation and replay reused
that saved login without another auth call. Do not infer ACP readiness from a
successful `agy models` invocation or the old Gemini credential file.

Google's [ACP changelog](https://antigravity.google/docs/changelog) mentions
custom clients, while its [consumer FAQ](https://antigravity.google/docs/faq/)
restricts third-party access. YA identifies itself as `yepanywhere`; it never
impersonates an allowlisted editor or promises models available to that editor.
Account access remains Google's decision.

## Vanilla execution

Include `antigravity` in the existing `ENABLED_PROVIDERS` allow-list to expose
the preview. It is absent from ordinary provider discovery otherwise. Existing
clients use the normal provider discovery and session routes; older servers
never advertise it, so updated clients send no new unsupported action. No
released capability is broadened and no new route or wire format is required.

The runtime owns tools, permissions, native configuration and session files.
YA sends ordinary text verbatim, adds no context prefix, advertises no client
filesystem/terminal tools and performs no model substitution. The native default
stays selected unless the operator explicitly chooses a model. The dynamic
catalog is the actual account's `session/new` response, not the CLI's catalog
or a static list. A coalesced, short-lived blank probe checks readiness without
sending a model prompt, then removes only its proven scratch session files.

Native Default, Auto Edit and YOLO correspond to YA default, accept-edits and
bypass-permissions. YA's Plan permission mode is refused; use native `/plan`.
Permission replies use the actual offered option IDs and never promote Allow
once to Allow always. Native fixed-choice questions require an offered answer.
Missing handlers and interrupted requests cancel. Stop requests native
`session/cancel`; hard abort closes the owned process group and waits for exit.

Initial support covers text and file references. Inline image/document blocks
fail explicitly rather than being discarded. Native `/plan` and `/usage` text
is forwarded normally, but no YA command inventory, steering, manual compact,
rewind, fork, quota dashboard, sandbox or custom instructions are promised.
Native skills, hooks, MCP configuration and provider-created workspace files
remain Google's behavior; YA creates no project-local cache or Git exclusions.
Native-only projects now join the shared retained catalog and project list;
Claude history is not required. External-process detection and focused native
history observation remain unqualified.

## Identity and history

The existing YA admission owner retains the public session identity. The
provider-native UUID is a continuation address under the canonical
`GEMINI_HOME/antigravity-acp/conversations` store (default `~/.gemini`). Resume
validates the original store, physical database and project before native
effects. Rejected native resume never falls back to `session/new` or replays
queued input into another conversation.

History comes from native `.meta`/database facts and ACP `session/list` and
`session/load`, with no YA shadow transcript or protobuf decoder. Reading never
sends a prompt or auth request. Unknown/foreign project files are not adopted.
The native replay API may update Google's own continuation metadata; YA does
not treat it as a byte-preserving database export.

The preview uses a local in-process owner, even when the shared provider host
is enabled. Cold resume uses native `session/load` to restore history before
new input. While that owner lives, detail reads use its bounded native-event
projection rather than loading the same native session a second time. This
in-memory view survives YA's short transport replay window, is discarded on
owner exit, and is never persisted as a substitute transcript. Concurrent use
of the same conversation in a separate editor/CLI is not qualified.

App browsing uses the shared catalog and provider-root watcher described below.
Explicit native history and title reads own subprocesses; reader disposal closes
them. Native title lookups coalesce and cache their ACP list for five seconds,
cap at 2,000 entries and refuse unsupported pagination.
At most eight detail reads per cached reader may run concurrently. Replay is
bounded to 8 MiB/10,000 messages and protocol frames to 16 MiB; excess fails
explicitly instead of claiming complete history. Larger-corpus/bounded native
replay support is a prerequisite to removing these preview limits.
The live projection has the same 8 MiB/10,000-message limit. It is retained only
for an owned provider session and adds no timers or background history reads.

Text and generic tool records are normalized from actual native notifications.
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

Antigravity discovery reads at most 2,000 `.meta` records, in batches of eight,
with a 16 KiB metadata limit. Native database and WAL file facts version rows;
their contents are never decoded. These rows have identity fidelity and no
inferred title. Browsing starts no native agent, login or model prompt. Explicit
history reads still use Google's loader and preserve the active-owner guard.
App-owned Antigravity session listings consume accepted catalog rows instead
of repeating native inventories per project.

Retained project reads return accepted state while finite discovery runs.
Completeness requires accepted coverage of each eligible native store, including
empty stores; failed acquisition retains the previous generation. Only historically
used families are eligible. Antigravity joins the existing provider-root watcher
owner, watching native metadata, database and WAL changes. Changes under a
registered native store refresh that store without rescanning file-provider
projects. Project notifications follow changed project facts, rather than title
changes alone. There is no new polling loop or watcher per project.

This slice does not unify all per-project readers, queue/title lookups, focused
history watches or process-to-session correlation. Grok and OpenCode do not gain
a new root watcher here; their existing invalidation and explicit catalog refresh
behavior remains. Legacy Gemini execution and historical readers remain intact.
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

Once Antigravity discovery and normal session use meet the selected platform
qualification, remove legacy Gemini execution and its installer/authentication
surface. Retain historical readers, recorded IDs, scoped source resolution and
useful regressions. A request to execute a retired provider fails explicitly;
it never selects another provider or allocates a replacement conversation.

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

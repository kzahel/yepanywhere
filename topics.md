- grok - Grok Build ACP provider integration.
- predictive-scroll - Tool row on-demand hydration and placeholder sizing.
- stable-tool-preview-rendering - Browser preference to pre-render tool previews for stable session scrolling.
- recaps - Away-summary recap UX and simulated-helper configuration.
- emulated-slash-commands - Provider command aliases and skill-backed fallbacks.
- glossary - Project vocabulary lookup and regeneration contract.
- side-session-config - Shared helper side-session defaults and lifecycle.
- openai-compatible-helper-sessions - OpenAI-compatible helper endpoint runtime for simulated helper work.
- core-service-api - Proposal to expose YA's provider/session runtime as a headless service and extractable core for external scripts and OpenAI-style proxy clients.
- prompt-suggestions - Next-user-turn suggestion surface and native/simulated split.
- session-liveness - Provider/session cache state, stale entries, and recovery.
- session-context-actions - Clear, fork, handoff, compaction, and durable
  done/archive/terminate session boundaries.
- pluggable-speech-recognition - YA server-routed speech backends and browser-native fallback.
- cost-efficiency - Preferring subscription/local over metered APIs; billing footgun masking.
- ya-env-vars - Catalog of YA env vars and the canonical YEP_/YEP_MODULE_
  naming conventions.
- subprocess-environment - Runtime child-environment, shell-startup, and
  hermetic subprocess-test boundaries.
- source-name-prefixes - Distinguish TypeScript module symbols from YEP_
  process environment variables and runtime globals.
- env-vars-config - Settings UI for process-start env visibility and future
  child-process override defaults.
- kzahel-disabled - Upstream-disabled feature decisions to revisit as configurable defaults.
- session-ui-customization - User-selectable visibility/enabling of advanced session controls.
- relay-origin-and-share-gating - Public relay origin allowlist and public share opt-in/privacy gating.
- session-toolbar-customization - Browser-local session composer toolbar visibility controls.
- i18n-sparse-locale-cleanup - Sparse non-English locale overlays and translation key health checks.
- session-activity-tab-title - Browser-local tab title activity indicator.
- client-session-lifecycle-store - Shared client lifecycle reducer/store for session activity indicators.
- client-session-collection-store - Normalized client session facts and list projection consistency.
- relative-filenames - Shortest-unambiguous file path display and link targets.
- rich-text-rendering - Rendered file/message/diff previews, source-aware copy,
  semantic rich copy, and local-link handling.
- media-rendering-and-routing - Relay-safe media discovery, compact turn
  galleries, and full-image viewer interaction.
- security - YA trust-boundary contracts for local, authenticated, relay, and public surfaces.
- trusted-client-packaging - Signed/local client packaging and relay-only transport trust roots.
- android-credential-sharing - Digital Asset Links association between the
  packaged Android app and yepanywhere.com login credentials.
- message-control-steer-queue-btw-later-interrupt - Steer/queue control state, ownership normalization, and metadata contract cleanup.
- composer-bottom-bar-overflow - Narrow composer bottom-row overflow popup and control priority.
- ui-architecture - Shared rendering boundaries and anti-DOM-rewrite discipline.
- opencode-backend - OpenCode provider capability and transcript-rendering parity.
- provider-refresh - Provider upstream/source refresh triggers, probes, and due-refresh evidence.
- pi-provider - Pi installed-binary contract coverage and upstream compatibility refreshes.
- provider-model-glyphs - Compact provider/model identity for narrow status surfaces.
- provider-subscription-usage - Capability-gated provider quota windows and
  model-applicable usage surfaces.
- graehl-ci-pre-kzahel-gate - Retired to a checkout-local note (maintainer-personal remote policy); topic string stays reserved for the existing commit series.
- claude - Claude provider control, restart/resume safety, interviews, and YA-owned process bridges.
- edit-turn - Inline editing proposal for queued/sent user turns with a visible Esc/cancel escape hatch.
- resume-compaction - Compact-before-resume choice for old or context-heavy provider sessions.
- steer-queue-provider-differences - Claude now/next/later lanes, Codex steer vs app-held queueing, and turn-end signals behind YA send modes.
- vanilla-defaults - Overarching UX theory: first-party-familiar out of the box; YA-novel user-visible behavior is configurable default-off.
- streaming-speech-capture - Client PCM capture contracts, warm-mic latency, and AudioWorklet follow-up.
- direct-xai-speech - Hosted Grok STT direct browser-to-xAI data path and explicit client key borrowing.
- mic-button-speech-ui - Mic button speech insertion, spoken commands, and streaming/batch composer behavior.
- prompt-cache-keepalive - Open-client-only provider prompt-cache warming and cost/activity bounds.
- session-list-display - Session list/sidebar badges, model glyph mapping, and the hover tooltip card.
- session-list-hidden-duplicates - Conservative duplicate-title hiding for session lists, preserving fork/helper lineage and never letting YA helper sessions hide source/current sessions.
- stream-durable-id-dedup - Stream-vs-durable message id alignment and the approx-dedup backstop (codex/opencode steer double-render).
- selection-comment-ui - Non-obscuring quote/source/rich selection actions,
  quote-to-composer behavior, and source-block tint reminders.
- fork-from-turn - Turn-notch fork actions and server-owned fork-after-summary jobs.
- provider-fork-support - Whether Codex/Pi could implement the forkSession primitive, with per-provider enablement plans and gaps.
- transcript-display-objects - Persisted viewer-only objects anchored in transcript order.
- backward-compat - Observable and persisted surface compatibility decisions.
- provider-session-tree - Capability-gated sidebar tree for provider transcripts with parent-link branch data.
- session-retitle - Explicit title editing and user-confirmed generated retitle proposals.
- responsive-layout-gaps - Font-metric-sensitive responsive wrapping gaps and the measured layout invariants that should replace fixed pixel/rem thresholds.
- mobile-transcript-horizontal-overflow - Fixed outer session viewport with
  renderer-owned code/tool scrollers and swipeable turn galleries.
- session-defaults - New-session default scoping: all-provider controls vs provider/model economics controls.
- floating-new-session-composer - Non-session-page `+` quick composer, new-session prefill, and click-time non-browser speech prewarm.
- permission-mode - Provider-independent approval preference with model-capability-gated Auto fallback.
- codex-sessions - Codex rollout storage, compression representation, and YA's durable read assumptions.
- codex-user-turn-provenance - Use Codex's persisted user-turn lifecycle to distinguish real prompts from user-role contextual response items.
- codex-metadata-scanner - Codex rollout head-metadata discovery, current cache layers, and scanner performance gaps.
- project-queue - Server-owned project-level queued messages, idle promotion, and hidden-by-default UI surfaces.
- inbox - Session-attention tiers for pending input, active work, recent activity, and unread notification state.
- session-queue-persistence - Durable server-side persistence prep for
  per-session queued messages and restart-paused recovery.
- client-global-store - Zustand-backed coarse client summary store for sessions, projects, queues, and inbox projections.
- source-control-basic-actions - Narrow Source Control page expansion with split diff, recent commits, and explicit remote actions.
- draft-attachment-staging - Draft envelope, staged attachment storage, and materialization support for composer attachments.
- inactivity-push-notifications - Default-off push settings and server-side inactive project / YA notification edges.
- client-query-controller - Source-scoped client fetch lifecycle, coverage-aware
  dedupe, and retained summary feed queries.
- session-initial-load-performance - Long-session initial render progress,
  chunking, and transcript mount cost experiments.
- client-route-retention - Bounded browser-side route/view retention for
  instant back/forward returns without unbounded transcript caching.
- turn-rail-marker-layout - Right-scrollbar turn marker hit targets, previews,
  and bottom-bar position-age hints.
- conversation-handoff-from - Turn-notch Handoff from… new-session prefill
  from the in-memory Conversation view projection.
- remote-hosted-compatibility - Coarse hosted remote UI / YA server
  compatibility level, starting with recommended level 10 for the first
  rollout.
- codex-session-index-memory - Codex summary-index cold parse memory spikes,
  entry cache retention, and instrumentation.
- summary-parser-worker-isolation - Worker child-process lifecycle,
  parent-side parse coordination, and duplicate large transcript parse
  reduction.
- project-queue-reorder-and-titles - Project Queue project-local
  reprioritization and cache-backed target session display titles.
- session-dom-linger-speedup - Bounded hidden-DOM linger for immediate
  session back/reselect returns.
- public-share-content-censorship - Content-aware censorship proposal for
  public transcript bodies that may include Read/Edit snippets and command
  output secrets.
- bash-result-contract - Provider-normalized Bash result fields for output,
  return code, timing, and empty-output rendering.
- stream-persisted-render-parity - Strong convergence for live items with
  durable counterparts, with bounded optimistic/live-only detail at the tail.
- provider-authoring - Map for adding a new agent provider to the harness
  (interface, reader, normalization, parity, snooping JSONL).
- browser-profile-devices - Browser profile identity, automated browser
  grouping, and stale non-push profile retention.
- session-detail-data-layer - Canonical client session detail store/reducer
  between provider transcript inputs and transcript DOM rendering.
- remote-client-ci-publish - Opt-in CI publish proposal for the hosted remote
  client (repo-variable-gated GitHub Actions to a personal Pages repo).
- thinking-expand-latest-only - Thinking auto-expand policies and the
  thought-toggle right-click gesture (registered retroactively; series
  began at fd47ecb2).
- composer-model-visibility - Provider/model identity echoed adjacent to
  composers (New Session chip, floating composer chip; the session-composer
  float was removed as redundant with the header badge).
- provider-output-contract - Single spec for normalized provider output
  (message envelope, tool results, status, lineage links); named TS types
  as the type definition, validation kept off hot paths.
- provider-runtime-status - Live provider retry/failure status surfaced from
  provider streams into YA process/session UI state.
- client-source-runtime-topology - Source-runtime context and session-detail
  coordinator extraction for client data-flow cleanup.
- workstreams - YA-managed lanes for topic work in one repository: per-lane
  queues over real checkouts syncing through the shared upstream.
- session-media-handles - Server-owned media handles replacing inline base64
  transcript payloads in retained client state.
- source-transport - Source-bound transport facade for localhost, plain
  multiplex WebSocket, and secure/relay modes with visible channel status.
- session-exit-navigation-latency - Large transcript routes must not delay
  first paint of Settings or other lightweight routes when leaving a session.
- typescript-module-boundary-refactor - Tracking-first refactor series for
  extracting large TypeScript/TSX files along existing module boundaries.
- server-capabilities - Shared registry and lifecycle policy for `/api/version`
  capability strings and transitional compatibility gates.
- session-id-remap - Public remap event and client summary-store merge for
  startup-time temporary session IDs that later canonicalize.
- session-compact-tail-pagination - Session-detail `tailCompactions`
  semantics: include exactly the requested number of compact boundary markers
  once they exist, avoiding the exactly-two-boundary full-history
  discontinuity for the default compact tail.
- memory-growth - Browser/client memory-growth investigations and bounded
  transcript load contracts for large provider sessions.
- server-performance-observability - Draft local operator metrics, bounded
  diagnostic events, and V8 memory-pressure cache eviction; implementation is
  deferred pending a measured investigation and compatibility approval.
- transcript-virtualization - Viewport-bounded transcript rendering, native
  content visibility, and first-traversal scroll stability.
- codex-code-mode-render-convergence - Shared rollout-recoverable semantic
  actions for GPT-5.5 and GPT-5.6 command rendering and explored grouping.
- windows-codex-cli-detection - Windows Codex auto-discovery across PATH
  shims, desktop binaries, and fallback installs.
- portable-transcript-compiler - Stable server ingest, bounded transcript
  envelopes, and a shared semantic projection compiler for web and native
  renderers.
- provider-child-sessions - Provider-launched delegated work discovered from
  provider persistence and nested beneath its canonical YA parent session.
- cross-host-delegation - Directed YA-host grants and the product surface for
  creating and supervising separate native worker sessions on another host.
- claude-cross-session-messaging - Claude's live session messaging and local
  Agent View compared with YA's durable cross-host delegation control plane.
- older-claude-models - Default-off server registry and grandfathered custom
  selections for previous provider model versions.
- host-awake - Server-owned, process-lifetime idle-sleep inhibition with an
  optional macOS closed-lid-on-external-power strategy.
- host-identity - Optional server-owned emoji marker for connected headers and
  browser-tab titles, hidden against older servers.
- tooltip-interactions - Shared native/themed tooltip presentation, pointer-rest
  delay, warm adjacent scanning, and future rendered hidden-tail previews.
- session-summary-fidelity - Bounded session list projections, complete-index
  isolation, and partial-observation nondowngrade rules.
- agents-activity-preview - Optional bounded multi-session activity previews
  for active and recently idle process cards on Agents.
- agents-process-observability - Default-on, request-driven host process
  metrics and read-only external provider process discovery for Agents.
- session-sandboxing - Default-off, all-provider Project writes only
  confinement; Linux v1 requires Bubblewrap with provider defense in depth.
- session-sandbox-network-boundary - Optional sandbox network firewall that
  denies host/local destinations and private YA/provider control paths.
- interactives - Zero-setup container for agent-built project web apps:
  opinionated template, committed project files, registry, icon links,
  YA-server-only reach (relay core, with optional globally configured
  Tailscale and Cloudflare paths), and a meta-UI comment-to-agent channel.
- rich-interviews - Banked: multi-round structured-input interview flows;
  YA renders declared formats inline; revisit atop interactives machinery.
- server-plugin-arch - Banked no: settings-gated loadable server plugins;
  monolith convenience wins absent a contributing community.
- project-settings-overrides - Banked seed: project-scoped settings
  overriding global; easy mechanically, painful to visualize; no current use.
- composer-recall-drawer - Ctrl+Up prefix-match history drawer folding up
  from the composer (reuses isearch/UserTurnNavigator machinery); bundled
  enablement change makes !! execution and the recall drawer always-on,
  with only the "!! Commands" sidebar section opt-in. Vanilla Defaults
  amended with an established-convention carve-out to allow it.
- composer-input-latency - Session composer typing stays local regardless of
  transcript size; quote and queued-edit consumers subscribe below the
  transcript boundary, while reactive browser preferences use cached
  snapshots and draft-presence decoration is event-driven.
- settings-search - live substring filter over the Settings UI: shared
  SettingsItem/SettingsSection row layer, operable-in-place results with
  highlighted matches and jump links, default-off "Match values" toggle.
- source-review-to-session - Read-only source review comments accumulated into
  a new agent session; issue #95's broader source manager is inspiration only.
- conversation-view - Opt-in condensed transcript preserving user/agent text,
  images, and failures behind per-turn expandable elapsed/activity summaries.
- acli-ui - ACLI capability detection (`acli:` help line) and richer
  bang-composer completion/help UI proposal.
- ui-testing - Capture-confirmed browser QA by default, with an explicit
  user-owned visual-verification handoff that skips agent capture work.
- source-control - Repository-navigation workbench: changes, commits, files,
  blame, diffs, responsive panes, and links to relevant agent sessions.
- aligned-markdown-diffs - Resumable source-positioned Markdown rendering that
  keeps changed rows, diff lanes, and scroll context aligned.
- federated-super-sessions - One canonical YA session whose active provider
  runtime can migrate safely between trusted cross-platform YA peers.
- skill-invocation - Provider-aware `/name` and `$name` skill discovery,
  composer completion, and exact-token dispatch without constraining prompt
  text.
- relay-client-mux - Optional relay-owned client multiplexing for several
  independently authenticated YA hosts with exact legacy `/ws` fallback.
- android-native-multi-host - Android saved/included/demanded host ownership,
  one-or-more-host relay mux, unified filters, server settings, and removal.
- desktop-v0 - Windows-first self-contained Tauri release with an atomic
  private runtime/server resource, advisory external providers, reload-safe
  loopback bootstrap, and owned process lifecycle.
- android-fcm-push - Native Android device push subscriptions through a
  hosted FCM broker, with SRP-first enrollment, generic/descriptive privacy
  modes, and registration-lifecycle details deferred to implementation.
- android-native-shell - First-class Gradle/Kotlin Android ownership, Compose
  app navigation, a full-web fallback, and an origin-scoped native host
  message contract without Tauri Mobile.
- android-native-connection - Kotlin-owned SRP, secretbox, direct/relay YA
  protocol transport, resumable native sessions, and shared Compose/service
  lifecycle ownership independent of the WebView.
- mobile-server-pairing - App-local server profiles, durable mobile-device
  pairing, Kotlin-owned native transport, independent bundled-web transport,
  resume-authenticated direct/relay discovery, and push as a revocable child
  capability; public installation identity is deferred.
- security-client-audit - Unified browser/native/desktop client registration,
  signed continuity check-in, revocation-surviving bounded security history,
  opt-in new-client alerts, and future WebAuthn/platform-attestation assurance.
- css-architecture - Containment for legacy global stylesheets: CSS Modules by
  default, frozen line-count ceilings, and opportunistic extraction with a
  downward-only ratchet.
- session-reactivation - Message-less provider resume lifecycle, idle reaping,
  and recovered patient-queue delivery.
- notifications - Cross-platform event, delivery, and recipient-presentation
  boundaries for browser Web Push and native app push.
- active-content-security - Source-first active-file viewing and isolated
  origins for executable agent- or project-authored web content.
- website-product-communication - Canonical public feature/provider/
  distribution claims, public docs ownership, and the marketing analytics
  boundary.
- reload-safe-provider-runtimes - Wrapper-owned provider protocol runtimes
  that keep active turns alive across a development Hono reload, with bounded
  reattachment and cleanup.
- provider-host-api - Same-user local control of wrapper-owned provider
  workers, headless bootstrap, and authenticated Hono adaptation.
- project-path-links - Filesystem-authoritative project path membership and
  highlighted-source linkification.
- performance-regression-suite - Capacity-keyed black-box latency, memory,
  correctness, and historical-regression evidence.
- public-share-persistence - Independent per-session share state, compact
  bearer-link grants, frozen revisions, and aggregate-store migration.
- project-directory-storage - App-data-only default for YA-managed state,
  explicit global opt-in for project-local assets, and no ambient project or
  Git-metadata writes from browsing, rendering, indexing, or replay.
- glossary-tooltips - Default-off glossary annotations backed by one governing
  contained include graph, a compiled phrase matcher, and nonblocking render
  integration.
- client-asset-delivery - Immutable generated assets, negotiated precompressed
  representations, bounded static serving, and deploy-generation retention for
  old entrypoints.
- session-catalog-observation - Durable compact session catalog, continuous
  server observation, interest-prioritized freshness, coherent generations,
  and multi-client single-flight refresh.
- biome-format-baseline - Repository-wide Biome formatting invariant, CI
  enforcement, and blame preservation for verified mechanical rewrites.
- goal-judge-fork-vs-side-session - Proposal + experiment deciding where a
  loop-until-done stop judge lives: forked same-model turn vs side session
  (small/same-tier/cross-vendor/tool-running) vs self-declaration, on
  false-complete/false-continue rates and real billed cost.
- composer-full-pane-editing - Viewport-bounded long-form drafting with one
  spare line, direct Ctrl+Enter submission, and visible New Session, handoff,
  and in-session entry.
- session-wake - Event-driven wake turns: authenticated endpoint + agentctl
  job-completion client (design topic; implementation series to follow).
- parked-file-viewer - Preserve document reading state while a persistent
  composer controller or session-list drawer uncovers the live session.
- settings-ui-placement - Reviewed settings copy, placement, defaults, and
  externally visible behavior that the UI can state with confidence.
- cache-aware-session-bootstrap - Current cold-start context placement and the
  explicit absence of a prepared-session pool or cache-reuse guarantee.
- agent-context-injection - Provider-specific placement and compaction
  durability for YA, harness, and project instructions; candidate boot and
  protected-capsule mechanisms live in its sketches companion.
- all-session-content-search - Current catalog/in-session search boundary and
  explicit absence of a cross-session transcript-content index.
- source-review-followups - Optional clarification, discussion,
  source-comment, and gap annotations for a future review-sweep workflow.
- user-authorization-attestation - Current absence of signed gate-specific
  turns; candidate signature and capability-inbox transports live in sketches.
- quarto-markdown - Safe `.qmd` viewing and inert, source-preserving file links
  for Quarto include directives.
- remote-browser-diagnostics - Explicit per-tab full-JavaScript debugging
  leases for YA-launched agents, with visible consent, bounded evidence, and
  server-mediated two-factor authority.
- mobile-session-startup-stability - A monotonic hosted session shell,
  selected-route parallel acquisition, coherent session-core chunking, and
  cache-correct prior-generation asset delivery.
- ui-control-alignment - Shared baseline and metric policy for compact rows.
- attachment-storage - YA-managed attachment location and viewer access.
- nested-harness-launch - Linking a shell-launched second harness process to
  the session it writes, read from the launching command.
- isearch-jump - Ctrl+R/S Enter and click must land on the highlighted match
  after search unhides non-matching turns.
- attachment-hover-preview - Anchored full-size image hover on attachment chips, using local bytes when just pasted or sent.
- conversation-thinking-auto-hide - Conversation view fades thinking 5s after a completed turn with following text.
- cache-miss-accounting - Provider-normalized cache hit/miss evidence, human-turn idle gaps, empirical rate/provider views, and grouped event inspection.
- provider-installation-updates - Cross-provider coordination for installation
  mutation, runtime leases, verified generations, and cache convergence.
- live-worktree-resource-safety - Platform-dependent live Source Control
  monitoring, bounded native watchers, and fail-closed resource-exhaustion
  fallback.
- at-session-launching - Opt-in scanner that launches due at/ queue jobs
  across projects through at-queue.
- yacron - A generally running local scheduler and agent CLI for durable future
  prompts targeting existing or fresh YA sessions through the provider host.
- mobile-ime-delivery - Android IME-safe composer delivery and the default-off
  preference for retaining keyboard focus afterward.
- server-cache-concurrency-safety - Per-key async ownership, bounded source
  snapshots, invalidation fences, and serialized publication for retained
  server caches.
- agent-session-access - Scripted local-agent session search/browse/messaging
  over a scoped REST channel; boss supervision; fs/git mirror rejected.
- new-session-agent-tooling - Launch-time PATH scripts, scoped API channel,
  capability fragment, and virgin instruction-scope option.
- ask-session - Exact-id agent ask plus structured candidate search, bounded
  timeout/deferral reply contract, ask records, and an asks drawer.
- boss-mode - Delegated-orchestration working mode: the user talks to one
  boss agent session that creates and supervises the rest.
- project-code-names - Unique editable project shorthand for browser titles
  and sidebar labels, with deterministic collision reassignment.
- server-side-settings - Server-owned policy, cross-client coherence, demand
  leases, warm retention, and environment fallback or pinning.
- managed-runner-execution-targets - Default-off controller-owned sessions on
  injected target runners, exact committed worktrees, and synchronized incoming
  Git heads.
- managed-remote-executors - Manual-SSH-first managed execution with an
  injected provider-neutral runner, controller-prepared Git workspaces,
  Codex-first proof, and no target upstream credentials.
- agent-command-runtime - Candidate per-session launch capability grants for one
  npm/desktop-bundled YA command dispatcher, private input, and shared
  session-access/yacron delivery without process-tree authentication.
- codex-rollout-lineage - Reference-backed paginated Codex history across
  native Clone/Fork, reader caches, summaries, paging, and server capability
  negotiation.
- provider-agnostic-btw-asides - Continuing /btw sessions and one-shot question
  cards with explicit save/discard and independent main-session typing.
- synthetic-turn-injection - General user/assistant context delivery through
  native history insertion or attributed normal user turns.
- acli-commentary - Declared tool prose and artifact capture handoffs in YA.

- desktop-nightly-releases - Signed nightly publication and same-app Stable/Latest channels.
- ya-agent-self — read-only owning-session inspection and command delivery.
- node-22-builtin-sqlite - Immediate server runtime floor and advisory remote upgrade guidance.
- pending-send-live-echo-fallback - Sending chips must reconcile from durable
  history when the live user-echo notice is dropped.
- claude-goal-controls - Claude `/goal` state read from its transcript, with
  YA-owned pause/resume and the session header flag.
- tool-display-contracts - Checked renderer registration, exhaustive display
  coverage, and native live/persisted rendering parity.
- agent-instruction-consolidation - Canonical AGENTS instructions, harness
  pointers, and bounded deduplication of repository guidance.
- issue-session-associations - Experimental single-server Jira/GitHub issue
  and PR links, durable association evidence, and SQLite schema evolution.
- optional-sqlite - Built-in SQLite discovery storage: runtime adapters, data
  directory placement, and the transaction cost callers must respect.
- simple-client-api - Experimental typed server views with a multi-server web
  demo and early Kotlin/Compose and Swift/SwiftUI consumers.

- [Core house cleaning](core-house-cleaning.md) (active cleanup proposal:
  numbered feature/contributor ledger; initially remove Kyle-led lanes, SSH
  executors, Hosts placeholder and Gemini ACP; defer Conversation API/preview
  and graehl-led automation/helpers)
- [On-device Android host](android-host.md) (experimental Alpine/PRoot host,
  optional ADB direction, distribution research, assistant entry-point research
  and pinned Buddy/Shizuku/Termux references; assistant device spikes deferred)
- new session project selection
- Rich rendering for agent output via yepanywhere
- [Code-fence language renderers](code-fence-renderers.md) (info-string
  normalization, the `language-*` marker, the hover/tap language label, and the
  per-language renderer registry with Mermaid diagrams as its one member)
- Task-list rendering from incremental Claude `Task*` events (problem framing)
- Codex GPT-5.5 model and protocol compatibility
- [Mid-session effort change](mid-session-effort-change.md) (long-context
  warning before an effort change, per-provider threshold, fork at the new
  effort)
- Pluggable speech recognition providers
- Browser-load session UI reliability
- Public read-only session shares
- [Session notes and discussion](session-notes-and-discussion.md) (proposal:
  human-only scratch notes and shared chat, with explicit audience boundaries)
- [Participatory Live Share](relay-origin-and-share-gating.sketches.md#participatory-live-share)
  (proposal: shared discussion, owner-reviewed suggestions, and explicit
  session-input grants)
- [Principals and grants](principals-and-grants.md) (implemented limited-user
  context and proposed convergence of invitations, accounts, and scoped grants)
- Public share content censorship
- Approval and local access security hardening
- [Connection-safe settings](connection-safe-settings.md) (the same settings
  over direct and Remote Access connections, confirmation before a change cuts
  off its own caller, and runtime listener changes)
- Security trust boundaries
- Active content security (confirmed same-origin HTML execution, scriptless
  file viewing, and isolated origins for agent-built applications)
- [File source editing](file-source-editing.md) (conditional saves and HTML
  comment targets opening approximate original-source locations)
- Trusted client packaging for signed/local app installs
- [Optional computer control](optional-computer-control.md) (on-demand local
  native control, session eligibility, MCP spike evidence and Codex/Sky mechanics)
- Hard development rules for upstream-facing defaults
- Kzahel-disabled feature decisions
- Session UI customization
- [Shared UI controls and feedback](shared-ui-controls.md) (toast lifetimes,
  dropdown placement, and fatal client diagnostics)
- Provider image sizing guidance
- Attachment previews and same-browser cache
- Project directory storage (app-data-only default, global project-local
  opt-in, writer audit, and Git-metadata boundary)
- Storage settings (YA data directory vs. project `.yep`, default lazy media,
  and live managed-session preservation opt-in)
- [Required SQLite storage](required-sqlite.md) (Node/Bun adapters,
  startup policy, migrations, and source-server readiness)
- OpenCode backend capability and rendering parity
- [ACP integration and sharing](acp.md) (current YA/T3 comparison and proposed
  transport/session composition; native Copilot and generic registry boundaries)
- OpenCode ses_ session ID unification with YA session ID
- MessageQueue batch delivery and steering UI
- Message-control and queue intent (`/btw`, queue intent, later-interrupt state contract)
- Queue survival across compaction boundaries (verified-idle/patient queue lost on Claude compaction termination)
- Queued messages: server-authoritative design (draft-only localStorage, no fuzzy matching)
- Emulated slash commands
- Provider-agnostic /btw asides
- Side session configuration
- OpenAI-compatible helper sessions
- Prompt suggestions
- Session liveness and queue intent
- [YA-owned session identity](session-identity.md) (selected pre-launch session
  ownership and permanent public ids; startup recovery and compatibility audit)
- [Session creation and navigation](session-creation.sketches.md) (proposal
  built on YA-owned identity, including durable acceptance and background creation)
- Provider process state machine
- Compact-and-handoff guardrail (targeted provider/model policy)
- Claude 1M vs 200K context window (resolution, reporting, autocompact)
- Exposing older Claude models (Opus 4.7/4.6/4.5, Sonnet 4.5) as an opt-in path
- Heartbeat ownership and timers
- Claude provider control
- Codex API provider as a future API-key-backed backend
- Pixel-scale icon aesthetics
- UI testing and screenshot regression checks
- Mobile transcript horizontal overflow (outer session scrollbar above
  composer when wide Grep/tool content leaks past local scrollers)
- Provider/model compact glyph vocabulary (top-right status)
- Claude API failures and auto-retry (transient 5xx/overload evidence)
- Media rendering and routing (image/video/file surfaces, the relay fetch rule, serving doors)
- Sidebar session ordering (user activity owns chronology; pointer/focus holds keep rows clickable)
- Session list hidden duplicates (conservative duplicate-title hiding, fork/helper lineage, current/source session safety)
- Deferred & tactical roadmap (prioritized: backgrounded-jobs badge, `Task*` list rendering, queue-across-compaction, rich-text gaps, OpenCode/pi provider fleshout)
- pi provider (Zechner's pi-mono as agnostic backend: integration plan + periodic progress tracking)
- [YA vs pi-durable](ya-vs-pi-durable.md) (pi's committed-state harness and
  watch API compared with YA's provider-owned transcripts; sketch for a YA
  session-state and subscription layer)
- Provider read/edit disciplines (native edit formats vs YA's one canonical Read/Edit/Write presentation)
- Collapse/expand mode (brainstorm: default-collapse more actions; expand subagent progress as pure outline UI)
- Conversation view (opt-in condensed transcript preserving agent text,
  images, and failures with one expandable elapsed/activity summary per turn)
- Session hover card recent activity (add last regular agent turn excerpt to the row tooltip; fire it on all-sessions + search too)
- Tooltip interactions (native fallback, themed pointer-rest delay, warm adjacent scanning, and future rendered hidden tails)
- Turn-notch actions / fork-from-turn (fork already exists; proposal: expose fork/copy/trim from scrollbar notches + seed compose with the forked turn)
- Turn-rail marker layout (hit targets sized to neighbor gaps; optional PAVA de-cluster spread behind one off-by-default constant)
- Client global store (coarse normalized sessions/projects/project queues/inbox summary cache, not transcript state)
- [React state patterns](react-state-patterns.md) (effect and store publication,
  convergence, snapshot identity, subscription scope, and lifecycle ownership)
- Session summary fidelity (bounded list projections, complete-index isolation,
  and partial-observation nondowngrade rules)
- Client source runtime topology (per-YA-server runtime boundary above summary/query/session-detail stores)
- [Working Across Machines](multi-machine-architecture.md) (discussion entry
  point comparing remote tools, runners, independent hosts, grants, central
  daemons, multiplayer and migration; links Machine Control and prior art)
- [Managed executor retirement](managed-remote-executors.md) (injected SSH
  runners, remote workspace/auth/mirror infrastructure removed; old managed
  target proposals withdrawn; same-host provider workers retained)
- Cross-host delegation (directed grants let one YA server create and supervise
  a separate native worker session on another YA host)
- Claude cross-session messaging compared with YA delegation (live Claude
  session messaging and Agent View versus a durable cross-host control plane)
- Federated super sessions (one canonical single-writer provider session
  migrates between trusted YA peers for native cross-platform work)
- Session media handles (problem statement for lazy transcript image/blob
  payloads behind authenticated server media IDs)
- Session exit navigation latency (large transcript should not delay first
  paint of Settings/other lightweight routes)
- [Workstreams retirement](workstreams.md) (YA-managed checkout lanes removed;
  ordinary user-created checkouts/worktrees remain independent projects)
- Module boundary refactor discipline (move-only slices, naming and
  coordination rules, tripwire matrix, and verification tiers for the
  large-file extraction campaign)
- Portable transcript compiler (stable server ingest, bounded window + prefix
  facts, and shared semantic projection for web and Android native renderers,
  with iOS following later)
- [Simple Client API](simple-client-api.md) (server-owned typed summaries and
  Conversation views; multi-server web demo with early Compose consumption and
  TypeScript/Kotlin schema conformance and a capture-tested server producer;
  iOS deferred)
- Agents multi-session activity preview (default-off condensed live activity
  for active processes and last-output previews for recently idle ones)
- Agents process observability (default-off host metrics plus read-only
  discovery of externally launched local provider processes)
- Bang commands (`!!` composer messages run local shell commands as
  persistent inline display objects, never entering provider context; tab
  completion, rendered output, cross-session history)
- Interactives (proposal: zero-setup container for agent-built project web
  apps — opinionated template, committed files, registry, icon links,
  YA-server-only reach via relay with optional globally configured Tailscale
  and Cloudflare paths, meta-UI comment channel)
- Rich interviews (banked: multi-round structured-input flows rendered inline
  from declared formats; revisit atop interactives machinery)
- Server plugin arch (banked no: settings-gated loadable server code;
  monolith convenience wins absent a contributing community)
- Project settings overrides (banked seed: project-scoped overrides beating
  global settings; mechanically easy, visualization is the cost)
- Session wake turns (authenticated automation endpoint queues a user turn
  into one session; agentctl job-completion client, resume-on-wake gates,
  provider-CLI fallback rules)
- Agent command runtime (proposal: one npm/desktop-bundled `ya-agent`
  dispatcher, per-session PATH and scoped authority, private input, and shared
  delivery for session-access and integrated yacron clients)
- User authorization attestations (sketch: opt-in signed turns or a Linux-
  bounded capability inbox for only predeclared authorization gates)

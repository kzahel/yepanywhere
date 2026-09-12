- new session project selection
- Rich rendering for agent output via yepanywhere
- [Code-fence language renderers](code-fence-renderers.md) (info-string
  normalization, the `language-*` marker, the hover/tap language label, and the
  per-language renderer registry with Mermaid diagrams as its one member)
- Task-list rendering from incremental Claude `Task*` events (problem framing)
- Codex GPT-5.5 model and protocol compatibility
- Pluggable speech recognition providers
- Browser-load session UI reliability
- Public read-only session shares
- Public share content censorship
- Approval and local access security hardening
- Security trust boundaries
- Active content security (confirmed same-origin HTML execution, source-first
  file viewing, and isolated origins for agent-built applications)
- Trusted client packaging for signed/local app installs
- Hard development rules for upstream-facing defaults
- Kzahel-disabled feature decisions
- Session UI customization
- Provider image sizing guidance
- Attachment previews and same-browser cache
- Project directory storage (app-data-only default, global project-local
  opt-in, writer audit, and Git-metadata boundary)
- Storage settings (YA data directory vs. project `.yep`, default lazy media,
  and live managed-session preservation opt-in)
- [Optional discovery SQLite storage](optional-sqlite.md) (Node/Bun adapters,
  startup opt-in, migrations, and source-server readiness)
- OpenCode backend capability and rendering parity
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
- Provider read/edit disciplines (native edit formats vs YA's one canonical Read/Edit/Write presentation)
- Collapse/expand mode (brainstorm: default-collapse more actions; expand subagent progress as pure outline UI)
- Conversation view (opt-in condensed transcript preserving agent text,
  images, and failures with one expandable elapsed/activity summary per turn)
- Session hover card recent activity (add last regular agent turn excerpt to the row tooltip; fire it on all-sessions + search too)
- Tooltip interactions (native fallback, themed pointer-rest delay, warm adjacent scanning, and future rendered hidden tails)
- Turn-notch actions / fork-from-turn (fork already exists; proposal: expose fork/copy/trim from scrollbar notches + seed compose with the forked turn)
- Turn-rail marker layout (hit targets sized to neighbor gaps; optional PAVA de-cluster spread behind one off-by-default constant)
- Client global store (coarse normalized sessions/projects/project queues/inbox summary cache, not transcript state)
- Session summary fidelity (bounded list projections, complete-index isolation,
  and partial-observation nondowngrade rules)
- Client source runtime topology (per-YA-server runtime boundary above summary/query/session-detail stores)
- Managed remote executors (default-off manual SSH baseline with injected
  provider-neutral runners, YA-managed Git workspaces, Codex-first validation,
  and controller-fetched incoming heads)
- Managed runner execution targets (default-off controller-owned sessions on
  injected subordinate machines or disposable VMs, extending the managed SSH
  baseline with Machine Control discovery and lifecycle)
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
- Workstreams (lane-aware Project Queue; each lane is a real checkout of the
  repository syncing through the shared upstream)
- Module boundary refactor discipline (move-only slices, naming and
  coordination rules, tripwire matrix, and verification tiers for the
  large-file extraction campaign)
- Portable transcript compiler (stable server ingest, bounded window + prefix
  facts, and shared semantic projection for web/Android/iOS native renderers)
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

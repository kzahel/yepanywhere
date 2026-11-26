# Competitive Landscape

Analysis of similar tools in the AI coding agent supervisor space.

**[Feature Matrix](feature-matrix.md)** — Historical checklist plus links to
dated source reviews; use the newer reviews for current comparisons.

**[Happy and T3 Android health](happy.md#android-adoption-and-project-health-versus-t3-code)**
— 2026-10-17 public-evidence review of Happy's unified-harness pivot,
implemented team mode, mobile/runtime boundaries, Android adoption and issue
reports. [T3's October follow-up](t3code.md#october-17-follow-up-android-health-and-adoption)
records its 2.0 mobile release and qualifies Android reliability comparisons.

**[T3 Code remote environments](t3code-remote-sessions.md)** — 2026-10-03
source review of enrollment, SSH server ownership, target-local credentials and
worktrees, Git/PR workflows, disconnect/restart recovery, and implications for
YA's remote-execution choices.

**[T3 and YA provider architecture](t3code-provider-architecture.md)** —
2026-10-28 source comparison of provider commands, ownership, queues,
normalization and persistence after YA's house cleaning, with bounded refactor
recommendations and the revised feature-retention decisions.

## First-Party Tools

Official apps from AI providers:

| Tool | Type | Key Differentiator |
|------|------|-------------------|
| [Codex App](codex-app.md) | macOS + cloud | Cloud sandboxes, automations, GitHub integration |
| [Claude Code Desktop](claude-code-desktop.md) | Desktop (Electron) | Remote execution, Cowork for non-coders |

## Third-Party Tools (Agent Supervisors)

| Tool | Type | Agents | Key Differentiator |
|------|------|--------|-------------------|
| [Warp](warp.md) | Native desktop terminal + browser/mobile Remote Control | Warp Agent; 15 advertised local CLIs; Claude/Codex cloud harnesses | Direct local-agent remote supervision, attention mailbox, forks, review, hosted/self-hosted execution and adjacent Factories |
| [T3 Code](t3code.md) | Web + desktop + native mobile | Codex, Claude, Cursor, Grok, OpenCode, Antigravity | Integrated workbench, offline mobile, multi-environment remote access, full source-control workflow |
| [Paseo](paseo.md) | Electron + native mobile + web + headless daemon + CLI | Ten documented integrations plus generic ACP and plugins | Managed worktrees, integrated review and preview, public mobile apps, encrypted multi-host access and optional Hub automation |
| [bb](bb.md) | Web + desktop + early-access mobile shell | Claude, Codex, Pi, five named ACP agents + custom ACP | Extensible plugin workbench, durable workflows, scheduling, managed environments and multi-host execution |
| [AionUi](aionui.md) | Desktop + WebUI + Telegram | 17 (ACP) | Messaging platform bots, cron scheduling, Zed ACP bridges |
| [emdash](emdash.md) | Desktop app | 20+ | Multi-agent orchestration, git worktrees |
| [Conductor](conductor.md) | macOS app | Claude, Codex | Git worktree isolation |
| [Paradev](paradev.md) | Desktop + native mobile + headless host | Any CLI; structured chat for Claude, Codex, OpenCode, Pi | Managed Git worktrees, integrated GitHub review, cloud workspaces and event-triggered runs |
| [HAPI](hapi.md) | Web + CLI | Claude, Codex, Gemini, OpenCode | CLI-wrapper architecture, terminal page |
| [Happy](happy.md) | Desktop + headless runtime + native mobile; legacy CLI | Claude, Codex, Grok | Unified harness, persistent bots, encrypted mobile sync, shared team sessions and collaborative documents |
| [CosmoRemote](cosmoremote.md) | Native mobile + Mac bridge | Claude, Codex, Cursor, terminal | Multi-Mac mobile fleet and interactive simulator/emulator streaming |

See also [Community Projects](community-projects.md) for smaller tools shared on Reddit/forums.

## Android hosts and platform references

The [Android host topic](../../topics/android-host.md) owns YA's runtime,
optional ADB direction, distribution assessment and research-only assistant
entry-point exploration. The 2026-10-18 reviews below use pinned source, with
no app installation, device investigation or assistant spike.

| Project | Role | Research focus |
| --- | --- | --- |
| [Buddy](buddy.md) | Phone-local provider runtime and assistant | Alpine/PRoot, native phone tools, provider sign-in, APK updates and restricted Play flavor |
| [Shizuku](shizuku.md) | Adjacent Android privilege broker | User-enabled ADB/root service, Binder authorization, wireless setup, lifecycle and rish |
| [Termux](termux.md) | Adjacent terminal/development environment | Upstream versus Play builds, native execution, system-linker wrapper, package provenance and PRoot |

The [reference map](android-host-references.md) and
[YAML pins](android-host-references.yaml) bind the nine local research
checkouts to exact commits. These are source-reading references, not adopted
runtime dependencies or evidence of YA store approval.

## Adjacent: Version Control And Multiplayer Threads

**[Multiplayer AI and collaborative live sessions](multiplayer-ai.md)** —
2026-09-30 product review of HumanLayer, Delta, Coshell, mpai, Slack Code, and
YC activity; distinguishes shared conversations from shared projects and records
permission boundaries, open-source status, and relevance to YA's proposals.
A dated October 17 follow-up adds Happy's implemented shared-server team mode
and its broad access/membership-management limits.

| Product | Type | Key Differentiator |
|---------|------|-------------------|
| [Zed DeltaDB / Delta](deltadb.md) | Public beta; no public Delta source verified | Operation-level history with edits linked to conversation, delta-anchored comments, mid-run branches, live multi-person threads |

Not an agent supervisor, but it overlaps YA on code↔conversation provenance,
forking, and shared sessions; the review names the YA sketches it motivates.

## The "Claw" Ecosystem (Adjacent Category)

"Claw" is now a recognized category term (Karpathy coined it, Willison validated it, Feb 2026) for AI agents that run on personal hardware, communicate via messaging, and schedule autonomous tasks. These are **runtimes that wrap LLM APIs**, not agent supervisors like yepanywhere. But they overlap enough to track.

| Project | Stars | Language | Key Differentiator |
|---------|-------|----------|-------------------|
| [OpenClaw](https://github.com/openclaw/openclaw) | 215k | TypeScript | The original. 38+ channels, 5,700+ skills on ClawHub |
| [Nanobot](https://github.com/HKUDS/nanobot) | 22.4k | Python | ~4K lines. Research-friendly. MCP integration |
| [PicoClaw](https://github.com/sipeed/picoclaw) | 17.2k | Go | <10MB RAM, runs on $10 RISC-V boards |
| [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw) | 16k | Rust | <5MB RAM, single binary, 22+ providers |
| [NanoClaw](https://github.com/qwibitai/nanoclaw) | 10.2k | TypeScript | Container isolation (Docker/Apple Container) |
| [Moltworker](https://github.com/cloudflare/moltworker) | 8.6k | TypeScript | Serverless on Cloudflare Workers |
| [IronClaw](https://github.com/nearai/ironclaw) | 2.6k | Rust | WASM sandboxing, PostgreSQL, defense-in-depth |

**Why we're different:** Claws are runtimes — they manage LLM API calls, tool execution, and session state. We're a supervisor/relay — we manage existing agents (Claude Code, Codex) that handle their own execution. See the [Seneschal competitive analysis](../../../assistant-data/assistants/scout/docs/seneschal-ideas.md) for detailed positioning.

## Common Features Across Competitors

Most tools in this space provide:
- Multi-session dashboard
- Real-time streaming
- Permission approval UI
- Session persistence

## yepanywhere Differentiators

The combination that most clearly distinguishes yepanywhere:

- **Tiered inbox** (Needs Attention → Active → Recent → Unread) across
  YA-owned and externally discovered provider sessions
- **Conversation fork/clone** from a selected completed user turn
- **Provider-native history discovery** rather than a product-only thread silo
- **Global activity stream** across sessions
- **Reload-safe provider runtimes** that can survive a Hono server replacement
- **App-data-only storage by default** — browsing and indexing do not create
  project directories or Git refs
- **Application-layer E2E relay encryption** (Happy and Paseo also use E2E;
  T3 Connect and CosmoRemote do not appear to)
- **Alternate/local provider variants** including Codex OSS/local, Gemini, and
  Claude gateway/Ollama configurations

These describe a combination, not individually unique capabilities. The
[bb source review](bb.md) confirms conversation forks, daemon-owned execution
and remote access there too. Against bb, emphasize provider-native history,
the tiered inbox, application-layer E2E relay encryption, and native Windows
support; bb currently requires WSL2 on Windows.

The [Warp source review](warp.md) also confirms local-agent Remote Control,
attention notifications, earlier-turn native conversation forks and native
Claude/Codex transcript capture for managed runs. Against Warp, emphasize
external provider-history discovery, the server-wide session inbox and the
encrypted authenticated relay boundary. Warp's published session content is
uploaded to its service; its open execution worker does not replace the hosted
control plane.

The [Happy review](happy.md) now confirms daemon-owned execution, worktrees,
mixed-model orchestration and human multiplayer. Against Happy, distinguish
YA's provider-owned runtimes and native history from Happy's recreated
execution harness; do not reuse the February process/worktree absence claims.

The [Paseo source review](paseo.md) confirms native-session import, contextual
chat forks, public Android and iOS apps, a managed worktree and preview loop,
and a separate Hub for team and event automation. Against Paseo, distinguish
automatic provider-history discovery, the cross-project attention inbox, and
provider-native forks from explicit import and history-attachment forks.

## Common Gaps

Features competitors have that we should consider:

- **Git worktree creation and exact workspace rollback** per session
- **Integrated terminal/browser and full forge workflows** (T3 Code)
- **Native mobile store distribution** (T3 Code, Happy, CosmoRemote)
- **Offline mobile outbox** (T3 Code)
- **Phone-driven simulator build/test loop** (CosmoRemote)
- **Multiple provider-account instances** with explicit resume rules (T3 Code)
- **Scheduling/automations** (Codex App, AionUi)
- **Durable agent workflows and a general workbench plugin SDK** (bb)
- **Messaging platform bots** as mobile proxy (AionUi — Telegram/Lark/DingTalk)

## Related (Non-Competitive)

See **[Ecosystem](../ecosystem/)** for adjacent projects — agent-to-agent coordination, workflow DAG platforms, multi-agent orchestrators — that aren't direct competitors but operate in complementary spaces.

## Last Updated

2026-11-26 ([Paseo source review](paseo.md)). Other reviews retain their
own snapshot dates.

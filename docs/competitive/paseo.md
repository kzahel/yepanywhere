# Paseo versus Yep Anywhere

Reviewed 2026-11-26. Paseo was pinned to stable v0.17.5
([713b6db][paseo-pin]), and Paseo Hub to v0.12.0 ([8f09052][hub-pin]).
The Yep Anywhere (YA) baseline is [222763b88][ya-pin]. The review draws on
release-tagged source, public docs, package metadata, release assets, and US
App Store and Google Play listings. App behavior, provider interoperability,
recovery on real devices, and hosted operations were assessed from those
sources without running either app. [Paseo release][paseo-release] ·
[Hub release][hub-release]

**Paseo is now a self-hosted development environment for taking several changes
from task to review in parallel. YA is strongest when work already exists in a
provider and the user wants to find, resume, and supervise it from another
device.** Both use the underlying coding agents and keep execution on a host
the operator controls. Paseo's public mobile distribution, worktree lifecycle,
and optional team automation make it a direct competitor across more of that
workflow than the March 2026 survey captured.
[Paseo workspaces][workspaces] · [Hub][hub-product] · [YA README][ya-readme]

## What changed since March

| March 2026 snapshot | November 2026 evidence |
| --- | --- |
| v0.1.28, 215 GitHub stars | v0.17.5, released November 26. GitHub API reported 25,681 stars and 3,192 forks on the review date. These are repository signals. [Release][paseo-release] · [Repository][github] |
| Tauri desktop, Expo clients, AGPL-3.0 | Electron replaced Tauri in v0.1.32. Paseo changed its license to Apache-2.0 in v0.7.0, with third-party components retaining their own licenses. iOS/iPadOS and Android have public store listings. [Changelog][changelog] · [License][license] · [Downloads][download] |
| Three providers and brief notes on subagents | Ten integrations in Paseo's native support list, a generic ACP adapter and curated catalog, saved agent profiles, and product workflows for mixed-provider workers. [Providers][providers] · [Orchestration][orchestration] |
| QR-paired NaCl relay | Noise NK for current clients, legacy NaCl fallback, an optional daemon password, and documented direct, Tailscale and Desktop/CLI SSH transports. [Security][security] · [Connectivity][connectivity] |
| Chat, terminal, voice, early workspaces | Managed worktrees, editor and review tools, preview services and desktop browser, explicit native-session import, conversation forks, schedules, and a plugin registry. Hub adds external events and team management as a separate deployment. [Changelog][changelog] · [Plugins][plugins] · [Hub concepts][hub-concepts] |

## Workspaces, review, and preview

A Paseo daemon owns the working directory and workspace identity. A project
can contain several workspaces, each with several agent sessions, terminals
and other panes. The user can choose the project directory, adopt an
existing worktree, or create a managed worktree from a branch or pull request.
A workspace can exist before its first agent. Archiving the last workspace
using a Paseo-created worktree can remove the checkout. Adopted worktrees are
kept. The November changelog records checks for unsaved files and unpushed
commits before removal, and the source distinguishes workspace restore from
recovering deleted uncommitted changes. Branch and worktree operations affect
the repository even when the checkout itself is under `PASEO_HOME`.
[Workspaces][workspaces] · [Worktree guide][worktrees] ·
[Archive changes][changelog]

A repo can define setup, teardown, terminal presets and long-running services
in committed `paseo.json`. A checkout can get allocated service ports and
worktree-specific proxy URLs. Setup for pull requests from forks has an
approval gate, and v0.17.5 extends that protection to teardown when setup was
never approved. Worktree isolation separates files and branches. Processes
still share the host's OS account and network unless separately isolated.
[Worktree guide][worktrees] · [Parallel development][parallel] ·
[v0.17.5 release][paseo-release]

The workbench includes an editor, changes and commit history, Git actions,
and a PR/MR pane with checks and activity. Line comments from the diff can
be sent to an agent, including from the phone layout. The source has adapters
for GitHub, GitLab, Gitea, Forgejo, and Codeberg. Actions vary by forge. The
Electron browser can open a workspace service beside the terminal and diff.
Optional MCP browser tools route through the daemon to a connected desktop
app and target tabs in the agent's workspace. This path uses the Paseo browser
profile, including authenticated browser state. The browser host is
desktop-only and requires the relevant features to be enabled.
[Forge adapters][forges] · [PR pane][pr-pane] · [Diff feedback][diff-feedback] ·
[Browser architecture][browser]

YA's Source Control covers inspection, line-anchored feedback, remote checks,
fast-forward pull and explicit push. The project remains an existing folder,
with app-data-only storage by default. YA retired managed checkout lanes.
Project apps, isolated artifact viewing and remote Android/Apple Simulator
control cover a different part of the preview loop. The
[worktree file-link gap](../../gaps/session-worktree-file-links.md) already
tracks preserving the exact checkout identity for a session's files, and
[artifact review rounds](../../gaps/sketches/artifact-review-comments.md) tracks
submitting feedback on rendered artifacts.
[YA Source Control](../../topics/source-control.md#product-boundary) ·
[Project storage](../../topics/project-directory-storage.md) ·
[Workstream retirement](../../topics/workstreams.md) · [YA README][ya-readme]

## Providers, session data, and recovery

- **Provider breadth.** Paseo documents Claude Code, Codex, OpenCode, Pi,
  GitHub Copilot, Antigravity, Muse Code, fx, Hoplite, and Oh My Pi in its
  native support list. The registry uses dedicated integrations including
  Codex App Server, Claude, OpenCode and Pi RPC, alongside ACP integrations
  and a generic ACP adapter. Cursor, Gemini CLI and Hermes are examples in
  the ACP catalog. The CLI and credentials live on the execution host.
  Provider aliases, endpoint and binary overrides, and saved model, effort
  and mode profiles are separate configuration features. Catalog presence
  alone leaves import, permissions, model controls and resume
  provider-dependent. [Provider docs][providers] · [Registry][provider-source] ·
  [Custom providers][custom-providers] · [Agent profiles][profiles]
- **External history.** Paseo's explicit Import Session flow lists recent
  native sessions from the adapters that support listing, with optional
  working-directory and search filters. The daemon deduplicates against
  managed and archived agents. Import uses the selected session's native
  working directory, places it in a Paseo workspace, and retains a native
  persistence handle and a projected timeline. YA's Claude and Codex history
  appears in its ordinary browsable catalog and inbox, including sessions
  started outside YA. The comparison is about the path from discovery to
  supervision. [Import listing and placement][import-source] ·
  [Provider replay][import-replay] · [YA README][ya-readme] ·
  [YA history queries](../../topics/provider-history-facts.md)
- **Forking.** Paseo's chat action captures a projected conversation prefix
  as a history attachment and opens a new draft in the current workspace or a
  new one, with source provider and model settings prefilled. It can also
  capture a partially streamed turn. The draft can seed another provider.
  YA's fork and clone concern supported native conversation state, with
  provider-specific limits and a completed-turn boundary. Both products
  have a fork affordance, with different context preservation semantics.
  [Paseo fork driver][fork-source] ·
  [YA fork contract](../../topics/fork-from-turn.md) ·
  [YA provider coverage](../../topics/provider-fork-support.md)
- **Persistence and reconnect.** Paseo has daemon-owned JSON agent records and
  a sequenced timeline projection. The 200-item timeline value is a default
  fetch limit. Reconnect can use epoch and sequence cursors. The app includes
  a local replica cache backed by native SQLite or web IndexedDB. Its offline
  workspace-draft test expects a disconnected-host message. Local read state
  is implemented. Offline send and delivery remain unverified. [Agent storage][storage] · [Timeline store][timeline] ·
  [Replica cache][replica] · [Offline draft test][offline]
- **Execution lifetime.** Disconnecting the client leaves an independently
  running daemon in charge. Full Electron quit defaults to stopping a
  desktop-managed daemon, with a keep-running setting. Daemon startup
  recovery repairs stale running status; an opt-in path can send a resume
  prompt for eligible agents. This is a new dispatch on startup. YA's gated
  provider host can keep a live provider worker through a Hono reload on
  supported development launches. Linux defaults enabled there. macOS
  remains opt-in pending the documented active-turn issue.
  [Desktop settings][desktop-settings] · [Quit ownership][desktop-quit] ·
  [Paseo restart recovery][restart-source] · [YA architecture](../../ARCHITECTURE.md#provider-runtime-ownership-and-reload) ·
  [macOS gap](../../gaps/macos-provider-host-turn-interruptions.md)

## Execution and extension surfaces

**CLI, SDK, and agent tools.** Paseo's CLI covers agent run/list/send/logs/wait,
projects, workspaces, PTYs, permissions, schedules, plugins and named hosts.
There is a published TypeScript client SDK. Opt-in Paseo MCP tools let a
supervised agent create workers, message or wait for them, and control its
workspace. Child agents can use different providers, appear in a subagent
track and report completion to their parent. For another machine, the docs
describe the CLI connecting to a reachable daemon with its own host and
credentials. Each daemon owns its sessions and workspace paths. The CLI path
and client host picker establish remote targeting, while Hub adds a separately
enrolled dispatcher. Both paths place work on a target that owns the
resulting session. [CLI][cli] · [SDK][sdk] · [Orchestration][orchestration]

**Daemon-local schedules.** A schedule creates a fresh agent and workspace on
a cron cadence, while a heartbeat sends a prompt into an existing agent.
Schedules are visible in the app and controllable through CLI and MCP, with
pause, run-once and run history. Fresh-run workspaces archive by default.
The daemon atomically saves JSON schedule records, claims a due slot and
advances its cursor in one store update. Startup marks interrupted runs
failed and skips elapsed slots. This is a reference for scheduled dispatch and
recovery semantics. YA's current Project Queue owns idle-project admission,
and its general scheduler remains deferred.
[Schedules][schedules] · [Schedule service][schedule-source] ·
[YA Project Queue](../../topics/project-queue.md) ·
[YA scheduler gap](../../gaps/sketches/yacron-scheduler.md)

**Paseo Hub.** The optional Apache-2.0 service has its own organization,
credentials, integrations and activity history. It matches GitHub, Linear,
Slack, Discord, webhook, schedule and manual events to triggers configured in
a dashboard or version-controlled YAML. The selected daemon owns the
execution. Hub can route later events on the same issue or thread to the same
agent and record outcomes, with scoped integration rights and optional
replies. A daemon must explicitly grant `hub.execute`; that grant applies to
the daemon and includes agent state, timelines and workspace operations.
Enrollment, CLI login and execution authority are distinct. Hosted Hub
processes integration events and output even though provider processes run
on user hosts. Self-hosted Hub offers an embedded database or PostgreSQL,
and its repository still warns of early-development changes and data loss.
Public pricing on the review date was free self-hosting, 50 runs per month
for one hosted free seat, or $15 per hosted Pro seat per month with unlimited
runs. [Hub source][hub-pin] · [Dispatch][hub-dispatch] ·
[Hub concepts][hub-concepts] · [Hub authority][hub-security] ·
[Plans][hub-product]

YA's alpha HTTP v0 provides target-owned discovery, follow, authorized
commands, durable request receipts and bounded peer operations. It is the
comparison point for session control by another service. Paseo Hub adds a
packaged control plane for external event intake, authoring, continuation and
team visibility. Its organization membership and daemon execution grant
describe different authority from an individual client pairing.
[YA HTTP v0](../../topics/http-api-v0.md#target-owned-peer-apis-and-session-control--2026-11-13) ·
[YA cross-host delegation](../../topics/cross-host-delegation.md) ·
[Hub authority][hub-security]

**Plugins.** A daemon-level opt-in enables trusted plugins installed from a
reviewed registry entry, a Git source, a package or a local directory. The
plugin can contribute client panels, sidebar screens, composer actions and
timeline renderers as well as provider adapters, MCP tools and lifecycle hooks.
Client contributions load on connected clients, including mobile. Server
code and preparation commands run with the daemon user's access. v0.17.5
launch wraps can apply an execution boundary to selected workloads, while
the plugin itself remains trusted code. This extends the product at a
different scope from YA's provider integrations and optional external tools.
[Plugin SDK][plugins] · [Plugin hooks][hooks] · [Release][paseo-release]

## Remote access, notifications, and distribution

- **Connectivity and trust.** Clients can save multiple host profiles and use
  the optional relay or a direct address, including Tailscale. v0.17.5 added
  Tailscale setup in the UI. Desktop and CLI can also SSH-tunnel to a daemon
  already running on the remote host. Relay pairing carries the daemon's public
  key. Current endpoints use Noise NK (X25519, ChaCha20-Poly1305, SHA-256), with
  a configurable requirement to reject legacy NaCl fallback. An optional
  daemon password is sent inside the encrypted relay channel. Direct
  connections with a password depend on TLS or a private network for transport
  confidentiality. YA also offers direct and end-to-end encrypted relay
  connections. Its password-based relay login uses SRP, with no pairing offer
  required. [Paseo connectivity][connectivity] · [Paseo security][security] ·
  [Noise source][noise] · [YA remote access][ya-remote]
- **Notifications and voice.** Paseo's native push path sends through Expo.
  A source test verifies assistant preview text in completion payloads, so
  notification data can leave the daemon outside the relay. YA's separate
  native push broker is designed for bounded generic notification payloads.
  Paseo supports dictation and opt-in conversational voice, with daemon-local
  ONNX speech recognition and synthesis or configurable OpenAI-compatible
  endpoints. The local speech processing runs on the daemon host, which may
  be a different machine from the phone. Voice reasoning uses a configured
  coding agent. [Push transport][push] · [Push payload test][push-payload] ·
  [Voice docs][voice] · [YA architecture](../../ARCHITECTURE.md#shape)
- **Distribution and adoption.** Paseo publishes Electron packages for macOS
  Intel/Apple Silicon, Windows x64/ARM64 and Linux x64 (AppImage, DEB and RPM).
  v0.17.5 also ships an APK. The download page links public iOS/iPadOS and
  Google Play listings, a hosted web client, npm CLI and Nix. There is an
  official Docker image with the bundled web UI. The npm registry listed
  v0.17.5 for the CLI, server, client, protocol, relay, plugin and highlight
  packages. The Play listing showed 10K+ downloads and the US App Store 120
  ratings at 4.9 on the review date. These signals give distribution evidence
  without establishing active use or platform parity. YA has browser support,
  desktop beta releases and native mobile distribution still in progress
  under the roadmap. [Downloads][download] · [Release assets][paseo-release] ·
  [App Store][ios] · [Google Play][android] · [Docker][docker] ·
  [npm CLI][npm] · [YA release roadmap](../roadmap/README.md#1-publish-the-desktop-and-mobile-apps-with-continuous-delivery)

## Competitive implications

- **Worktree lifecycle is Paseo's strongest advantage for new work.** The
  checkout, agents, preview and review share one identity from start to archive.
  For ongoing work started in Claude Code or Codex, YA's automatic native
  discovery and cross-project attention inbox reduce the steps before a user
  can act. That distinction also matters when a user needs native provider
  context at a fork point or wants to carry a summary into another provider.
- **The distribution lead is observable now.** Paseo has store installs and
  an independently shipped desktop workbench. Its mobile apps and YA's
  bundled web UI in native shells represent different presentation choices.
  The release evidence establishes reach. Input, reconnect, active-turn
  survival and end-to-end mobile parity remain candidates for a controlled
  hands-on comparison.
- **Paseo now spans three automation boundaries.** Local schedules, agent
  coordination and Hub event dispatch solve distinct jobs. The most transferable
  patterns for YA's existing work are explicit target ownership, visible
  dispatch and continuation outcomes, and explicit cleanup. The
  [scheduler gap](../../gaps/sketches/yacron-scheduler.md) and
  [peer API contract](../../topics/http-api-v0.md) record YA's decisions and
  remaining scope.

[github]: https://github.com/getpaseo/paseo
[paseo-pin]: https://github.com/getpaseo/paseo/tree/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8
[paseo-release]: https://github.com/getpaseo/paseo/releases/tag/v0.17.5
[hub-pin]: https://github.com/getpaseo/hub/tree/8f090525dd0337d8de7155708d8340fd9be2c529
[hub-release]: https://github.com/getpaseo/hub/releases/tag/v0.12.0
[ya-pin]: https://github.com/kzahel/yepanywhere/tree/222763b88c3d4f71f0ad799d10cc5d0c52ca32bf
[ya-readme]: https://github.com/kzahel/yepanywhere/blob/222763b88c3d4f71f0ad799d10cc5d0c52ca32bf/README.md#features
[ya-remote]: https://github.com/kzahel/yepanywhere/blob/222763b88c3d4f71f0ad799d10cc5d0c52ca32bf/README.md#remote-access
[license]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/LICENSE
[changelog]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/CHANGELOG.md
[download]: https://paseo.sh/download
[ios]: https://apps.apple.com/us/app/paseo-remote-coding-agents/id6758887924
[android]: https://play.google.com/store/apps/details?id=sh.paseo
[npm]: https://www.npmjs.com/package/@getpaseo/cli/v/0.17.5
[docker]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/docker.md
[workspaces]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/workspaces.md
[worktrees]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/worktrees/index.md
[parallel]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/parallel-development.md
[forges]: https://github.com/getpaseo/paseo/tree/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/app/src/git/forges
[diff-feedback]: https://github.com/getpaseo/paseo/pull/6455
[pr-pane]: https://github.com/getpaseo/paseo/tree/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/app/src/git/pull-request-panel
[browser]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/browser.md
[providers]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/providers.md
[custom-providers]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/custom-providers.md
[profiles]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/agent-profiles.md
[provider-source]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/server/src/server/agent/provider-registry.ts
[import-source]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/server/src/server/agent/import-sessions.ts
[import-replay]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/server/src/server/agent/provider-session-import.ts
[fork-source]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/app/src/hooks/use-fork-agent.ts
[storage]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/server/src/server/agent/agent-storage.ts
[timeline]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/server/src/server/agent/agent-timeline-store.ts
[replica]: https://github.com/getpaseo/paseo/tree/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/app/src/runtime/replica-cache
[offline]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/app/e2e/browser/offline-draft.spec.ts
[desktop-settings]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/desktop/src/settings/desktop-settings.ts
[desktop-quit]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/desktop/src/daemon/quit-lifecycle.ts
[restart-source]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/server/src/server/agent/restart-recovery/index.ts
[cli]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/cli.md
[sdk]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/sdk/index.md
[orchestration]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/orchestration.md
[schedules]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/schedules.md
[schedule-source]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/server/src/server/schedule/service.ts
[hub-product]: https://paseo.sh/hub
[hub-concepts]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/hub/concepts.md
[hub-security]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/hub/security.md
[hub-dispatch]: https://github.com/getpaseo/hub/blob/8f090525dd0337d8de7155708d8340fd9be2c529/src/dispatcher/index.ts
[plugins]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/plugins/index.md
[hooks]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/plugins/hooks.md
[connectivity]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/connectivity.md
[security]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/security.md
[noise]: https://github.com/getpaseo/paseo/tree/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/relay/src/noise
[push]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/server/src/server/push/push-service.ts
[push-payload]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/packages/server/src/server/websocket-server.notifications.test.ts#L257-L291
[voice]: https://github.com/getpaseo/paseo/blob/713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8/public-docs/voice.md

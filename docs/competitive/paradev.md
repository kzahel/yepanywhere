# Paradev versus Yep Anywhere

Reviewed 2026-11-25 at Paradev `main` [296f25b][paradev-pin] and
Yep Anywhere (YA) [4d7c0fb12][ya-pin]. The full reference clone is at
`~/GitHub/Paradev`. This review uses source, public docs, release notes and
pricing. The latest Paradev desktop release observed was 2.0.11 on November 20.
App behavior, provider logins, deployment and paid flows were assessed through
source and documentation only. [Desktop release][release]

**Paradev's advantage is starting several changes in one repository and taking
each through preview, review and merge. YA's advantage is picking up work
already underway in Claude Code or Codex and supervising it from any browser.**
Paradev now has enough mobile review and agent control to compete directly for
that workflow, especially for developers who already start their tasks there.
[Paradev overview][overview] · [Paradev mobile][mobile] · [YA features][ya-features]

## Workflow comparison

| Workflow | Paradev | Yep Anywhere |
| --- | --- | --- |
| Parallel work in one repo | Defaults to a branch and Git worktree per task. Supports existing checkout mode, worktree import, setup/teardown, workspace terminals, and a board driven by agent and PR status. Archived worktrees can be restored from a retained branch with committed changes. [Workspaces][workspaces] · [CLI][cli] | Runs in the selected project directory. User-created worktrees are supported. YA removed its managed checkout lanes in October. [Workstreams retirement](../../topics/workstreams.md) |
| Agent choice and history | Runs arbitrary CLI agents in terminals. Claude Code, Codex, OpenCode and Pi have ACP chat with permissions. Supported CLIs can resume or fork, and desktop chat finds native history for a workspace and supported agent. [Chat][chat] · [Agent sessions][agent-sessions] · [History source][history-source] | Scans Claude Code and Codex history across host projects, including sessions started in terminals, VS Code, and first-party apps. The inbox combines attention, activity and recent history. Fork from a selected completed turn or clone the latest completed state. [Providers][ya-providers] · [Fork contract](../../topics/fork-from-turn.md) |
| Code review and delivery | Stage/commit/push, GitHub PR checkout and creation, checks, reviews and merge. A PR comment can go to the agent without posting to GitHub. Mobile can send diff comments and merge PRs. [PRs][prs] · [Mobile][mobile] | Inspect working-tree and commit diffs, tracked files and blame. Send source-anchored reviews to a new or existing session. Check remote, fast-forward pull and explicit push are built in. The agent handles commits, integration and recovery. [Source Control](../../topics/source-control.md#product-boundary) · [Review handoff](../../topics/source-review-to-session.md) |
| Preview and artifact feedback | Detects workspace ports, forwards remote ports to desktop, and opens previews in the embedded browser. Design Mode packages an element selection and screenshot for the agent. Hosted Pages add versioned sharing, pinned comments and delivery to a watching agent. [Browser][browser] · [Remote ports][remote] · [Pages][pages] | Project apps, reserved vhosts, session artifact viewing and Android/Apple Simulator streaming cover adjacent needs. Richer review rounds on artifacts are already tracked. [Project apps][ya-apps] · [YA features][ya-features] · [Artifact review sketch](../../gaps/sketches/artifact-review-comments.md) |
| Mobile and remote access | Native iOS/iPadOS and Android are on the stores and require Pro. Mobile Home groups workspaces for the selected machine with attention badges. Supports approvals, dictation, attachments, diff review and PR actions. Public docs describe mobile push as forthcoming. [Mobile][mobile] · [FAQ][faq] · [Android launch][android-launch] | Full mobile browser interface with Web Push, approvals, uploads and voice. Direct LAN/Tailscale, free public relay and self-hosted deployment options. Public docs list browser as the supported mobile path and desktop installers for macOS and Windows as beta. [Remote access][ya-remote] · [Notifications][ya-notifications] · [YA README][ya-pin] |
| Automation and coordination | Schedule or dispatch from GitHub, Slack, Linear, Sentry, and other integrations or webhooks. Runs target a device or cloud and can create a worktree or use an existing workspace. CLI, SDK and MCP expose workspace and agent operations. [Automations][automations] · [CLI][cli] · [MCP][mcp] | Durable Project Queue waits for the selected project to become quiet. Separate alpha v0 API exposes authorized session creation, commands, follow, receipts and peer operations. General scheduling remains deferred. [Project Queue](../../topics/project-queue.md) · [HTTP API v0](../../topics/http-api-v0.md) · [Scheduling sketch](../../gaps/sketches/yacron-scheduler.md) |

## What the source establishes

- **Worktrees are part of the workbench contract.** The host database owns
  project, workspace, terminal binding and PR records. Host code creates
  branch worktrees, including sparse checkout support, or adopts an existing
  worktree. The same workspace coordinates the branch, changes, dev server and
  terminal. Worktrees share the host's filesystem outside the checkout, network
  and processes. Paradev's migration guide uses this ordinary Git boundary to
  import Conductor worktrees in place and preserve the paths used for native
  history. [Host schema][host-schema] · [Worktree creation][worktree-source] ·
  [Conductor migration][migration] · [Paradev FAQ][faq]
- **Persistent terminals and structured chat have distinct owners.** The
  detached PTY daemon owns terminal processes and scrollback. Quitting the
  desktop app can leave terminals running while taking the host service
  offline. The standalone CLI can maintain host reachability. Structured chat
  has a local SQLite event journal and a native harness ID. The desktop history
  picker combines its workspace journal with supported ACP `session/list`
  results for that workspace and agent, and launches through the native ID
  where available. YA's distinction is host-wide history discovery and a
  session-first inbox. [PTY daemon][pty-source] · [Keep agents running][lifecycle] ·
  [Chat journal][journal-source] · [History source][history-source] ·
  [ACP adapter][acp-source] · [YA provider history](../../topics/provider-history-facts.md)
- **The relay trust boundaries differ.** Paradev hosts perform Git, terminal
  and agent work. Hosted identity and organization/host grants admit remote
  clients. The inspected relay terminates and forwards HTTP requests with
  application headers and body bytes, establishing that the relay can read
  this path. Its bring-your-own-cloud setup keeps files and sign-ins on the
  user-managed host and still uses Paradev's API and relay. YA's Remote Access
  path uses SRP-6a and application-layer NaCl encryption between client and
  host. The relay sees routing metadata and encrypted payloads. Public YA
  session shares use a separate trust boundary. [Paradev relay source][relay-source] ·
  [Bring your own cloud][byoc] · [YA security](../../topics/security.md#authenticated-remote-access-and-the-relay)
- **The public browser and notification stories have release boundaries.**
  Paradev's README mentions web access. Its FAQ says a web dashboard is
  unsupported, and the inspected workspace URL defaults to a desktop deep link
  with an `AGENTS_ENABLED` browser fallback. Hosted Pages have their own web
  surface. The mobile tree also includes iOS Live Activities and Android
  ongoing notification cards. These are distinct from general background
  push for a blocked agent, which the public FAQ lists as forthcoming.
  [Workspace deep link][web-source] · [Mobile activity source][activity-source] ·
  [Pages][pages] · [FAQ][faq]
- **Automations combine cloud dispatch and host execution.** The API matches
  normalized integration events against enabled triggers and dispatches through
  QStash. A run's `created` state records workspace creation. Run history also
  distinguishes a missed offline dispatch from a failed handoff. Hosted cloud
  workspaces add provisioned, metered sandboxes with a documented
  credential-injection path. [Trigger matcher][triggers-source] ·
  [Automations][automations] · [Cloud workspaces][cloud]

## Distribution and positioning

Paradev's MIT repository had 16,607 GitHub stars and 1,496 forks on November 25,
versus 558 stars and 82 forks for YA. These are repository signals. Paradev's
supported desktop target is macOS, with experimental Linux x64 AppImage builds
and no supported Windows desktop release listed. Free covers local workspaces,
desktop and CLI. Pro is $20/user/month monthly or $16/user/month billed annually
and adds remote access, mobile and automation. Team is $60 or $54 respectively
and adds cloud workspaces. Ultra is $200/month per user. The desktop and host
source is open. Full independent deployment of its commercial stack was outside
the verified scope. [Repository][paradev-repo] · [GitHub metadata][paradev-stats] ·
[YA GitHub metadata][ya-stats] · [Paradev FAQ][faq] · [Pricing][pricing]

Paradev has a concrete acquisition path for Conductor users. Add the repo,
import existing worktrees, carry over setup scripts, and resume agent history
where the provider retained it. Its parallel-agent recipe then makes the
benefit visible in one sitting. YA's equivalent demonstration is to start
Claude Code or Codex outside YA, open the session on a phone, approve an action,
and hand source feedback back to the agent. That shows why the product is
valuable even when the user keeps their existing desktop workflow.
[Migration guide][migration] · [Paradev quickstart][quickstart] ·
[YA getting started][ya-start]

## Implications for Yep Anywhere

1. **Lead with resuming existing sessions from a phone.** Mobile access alone
   is shared. The relevant combination is discovery across already-used tools,
   attention across projects on a host, browser push, and free remote access
   with a content-private relay. Account-based host sharing and store presence
   are real Paradev advantages. YA's [source-runtime direction](../../topics/client-source-runtime-topology.md#multi-host-ui-direction)
   already records a possible merged attention view across hosts.
2. **Study how Paradev keeps review attached to the right work.** Its
   strongest concrete pattern is selecting a PR diff line, check failure, or
   live preview element and returning that context to the right agent. YA
   already has durable source-review handoff. The competitive evidence supports
   the existing gaps around [exact worktree file links](../../gaps/session-worktree-file-links.md),
   [commit/session attribution](../../gaps/sketches/committed-change-session-attribution.md)
   and [artifact review](../../gaps/sketches/artifact-review-comments.md).
   Ordinary user-created worktrees are the relevant baseline under the
   [managed lanes retirement](../../topics/workstreams.md).
3. **Compare automation on observable outcomes.** Paradev makes triggers
   and handoff status visible and puts each result where a human can review it.
   YA's interesting comparison is whether an authorized queued or peer-created
   session is easy to find, follow and review after launch, using the existing
   [Project Queue](../../topics/project-queue.md) and
   [v0 receipts](../../topics/http-api-v0.md). That is a separate workflow from
   matching Paradev's hosted integration catalog.

[paradev-pin]: https://github.com/ParadevAI/Paradev/tree/296f25b450ca126aa2df291dbe905ab48ff15294
[ya-pin]: https://github.com/kzahel/yepanywhere/tree/4d7c0fb12b6f73edb77db34da751719afc5eab35
[paradev-repo]: https://github.com/ParadevAI/Paradev
[paradev-stats]: https://api.github.com/repos/ParadevAI/Paradev
[ya-stats]: https://api.github.com/repos/kzahel/yepanywhere
[release]: https://github.com/ParadevAI/Paradev/releases/tag/desktop-v2.0.11
[overview]: https://docs.paradev.com/overview
[quickstart]: https://docs.paradev.com/first-workspace
[workspaces]: https://docs.paradev.com/workspaces
[chat]: https://docs.paradev.com/chat
[agent-sessions]: https://docs.paradev.com/agent-sessions
[lifecycle]: https://docs.paradev.com/keep-agents-running
[prs]: https://docs.paradev.com/pull-requests
[browser]: https://docs.paradev.com/browser
[pages]: https://docs.paradev.com/pages
[remote]: https://docs.paradev.com/remote-access
[mobile]: https://docs.paradev.com/mobile
[faq]: https://docs.paradev.com/faq
[android-launch]: https://paradev.com/changelog/2026-11-22-new-layout-mobile-home-skills
[migration]: https://docs.paradev.com/migrate-from-conductor
[automations]: https://docs.paradev.com/automations
[cli]: https://docs.paradev.com/cli/cli-reference
[mcp]: https://docs.paradev.com/mcp-server
[byoc]: https://docs.paradev.com/bring-your-own-cloud
[cloud]: https://docs.paradev.com/cloud-workspaces
[pricing]: https://paradev.com/pricing
[ya-features]: https://yepanywhere.com/features
[ya-providers]: https://yepanywhere.com/docs/providers
[ya-apps]: https://yepanywhere.com/docs/project-apps
[ya-remote]: https://yepanywhere.com/docs/remote-access
[ya-notifications]: https://yepanywhere.com/docs/notifications-and-voice
[ya-start]: https://yepanywhere.com/docs/getting-started
[host-schema]: https://github.com/ParadevAI/Paradev/blob/296f25b450ca126aa2df291dbe905ab48ff15294/packages/host-service/src/db/schema.ts
[worktree-source]: https://github.com/ParadevAI/Paradev/blob/296f25b450ca126aa2df291dbe905ab48ff15294/packages/host-service/src/trpc/router/workspace-creation/shared/add-branch-worktree.ts
[pty-source]: https://github.com/ParadevAI/Paradev/blob/296f25b450ca126aa2df291dbe905ab48ff15294/packages/pty-daemon/src/main.ts
[journal-source]: https://github.com/ParadevAI/Paradev/blob/296f25b450ca126aa2df291dbe905ab48ff15294/packages/chat-runtime/src/db/schema/schema.ts
[history-source]: https://github.com/ParadevAI/Paradev/blob/296f25b450ca126aa2df291dbe905ab48ff15294/apps/desktop/src/renderer/routes/_authenticated/_dashboard/workspace/%24workspaceId/hooks/usePaneRegistry/components/ChatPaneTitle/hooks/useChatHistory/useChatHistory.ts#L37-L74
[acp-source]: https://github.com/ParadevAI/Paradev/blob/296f25b450ca126aa2df291dbe905ab48ff15294/packages/chat-runtime/src/harness/acp/acpAdapter.ts#L963-L1005
[relay-source]: https://github.com/ParadevAI/Paradev/blob/296f25b450ca126aa2df291dbe905ab48ff15294/apps/relay/src/index.ts#L334-L394
[web-source]: https://github.com/ParadevAI/Paradev/blob/296f25b450ca126aa2df291dbe905ab48ff15294/apps/web/src/app/workspaces/%5BworkspaceId%5D/page.tsx
[activity-source]: https://github.com/ParadevAI/Paradev/tree/296f25b450ca126aa2df291dbe905ab48ff15294/apps/mobile/modules/live-activity
[triggers-source]: https://github.com/ParadevAI/Paradev/blob/296f25b450ca126aa2df291dbe905ab48ff15294/apps/api/src/lib/automations/dispatchMatchingTriggers.ts

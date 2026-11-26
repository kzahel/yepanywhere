# All Projects — Quick Reference

Everything in the AI coding agent supervisor/wrapper space, in one table. For deep dives, see the individual docs linked from [README.md](README.md) and [community-projects.md](community-projects.md).

## First-Party (Official Tools)

| Name | One-liner | Link | License | Who | Stars |
|------|-----------|------|---------|-----|-------|
| **Codex App** | OpenAI's official desktop + cloud IDE for Codex agents | [openai.com](https://openai.com/index/introducing-the-codex-app/) | Proprietary | OpenAI | N/A |
| **Claude Code Desktop** | Anthropic's official GUI for Claude Code (local + remote execution) | [code.claude.com](https://code.claude.com/docs/en/desktop) | Proprietary | Anthropic | N/A |
| **Claude Code Remote Control** | Continue local CLI sessions from phone/browser via Anthropic's relay; `claude remote-control` or `/rc` | [docs](https://code.claude.com/docs/en/remote-control) | Proprietary | Anthropic | N/A |

## Funded / Major Third-Party

| Name | One-liner | GitHub | License | Who | Stars |
|------|-----------|--------|---------|-----|-------|
| **Warp** | Native terminal/workbench with third-party CLI supervision, browser/mobile Remote Control, attention mailbox, forks, review, hosted/self-hosted runs and adjacent Factories ([deep dive](warp.md)) | [warpdotdev/warp](https://github.com/warpdotdev/warp) | AGPL-3.0 client; MIT UI crates/worker/plugin; hosted services separate | Warp | 65,341 (2026-10-02) |
| **T3 Code** | Web/Electron/native-mobile workbench for six agents with offline mobile, event-sourced orchestration, multi-environment remote access, terminal, worktrees, and four-host source-control workflows ([deep dive](t3code.md)) | [pingdotgg/t3code](https://github.com/pingdotgg/t3code) | MIT | T3 Tools Inc. | 21,689 |
| **Paseo** | Self-hosted agent workbench with Electron, public mobile apps, native-session import, managed worktrees, mixed-provider orchestration, plugins, encrypted relay and optional event automation through Hub ([deep dive](paseo.md)) | [getpaseo/paseo](https://github.com/getpaseo/paseo) | Apache-2.0 | Mohamed Boudra | 25,681 (2026-11-26) |
| **Paradev** (formerly Superset) | Desktop workbench with managed worktrees, arbitrary CLI agents, ACP chat, GitHub review, native mobile, automations, and hosted sandboxes ([deep dive](paradev.md)) | [ParadevAI/Paradev](https://github.com/ParadevAI/Paradev) | MIT | Paradev | 16,607 (2026-11-25) |
| **bb** | Extensible web/Electron agent workbench with Claude/Codex/Pi/ACP, daemon-owned multi-host execution, managed worktrees, scheduling, durable workflows, and an early-access mobile WebView shell ([deep dive](bb.md)) | [get-bb/bb](https://github.com/get-bb/bb) | MIT | get-bb | 3,594 (2026-09-13) |
| **AionUi** | Electron desktop app + WebUI/Telegram/Lark/DingTalk for 17 ACP agents with cron scheduling | [iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi) | Apache 2.0 | iOfficeAI | 16,800 |
| **Happy** | Mobile + web client for Claude Code & Codex with E2E encryption and voice | [slopus/happy](https://github.com/slopus/happy) | MIT | slopus | 12,944 |
| **Claude Code UI (CloudCLI)** | Web UI for Claude Code, Cursor CLI, and Codex with file editor and terminal | [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) | GPL-3.0 | siteboon | 6,405 |
| **Omnara** | YC S25 — was mobile + web client for Claude Code; OSS repo archived Feb 2026, pivoted to proprietary voice-first agent platform | [omnara-ai/omnara](https://github.com/omnara-ai/omnara) (archived) | Apache 2.0 (archived) | Omnara (YC S25) | 2,608 |
| **emdash** | YC W26 — desktop terminal multiplexer for 21 CLI agents with git worktrees. **No output parsing** — just spawns PTY processes and streams raw terminal to xterm.js. Multi-agent "support" is a flat registry of CLI flags (~1 KB per agent). Not a structured supervisor. | [generalaction/emdash](https://github.com/generalaction/emdash) | Open source | General Action (YC W26) | 1,527 |
| **claude-devtools** | Desktop app for visualizing Claude Code sessions from JSONL logs | [matt1398/claude-devtools](https://github.com/matt1398/claude-devtools) | MIT | matt1398 | 1,254 |
| **Claude-Code-Remote** | Control Claude Code via email, Discord, or Telegram — reply to continue | [JessyTsui/Claude-Code-Remote](https://github.com/JessyTsui/Claude-Code-Remote) | MIT | JessyTsui | 1,067 |
| **Gemini-CLI-UI** | Web UI for Google's Gemini CLI with chat, terminal, file explorer, git | [cruzyjapan/Gemini-CLI-UI](https://github.com/cruzyjapan/Gemini-CLI-UI) | — | cruzyjapan | 599 |
| **CosmoRemote** | Native iOS/Android remote for Claude, Codex, Cursor, and terminal sessions on Macs, with a multi-Mac fleet and interactive simulator/emulator streaming ([deep dive](cosmoremote.md)) | [site-only repo](https://github.com/maththedev42/cosmoremote) / [npm bridge](https://www.npmjs.com/package/cosmoremote) | Partial: bridge package MIT; apps/relay closed | Matheus Weber | N/A |
| **Yep Anywhere** | Mobile-first supervisor with E2E encryption, tiered inbox, fork/clone, multi-agent (Claude/Codex/Gemini) | [kzahel/yepanywhere](https://github.com/kzahel/yepanywhere) | MIT | Kyle Graehl | 206 |
| **HAPI** | Local-first hub for Claude/Codex/Gemini/OpenCode with terminal page and file browser | — | Open source | — | — |
| **Vicoa** | "Vibe Code Anywhere" — mobile-first remote supervisor for Claude Code, Codex, OpenCode, Google/OpenRouter. Native iOS app + web + CLI. Freemium: free (50 msgs/mo), Pro $9.99/mo | [vicoa.ai](https://vicoa.ai/) | Proprietary | — | N/A |
| **Conductor** | macOS app for parallel Claude Code + Codex with git worktree isolation | [conductor.build](https://www.conductor.build/) | Proprietary | — | N/A |

## Community Projects

| Name | One-liner | GitHub | License | Who | Stars |
|------|-----------|--------|---------|-----|-------|
| **Codexia** | Tauri desktop workstation for Codex CLI + Claude Code with task scheduler, git worktrees, remote control, IDE editor, MCP ([deep dive](codexia.md)) | [milisp/codexia](https://github.com/milisp/codexia) | AGPL-3.0 | milisp | 489 |
| **Farfield** | Local web UI for remote-controlling Codex Desktop via IPC socket | [achimala/farfield](https://github.com/achimala/farfield) | MIT | achimala | 89 |
| **AgentOS** | Mobile-first multi-agent dashboard (Claude, Codex, Gemini, Aider, Cursor) | [saadnvd1/agent-os](https://github.com/saadnvd1/agent-os) | — | saadnvd1 | 81 |
| **Nimbalyst** | Electron desktop + native iOS app — visual workspace (WYSIWYG markdown, diagrams, mockups, Kanban tasks) with Claude Code & Codex session management | [Nimbalyst/nimbalyst](https://github.com/Nimbalyst/nimbalyst) | Proprietary | Karl Wirth | 81 |
| **Chell** | Claude Code session manager | [Cerulin/Chell](https://github.com/Cerulin/Chell) | — | Cerulin | 72 |
| **Obsidian Claude Anywhere** | Obsidian plugin with embedded relay and full terminal access | [derek-larson14/obsidian-claude-anywhere](https://github.com/derek-larson14/obsidian-claude-anywhere) | — | derek-larson14 | 65 |
| **Termly CLI** | Universal PTY wrapper for 20+ AI assistants with E2E encryption | [termly-dev/termly-cli](https://github.com/termly-dev/termly-cli) | — | termly-dev | 54 |
| **Codex Web UI** | Runtime-patches Codex Desktop's Electron app to expose full UI over HTTP | [friuns2/codex-web-ui](https://github.com/friuns2/codex-web-ui) | MIT | friuns2 | 47 |
| **ssh-to-go** | Self-hosted multi-host tmux dashboard and web terminal for persistent Claude, Codex, or any TUI session; also offers a CLI, early Android client, command API, and MCP pane control | [awkto/ssh-to-go](https://github.com/awkto/ssh-to-go) | AGPL-3.0 | awkto | 42 |
| **claude-code-supervisor** | Auto-review agent that iterates on Claude Code output; multi-provider | [guyskk/claude-code-supervisor](https://github.com/guyskk/claude-code-supervisor) | MIT | guyskk | 40 |
| **claude-code-app** | Mobile app for Claude Code (Flutter/Dart — true cross-platform native) | [9cat/claude-code-app](https://github.com/9cat/claude-code-app) | MIT | 9cat | 38 |
| **clauder** | Native iOS remote control for Claude Code (Swift) | [ZohaibAhmed/clauder](https://github.com/ZohaibAhmed/clauder) | MIT | ZohaibAhmed | 27 |
| **CodeRelay** | Multi-provider (Codex, OpenCode, Copilot ACP, Claude) mobile web UI over Tailscale with SQLite, interactive approvals, QR pairing | [ddevalco/CodeRelay](https://github.com/ddevalco/CodeRelay) | — | ddevalco | 30 |
| **Codex Pocket** | iPhone remote for Codex Desktop via Tailscale with SQLite persistence (predecessor to CodeRelay) | [ddevalco/codex-pocket](https://github.com/ddevalco/codex-pocket) | MIT | ddevalco | 24 |
| **claude-conduit** | Lightweight daemon to manage Claude Code sessions from iPad/iPhone | [A-Somniatore/claude-conduit](https://github.com/A-Somniatore/claude-conduit) | MIT | A-Somniatore | 22 |
| **247-claude-code-remote** | Tailscale + Fly.io VM provisioning for Claude/Codex/Gemini/OpenCode | [QuivrHQ/247-claude-code-remote](https://github.com/QuivrHQ/247-claude-code-remote) | — | QuivrHQ | 21 |
| **claude-remote** | Mobile chat with E2E encryption via Cloudflare tunnel | [jamierpond/claude-remote](https://github.com/jamierpond/claude-remote) | MIT | jamierpond | 16 |
| **ClawIDE** | Web IDE for Claude Code — terminal multiplexing, file editor, Docker, git worktrees — single Go binary + tmux | [davydany/ClawIDE](https://github.com/davydany/ClawIDE) | — | davydany | 13 |
| **Geoff** | "Side projects while you're at work" — multi-agent with Supabase sync | [belgradGoat/Geoff](https://github.com/belgradGoat/Geoff) | — | belgradGoat | 8 |
| **Poirot** | Native macOS companion for Claude Code — browse sessions, explore diffs, re-run commands (SwiftUI) | [LeonardoCardoso/Poirot](https://github.com/LeonardoCardoso/Poirot) | MIT | LeonardoCardoso | 55 |
| **Cogpit** | Desktop + web dashboard for Claude Code with undo/redo branching and cost charts | [gentritbiba/cogpit](https://github.com/gentritbiba/cogpit) | MIT | Gentrit Biba | 3 |
| **Moshi** | Native iOS terminal app using Mosh protocol for AI agent resilience | [getmoshi.app](https://getmoshi.app/) | Proprietary | — | N/A |
| **Chroxy** | React Native mobile app + Node.js daemon with Cloudflare tunnels and E2E | [blamechris/chroxy](https://github.com/blamechris/chroxy) | MIT | blamechris | 1 |
| **VSClaude WebApp** | Scrapes VS Code via Chrome DevTools Protocol for real-time monitoring | [khyun1109/vscode_claude_webapp](https://github.com/khyun1109/vscode_claude_webapp) | — | khyun1109 | 1 |
| **claude-link** | Control Claude Code from your phone via Telegram — message forwarding, voice support | [Qsanti/claude-link](https://github.com/Qsanti/claude-link) | MIT | Qsanti | 0 |
| **Harnss** | Electron desktop app for parallel Claude Code, Codex, and ACP agents with MCP server integration | [OpenSource03/harnss](https://github.com/OpenSource03/harnss) | MIT | OpenSource03 | 3 |
| **Clautel** | Use Claude Code from your phone via Telegram — manager bot spawns per-project worker bots | [AnasNadeem/clautel](https://github.com/AnasNadeem/clautel) | MIT | AnasNadeem | 8 |
| **Forge** | Self-hosted web platform for Claude Code with tmux terminal, YAML task orchestration, Cloudflare tunnels, Telegram bot | [aiwatching/forge](https://github.com/aiwatching/forge) | MIT | aiwatching | 1 |

## Adjacent: "Claw" Runtimes

These are LLM agent runtimes, not supervisors. They manage their own agent loops rather than wrapping existing CLIs. Different category but overlapping market.

| Name | One-liner | GitHub | Stars |
|------|-----------|--------|-------|
| **OpenClaw** | The original claw runtime — 38+ channels, 5,700+ skills | [openclaw/openclaw](https://github.com/openclaw/openclaw) | 215,000 |
| **Nanobot** | ~4K lines, research-friendly, MCP integration | [HKUDS/nanobot](https://github.com/HKUDS/nanobot) | 22,400 |
| **PicoClaw** | <10MB RAM, runs on $10 RISC-V boards | [sipeed/picoclaw](https://github.com/sipeed/picoclaw) | 17,200 |
| **ZeroClaw** | <5MB RAM, single binary, 22+ providers | [zeroclaw-labs/zeroclaw](https://github.com/zeroclaw-labs/zeroclaw) | 16,000 |
| **NanoClaw** | Container isolation (Docker/Apple Container) | [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) | 10,200 |

## To Research

Collected 2026-02-25 from Twitter threads after Anthropic's Remote Control announcement. Goal: research these and write an article about how the community loved building Claude Code wrappers/supervisors.

| Name / URL | One-liner | Notes |
|------------|-----------|-------|
| [deivid11/tide-commander](https://github.com/deivid11/tide-commander) | Visual multi-agent orchestrator with RTS-inspired 3D battlefield, 2D canvas, and metrics dashboard | npm pkg, Claude Code + Codex, file explorer w/ git diffs, conversation history, permission controls, command palette. MIT. |
| [egradman/extendo-cli](https://github.com/egradman/extendo-cli) | Human-in-the-loop decisions for AI agents via mobile push — structured UI cards (yes/no, choices, reviews) | iOS app (TestFlight), CLI sends decision artifacts to phone, agent blocks until human responds. Also captures ideas from Apple Watch. Self-host backend available. |
| [remote-code.com/claude](https://remote-code.com/claude) | Mobile app for Claude Code on iPhone with gesture nav and git integration | Proprietary (Vanna.ai). Pairs via "Uplink" desktop app. TestFlight beta, no pricing yet. |
| [comfortablynumb/claudito](https://github.com/comfortablynumb/claudito) | Web-based manager for multiple Claude Code agents with Ralph Loop iterative dev | npm pkg, Mermaid.js diagrams, MCP server config, auth with username/password. MIT. |
| [kibbler.dev](https://kibbler.dev/) | Remote mobile control for Claude Code with voice commands and IDE plugins | Proprietary. $3.99/mo. mTLS tunnel, approval mode for diffs, VS Code + JetBrains plugins, multi-session. |
| [cospec-ai/zane](https://github.com/cospec-ai/zane) | Phone remote for Codex CLI via Cloudflare Workers relay with passkey auth | Svelte web client, self-host on your own Cloudflare account. Push notifications, plan mode, diff review. Also has local mode (no Cloudflare). |
| [remotecodetrol.ai](https://remotecodetrol.ai/) | Native iOS app for controlling Claude Code + Codex from iPhone with Quick Actions and Bots | Proprietary. mTLS, no cloud. Scheduled/webhook-triggered automated workflows. Multi-provider (Claude, Codex, Gemini). TestFlight beta. |
| [ssv445/claude-wormhole](https://github.com/ssv445/claude-wormhole) | Access Claude Code sessions from any device via tmux + Next.js + Tailscale | PWA installable on iOS, push notifications, xterm.js WebSocket terminal. MIT. |
| [rohitg00/tailclaude](https://github.com/rohitg00/tailclaude) | Claude Code web UI published to Tailscale tailnet with streaming, cost tracking, model switching | Powered by "iii engine". QR code pairing, touch-optimized, OTel tracing. Tailscale Funnel for public access. |
| [mikeyobrien/rho](https://github.com/mikeyobrien/rho) | Always-on personal AI operator with persistent memory and proactive heartbeat check-ins | Not a Claude Code wrapper per se — more of an autonomous agent with memory. Web UI, Telegram, agent email. Built on pi coding agent. |
| [touchgrass.sh](https://touchgrass.sh/) | CLI wrapper that pipes Claude Code / Codex / Pi / Kimi through Telegram for phone control | Open source, free. Zero config, 60-second setup, cross-platform. |
| [sumansid/claude-app-server](https://github.com/sumansid/claude-app-server) | JSON-RPC 2.0 server wrapping Claude Code — the Claude equivalent of OpenAI's Codex app-server | npm pkg. stdio or WebSocket transport, QR code pairing, pair key auth, self-signed TLS. |
| [afkdev.app](https://afkdev.app/) | Remote desktop app for controlling your Mac from iPhone/iPad via WebRTC | Not Claude-specific — general remote desktop. P2P, E2E encrypted, no account needed. Proprietary, iOS app on App Store. |
| [beachviber.com](https://www.beachviber.com/) | Free PWA for remote-controlling Claude Code from phone with voice/image input and QR pairing | MIT (npm pkg), but GitHub repo not public. npm desktop agent (`@beachviber/agent`), cloud relay (encrypted pass-through), macOS/Win/Linux. Real-time streaming, tool approval workflow, multi-device. |

Already listed above: emdash, claudecodeui.

## Last Updated

2026-10-02 (Warp added; other entries and counts were not refreshed)

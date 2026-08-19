<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/public/branding/lockup-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="site/public/branding/lockup-light.svg">
    <img src="site/public/branding/lockup-light.svg" alt="Yep Anywhere" height="60">
  </picture>
</p>

<p align="center">
  <em>Mobile-first. End-to-end encrypted. Open source.</em>
</p>

<p align="center">
  <a href="https://yepanywhere.com">yepanywhere.com</a>
</p>

A durable, browser-based interface for Claude Code and Codex. Supervise agents
from another computer, a tablet, or a phone while they run on the machines you
control.

Use an eligible Claude or ChatGPT plan through the account already signed in to
the official provider tool. Yep Anywhere can also show current subscription
limits when the provider exposes them.

## Features

- **Persistent, interoperable sessions** — View and resume compatible work from
  CLIs, VS Code, and first-party desktop apps. Client disconnects do not stop
  server-owned processes.
- **Separately usable provider layer** — On Linux source checkouts, run the
  provider host with the non-watch development wrapper or by itself in a
  foreground terminal, then submit bounded turns through its stable
  [headless local protocol](topics/provider-host-api.md).
- **Mobile supervision** — Approve tools, answer questions, upload files and
  photos, use voice input, and receive attention notifications.
- **Multi-agent coordination** — Use the tiered inbox, global activity view,
  mid-turn steering, follow-up queues, search, recaps, forks, and clones.
- **Review and source control** — Browse working-tree and commit diffs, tracked
  files, and blame; bundle line comments into agent sessions; check remotes,
  fast-forward pull, push, or share a session read-only.
- **Remote device control** — Stream Android devices and Apple Simulators over
  peer-to-peer WebRTC with touch controls and adaptive quality.
- **Flexible remote access** — Connect directly or enable the end-to-end
  encrypted public relay and sign in from any modern browser without device
  pairing, a VPN, or port forwarding.

See the [complete feature catalog](https://yepanywhere.com/features) and
[public documentation](https://yepanywhere.com/docs) for availability and setup.

## Supported Providers

| Provider | Diffs | Approvals | Streaming | Notes |
|----------|-------|-----------|-----------|-------|
| Claude Code | Full | Yes | Yes | Primary provider, full feature support |
| Codex | Full | Yes | Yes | Full support including diffs and approvals |

OpenCode, Grok Build, Claude + Ollama, Gemini, and pi integrations are
experimental; capabilities vary. See the
[provider guide](https://yepanywhere.com/docs/providers).

## Screenshots

<p align="center">
  <img src="site/public/screenshots/session-view.png" width="250" alt="Session view">
  <img src="site/public/screenshots/conversation.png" width="250" alt="Conversation">
  <img src="site/public/screenshots/approval.png" width="250" alt="Approval flow">
</p>
<p align="center">
  <img src="site/public/screenshots/navigation.png" width="250" alt="Navigation">
  <img src="site/public/screenshots/new-session.png" width="250" alt="New session">
  <img src="site/public/screenshots/mobile-diff.png" width="250" alt="Mobile diff view">
  <img src="site/public/screenshots/device-stream.png" width="250" alt="Remote device control">
</p>

**Works great on desktop too!**

<p align="center">
  <img src="site/public/screenshots/desktop.png" width="400" alt="Desktop view">
  <img src="site/public/screenshots/desktop-diff.png" width="400" alt="Desktop diff view">
</p>

## Getting Started

If you can install Claude Code or Codex, you can install this. The runtime has a
narrow dependency surface.

**Desktop apps (beta):** Signed macOS and Windows installers are
available on [GitHub Releases](https://github.com/kzahel/yepanywhere/releases).
They are available now while release-readiness work continues.

**npm (established path):**

```
npm i -g yepanywhere
yepanywhere
```

Or, from source:
```bash
git clone https://github.com/kzahel/yepanywhere.git
cd yepanywhere
pnpm install
pnpm build
pnpm start
```

Open http://localhost:3400 in your browser. The app auto-detects installed CLI agents.

The complete phone and tablet experience is the responsive browser client. A
native app should add more than an app-store wrapper, so Android is in
development around reliable background notifications, deep links, trusted
packaging, and a multi-server inbox, with iOS planned afterward. Neither is
published. Follow the
[getting-started guide](https://yepanywhere.com/docs/getting-started) for the
current platform choices.

## Updating

For the npm-global install:

```bash
npm update -g yepanywhere
```

Then restart `yepanywhere`.

For a source checkout:

```bash
git fetch origin
git merge origin/main
pnpm install
pnpm build
```

Then restart the server with `pnpm start`.

## Voice Input and STT Keys

Browser-native voice input works without extra configuration. To use
server-mediated STT, export the provider key in the Yep Anywhere server
environment before starting the app:

```bash
export YEP_STT_XAI_API_KEY="xai-..."
export YEP_STT_DEEPGRAM_API_KEY="deepgram-..."
```

Providing `YEP_STT_XAI_API_KEY` auto-enables the `ya-grok` backend; providing
`YEP_STT_DEEPGRAM_API_KEY` auto-enables the `ya-deepgram` backend. These
`YEP_<MODULE>_<NAME>` secrets are consumed by Yep Anywhere and stripped from
child agent environments. The STT-specific xAI key is preferred over a general
`XAI_API_KEY`, which lets speech transcription use different billing from any
Grok model or CLI usage.

Local STT backends are opt-in and use the committed pixi `stt` environment:

```bash
# Enable one or more local backends before starting the server:
export YEP_VOICE_BACKENDS=ya-whisper
export YEP_VOICE_BACKENDS=ya-whisper,ya-parakeet
export YEP_VOICE_BACKENDS=ya-whisper,ya-parakeet,ya-nemo
```

When `ya-whisper`, `ya-parakeet`, or `ya-nemo` is enabled, startup
creates/updates the pixi environment if needed, installs the matching local STT
Python requirements, and downloads the selected model on first load. `ya-nemo`
uses the heavier optional `stt-bootstrap-nemo` add-on. If setup and model
validation succeed, the STT backend menu includes the local backend; otherwise
the server logs repair hints and hides the unavailable option.

If you already exported xAI's standard `XAI_API_KEY`, Yep Anywhere will also use
it for Grok STT and scrub it from child agent environments. Grok Build does not
receive `XAI_API_KEY` by default, avoiding accidental pay-as-you-go provider
billing; Settings > Providers has an explicit opt-in to pass that key to Grok
Build. For backend behavior and retention details, see the
[server-mediated STT topic](topics/pluggable-speech-recognition.md); for the
broader environment variable table, see
[topics/ya-env-vars.md](topics/ya-env-vars.md).

## Remote Access

**Easiest:** Use our free public relay when you want passworded,
end-to-end encrypted access from any browser. Configure it in Settings, or via
CLI for headless setups:

```bash
yepanywhere --setup-remote-access --username myserver --password "secretpass123"
```

Then connect from anywhere at [yepanywhere.com/remote](https://yepanywhere.com/remote).

Remote Access application traffic is end-to-end encrypted, so the relay
cannot read session contents. Public session shares are a separate opt-in path:
the current relay operator can read shared content. No accounts are required.

**Private network:** If you only need to reach a solo install from your phone,
a VPN such as Tailscale is usually simpler than deploying your own relay: put
the phone and dev machine on the same private network, then open the Yep
Anywhere server from the phone.

**Self-hosted web access:** Prefer to run your own public infrastructure? Use
Caddy or any reverse proxy with SSL termination. See the
[remote access docs](docs/project/remote-access.md) for details.

## Why not just use the terminal?

You *can* use the terminal on your phone — but monospace text is painful on a small screen, there's no file upload, no push notifications, and no way to see all your sessions at once. This gives you a proper UI while keeping everything self-hosted and running your code locally.

## Comparison to Other Tools

There are a lot of projects in this space. We track them all: **[docs/competitive/all-projects.md](docs/competitive/all-projects.md)**

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for build instructions, configuration options, and more.
For client render/update architecture and performance invariants, see
[packages/client/RENDERING_PERFORMANCE.md](packages/client/RENDERING_PERFORMANCE.md).

## TOS Compliance

Yep Anywhere uses the official [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) published by Anthropic. We don't handle authentication, spoof headers, or manipulate OAuth tokens. You authenticate via your own Claude CLI — we're just a remote interface to your sessions.

Read more: [How we use the SDK](https://yepanywhere.com/tos-compliance.html) | [Feb 2026 auth clarification](https://yepanywhere.com/sdk-auth-clarification.html)

## Star History

<a href="https://star-history.dera.page/#kzahel/yepanywhere&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=kzahel/yepanywhere&type=date&legend=top-left&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=kzahel/yepanywhere&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://star-history.dera.page/svg?repos=kzahel/yepanywhere&type=date&legend=top-left" />
  </picture>
</a>

## License

MIT

---
title: Updating
description: Update npm, source-checkout, and beta desktop installations without losing local sessions or settings.
---

## npm installations

```bash
npm update -g yepanywhere
```

Restart `yepanywhere` after the update. Your server state remains in the active
Yep Anywhere data directory, and provider transcripts remain in the provider's
own storage.

The server checks `updates.yepanywhere.com` for a newer release when a client
asks for version information, normally reusing the answer for a day, and sends
its version and a random install identifier. It never installs anything
itself. To turn the check off, start it with `YEP_UPDATE_CHECK=false`; the
device bridge version check stops as well, though downloading the bridge
still contacts the update server.

## Source checkouts

```bash
git fetch origin
git merge origin/main
pnpm install
pnpm build
```

Restart the server after the build. Review local changes before merging; do not
discard an edited checkout merely to update it.

### Keep work running during server reloads

For Node.js source checkouts on Linux and macOS, the optional **provider host**
lets you take YA web-server updates without disrupting ongoing work. It keeps
agent processes separate from the web server, so supported active turns and
pending approvals survive its replacement. On Linux, it also keeps project apps
and Live preview running with the same process and URL, including their
development watchers and hot module replacement (HMR).

This is most useful when running from source and updating YA frequently.
Users following packaged releases generally restart the whole installation
to update; those distributions do not currently expose this host mode.

The host also provides a local scripting API. Scripts can send a turn to an
existing session, queue it until current work finishes, and resume a stopped
session when they supply the required launch information. This lets automation
wake an agent without keeping a browser open. The authenticated HTTP API can
submit turns to running sessions, but cannot launch or wake a stopped session.
For request formats, feature negotiation and approval handling, see the
[provider host API](https://github.com/kzahel/yepanywhere/blob/main/topics/provider-host-api.md).

Linux development launches enable it by default. To opt in on macOS, run from
the checkout root:

```bash
YEP_PROVIDER_HOST_ENABLED=true pnpm dev
```

macOS currently defaults to off while reports of active turns ending during
long-running test tools are investigated. Its provider host supports agent
continuity, but process apps still require the Linux project sandbox. This
option applies to Node.js source launches, not packaged npm or Desktop apps.

To disable hosting, use `YEP_PROVIDER_HOST_ENABLED=false pnpm dev`. Changing
the option requires a full restart of the development launcher. Without
hosting, provider sessions and process apps are owned by the web server.

The benefit lasts while the host remains running: stopping its owning
terminal or launcher, restarting the host, or rebooting the machine stops
its processes. A host-code update therefore needs a full restart; a web-server
reload alone cannot install it. Apps require an explicit Start after losing
their host, and their working files are retained.

## Desktop apps

Use the in-app update check when an update is offered. A manual reinstall from
the [desktop downloads page](/download) is the v0 recovery path. Desktop
updates replace the shell, private runtime, and bundled
Yep Anywhere build as one unit while preserving the desktop data directory.

Automatic downgrade is not supported. Keep the installer for a version you
may need to restore manually, and read its release notes before moving between
beta builds.

## Hosted remote compatibility

The client at `yepanywhere.com/remote` can update before an installed server.
New optional controls are hidden when the server does not advertise the
required capability. If the hosted client recommends a server update, update
the server first rather than assuming a missing control is a browser problem.

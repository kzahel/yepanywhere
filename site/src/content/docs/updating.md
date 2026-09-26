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

## Source checkouts

```bash
git fetch origin
git merge origin/main
pnpm install
pnpm build
```

Restart the server after the build. Review local changes before merging; do not
discard an edited checkout merely to update it.

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

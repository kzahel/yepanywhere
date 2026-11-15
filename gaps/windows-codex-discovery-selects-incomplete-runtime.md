# Windows desktop Codex discovery can select an incomplete runtime

The installed Windows desktop app can select an old Codex fallback that reports
its version and starts an app-server, but cannot execute any command. The
maintainer requested recording the diagnosis and improvements, including a
Provider settings override and an execution probe. This entry captures proposed
work; no discovery, selection, or probe behavior has been changed.

## Reproduced failure

On 2026-11-15, desktop 0.10.0, packaged from `280c1a77c`, launched Codex
0.160.0 from `%USERPROFILE%\.codex\.sandbox-bin\codex.exe`. The rollout
recorded both command attempts failing before PowerShell started:

```text
failed to spawn code-mode host
<user-home>\.codex\.sandbox-bin\codex-code-mode-host.exe:
The system cannot find the file specified. (os error 2)
```

The executable existed, but its adjacent code-mode host did not. The session
used `danger-full-access` with approval policy `never`; this was not a denied
sandbox permission. The fnm-managed npm installation had Codex 0.169.0 and its
helper. The OpenAI app installation had 0.167.0-alpha.3.2 and its helper.

Running the installed discovery module under three environments reproduced:

| Environment | Selected installation |
| --- | --- |
| Shell with fnm initialized | npm/fnm Codex 0.169.0 |
| Windows machine and user PATH reconstructed from the registry | Incomplete `.sandbox-bin` Codex 0.160.0 |
| Reconstructed PATH with fnm's default alias prepended | npm/fnm Codex 0.169.0 |

The reconstructed environment was a diagnostic approximation, not a dump of
the desktop process environment. Its selection matched the actual desktop
child process. With that PATH, `where codex` found nothing and `npm prefix -g`
resolved the older nvm installation rather than fnm's default installation.

## Why the previous fixes did not cover this case

[`cli-detection.ts`](../packages/server/src/sdk/cli-detection.ts) collects PATH
matches, one npm global prefix, and common executable locations. It does not
discover fnm's default installation independently of PATH. Its candidate probe
checks only `--version`. The comparator demotes app-bundled prereleases below
any other versioned candidate, including an incomplete internal fallback.
[`server.rs`](../packages/desktop/src-tauri/src/server.rs) launches the packaged
server with the inherited environment, without initializing fnm.

This is a recurring interaction between discovery and ranking fixes:

- `6f54a6b8d` (March 27): added the `.sandbox-bin` fallback.
- `964949c11` (June 25): preferred Codex Desktop over that stale fallback.
- `112b56d2b` (July 11): fixed Windows npm shim probes and chose newest Codex.
- `fb733fac1` (August 20): fixed additional Windows command lookup cases.
- `3bb1c784a` (November 9): demoted app-bundled prereleases, allowing the stale
  fallback to win again when the app installation is an alpha.

The focused discovery tests cover individual ranking rules. The native
[`app-fixture.ts`](../packages/server/test/native-provider/app-fixture.ts)
supplies `YEP_DESKTOP_CODEX_CLI_PATH`, so its successful provider execution does
not establish that automatic desktop discovery selects a working installation.

## Proposed improvements

Keep discovery, selection, execution verification, and diagnostics together in
this fix rather than adding another isolated path-order exception. Update the
owning [discovery contract](../topics/windows-codex-cli-detection.md) when
implementing; its future selector section already describes the override idea.

- Discover supported fnm installations without requiring shell initialization,
  respecting the configured fnm root and default alias. Avoid sourcing arbitrary
  shell profiles or selecting an unused Node installation just because it is
  newer. Preserve the complete package and its helpers instead of copying a
  single executable into `.sandbox-bin`.
- Verify usability before applying version preferences. Treat internal fallback
  provenance explicitly instead of assuming every non-app binary represents a
  deliberately chosen user installation. A successful version query or protocol
  handshake alone must not establish command execution readiness.
- In Settings -> Providers -> Codex, offer Auto, detected installations, and a
  custom path. Show source, version, full path, selected status, and probe result,
  with Rescan and Test execution actions. Persist an override on the target
  server; new sessions use it and running sessions retain their executable.
  Show environment-provided overrides as managed configuration. A broken
  explicit override remains selected with an actionable failure rather than
  silently switching installations.
- Probe the selected production launch descriptor through the real app-server
  and tool execution path. A local scripted model response should request a
  harmless shell command in an isolated temporary workspace. Require a unique
  output marker and successful exit, including the code-mode host path when
  applicable. Bound the run and reap owned processes on success, failure, and
  timeout. Reuse the small applicable pieces of the existing
  [native provider harness](../topics/native-provider-testing.md), rather than
  inventing a second protocol/tool implementation.
- The execution probe should use isolated probe configuration and a local model
  endpoint, with no paid inference. Report command execution verification
  separately from account authentication and real model access; the local
  execution check does not establish those. Auto selection should choose among
  candidates that pass, retain results until the installation changes, and
  support explicit retesting without periodic background inference. Retain
  candidate rejection reasons so the selected path can be explained.

## Regression and acceptance evidence needed

Exercise automatic discovery under a desktop-like environment with no fnm PATH
initialization, a complete fnm installation, a newer complete app-bundled alpha,
and a stale fallback that answers `--version` but cannot execute tools. Do not
override the executable in this scenario. Require actual command output from
the selected runtime, not just a discovery result. Cover explicit selection,
broken-override behavior, installation replacement invalidating probe results,
timeout cleanup, and existing-session retention when the selection changes.
Coordinate probes and selection with the existing
[installation lifecycle](../topics/provider-installation-updates.md), including
updates and shared Codex aliases. Verify sequential typing and focus if adding
the custom-path input, including while rescans and probe results arrive.

Deferred because this request is to record the defect and improvement ideas,
not implement the runtime and settings changes. A path-only workaround would
restore this machine but would not close the selection or verification gaps.

Found 2026-11-15 while inspecting a Windows desktop session whose shell tool
failed before starting PowerShell.

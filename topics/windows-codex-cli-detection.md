# Windows Codex CLI Detection

Topic: windows-codex-cli-detection

## Problem

Windows can have several runnable `codex` installs at once:

- an npm/fnm shim on `PATH`, usually `codex.cmd`;
- an OpenAI desktop hashed binary under
  `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`;
- Codex-managed fallback binaries such as
  `%USERPROFILE%\.codex\.sandbox-bin\codex.exe`;
- user-managed installs under cargo, local bin, or other PATH entries.

On 2026-07-11, a Windows dev machine had `codex --version` resolving through
fnm/npm to `codex-cli 0.144.1`, while YA detected
`%LOCALAPPDATA%\OpenAI\Codex\bin\38dff8711e296435\codex.exe` at
`codex-cli 0.142.0`. The reason was not that the desktop binary was inherently
preferred; it was that YA probed PATH entries with Node `execFile`, which does
not execute Windows `.cmd` shims by default. After the PATH shim failed the
probe, YA fell through to common `codex.exe` locations.

On 2026-11-15, desktop 0.10.0 built from `280c1a77c` selected Codex
0.160.0 under `.codex/.sandbox-bin`. It reported a version and started an
app-server but could not spawn its missing code-mode host. The complete fnm
0.169.0 installation was absent from the inherited PATH, while the complete
app-bundled alpha lost the version-ranking preference. The shared repair below
addresses discovery, explicit selection and actual execution together.

## Current contract

[Provider CLI installations](provider-cli-installations.md) owns the shared
selector, profile storage, execution verification, cache and failure behavior
on Windows, macOS and Linux. Explicit environment or saved paths remain
authoritative; removing one never causes silent fallback.

Auto inventories PATH, npm, fnm's configured default and common locations.
Internal `.codex/.sandbox-bin` fallbacks rank below other installations. Among
other versioned candidates, app-bundled prereleases rank below deliberately
installed CLIs; stable app builds compete by version. Discovery order breaks
equal/unparseable-version ties. New session launches then require actual command
execution verification, trying the next candidate on failure. A successful
`--version` alone is never sufficient to authorize a new interactive runtime.

Windows npm/fnm command shims are first-class candidates. A recognized npm
package may launch its own native executable with its complete helper layout.
Other command shims use an explicit, escaped `cmd.exe` descriptor, with no
Node shell-plus-argument-vector launch. Catalogs and login flows retain the same
selected package identity. fnm discovery does not require initialized shell PATH
and never sources profiles or enumerates unused Node installations.

The 2026-11-15 regression reproduces a versioned native Codex copy with no
code-mode host, rejects it on actual execution and accepts the complete runtime.
A native Windows ARM64 command-driven smoke exercises automatic discovery with
fnm absent from PATH; the packaged GUI launch remains a release qualification
boundary rather than being inferred from that command-driven environment.

## Related Code

- `packages/server/src/sdk/cli-detection.ts` owns Codex discovery/version probes;
  `sdk/fnm-codex-discovery.ts` resolves the default fnm installation.
- `packages/server/src/services/CliInstallationService.ts` owns the shared
  selection/verification lifecycle, with adapters in `sdk/cli-installation-adapters.ts`.
- `packages/server/src/sdk/providers/codex.ts` resolves the command for cloud
  Codex app-server sessions and helper sessions.
- `packages/server/src/sdk/providers/codex-oss.ts` resolves the command for OSS
  Codex sessions.
- `packages/server/src/services/CodexUpdateChecker.ts` reports the installed
  version shown in Provider settings.

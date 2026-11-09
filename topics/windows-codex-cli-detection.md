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

## Current Contract

Explicit configuration stays authoritative. When the desktop runtime or an
operator provides `YEP_DESKTOP_CODEX_CLI_PATH`, YA should use that path and not
silently drift to a different install.

Auto-discovery is different: when no explicit path is configured, YA should
collect detected candidates, probe each usable CLI for its version, and select
the highest parsed Codex CLI semver. PATH order and common-path order remain
tie-breakers for equal or unparseable versions.

A desktop app bundle's prerelease never wins over another install that
reports a version. ChatGPT ships its own Codex build, often an alpha (on
2026-11-09 ChatGPT 26.1013 bundled `0.163.0-alpha.10.2` at
`ChatGPT.app/Contents/Resources/codex-cli/bin/codex`), and replaces it on the
app's schedule. Ranking it by semver alone would silently move YA off a stable
CLI the user installed. A bundle path is a macOS `.app/Contents/Resources/`
path or the Windows `OpenAI\Codex\bin\` directory; a stable bundled build
competes normally, and a bundled prerelease is still used when nothing else
is installed.

Windows command shims are first-class auto candidates. In particular, `codex.cmd`
from npm/fnm must be probed through a shell-compatible path so that YA sees the
same installed version a user sees from `codex --version`.

## Future Switcher

The eventual settings surface should expose a provider CLI selector:

- `auto`, using the auto-discovery contract above;
- specific detected candidates, labeled by source and path, such as PATH/npm,
  OpenAI desktop, sandbox fallback, cargo, or local bin;
- possibly a custom path entry for advanced users.

The selector should make the mapping explicit rather than letting provider
native ids or desktop-managed paths silently replace the user-visible YA choice.
Until that UI exists, the only persisted/configured choice is the explicit
environment-provided path, and the unconfigured behavior is auto.

## Related Code

- `packages/server/src/sdk/cli-detection.ts` owns Codex CLI discovery and
  version probes.
- `packages/server/src/sdk/providers/codex.ts` resolves the command for cloud
  Codex app-server sessions and helper sessions.
- `packages/server/src/sdk/providers/codex-oss.ts` resolves the command for OSS
  Codex sessions.
- `packages/server/src/services/CodexUpdateChecker.ts` reports the installed
  version shown in Provider settings.

# Testing

[Contributor guide](../../DEVELOPMENT.md) · [Development docs](README.md)

Commands and code paths below are relative to the repository root unless stated
otherwise.

## After Editing Code

After editing TypeScript or other source files, verify your changes compile
and pass `pnpm lint`, `pnpm format:check`, `pnpm typecheck` (no emit), and
`pnpm test`. For UI changes, also run `pnpm test:e2e`.

For site changes (marketing pages in `site/`):

```bash
cd site && npm run build   # Astro check + build (or: pnpm site:build from root)
```

Fix any errors before considering the task complete.

The general CI unit-test job runs `pnpm test`. Android unit, lint, build, and
instrumentation coverage belongs to the dedicated Android App workflow so its
Gradle work does not contend with the JavaScript workspace test processes.
Android JVM unit-test tasks have a five-minute task timeout and emit per-test
lifecycle output so a stalled worker fails with attributable evidence.

Captured provider regressions run offline in the normal server suite:
`pnpm --dir packages/server exec vitest run test/captured-provider.test.ts`.
The [corpus README](../../packages/server/test/fixtures/captured/README.md)
owns the capture/import recipe, coverage limits, and manifest format. These
tests use production readers/adapters and require no provider credentials or
private histories. Root typechecking includes their helpers and importer.

Environment-dependent subprocess tests must control both the child environment
and relevant process descriptors. In particular, Bash `BASH_ENV` probes use
ignored stdin rather than inheriting a test runner's socket-backed stdin. See
[subprocess environment boundaries](../../topics/subprocess-environment.md) for the
runtime and hermetic-test contract.

## Cross-Platform Behavior And Tests

Treat Linux, macOS, and Windows as supported development targets. Code and
tests must not assume that the current host's filesystem, descriptor, process,
or shell behavior is portable. Pay particular attention to path syntax and
case handling, symlinks, `/proc` and `/dev/fd`, permissions and file locking,
signals and process trees, executable discovery, temporary directories, and
shell availability.

For every OS-sensitive change, either use portable APIs and cover all three
platforms, or make the narrower capability explicit: document it, gate native
tests by platform or capability, and test the supported fallback on the other
platforms. Passing on one contributor's OS is not sufficient evidence. When
other-OS validation is unavailable, state that limitation in the handoff.
Never weaken a security boundary merely to make another platform pass.

## Device Control Testing

Use the Android emulator only when testing the device-control/device-bridge feature. Check with `source ~/.profile && adb devices` and deploy/test on the emulator for changes that touch device streaming, `/api/devices`, `deviceBridge`, or `packages/device-bridge`. For general client, server, web UI, provider, relay, or rendering changes, do not require emulator testing.

## ChromeOS Debugging

For Chromebook testing and debugging (screenshots, input, diagnostics), use the chromeos-testbed CLI — NOT the browser control skill (which is for local headless Chromium).

```bash
~/code/chromeos-testbed/bin/chromeos screenshot              # saves screenshot, prints path
~/code/chromeos-testbed/bin/chromeos screenshot output.png   # saves to output.png
~/code/chromeos-testbed/bin/chromeos help                    # full command list
```

Requires SSH access to `chromeroot`. See `~/code/chromeos-testbed/CLAUDE.md` for details.

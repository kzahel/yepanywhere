# CI runs the unit and e2e suites on Linux only, and never builds two targets

Cross-platform behavior is a stated project requirement, but the suites that
would catch a violation execute on one operating system. Audited against the
workflows in `.github/workflows/` and against actual recent runs on both
`kzahel/yepanywhere` and `graehl/yepanywhere`.

What is covered well, so it is not re-litigated here: `sqlite.yml` runs packaged
startup and the SQLite contract across ubuntu, macOS and Windows at Node
22.16.0, 23.11.0, 24.10.0 and 24, plus Bun legs, on every push.
`ci.yml`'s `agent-self-source` runs on all three operating systems, and
`windows-host-awake-smoke` covers one Windows-specific path. `desktop-ci.yml`
builds macOS aarch64 and x64 and Windows. `android-app-ci.yml` runs unit and
WebView instrumentation on ubuntu. `bridge-ci.yml` covers its own runner matrix.

The holes:

The focused `persistence-native` job now covers settings, directory-sync error
handling, Source Review persistence, and storage transitions on Linux, macOS and
Windows. This closes that persistence coverage hole; the broader suite gaps below
remain.

| Not exercised | Where |
|---|---|
| `pnpm test` on macOS or Windows | `ci.yml` `unit-tests`, `runs-on: ubuntu-latest` |
| `pnpm test:e2e` on macOS or Windows, or any browser but chromium | `ci.yml` `e2e-tests`, ubuntu + `playwright install chromium` |
| Any Linux desktop build | `desktop-ci.yml` matrix is macOS aarch64, macOS x64, Windows; its two ubuntu jobs are release orchestration only |
| Any build or test of `packages/ios-sim-server` | Swift package with `Package.swift` and `Sources`, and no workflow references it |
| Automatic performance regression detection | `performance.yml` is `workflow_dispatch` only, so it never runs on push |

The unit-test hole is the sharpest. Over five thousand server tests and the
whole client suite decide correctness for macOS and Windows users while only
ever executing on Linux, so a path-syntax, symlink, file-locking, process-tree
or executable-discovery regression reaches those users unopposed. `sqlite.yml`
partially compensates by starting the packaged server on all three, but startup
is not the suite.

Not fixed in place because widening the matrix is a maintainer cost decision,
not a code fix: adding macOS and Windows legs to `unit-tests` and `e2e-tests`
roughly triples those jobs' minutes, and the right answer may instead be a
reduced platform-sensitive subset, or a nightly full-matrix run rather than a
per-push one. The iOS and Linux desktop items may also be deliberate scope
choices rather than oversights; they are recorded here so the choice is
explicit rather than assumed.

Cheap first step if wanted: run only the platform-sensitive server tests on
macOS and Windows, selected by the areas
[cross-platform behavior](../docs/development/testing.md) already names —
paths, symlinks, `/proc` and `/dev/fd`, permissions and locking, signals and
process trees, executable discovery, temporary directories, shell availability.

Found 2026-09-10 while auditing what CI verifies for us after a push, prompted
by a `Server Runtime And SQLite` failure on `fe8e041fa` that turned out to be a
flaky macOS readiness timeout rather than a regression.

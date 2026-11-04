# npm publication does not require production startup of the packed package

The npm release workflow can publish a package whose production startup emits
a persistent failure banner. Existing package tests do not cover the complete
production startup path, and publication does not depend on their passing.

## Evidence

The provider-host startup change `0f42be02c` tried to import host scripts even
when the npm distribution shipped none. A normal Linux npm launch outside the
source checkout therefore logged a host startup failure and advertised
`providerHostDegraded`, producing the non-dismissible warning banner. The
package continued running agents in-process, which is the supported behavior
for a distribution without host scripts; the warning incorrectly called that
setup degraded.

Inspection of the published tarballs confirmed the bug in npm 0.9.0, 0.9.1 and
0.9.2. The source fix `2b3813297` landed September 27, 2026; the first fixed
npm publication was 0.10.2 on October 20. This entry tracks the remaining
release-verification gap, not the already-fixed provider-host bug.

Current checks leave three holes:

- [The package smoke](../scripts/agent-self-package-smoke.mjs) packs the staged
  distribution and installs it into a temporary directory. Its optional
  `--startup` path is exercised by the cross-platform
  [runtime/SQLite workflow](../.github/workflows/sqlite.yml).
- [The startup probe](../scripts/test-sqlite-startup.mjs) uses an isolated home,
  a working directory outside the checkout, and `NODE_ENV=production`, but
  also sets `USE_MOCK_SDK=true`. That bypasses real provider-host bootstrap.
  It checks HTTP, SQLite and WebSocket readiness without asserting that
  `/api/version` does not report `providerHostDegraded`.
- [The publication workflow](../.github/workflows/publish.yml) requires its
  own lint, typecheck and unit-test validation, then builds and runs
  `npm pack --dry-run`. It does not require the clean-package startup probe.
  [The release guide](../docs/development/releasing.md) does not require it
  either. The focused scriptless-host unit regression passes an explicit
  `null` root; it does not verify packaged entry-point discovery and startup.

## Closure criteria

Extend the existing package harness with a Linux production-startup case for
the packed candidate, installed and launched outside the checkout with an
isolated home. Exercise the normal provider-host decision without the mock
startup bypass or an explicit host-disable override. No real credentials or
cloud inference should be needed just to start the server.

Assert responsive HTTP and the expected package version, no degraded-host flag
or host-script import failure, and complete cleanup of the owned processes.
Verify that this case rejects the affected 0.9.2 artifact and accepts the fixed
candidate. Make successful acceptance of the candidate artifact a dependency
before `npm publish`, and document the requirement in the release guide.
Reuse existing packaging/startup infrastructure rather than adding a parallel
smoke suite or requiring a browser to inspect a flag exposed by the API.

Recorded instead of implemented because the requested scope was to capture and
commit the release-check gap after diagnosing the installed-package warning.

Found 2026-11-04 while auditing the provider-host banner across npm releases.

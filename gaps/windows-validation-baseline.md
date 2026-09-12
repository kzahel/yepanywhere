# Windows full-suite and checkout-format validation remain incomplete

The directory-sync fix has focused native settings/review/storage coverage, but
the full Windows gates remain red outside that change. Observed on Node 24.18.0
against base `845143a599c62d0e4057905bafb8d16906d2ae4e` plus the persistence fix:

- `pnpm test`, after building shared, reports server totals of 273 failed,
  4,777 passed, 103 skipped, and three unhandled rejections across 379 files
  (32 failed, 336 passed, 11 skipped). Shared passes 737 tests and relay passes
  130; recursive execution exits before a final client aggregate is available.
- `icacls` exits 1332 while handling existing unresolved SID entries in private
  storage ACLs. This affects public-share and provider-installation tests, among
  others; all three unhandled rejections originate in
  `ProviderInstallationCoordinator.test.ts`. Do not bypass ACL enforcement to
  make these tests pass.
- OpenCode reader tests leave SQLite files open at cleanup and fail with
  `EBUSY`. Other failures include Windows symlink privileges, POSIX path/shell
  assumptions, and watcher/timing expectations. Earlier evidence of the ACL,
  directory-fsync and SQLite-cleanup families is recorded in
  `docs/tactical/108-windows-codex-unread-activity.md`; this change removes the
  directory-fsync defect, not those other families.
- `pnpm format:check` encounters existing CRLF checkout content throughout the
  repository (for example `packages/client/e2e/codex-oss.spec.ts` and
  `tsconfig.base.json`). Exact changed-source formatting passes. Rewriting the
  entire checkout would create unrelated churn; establish portable checkout
  line endings and validate canonical source separately in a formatter task.
- Test launch emits Node `DEP0190` from `scripts/run-with-safe-home.js` using
  `shell: true` on Windows. That file already documents its package-script-only
  argument assumption inline. No new warning suppression was added. Lint has
  zero warnings and one existing informational `useTemplate` diagnostic at
  `packages/server/test/utils/native-tool-display-lifecycle.ts:91`.

These failures span permissions, provider fixtures, process launch, database
ownership and checkout policy. They cannot safely be repaired as incidental
cleanup of the settings-save fix. Continue with focused platform-specific
regressions and the broader CI coverage work in
[ci-platform-coverage-holes.md](ci-platform-coverage-holes.md).

The Windows dev-restart fix rechecked this baseline on 2026-09-12: lint and
typecheck passed; the full server suite still reported 273 failed, 4,784 passed,
103 skipped and three unhandled rejections (32 failed files). The full formatter
still reported the checkout-wide debt above; all restart source files passed
their exact-file lint and formatting checks. Those unrelated permission,
database, watcher and formatting failures remain outside the restart repair.
The new portable reload regression and server-admin tests passed, and a real
dev wrapper with a disposable HOME/profile completed five API restarts while
replacing backend/Vite PIDs, removing the prior launchers, and releasing all
three test ports on cleanup. Native Linux/macOS validation is delegated to the
existing provider-host CI matrix, which now includes the portable reload test.

Found 2026-09-12 while validating Windows directory-sync persistence fixes.

The unread-state repair rechecked the full workspace suite on 2026-09-12:
the server still reports 273 failed, 4,788 passed, 103 skipped and three
unhandled rejections (the same 32 failed files). The full formatter still hits
the existing checkout-wide CRLF debt. These broad permission, database,
watcher and formatting failures remain outside the read-state change;
focused server regressions, lint, typecheck and exact-file formatting pass.

The default Playwright global setup also assumes POSIX paths at
`packages/client/e2e/global-setup.ts:173`: replacing only `/` leaves a Windows
drive colon and backslashes inside the fixture directory name, so it fails
before any browser test. The read-state regression has a standalone config
that owns its backend and Vite without this unrelated global fixture corpus.
The Windows run used a fresh private temporary directory and the Windows
PowerShell module path for its ACL subprocess; the inherited PowerShell 7
module path otherwise prevents Windows PowerShell from loading `Get-Acl`.

The optional Computer Control candidate rechecked the gates on native ARM64
Windows with Node 24.13.0 and Biome 2.5.6 on 2026-09-12. The ARM64 Biome binary
crashes with exit code `0xC0000005`, including on a single source file, although
`--version` works. The same version's x64 binary works under emulation; an
ignored local tooling copy supplied `BIOME_BINARY` without dependency changes.
Root lint stops at `simple-client:check`: checkout CRLF makes
`packages/shared/src/experimental/simple-client.generated.ts` appear stale.
The full formatter still reports the checkout-wide CRLF debt. Scoped new and
modified source formatting/lint pass without warnings. Rewriting generated
contracts or changing dependency versions would hide unrelated checkout/tool
failures rather than establish portability.

The completed full unit run reports server totals of 298 failed, 4,860 passed,
103 skipped and three unhandled errors (36 failed, 344 passed, 11 skipped
files). It includes the existing ACL, SQLite cleanup, Windows path/shell,
provider launch and timing failure families above. One exposed dynamic-tool
text-normalization regression was fixed and its existing focused test passes;
the remaining aggregate must not be claimed as an exact baseline match or as
passing. A redundant final aggregate was cancelled when overlapping validation
exhausted the 4 GB VM; final focused/native checks run without that load.
The default UI E2E gate still fails in the POSIX-only global fixture setup.
The isolated Computer Control E2E owns its backend and Windows PowerShell
module environment and passes operator controls and old-server fallback.

`pnpm console:scan` remains at its existing budget of 110 ungated call sites
(warn 60, error 92), with no additions. Broad logging cleanup spans unrelated
owners and is not part of this feature. CSS architecture and capability audits
pass. The controller completed the final macOS aggregate gates: lint, formatting,
typecheck, 11,964 unit tests and 232 UI E2E tests (8 skipped). These passing
checks do not replace the unresolved native Windows aggregate gate above.

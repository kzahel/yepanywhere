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

Found 2026-09-12 while validating Windows directory-sync persistence fixes.

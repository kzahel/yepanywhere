# Runtime cutover checks retain package-manager and console-budget warnings

The immediate runtime cutover passed lint with zero warnings, i18n with zero
warnings and the touched runtime/component tests without runtime warnings.
Two broader checks still report explicitly retained diagnostics:

- `pnpm console:scan` reports 110 ungated chatty call sites, within the existing
  checked-in budget and unchanged by this task. They span transport, upload,
  rendering and device services. Resolving them requires reviewing the owning
  behavior and diagnostic needs across those surfaces; it cannot safely be
  folded into an advisory runtime notice. Follow `topics/console-chatter.md`
  and reduce the baseline alongside each owning fix.
- `pnpm install --no-frozen-lockfile` and Desktop's resource preparation report
  deprecated `@hono/node-ws@1.3.0`, `@types/diff@8.0.0`, and transitive
  `@ungap/structured-clone@1.3.0`, `glob@10.5.0`, `node-domexception@1.0.0`,
  `uuid@9.0.1`, `whatwg-encoding@3.1.1`. The Node-API SQLite addon update removed
  `prebuild-install` and its deprecation. Desktop also
  reports "Shared workspace lockfile detected but configuration forces legacy
  deploy implementation." Replacing the WebSocket/deployment dependency paths
  needs their own transport and desktop artifact validation; keep the current
  physical resource layout rather than removing the legacy flag just to hide
  its warning. The install-script block list also prints its existing ignored
  scripts, intentionally explained in
  [Dependency maintenance](../docs/development/dependencies.md#install-script-allowlist).

Fresh npm installation of the cutover artifact, unlike workspace maintenance,
completed without package-manager warnings. No global warning filter or raised
console budget was introduced. SQLite's accepted upstream experimental notice
remains documented in `topics/server-runtime.md`.

Found 2026-09-08 during server runtime cutover verification.

## Managed artifact validation — 2026-10-16

The current console scan reports 108 ungated chatty call sites (155 informational
sites), with no new calls in the managed viewer. The same cross-surface cleanup
constraint above applies. Its public browser acceptance emits no console/page
errors. The existing artifact-viewer Playwright runner emits Node's
`[DEP0205] DeprecationWarning: module.register() is deprecated. Use
module.registerHooks() instead.` during tool startup; all 18 scenarios pass.
This comes from the current Node/loader toolchain. Replacing that loader across
the shared E2E infrastructure needs separate runtime compatibility validation;
no warning filter or dependency churn was added to the artifact feature.


## Server Connections verification — 2026-10-31

The console scan remains within its 108-site warning budget (no new chatty
call sites). Cleaning these unrelated transport/rendering/device diagnostics
still needs the owning-surface review above. Connection/auth focused tests and
the new page's lint pass without runtime or lint warnings. The whole workspace
retains the documented SQLite experimental notices and expected negative-path
service logs; no global suppression or budget increase was added.

The broader client run also retains two jsdom “navigation (except hash changes)”
notices already present in the pre-Connections peer-access workspace logs. They
are unrelated to the browser-based new page, whose interactions run in Chromium;
no global jsdom/navigation suppression was added.


## Identity Service rename verification — 2026-11-02

The rename's scoped lint/format, typecheck, server build, 48 core cases, five
browser cases and complete workspace tests pass. The final whole-tree
`pnpm format:check` still reports formatter-only differences in concurrently
edited session-creation/provider files outside this task:

- `packages/server/src/sdk/providers/provider-runtime-worker.ts`
- `packages/server/test/routes/sessions-queued-start-metadata.test.ts`
- `packages/server/test/sdk/providers/provider-runtime-host.test.ts`
- `scripts/provider-runtime-discovery.mjs`

These were already active unrelated edits, not changes introduced or staged by
the naming task. Formatting/committing them here cannot safely be isolated
from their owner's in-progress semantic work. They are left untouched for that
workstream's final formatter pass; no formatter suppression was added. Exact
check output is retained in ignored
`tasks/identity-service-rename/phase3-format-final.log`. The console baseline
remains 108 warning sites; no new client logging was added.

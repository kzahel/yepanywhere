# Dependency maintenance

[Contributor guide](../../DEVELOPMENT.md) · [Development docs](README.md)

Commands and code paths below are relative to the repository root unless stated
otherwise.

## Dependency Security Maintenance

CI runs `pnpm audit --prod` on every push (the `audit` job in `ci.yml`) and it
must exit 0. Pay special attention to the `web-push -> asn1.js -> bn.js` chain.
Keep `bn.js` patched (currently via pnpm override) until `web-push` ships an
upstream fix.

When a transitive dep has no direct upgrade path, prefer a pnpm override. Pin it
exactly if a newer major would escape the parent's declared range — `fast-uri`
is pinned to `3.1.6` rather than `^3.1.6` because 4.x is published and `ajv`
declares `^3.0.1`. When the parent's declared range already contains the patched
version, no override is needed: refresh the lockfile with
`pnpm -r update <pkg> --depth=Infinity` (plain `pnpm update` skips transitive
deps).

### Install-script allowlist

Dependency install scripts (preinstall/install/postinstall) are blocked by
default via `onlyBuiltDependencies` in `pnpm-workspace.yaml`; only
`bcrypt` may run its native build. Relay and push broker used to add
`better-sqlite3` here; they now use the runtime's built-in SQLite through
`@yep-anywhere/shared/sqlite`, so the repository has no SQLite addon to build
or ignore and needs no compiler on any host.
This neutralizes the `"preinstall": "node setup.mjs"` vector used
by npm supply-chain attacks. If a newly added dep needs its build script,
`pnpm install` warns `build scripts that were ignored: <pkg>` and the
package will be missing its native binary at runtime — vet the script,
then add the package name to the allowlist. Blocked today, each verified
a no-op with no performance fallback: `esbuild` (native binary ships via
`@esbuild/*` optional deps; the postinstall only swaps the bin shim, and
there is no silent WASM fallback), `@firebase/util` (bakes
`FIREBASE_WEBAPP_CONFIG` into web-SDK defaults; unset here), `protobufjs`
(prints a version-scheme warning).

### Known-unreachable advisories

Advisories triaged as unreachable are suppressed via
`auditConfig.ignoreGhsas` in `pnpm-workspace.yaml`; that list and this
table must stay in sync — every ignored GHSA needs a row here, and removing a
row means removing the ignore. As of 2026-09-08 three advisories are triaged as
unreachable with no fix compatible with YA's current dependency and runtime
constraints. Re-check when the listed trigger fires rather than re-deriving the
analysis:

| Advisory | Why unreachable | Revisit when |
|---|---|---|
| `react-router` RSC-mode CSRF (GHSA-qwww-vcr4-c8h2) | Client is SPA-only — `BrowserRouter`/`Routes`, no `createBrowserRouter`, RSC, or server actions | Migrating to react-router v8. The fix lands in 8.3.0 and `react-router-dom` never reaches it (v8 consolidated into `react-router`) |
| `@hono/node-server` serve-static traversal (GHSA-frvp-7c67-39w9) | `serveStatic` is never imported; only `serve`, `getRequestListener`, `HttpBindings`, `RESPONSE_ALREADY_SENT` | `@hono/node-ws` supports node-server 2.x — its peer is currently `^1.19.11`, so 2.x breaks the WebSocket path |
| `uuid` buffer bounds (GHSA-w5hq-g745-h8pq) | Only path is `firebase-admin -> @google-cloud/storage -> gaxios@6`, which calls `uuid.v4()` with no arguments; the defect needs v3/v5/v6 with a caller-supplied `buf`. Patched only in `>=11.1.1`, outside gaxios 6's `^9` range | `firebase-admin`/`gaxios` declare uuid `>=11`, or a 9.x patch release appears |

Anything not on this list is untriaged — treat a new advisory as actionable.

## Automated Dependency Updates

The hosted Mend Renovate app proposes updates from `renovate.json`, using
GitHub's Dependabot alerts and OSV as advisory sources. Dependabot security
and version updates stay off so the same bump never arrives twice. Update
PRs open weekly, at most five at a time, after a release is 3 days old;
security fixes skip both waits. The Dependency Dashboard issue lists
everything pending.

- Renovate automerges only non-major devDependency updates at 1.0 or later
  and non-major GitHub Actions updates and digest pins. Everything else waits
  for review.
- `platformAutomerge` is off: `main` has no required status checks, so
  GitHub's native automerge could merge a PR with failing checks. Renovate
  merges only after every check on the branch passes.
- Workflow runtime inputs (`node-version`, `go-version`, `toolchain`,
  `java-version`) are not updated; CI deliberately runs at the supported
  Node floor.
- Major updates to `pnpm-workspace.yaml` overrides are disabled; see the
  exact `fast-uri` pin above.
- `@anthropic-ai/claude-agent-sdk` and the pixi STT environment update
  only when requested from the dashboard, because they follow the
  [provider refresh](../../topics/provider-refresh.md) audit and the
  known-good STT snapshot respectively.

Before changing `renovate.json`, run
`npx --package=renovate -- renovate-config-validator --strict`.

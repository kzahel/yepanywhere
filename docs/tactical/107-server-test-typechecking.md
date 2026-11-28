# Server Test Typechecking

Topic: testing

Status: Partial CI coverage. The full server test config exists and still
reports errors. Start with the sessions metadata fixtures in step 2.

## Goal

Get every server TypeScript test file under the root `pnpm typecheck` command
that CI runs. A dependency or route signature change should surface as a type
error in the affected test fixture.

The open evidence and a known stale dependency cluster are tracked in
[`gaps/server-tests-not-typechecked.md`](../../gaps/server-tests-not-typechecked.md).

## Boundary

Vitest strips types during execution. Keep strict checks enabled and repair
the fixtures to match the contracts their tests exercise. Avoid blanket casts
and changes that make required production dependencies optional.

A dedicated test configuration is preferable to broadening the production
build configuration: test globals, fixtures, source conditions, and emitted
output concerns differ, while production compilation should retain its current
boundary.

## Baseline

`packages/server/tsconfig.test.json` checks server tests and their imported
source without emitting. It uses bundler module resolution and permits explicit
`.ts` imports because Vitest owns test-module loading, including a small set of
direct client source imports. The production configuration remains NodeNext
and unchanged; its existing `src/**/*` include continues to own the two
source-adjacent test files.

The August 11, 2026 inventory found 610 diagnostics across 69 files. The
November 28, 2026 run found **1,017 diagnostics across 151 files**. An in-memory
probe that matched Vitest's `source` export condition, added the Node test APIs
to the TypeScript library list, and loaded JSX and Vite declarations for the
client imports left **990 diagnostics across 142 files**, all in the server
test tree.

CI currently checks **69 of 702 tracked server TypeScript test and spec files**.
The server build config owns two source-adjacent tests. `pnpm tools:typecheck`
adds 67 files through the tool-display, agent API eval, and native-provider
configs. All three targeted checks pass locally. The following counts come
from the unmodified full test config on November 28.

| Test file | Diagnostics | Owning issue |
|---|---:|---|
| `test/supervisor.test.ts` | 99 | Live-process cases need to narrow queued and queue-full results. |
| `test/services/RelayClientService.test.ts` | 67 | Captured WebSocket fixtures need explicit presence checks. |
| `test/routes/sessions-metadata.test.ts` | 59 | Seventeen route fixtures omit both `scanner` and `readerFactory`. |
| `test/sessions/codex-reader-oss.test.ts` | 43 | Reader fixtures and assertions need contract review. |
| `test/routes/global-sessions.test.ts` | 32 | Indexed response and collection entries need presence checks. |

All 125 metadata tests passed in Vitest on the same checkout. That suite
provides a starting point for verifying that fixture repairs preserve behavior.

## Local checks during cleanup

From the repository root, build shared declarations once after checkout and
again if shared types change. Run the server test check while editing.

```bash
pnpm --filter shared build
pnpm --dir packages/server exec tsc -p tsconfig.test.json --pretty false
```

Add `--watch` for repeated edits. For a single suite, use a temporary config
beside `packages/server/tsconfig.test.json` that extends `./tsconfig.test.json`
and sets `include` to that suite and any ambient declarations it needs. Run
`tsc -p` against that config to check the suite and its imports. Focused Vitest
runs verify behavior separately. For the first batch, run:

```bash
pnpm --dir packages/server test test/routes/sessions-metadata.test.ts
```

The broad server test check took about 10 seconds in an initial local run.
The current root `pnpm typecheck` passed in 66 seconds on the same Mac. Use
the root check at batch boundaries, especially when changing CI coverage.

## Work plan

### 1 — inventory the server test diagnostics (complete)

The non-emitting test config and baseline are available. Before repairing
fixtures that import client modules or use newer Node APIs, align the test
compiler settings with the runtime and confirm which diagnostics remain.

### 2 — repair the sessions route fixtures

Start with `test/routes/sessions-metadata.test.ts`. Reuse the existing test
helpers and centralize the required scanner and reader factory in a typed
route harness. Keep case-specific behavior in each test. Run the focused
typecheck and suite, then add the clean suite to CI.

### 3 — repair supervisor, relay, and remaining test fixtures

Group diagnostics by shared fixture or result type. Start with supervisor
result narrowing and relay WebSocket capture, then work through the remaining
clusters. Put each clean group under `pnpm typecheck` as it lands. After each
batch, record the remaining diagnostic and covered-file counts here. Keep
every enforced check at zero errors throughout the migration.

### 4 — gate the full server test suite in CI

Add a server `typecheck:test` script for the clean, non-emitting config and
call it from `pnpm typecheck`. Keep the source-adjacent tests owned by the
server build config. Consolidate overlapping server test entries in the
targeted configs and preserve their coverage of client tests and scripts.
Compare TypeScript's `--listFilesOnly` output with the server test and spec
inventory to verify coverage. Add a small coverage check if future include
or exclude changes could silently omit a test. Close the gap when CI enforces
the full check.

## Acceptance

- Root `pnpm typecheck` passes locally and in CI with 100% of server TypeScript
  test and spec files covered.
- A temporary invalid fixture in the newly covered test tree fails the root
  check. Removing the invalid change restores a passing check.
- The production build keeps its existing source and emit boundaries.
- The full test check uses strict settings, covers all test files, and adds no
  blanket casts or diagnostic suppressions.

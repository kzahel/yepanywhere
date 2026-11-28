# Server Test Typechecking

Topic: testing

Status: Implemented and verified locally. The existing CI typecheck job runs
the same root command.

## Goal

Get every server TypeScript test file under the root `pnpm typecheck` command
that CI runs. A dependency or route signature change should surface as a type
error in the affected test fixture.

The original gap was filed as `gaps/server-tests-not-typechecked.md`.

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

Before the migration CI checked **69 of 702 tracked server TypeScript test and
spec files**. The server build config owned two source-adjacent tests.
`pnpm tools:typecheck` added 67 files through the tool-display, agent API eval,
and native-provider configs. The following counts came from the unmodified
full test config on November 28.

| Test file | Diagnostics | Owning issue |
|---|---:|---|
| `test/supervisor.test.ts` | 99 | Live-process cases need to narrow queued and queue-full results. |
| `test/services/RelayClientService.test.ts` | 67 | Captured WebSocket fixtures need explicit presence checks. |
| `test/routes/sessions-metadata.test.ts` | 59 | Seventeen route fixtures omit both `scanner` and `readerFactory`. |
| `test/sessions/codex-reader-oss.test.ts` | 43 | Reader fixtures and assertions need contract review. |
| `test/routes/global-sessions.test.ts` | 32 | Indexed response and collection entries need presence checks. |

All 125 metadata tests passed in Vitest on the same checkout. That suite
provides a starting point for verifying that fixture repairs preserve behavior.

## Implementation and verification

- The test config uses Vitest's `source` export condition, the Node test APIs,
  and declarations for direct client imports. JavaScript imports can supply
  inferred types and JSDoc to TypeScript tests.
- The metadata harness supplies typed scanner and reader dependencies. Other
  fixture repairs narrow supervisor outcomes, validate captured WebSocket
  entries, and bring provider and route fixtures up to their current contracts.
- Root `pnpm typecheck` runs the server test script. The tool-display and agent
  API eval configs retain their client and script coverage. Native server tests
  now use the full server test config. All 103 files previously selected by
  the targeted configs remain covered.
- TypeScript's `--listFilesOnly` output covers all 700 tracked server TypeScript
  test and spec files. The test config covers 698 files, and the unchanged
  production config covers the two beside source.
- The server coverage check rejects a test file outside both configs. A
  temporary invalid fixture in the test tree failed root `pnpm typecheck`
  with TS2322. The root check passed after the fixture was removed.

See the [testing guide](../development/testing.md#after-editing-code) for
the current commands.

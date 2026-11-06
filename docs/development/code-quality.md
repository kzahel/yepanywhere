# Code quality and formatting

[Contributor guide](../../DEVELOPMENT.md) · [Development docs](README.md)

Commands and code paths below are relative to the repository root unless stated
otherwise.

## Zero-Warning Commits

Before committing, the checks you run must be warning-free, not merely
passing: `pnpm lint` reports zero warnings, and test runs covering the
touched areas emit no runtime warnings (React "cannot update while
rendering", "not wrapped in act(...)", and similar). Fix the cause rather
than suppressing the report; a warning that must stand needs an inline
justification.

“Pre-existing” is provenance, not an exemption. When a task's checks expose
warnings or source-format debt that can be safely isolated, clear them in a
separate cleanup commit instead of carrying them forward or folding them into
the behavior change. Use the owning formatter for source rewrites (Biome in
the current TypeScript/JavaScript tree; Ruff wherever a Python surface adopts
it). If the cleanup cannot be isolated safely, record the exact warning or
format check and the reason it remains in `gaps/`.

## Biome Import/Export Ordering

Do not apply Biome's organize-imports/exports assist as a routine cleanup.
Keep import/export edits scoped to the symbols needed by the change. Whole-file
ordering churn, especially in barrel files, obscures review and carries no YA
runtime-safety benefit. Run the project lint wrapper for diagnostics, but do not
turn a one-line import or export addition into a broad reorder solely to satisfy
organize-imports advice.

## Name Re-Exports Explicitly

`export * from` and `export * as` are banned by Biome's
`performance/noReExportAll` rule, which `pnpm lint` runs as an error. Re-export
each name: `export { a, b } from "./x.js"` and
`export type { T } from "./x.js"`. A star re-export:

- hides a module's public surface from its entry file, so additions to it
  (including helpers exported only for a sibling or a test) go unreviewed;
- turns "where does this name come from" into a search across every starred
  module;
- makes bundlers and the Vite dev server resolve every starred module to find
  one name.

An explicit barrel is longer. When that pushes a budgeted barrel over its
source-file budget, the explicit names are a legitimate `raise` reason; see the
[growth guard](../../topics/typescript-module-boundary-refactor.md#growth-guard).

Six files that predate the rule are exempted in the first `overrides` entry
of `biome.json`. That list only shrinks: convert a file's star exports to
explicit names, with its consumers' surface unchanged, and delete it from the
list in the same commit. Never add a file to it.

## Biome Formatting Is A Repository Invariant

`pnpm lint` remains a lint-only diagnostic command. `pnpm format:check` is the
separate non-writing formatter check, and CI requires both to pass. `pnpm
format` is the intentional repository-wide writer: the wrapper expands `.` to
the current tracked files and runs `biome format --write` over them.

During feature work in a shared or dirty worktree, format only the exact files
you edited:

```bash
node scripts/biome.cjs format --write path/to/file.ts path/to/other.tsx
```

Do not pass a directory or `.` for routine feature work, and do not use
`biome check --write` as a substitute: `check` combines additional concerns
that are intentionally separate here. A clean whole-repository `pnpm format`
is appropriate only for deliberately establishing a baseline or applying a
formatter-version migration.

Keep a broad mechanical rewrite in its own commit, time it against open PRs and
known in-progress work, and add its full hash to `.git-blame-ignore-revs` in a
follow-up commit. Never add a mixed behavior-and-format commit to that file.
The revision list is committed; GitHub honors it automatically, but local
Git does not enable it automatically.
Opt this checkout in with `git config --local blame.ignoreRevsFile
.git-blame-ignore-revs`, or pass `--ignore-revs-file .git-blame-ignore-revs`
to an individual `git blame` invocation.

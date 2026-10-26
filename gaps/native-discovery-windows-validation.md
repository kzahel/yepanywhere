# Windows validation limits for native discovery

The native discovery patch passes its real-file/HTTP acceptance and focused
reader/index/watcher regressions, but the whole workspace is not green in this
Windows checkout. Do not present the focused results as full-suite acceptance.

Baseline `805edd3a3ef81b3d01d13be81ca229c39eee4e16` reproduces these three
`packages/server/test/projects/scanner.test.ts` failures unchanged:

- `does not resurrect removed registered directories after discovery`
- `groups known workstream checkout cwd paths under the canonical project`
- `gives a project known only by id its sandbox directories`

The simple-client generated contract check fails on both baseline and patch.
The full root test command stops at the generated frame-find-agent check,
after 967 shared tests pass. The same generated-file check fails on the
unchanged baseline. Root typecheck stops in the optional desktop
workspace because its React/Tauri dependencies are not installed in this core
checkout. Shared and server TypeScript checks pass separately.

Root `pnpm format:check` reports CRLF-versus-LF differences across untouched
tracked files in this `core.autocrlf=true` checkout. The patch formats and
checks only its exact source/test files; changing thousands of unrelated
files would obscure the behavioral fixes rather than validate them.

These are outside the four native-discovery defects. Changing unrelated
generated contracts or Windows project identity semantics here would obscure
the review. Full-app startup previously hit `icacls /setowner` denial; the
patch does not bypass permissions. Linux/macOS and full-browser verification
remain pending; the existing native persistence CI matrix now runs the real-file
acceptance harness.

Found 2026-10-26 while verifying native session discovery fixes.

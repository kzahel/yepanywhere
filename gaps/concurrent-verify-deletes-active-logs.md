# Concurrent verify invocations delete each other's active logs

The shared `~/agents/scripts/verify` runner clears `.verify/last/` when
starting a run. A second invocation in the same checkout unlinks logs that
the first invocation still has open. Once its lint command exits, the first
runner crashes in `_matching_lines` with `FileNotFoundError` instead of
returning the check result.

Observed during the context-connector change: a separate publication's
`verify --only test:e2e` deleted this session's lint/typecheck logs. Copies
could be recovered through the running process's file descriptors; focused
checks were then rerun with separate output paths. Exit codes from the
underlying commands do not repair the lost runner result.

The fix belongs in the shared runner: each invocation needs its own log
directory, with `last` updated without deleting another active run's files.
It is outside the UI/provider refresh scope. Until fixed, concurrent callers
need separate command logs.

Found 2026-11-14 while verifying the context-window connector.
Contributing-model: 6-Astra

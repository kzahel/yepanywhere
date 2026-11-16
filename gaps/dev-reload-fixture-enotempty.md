# Development reload fixture can fail while removing its host directory

On source `de811d52b`, the first [CI 43903987109 unit job](https://github.com/kzahel/yepanywhere/actions/runs/43903987109/job/133427777988)
failed `replaces frontend and backend while preserving a live provider worker`
with `ENOTEMPTY` while recursively removing the private fixture's `host`
directory. The reload, provider inventory and fixture-child liveness assertions
before that removal passed. The error alone does not identify the writer or
establish a leaked production process.

The same source passed the full local workspace suite, an immediate focused
rerun (all three reload cases, 4.41 seconds), and the complete hosted unit-job
rerun. The first-attempt finding remains open. Preserve the directory contents,
writer identities and wrapper shutdown output on recurrence; do not weaken
process ownership checks or add blind deletion retries. This POSIX finding is
separate from the older [Windows identity finding](windows-dev-reload-process-identity.md).

Found 2026-11-16 while qualifying Desktop 0.12.1.

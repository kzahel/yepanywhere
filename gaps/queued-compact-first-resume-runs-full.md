# A compact-first resume that waits in the worker queue runs as a full resume

`Supervisor.resumeSession` honours `resumeMode: "compact-first"` only on its
immediate path (`startCompactFirstProviderResume`). At capacity the request
is enqueued, and `processQueue` → `startSessionInternal` always calls
`startProviderSession`, so the compaction is skipped and the message runs
against the full context.

Consequence: higher cost and possible context overflow exactly when the user
chose to compact first, and only under load, so it is hard to notice.

Fix: carry `resumeMode` through the queued request and branch the same way in
`startSessionInternal`.

Found 2026-11-08 while auditing resume paths for dropped session settings.

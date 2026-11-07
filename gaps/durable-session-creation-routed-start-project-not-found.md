# Routed Claude creation test sometimes ends at "Project not found"

`packages/client/e2e/durable-session-creation.spec.ts:324`, "routed Claude
accepts before startup and retains one session and native turn through
browser reload", fails intermittently. On 2026-11-07 it failed in a full
local browser run of an unpublished earlier version of `464171b92`, 1 of 3
focused runs at `464171b92`, and 1 of 4 focused runs at `9e97963aa`, before
plan 177 step 5, so it predates that change. Its `page.waitForResponse` for
`POST /session-creations` times out after five seconds because the form
never sends one. The failure screenshot shows the New Session form with the
typed prompt still in place and a "Project not found." toast.

`NewSessionForm.tsx` shows that toast for any start failure whose message
contains "404". The project field shows the fixture's realpath under
`/private/var/folders/...`, and the URL names the same project id, so the
404 most likely comes from `resolveProjectIdForSubmission`, which falls back
to `api.addProject(path)` when the loaded project list does not yet contain
the typed path. Whether the list, the selected project or the request is
what lags was not established.

Before changing the test or the form, record the requests the click sends
(project lookups, `addProject`, the creation request) and the project list
state at submit time on a failing run. If a start clicked before the project
list loads can fail for a project that exists, that is a user-visible bug in
the form, not a test problem; do not add waits to hide it.

Found 2026-11-07 while running the browser gate for plan 177 step 5.

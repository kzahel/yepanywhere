# Claude and Grok native watchers can miss children created after startup

The real aliased watcher integration for Claude child relationships sometimes
completed its initial scan and then received no native `fs.watch` callbacks
for a newly created child directory and sidecar on macOS with Node 24.22.1.
A failing trace showed the native watch opening and staying active through the
one-second assertion window. A passing trace showed `parent`, `subagents`,
and child file events. The Grok integration likewise received no callbacks
for a new child, and a separate workspace run missed a newly created parent.
Both fixtures now exercise the existing periodic rescan path for their small,
disposable trees alongside native callbacks.

Production hands off once after the initial baseline and reconciles on fresh
detail demand. To qualify automatic recovery in the startup window, exercise
that handoff with a withheld native event and a registered child source. Keep
reconciliation bounded to registered sources so this path avoids a second
full provider-tree scan.

Found 2026-11-24 while investigating intermittent workspace test failures.

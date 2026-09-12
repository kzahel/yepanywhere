# Project scanner persistence can finish after app disposal

`ProjectScanner.startSnapshotSave()` starts an asynchronous snapshot-save drain.
`ProjectScanner.dispose()` only unregisters its event-bus listener, and
`createApp().disposeSessionReaders()` does not await scanner persistence. A
focused-watch lookup during a one-shot request can therefore still create or
rename `indexes/project-scanner-cache.json` after app teardown has returned.

Observed while disposing a temporary app in the experimental Conversation
integration test: removing the app-data directory failed with `ENOTEMPTY` in
`indexes`. The test now isolates unrelated project discovery because its input
is an already retained catalog, while dedicated focused-watch tests own discovery.
The production lifecycle issue remains.

A follow-up should give the scanner an asynchronous shutdown that stops new
observations, cancels queued saves and settles in-flight save work, then call it
from app disposal. Cover shutdown racing a lookup/save. This touches the shared
scanner lifecycle beyond the Conversation adapter and is not folded into that
API change.

Found 2026-09-12 while integrating bounded experimental Conversation reads.

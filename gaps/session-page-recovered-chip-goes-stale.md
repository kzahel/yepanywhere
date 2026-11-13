# A session page can keep showing a recovered queue chip the server dropped

`topics/queued-messages.md` § Surface says the client renders the last
server-reported queue. For restart-recovered patient entries that report can
go stale, and the page then offers Resume, Steer now and Delete on an entry
that no longer exists. The actions now reread the queue when the server
answers "not found" (`dropMissingRecoveredEntry` in
`packages/client/src/hooks/useSessionQueuedMessageActions.ts`), so a click
clears the chip; the chip still appears until someone clicks. Three sources,
none fixed:

- **No queue updates without a live process.** `deferred-queue` events come
  only from a `Process` subscription (`packages/server/src/subscriptions.ts`).
  After a restart a session with recovered entries has no process, so a
  delete or resume from the Projects page, another tab, or another device
  never reaches an open session page. The server already emits
  `session-queue-persistence-changed` on the activity bus, and only
  `useProjectQueues` listens. Cheap fix: while the page's queue holds a
  `paused-after-restart` entry, reread session metadata on that event.
- **Queue change signals precede the durable write.** `Process` deletes or
  rewrites a durable row through an asynchronous chain
  (`enqueuePatientQueuePersistence`) but emits `deferred-queue` at once, and
  the stream projects `sessionQueueSummaries()` at that moment. On resume
  straight through (`deferMessage` with `promoteIfReady`) and on Steer now,
  the row is still `paused-after-restart` while the live queue no longer
  holds the entry, so that event lists it as a recovered chip. The route
  response waits for the write and is correct, and no later event follows
  the write, so a client that applies the event after the response keeps a
  ghost chip. Not reproduced; found by reading.
- **A slower metadata read can overwrite a newer mutation response.**
  `useSession` orders its own metadata reads with a snapshot token, but queue
  mutation responses applied through `setDeferredMessages` do not advance
  it, so a metadata read begun before a delete and finishing after it
  restores the deleted chip. Not reproduced; found by reading.

The session page's Delete also lacks the in-flight guard the Projects page
has (`mutatingRecoveredQueueIdRef` in `useProjectQueues.ts`), so a double
click sends two requests; the second now ends quietly.

Found 2026-11-13 while diagnosing a "Failed to delete recovered queued
message: Recovered queued message not found" toast after a server restart.
The server log does not record requests, so which source produced that
report is unknown.

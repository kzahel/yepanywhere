# A view gated on a server reply has no "this is taking unusually long" state

Requests now have a deadline: `API_REQUEST_DEADLINE_MS`
(`packages/client/src/api/requestDeadline.ts`) is two minutes and both
transports apply it, so a server that accepts the connection and then stops
answering eventually fails the request instead of leaving it pending forever.
What remains is what the reader sees during those two minutes, and after them.

A gated view has two states, loaded and errored, and nothing between. On a
healthy server the gap between them is imperceptible; on a stalled one the
reader sits in front of a bare spinner with no indication that anything is
wrong, no elapsed time, and no retry. `ProjectsPage`
(`packages/client/src/pages/ProjectsPage.tsx:244`) is the plainest case — a
loading div, with the error branch immediately below it at `:245`. `SessionPage`
(`:5123`, `:5727`), `GitStatusPage` (`:928`) and `NewSessionPage` (`:182`)
have the same shape. The 2026-09-10 symptom
was a black Loading screen and a New Session pane stuck on "Loading..." while
`GET /health` was taking 4-13 seconds; that server-side cause is fixed
([required SQLite](../topics/required-sqlite.md) § Data directory placement),
but any future slow server looks the same to the reader.

The wanted behavior is a third state after a few seconds of waiting: say the
server has not answered yet, and offer a retry rather than only a spinner.
`isRequestDeadlineError` (`packages/client/src/api/requestDeadline.ts`)
distinguishes a request that passed the deadline from an ordinary failure, so
the eventual error can say which happened.

Note what is *not* broken, so a fix does not go looking there. The polling and
refresh layer already handles slowness correctly: incremental session refresh is
single-flight with a last-wins pending slot
(`packages/client/src/lib/sessionDetail/sessionDetailCoordinator.ts:802`), the
public-share status poll reschedules from `.finally` rather than on a fixed
interval (`packages/client/src/hooks/usePublicShareStatus.ts:156`), and
reconnect uses capped exponential backoff with jitter
(`packages/client/src/lib/connection/ConnectionManager.ts:476`). Nothing piles
up concurrent requests against a stalled server.

Found 2026-09-10 while inspecting the client for burn and blocking under the
now-fixed network-home-directory server stall; narrowed to the presentation
half when the deadline landed.

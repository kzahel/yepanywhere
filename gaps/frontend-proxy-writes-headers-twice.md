# The dev frontend proxy can write a response's headers twice

`packages/server/src/frontend/proxy.ts:132` calls `clientRes.writeHead` when
the Vite response arrives, without checking whether the response has already
been answered. In a full local browser run on 2026-11-07 (of an unpublished
earlier version of `464171b92`),
`packages/client/e2e/artifact-viewer.spec.ts:136`, which runs this proxy
in-process, failed with an uncaught `Cannot write headers after they are
sent to the client` thrown there, and then its `Address name` field never
appeared. Something had answered the proxied request before Vite's response
came back.

The same proxy serves the UI of a development server
(`packages/server/src/server-main.ts:1626-1634`), and the server has no
`uncaughtException` handler, so the same double write would crash a
development server.

What answered first is not known. A scratch test with a slow upstream,
plain GETs and client aborts did not reproduce it. One lead, not
established: `@hono/node-server` writes its own response whenever Hono's
final response lacks the `x-hono-already-sent` header, which would happen
if an error handler or middleware replaced the already-sent response the
catch-all route returns. A `headersSent` check before `writeHead` would
stop the crash, but find the first writer before relying on it.

Found 2026-11-07 while running the browser gate for plan 177 step 5.

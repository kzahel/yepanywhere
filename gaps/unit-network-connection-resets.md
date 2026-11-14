# Full unit runs intermittently reset local HTTP/WebSocket connections

The conversation API's 2026-11-14 workspace checks observed two local transport
failures outside the changed surface:

- Node 27 alpha: `test/network/connection-safe-settings.test.ts`, "applies
  concurrent changes one after another", failed with fetch `ECONNRESET`.
  This runtime also failed the intentional supported-Node startup guard; it
  supplies no supported-runtime acceptance.
- Node 24.22.1: `test/routes/speech.test.ts`, "streams WebSocket audio when the
  backend advertises streaming", failed with `socket hang up` in a full run
  otherwise passing 7,471 server tests (95 skips). Its separate file run passed
  all 16 cases in 1.08 s. That establishes differing outcomes, not a cause.

No relationship between the failures is established. Capture the failing
connection's server/listener lifetime and upgrade path before attributing it to
host load, increasing timeouts or adding retries. The speech case currently
waits a fixed 100 ms before connecting; readiness and disposal ownership are
worth inspecting, but neither is proven to explain this reset. Preserve the
actual streaming and concurrent-listener assertions.

A complete repeat on the same Node 24.22.1 tree passes all 7,472 server tests
(95 skips) in 165.57 s. No transport code, time budget or retry was changed;
the intermittent failure still needs attribution.

These routes and fixtures are unchanged by the conversation work. Fixing their
lifecycle without a failing trace would expand that API task and could hide a
production transport defect. Logs are local investigation outputs under
`/tmp/ya-conversation-tests-node24.log` and `/tmp/ya-conversation-speech.log`.

Found 2026-11-14 while running the required full workspace checks for v0
conversation windows and native backing-store descriptors.

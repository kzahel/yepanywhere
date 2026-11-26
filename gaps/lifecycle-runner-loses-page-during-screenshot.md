# Lifecycle runner sometimes loses its page while taking a screenshot

An Android case of the
[lifecycle runner](../packages/client/e2e/lifecycle-study/README.md) now and
then ends with

```
page.screenshot: Target page, context or browser has been closed
    at capture (packages/client/e2e/lifecycle-study/run.mjs:298)
```

and is reported as a failed case with every acceptance check unmet, although
the app was never observed past that point. The same case passes when run
again. Seen four times on 2026-11-26 on an API 35 emulator with the minified
bundled app: `direct-session-read`, an `android-chrome` process-death case,
`android-wake-outage` at the `interrupted` capture just after the device woke,
and `mux-inbox-outage` at the `before` capture, before any fault.

`capture` checks `page.isClosed()` and then calls `page.screenshot`; the page
or its DevTools connection goes away in between. The run throws out of the
experiment, so no recovery time is recorded. The `before` occurrence rules out
the fault or a sleep and wake as the only cause.

Not fixed in place: the cause is unconfirmed. Either the WebView's DevTools
socket is replaced, or the instrumentation recreates the activity. A fix has
to tell those apart, and must not hide a real page loss,
which the `Recovery changed the requested page` check exists to catch. Retrying
the screenshot once on a re-resolved page, and recording a skipped capture
rather than failing the case when the page is verifiably the same document,
is the likely shape.

Found 2026-11-26 while measuring Android wake and relay-restart recovery.

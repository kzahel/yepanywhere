# Client browser unit suites can time out closing Chrome

A full macOS `pnpm test` run on 2026-11-10 passed the browser assertions but
hit the unchanged 10-second `afterAll` guard in four client suites:
`markdownPreviewCopy.test.ts`, `mobileKeyboardSteer.browser.test.ts`,
`ToolCallRow.preview-height.test.ts` and `editSelectionTransfer.browser.test.ts`.
The pending operations were page/context/browser close. Other tests and browser
verification were running concurrently; that correlation is not a proven cause.

An immediate focused rerun passed all seven cases in 2.11 seconds. The next
full workspace run passed all 7,342 client cases in 131 seconds and all 7,256
server cases in 147 seconds. This establishes a passing schedule, not reliable
cleanup under contention. Logs are `/tmp/191-test-final.log`,
`/tmp/191-browser-hooks.log` and `/tmp/191-test-verified.log` on this machine.

Defer cleanup/lifetime investigation from the CSS ownership slice. Investigate
the closing browser processes before changing a budget; no timeout, assertion
or logger was relaxed here. Existing jsdom navigation and negative-fixture
warnings remain tracked in their existing gaps.

Found 2026-11-10 while implementing plan 191 step 2.

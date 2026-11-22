# Typing while an older history page arrives can take 100 ms

Keystrokes typed while the session page prepends an older page of history
waited up to about 100 ms for their value to render. In the Antigravity log
browser case (`packages/client/e2e/antigravity-log-history.spec.ts`), a
programmatic click on Load older at the fifth key of 41 delayed one key a
few keys later: 82–104 ms with 4 MiB server pages (one phone run of 104.5 ms
in about eight) and 54–91 ms with 2 MiB pages, on one macOS arm64 host. All
other keys took under 20 ms, and every typed prefix was retained. Typing
during a log append and its catch-up, with the history loaded, stayed under
50 ms, which the browser case now gates at 100 ms.

The delay follows the client's handling of one older-page response (about
1,300 messages and 5 MB of JSON), not the server: halving the page size
lowered it only modestly. Claude and Codex send older pages of similar or
larger size, so they likely share it; that was not measured. The browser
case does not overlap Load older with typing, because a gate at the 100 ms
target would fail intermittently. Profile where the main thread spends the
time (JSON parsing, the prepend's transcript state update, or render), and
keep input acknowledgement independent of it, as
[sequential typing latency](../topics/ui-testing.md#sequential-typing-latency)
requires.

Found 2026-11-22 while adding typing during concurrent updates to the
Antigravity log browser case (plan 195 step 4, review round 1).

# Hosted native relationship qualification is not accepted

The first [native qualification run 42024897610](https://github.com/kzahel/yepanywhere/actions/runs/42024897610)
at `5ea03c920` failed all three jobs. Local macOS passes do not establish the
hosted boundary:

- Linux provider suite: 60 of 69 passed, 88.97 seconds total. Direct native
  children passed, but the configured OpenCode grandchild case exhausted its
  twelve-second budget. Other failures include Antigravity/OpenCode lifecycle
  and retry timeouts and Codex/OSS queued-tool content assertions.
- Linux app suite: four of ten passed. Reload/tool cases exhausted thirty
  seconds; Claude-to-Claude creation exhausted forty. A separate derived-index
  fault-injection writer hit SQLite contention; that fixture repair is part of
  plan 176's current qualification slice, not evidence that this job passed.
- Hosted macOS app suite: two of ten passed, 113.02 seconds total. Several
  fixtures never reached HTTP readiness within their thirty-second startup
  barrier; reload/tool cases exhausted their case deadlines. Browser steps
  were consequently not reached.

Attribute native provisioning, fixture construction, API readiness, model/tool
exchanges, persistence and cleanup before changing deadlines or concurrency.
In particular, check cleanup when fixture construction itself outlasts the
case. A timeout is a lower bound for budget derivation, not a performance fix.
The existing [OpenCode](opencode-native-scenario-budgets-under-concurrent-load.md)
and [Antigravity](antigravity-native-cold-resume-under-concurrent-load.md)
findings retain their independent load evidence. Codex's tool-content failures
need their actual result inspected, including possible incomplete exec results;
they are not yet a proved parser or runtime defect.

Local follow-up found two permission mismatches independently of those hosted
failures: the native fixture's Process default reset queued app-server turns,
and OSS exec resume omitted the launch sandbox. Both have native transcript
regressions, but neither is yet proved to explain the earlier hosted tool
content failures. Recent Responses inputs are now included in bounded failure
diagnostics so the actual returned tool result can establish that mechanism.

Retained logs are under ignored `tasks/session-relationships/slice-18-ci-linux-*`
and `slice-19-hosted-mac-app.log`. Keep hosted qualification explicitly pending
until the relevant jobs and browser steps actually pass. Do not relax the
100 ms input contract or manufacture native persistence to get acceptance.
This larger native/app boundary remains separate from the current relationship
fixture precision, completion-barrier and browser-clock corrections.

Found 2026-11-05 while qualifying durable provider-neutral relationships.

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

Native-app phase attribution now records monotonic times inside the fixture;
the earlier CI stdout blocks were printed after failure and their upload times
do not establish actual wrapper startup duration. Constructor cleanup also
starts before listener/environment acquisition and joins test cancellation.
Disposable controls reproduce the prior listener/root leak on an early setup
error, prove its repair, and prove timeout cleanup both before wrapper launch
and after a real wrapper spawns but before the caller retains the fixture.
These lifecycle repairs and new diagnostics still require hosted qualification;
they do not by themselves explain the original startup/control timeouts.

Watch the joined cleanup horizon on hosted runs as well: Vitest's existing
ten-second hook budget is shorter than the process terminator's full graceful
plus forced shutdown window. Local cleanup is around 250–350 ms; no hosted
teardown-budget failure has yet been attributed. Derive any hook-budget change
from actual termination progress and the supported shutdown window, preserving
joined cleanup rather than merely suppressing its errors.

Retained logs are under ignored `tasks/session-relationships/slice-18-ci-linux-*`
and `slice-19-hosted-mac-app.log`. Keep hosted qualification explicitly pending
until the relevant jobs and browser steps actually pass. Do not relax the
100 ms input contract or manufacture native persistence to get acceptance.
This larger native/app boundary remains separate from the current relationship
fixture precision, completion-barrier and browser-clock corrections.

Found 2026-11-05 while qualifying durable provider-neutral relationships.

The diagnostic [run 42040094970](https://github.com/kzahel/yepanywhere/actions/runs/42040094970)
at `a0627fb63` is also red: Linux provider 64/69, Linux app 5/10, macOS app
2/10, using four Vitest workers from the server configuration. All seven direct
native-child variants and nested OpenCode pass on Linux.
Antigravity's four failures have an SDK error before the first model request;
the old diagnostic omitted its text. Capture that error before treating its
timeouts as a budget problem. The fifth provider failure is OpenCode cancellation.

Linux app phases establish 21–22 seconds of cold API readiness before the
30-second reload/tool deadline. The four-CPU runner reports 84.4% whole-run CPU
busy, load up to 2.225 per CPU, CPU pressure and no swap use; it is contended
diagnostic evidence, not an eligible performance baseline. The three-CPU macOS
runner starts at load 50.08 with about 1.4 GB available and exceeds readiness
in its first eight cases; CPU/swap counters are unavailable. Later, less
concurrent cases reach readiness in 10–14 seconds. Every final fixture report
reaches root removal. Cleanup ownership is qualified for those runs, while
startup/reload acceptance remains open and neither hosted browser stage ran.

The workflow now exposes a bounded worker-count control, defaulting to two.
Both native runners record host windows, and native errors retain their text.
Compare separate `workers=2` and `workers=4` dispatches on one source before
attributing any result to concurrency.
No deadline, retry, assertion or provider behavior is changed by that control.

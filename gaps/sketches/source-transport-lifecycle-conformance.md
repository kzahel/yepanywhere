# Source transports pass one sleep, wake and reconnect conformance suite

Status: investigation started, 2026-10-07. The
[browser/emulator study](../../docs/testing/source-lifecycle-study-2026-10-07.md)
adds a real native comparison harness, visible error reproductions and a small
red unit case. The first Android repair now preserves typed request errors and
passes the direct/mux visible-503 reproductions. Android exhausted recovery now
has an explicit recoverability contract and platform network signals. The
page acceptance matrix checks Inbox/session/sidebar catch-up, drafts, input
acknowledgement and transient errors, with a sleep/wake case in normal Android
CI. The [second hardening round](../../docs/testing/android-lifecycle-hardening-2026-10-07.md)
adds process death, real notification taps, repeated sleep, forced Doze,
attachment-containing drafts and stock emulator Chrome comparisons. It records
shared attachment-validation and native notification-routing escapes, now
repaired under unit regressions and real-device-path emulator acceptance. The
shared all-transport conformance factory remains open.

On 2026-11-26 exhausted-retry recovery became one implementation shared by the
browser manager, the native bridge adapter and first acquisition, with an
exhaustive [conformance harness](../../topics/source-transport.md#one-exhausted-recovery-scheduler)
that replays every bounded event sequence against all three. That covers when
a waiting source probes. It does not cover the rest of this sketch: status
sequences, request errors, subscription catch-up or credentials.

## Purpose

Phone sleep, wake, network changes and server restarts are where clients go
wrong, and they are tested piecemeal. The contract exists in prose in
[source transport](../../topics/source-transport.md) (§ Request Semantics When
Not Ready, § Health And Recovery Ownership, § Recovery after a temporary
outage), but no shared test runs a `SourceTransport` through it. The native
data bridge originally answered with synthetic 503s while native reconnected,
and nothing failed until users saw the banners. That request error path is now
repaired; exhausted Android network recovery now remains `reconnecting`.

Make the lifecycle contract executable and bring Android up to the working
browser baseline. The agreed October 7 follow-up keeps browser recovery
behavior mostly unchanged; shared edits need a demonstrated defect and focused
regression coverage. Native remains the only SRP owner in the app.

## Direction

Agreed 2026-10-07:

1. Keep the native data bridge as the app's transport. A same-day replacement
   that handed the WebView native's resume credential was reverted in
   `65dcadaa5`: servers and the relay reject the bundled origins
   ([mobile-server-pairing § Bundled Web Client Transport](../../topics/mobile-server-pairing.md#bundled-web-client-transport)).
2. Build the conformance suite in this sketch and run it against the browser
   transports and the bridge's client half. The later October 7 direction
   preserves web recovery as the working baseline; record its failures and
   limit shared fixes to small, demonstrated defects. Web clients must not regress.
3. Repair the bridge until it passes: a typed retryable error instead of
   synthetic responses, requests held while native reconnects, and every web
   subscription field forwarded
   ([tool-output preference gap](../native-bridges-drop-live-tool-output-preference.md)).
   Then verify on a device.

The suite, not a transport switch, is what forces the lifecycle questions.

## Existing coverage

- `ConnectionManager.test.ts` with `MockTimers` and fake visibility
  (`ConnectionSimulator.ts`): backoff, ping/pong, visibility handling, critical
  operations.
- `recovery.test.ts`: exhausted-budget probes, signal coalescing, rate limits,
  stop on rejection, resume evidence.
- `recoveryConformance.test.ts`: the shared exhausted-recovery scheduler and
  its three owners over every bounded event sequence.
- `ReconnectSubscriptions.test.ts`, `SecureConnection.resume.test.ts`,
  `MultiplexSourceTransport.test.ts`, `ManagedStream.test.ts`, and
  `NativeSourceTransport.test.ts` over `nativeTransportFixture.ts`.
- Browser: `relay-integration.spec.ts` "recovers an exhausted relay connection
  on renewed activity without losing input" and auto-resume after refresh;
  `native-webview.spec.ts` for the bridge.

These test parts (the manager, the protocol, one stream) rather than what a
transport promises its callers, and each transport has its own tests. The
opt-in study now probes real native reconnection through the bridge, browser
freezing, bounded silent traffic stalls, cold process restart, repeated sleep,
forced Doze and real notification taps. Matched stock emulator Chrome cases
exercise the standard web client under the same controller. These do not
establish raw TCP dead-peer detection or complete physical sleep semantics.
Still uncovered: real silent peer death, sleep past credential/session expiry,
and server restart while hidden. The shared transport conformance factory also
remains open. Android CI runs the live native probes
(`test:live`) only after every instrumented test passes, so one unrelated
failure hides them.

## Scenarios

Each scenario asserts what callers see: the `status` sequence, the error type
demand requests receive, subscription catch-up, credential retention, and that
the page recovers without a reload. Typing during recovery must acknowledge
each keystroke within 100 ms (AGENTS.md).

| Scenario | Required outcome | Open defect it should reproduce |
| --- | --- | --- |
| Socket dies without a close event while hidden (half-open) | On visible, the wake ping times out, status goes `reconnecting`, then `ready`; subscriptions catch up | |
| Network lost and restored; wifi to cellular | `reconnecting`, demand requests wait bounded or fail with a typed retryable error, recovery on `online` | |
| Server restarts while the page is hidden | Recovery on visibility; the session page renders without reload | [background-relay-reconnect-blank-page](../background-relay-reconnect-blank-page.md) |
| Relay up, server down; relay restarts | Failure is not reported as rejection; the credential is kept | |
| Sleep past the session's idle expiry | Resume is rejected: the browser explains and offers login, the app asks native to sign in; never treated as network failure, never loops | |
| Request in flight when the phone sleeps or native reconnects | Typed retryable connection failure; never a synthetic HTTP status or blind write replay | Android request repair verified; extend shared conformance |
| Subscription misses events during the gap | Resumes from `lastEventId`; no missing or duplicated turns | possibly [live-user-turns-missing-until-reload](../live-user-turns-missing-until-reload.md) |
| Page frozen, then resumed (Android freezes background WebView timers) | Due timers fire once, one health check, no reconnect storm | |
| Renderer or process killed, document restored | Offline entry, drafts kept, connection acquired | Android cold-process acceptance passes; Chrome comparison records explicit URL reopening when needed |
| Refresh or forced reconnect while connected | Source returns to `ready` durably | [experimental-preview-refresh-disconnect](../experimental-preview-refresh-disconnect.md) |
| Server stalls after accepting | A visible slow state before the deadline | [client-requests-have-no-deadline](../client-requests-have-no-deadline.md) |

## Test levels

1. **Conformance unit suite.** A shared `describe` factory that takes a
   transport constructor plus a scripted socket or native channel,
   `MockTimers`, and fake visibility and online signals, and runs every
   scenario that needs no real browser. Run it against
   `MultiplexSourceTransport` (direct and relay), `SecureSourceTransport`, and
   `NativeSourceTransport` over a fake native peer that can drop, reconnect and
   stall. It belongs beside the existing transport tests and runs in
   `pnpm test`.
2. **Full-app browser cases with fault injection.** Reconnect across a real
   relay and server is a full-app contract under
   [E2E testing](../../topics/e2e-testing.md), so keep these few and on a
   worker-scoped server. Tools: `page.routeWebSocket` to stop delivering frames
   without closing (half-open), `context.setOffline`, the Chrome DevTools
   Protocol `Page.setWebLifecycleState` to freeze and resume, and restarting
   the worker's server or relay.
3. **Device runs.** Android emulator: `adb shell input keyevent KEYCODE_SLEEP`
   and `KEYCODE_WAKEUP`, `dumpsys deviceidle force-idle`,
   `cmd connectivity airplane-mode enable`, `am kill`. iOS simulator:
   background and foreground, server restart. These exercise the native half
   of the bridge, which no browser test reaches. Run them nightly or on demand
   through `~/kzahel/machine-control` rather than on every push, until their
   cost and stability are measured.

## Order

1. The conformance factory and the scenarios that need no browser, against the
   browser transports; record each failure as a gap or fix it in place.
2. The same suite against `NativeSourceTransport`; its failures are the bridge
   repair list in Direction step 3.
3. The browser fault-injection cases, starting with the blank-page and
   half-open scenarios.
4. Bridge repairs on Android and iOS, then device runs.

## Open questions

- Whether a hidden browser page should close its socket after some time. The
  bridge releases its lease on background; browsers keep theirs.
  [Architecture mandates](../../topics/architecture-mandates.md) bound server
  resources for closed tabs, not hidden ones.
- Whether the suite should also cover `LocalhostSourceTransport`, which is
  always `ready` and has no recovery to test.

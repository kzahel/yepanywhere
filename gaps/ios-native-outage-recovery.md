# iOS app has no recovery after its four-second native retry, and no outage test

An outage longer than about four seconds ends the iOS app's page and returns
the user to the native host list. Nothing retries afterwards. Android keeps the
page mounted as `reconnecting` and probes again on the
[shared recovery scheduler](../topics/source-transport.md#one-exhausted-recovery-scheduler);
iOS never reaches that scheduler.

This is read from source on 2026-11-26. It has not been run on a simulator.

- The shared Rust actor makes three resume attempts after a live connection
  drops, 250 ms, 1 s and 3 s apart (`reconnect` in
  `packages/mobile-core/src/session.rs`). On exhaustion it emits `FAILED` with
  `recoverable: true`, then ends and cancels its lease.
- `packages/ios/App/NativeBridge.swift` forwards that event, then its event
  loop fails on the cancelled lease and `fail()` closes the bridge and calls
  `switchHost`. The recoverable state reaches the WebView only as its document
  is being torn down.
- `HostModel.open` makes one acquisition attempt. On failure it shows "Could
  not connect. Your saved host is still available." and waits for a tap.
  Foreground return calls the same single attempt.
- Swift has no `reconnect` handling of its own: the command goes to the Rust
  actor, which is gone after exhaustion. Rust has no `status` operation, and
  nothing sends `networkAvailable` (no `NWPathMonitor`).

Android gets the missing behavior from Kotlin's `YaServerConnectionManager`:
a lease that outlives exhaustion, a `reconnect` that starts a new bounded cycle
or, with `retry: false`, a single attempt, a `status` query and a
network-available event. The WebView half, `RecoveryScheduler` with
`NATIVE_RECOVERY_POLICY`, is already shared and needs only that bridge
contract. Putting the manager's behavior in the shared Rust core would give
both shells one implementation; a Swift copy would be a second one to keep in
step.

There is also nothing to test it with. No test in `packages/ios/Tests` or
`packages/ios/UITests` covers an outage, a relay restart or a `RETRYING` phase.
The [lifecycle runner](../packages/client/e2e/lifecycle-study/README.md)
accepts only `browser`, `android` and `android-chrome`. The Rust tests call
`reconnect` on a healthy connection and assert no retry timing. An iOS client
for that runner, driving a simulator against the same fault gate, is the
matching harness.

Not fixed in place: the maintainer deferred iOS on 2026-11-26 while the
Android schedule was brought to the browser's.

Found 2026-11-26 while fixing Android passive recovery.

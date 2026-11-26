# Shared mobile transport migration

Status: implemented; local platform acceptance passed. Maintainer direction,
2026-10-02: prioritize Android's
Rust migration now and give iOS the same multi-host transport capabilities.

This continues [the iOS/core proof](138-ios-native-core-proof.md), after
simulator and physical iPhone acceptance. The existing
[mobile connection contract](../../topics/mobile-server-pairing.md) owns
source demand, route ordering, retry bounds, credential protection and isolation.
The [roadmap](../roadmap/README.md) keeps mobile publication the product goal.
The [iOS shell](../../packages/ios/README.md) now supports isolated artifact
previews and Blob export. On-device push enrollment remains release acceptance work.

## Scope and compatibility

Preserve the owner principal, existing SRP protocol, configured endpoints,
saved Android profiles, encrypted credentials, continuity keys and WebView
source boundary. The server requires no new route or capability. Limited-user
login and OPAQUE remain deferred. Kotlin and Swift retain platform storage,
login/host presentation, WebView, notification and OS lifecycle adapters.

### 1 — Share physical relay sockets across independent hosts

Implemented: Rust pool/circuit isolation checks and live two-server mux sharing,
independent close, reconnect and final cleanup pass. Per-profile consumer demand
is implemented in NativeRuntime/NativeSourceLease below.

Replace Rust's single-circuit wire with a bounded relay pool and circuit-local
queues. Discover mux only for eligible configured relay endpoints, retain exact
legacy fallback and direct sockets, handle overflow without losing peers, and
close idle sockets. Authentication and encryption stay independent per source.
Verify concurrent same-relay hosts, one-circuit teardown, slow-consumer isolation,
physical-socket failure and last-owner cleanup against disposable unchanged YA
servers and relays.

### 2 — Package and adopt Rust in Android

Implemented: Android production now uses Rust/UniFFI; the former Kotlin backend
is differential test code. Existing encrypted profile records and Keystore keys
remain compatible. All four ABIs, API 24, release ELF alignment and R8 native
bootstrap are verified. The owned live runner is wired into Android CI.

Generate Kotlin UniFFI bindings and Android libraries with pinned tooling.
Preserve the current minimum Android version and supported ABIs; package and
verify release libraries, including 16 KiB page alignment. Move production
authentication/encryption and connection work behind the existing Kotlin source
surface incrementally. Preserve route preference, scoped demand, background
ownership, three bounded retries, subscription restoration and non-replayed
requests/uploads. Convert credential representation only inside native protected
storage; preserve the authenticated protocol high-water across cancellation.
Use existing manager/bridge/storage tests plus live Rust execution and Android
instrumentation as gates. Production has one transport backend.

### 3 — Use the common connection ownership on iOS

Implemented: HostModel uses the shared profile runtime and consumer leases.
Switch Host preserves sibling demand; suspension retires the foreground runtime.
A successful continuity proof is remembered per authenticated nonce so a new
document does not submit a different proof on an already-bound connection.

Keep saved-host selection separate from transport demand. Multiple independent
native source owners can share a relay socket; retiring one document/profile
cannot close another owner's circuit. Preserve Keychain, per-profile WebKit
storage, route/draft restoration, source-document checks and iOS suspension
rules. iOS does not promise Android foreground-service behavior. Re-run native,
simulator UI and available physical-device acceptance.

### 4 — Record and verify the migration

Keep observable contracts and roadmap status current at each landed checkpoint.
Run Rust tests/Clippy, unchanged-server direct/mux/legacy probes, Android
unit/lint/release packaging and applicable device tests, iOS regression acceptance,
and the required root checks. Commit verified slices as work progresses.

## Acceptance, 2026-10-02

- Rust: 22 tests and warning-free Clippy; unchanged-server direct, mux and exact
  legacy probes, with scoped sibling subscriptions/uploads and profile teardown.
- Android: JVM tests, lint, both release channels and APK contracts pass. Every
  packaged native ELF load segment has at least 16 KiB alignment. The physical
  Pixel 7a passes the R8-minified direct/security and mux/two-host acceptance.
  Existing credentials resume through unreachable-preferred-route fallback;
  two hosts share one relay socket and retire independently. The WebView uploads
  100 MiB while sequential typing peaks at 16.6 ms (direct 1 MiB: 35.4 ms).
- iOS: 17 native simulator tests and both UI tests pass; unsigned Release device
  linking passes. On the physical iPhone SE (3rd generation), all 16 applicable
  native tests (simulator-local TLS fixture excluded) and both UI tests pass.
  This includes sibling survival on Switch Host and runtime retirement on
  suspension. Typing records 37 inputs, zero drops, a 19 ms peak and 294
  concurrent transcript mutations; the owned producer records 1,401 updates
  without failure over the full UI test.
- Root lint, formatting, typecheck and workspace tests pass. No server route,
  verifier, authentication version or password/credential migration changed.

The device probes use disposable servers, fixture profiles and public fixture
credentials. They preserve the ordinary app's protected records; generated
signing products, hardware selection and captures remain private/ignored.
Store signing/publication, broader tablet/network acceptance, the existing iOS
viewer/download gap and common native push enrollment remain separate work.

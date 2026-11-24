# Android pairing can remain busy after successful registration

On the owned Android 15/API 35 ARM64 emulator (WebView 124.0.6367.219), a fresh
bundled Debug app completes SRP login and persists its device registration on
the real YA server through the public encrypted relay. The native host screen
then remains busy, with Open full app disabled, for the 45-second observation
window. No WebView is created. A force-stop and normal launcher restart resumes
the saved profile and reaches the bundled viewer.

The same stall reproduces with the unmodified main server at `9b44f3c67`.
The feature branch changes no Android or mobile-core source, so this is not a
managed artifact preview regression. Registration is independently observed
through the real server's security-client inventory before the stall. Root
cause is not established. Inspect `YaPairingCoordinator.pair()` and its
`transport.closeAndAwait()` cleanup, and the native transport's cancellation
and wrapper-retirement path; do not bypass enrollment or remove cleanup to
make the UI proceed.

Reproduction: build the bundled Debug APK with the current web assets, then
run `artifact-host/acceptance.mjs --public-relay --native-fallback` on an
explicitly selected disposable `ANDROID_SERIAL` emulator. The optional
`YA_ARTIFACT_TEST_SERVER_ROOT` selects a baseline server checkout, without
modifying it. `--resume-after-pair` is an explicit test-setup workaround and
must not be reported as successful fresh-pairing acceptance.

Why not fixed in place: this investigation qualifies artifact delivery. Native
transport lifecycle and pairing are a separate boundary, and removing cleanup
or changing shared recovery while testing a viewer would hide the defect.
A future fix needs a real fresh UI pairing test plus native lifecycle coverage.

Found 2026-10-16 while testing the managed artifact viewer in Android emulator.

Physical-device follow-up on 2026-10-16: a fresh isolated bundled Debug app on
Android 17/API 37 (WebView 154) successfully pairs through the native UI and
automatically reaches its WebView, with no cold-resume workaround. The current
evidence therefore scopes this stall to the tested Android 15 emulator/setup;
it is not a demonstrated universal native pairing failure. Root cause of the
reproduced emulator stall remains unestablished.

November 24 Android release qualification also reproduced this on the bundled
Release app. The CI build `71401` saved its host after `GET /api/version` (200)
and `POST /api/security/clients/register` (201), then stayed busy on Android 15
using both direct loopback and the public TLS relay. Direct sign-in on the
same APK passed on Android 16 and on Android 15 after changing the emulator
to 37.2.13, build 16740729.

The exact AAB from [Android CI run 45355298568](https://github.com/kzahel/yepanywhere/actions/runs/45355298568)
(`0.1.4-ci.615.1` / `71501`) was converted to a locally signed universal APK.
On 37.2.13 it passed direct sign-in and repeatedly passed public TLS relay
sign-in, foreground resume and process restart. A fresh Android 15 repeat
with the same APK also left the registered server Idle with both host actions
disabled for 60 seconds. The smoke runner waits for an enabled action before
tapping. The main application thread was idle when sampled during the stalled
run. These results reproduce the intermittent stall on the pinned emulator.

A locally instrumented Release APK reproduced the same disabled server card.
Its trace shows that registration persisted and `closeAndAwait()` returned
after the native event read drained and the lease wrapper was retired. This
rules out a stuck transport close for that reproduction. The remaining trace
point is the ViewModel's post-pair notification offer and the Compose state
observed by the host screen. Local captures are under the ignored
`tasks/android-companion-release/` directory.

# Android control instrumentation is not reliably repeatable

On the owned API 35 emulator, the minified ordinary suite after the system-bar
repair failed `WebClientActivityTest.nativeHostDoesNotReplyToASubframe`: the
injected iframe's load marker stayed `pending` for ten seconds, before the
no-privileged-subframe-reply assertion. A focused rerun passed in 2.51 seconds.
This installation had already completed actual-Release pairing and still
retained its disposable host/profile; it was not an empty-app-state run. The
exact iframe failure cause is unresolved. The later clean-state suite passes
all 18 executable cases (25 fixture-dependent assumptions).
Do not weaken the security assertion or increase the timeout without diagnosis.

Repeating the entire suite on the same installation also reproduced the existing
[notification-permission reset defect](android-notification-test-revocation-kills-runner.md):
Android kills the instrumentation process when its helper revokes an already
granted permission. That entry owns the repair. Clearing only the owned
emulator's disposable test app data is the current clean-run preparation;
never do that on a user's phone.

Both failed logs are retained in `tasks/android-hardening-round2/`. Neither
failure is evidence of connection regression or a standard web defect. Keep
this bounded test-isolation work separate from the native appearance repair;
CI still runs the assertions without retries on its fresh emulator.

Found 2026-10-08 during final Release/system-bar verification.

On November 24, [Android CI run 45355298568](https://github.com/kzahel/yepanywhere/actions/runs/45355298568)
passed build, lint, APK inspection, ordinary instrumentation and the direct
live suite on emulator 37.2.13. The 100 MiB relay upload and typing checks also
passed, with every character retained and zero queue overflows. The same relay
case then failed on the long press at `YaNativeWebAppInstrumentedTest.kt:263`.
The accessibility capture shows the intended link focused and the app window
focused, with no **Open in new tab** menu. The runner failed because the menu
item lookup returned `null`. The check must still exercise a real long press
and verify the tab opens. Hosted publication remained gated by this failure.

[Follow-up run 45379108599](https://github.com/kzahel/yepanywhere/actions/runs/45379108599)
passed the native tab check with the fixture link clear of the session banner
and a WebView visual-state callback before the real long press. Native tab
creation, document identity and the existing typing assertions still ran.

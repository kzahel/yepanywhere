# iOS native host switching can miss acceptance after relaunch

[PR 151's iOS run 39455216181](https://github.com/kzahel/yepanywhere/actions/runs/39455216181)
passed native connection tests and the UI typing/draft checks, then failed
`LiveAppTests.testNativeLoginWebConversationTypingAndRelaunch` at the native
`host-add` readiness assertion after tapping **Switch Host**. The preceding
`QA host switch ready` assertion passed. Its checkpoint image and failure
hierarchy show the sidebar and Switch Host button still present; this does
not establish whether the tap was delivered or the native command arrived.

The refreshed rustls 0.23.46 branch passes all 23 native and two UI tests on
the local iOS 26.5 simulator without an iOS source change. This is a passing
schedule on a different runtime, not a repair or an explanation of the older
iOS 18.6 hosted failure. The scenario uses the unchanged plaintext loopback
fixture; no TLS handshake failure was reported at the failing step.

If it recurs, correlate the actual pointer/click event, native `switchHost`
command receipt and host-model generation before changing interaction code.
Retain the native host-picker assertion and the 100 ms input ceiling. The
original xcresult, exported checkpoint and activity tree are retained under
`tasks/rustls-native-review/` on the diagnosing checkout.

Found 2026-10-21 while investigating native acceptance for the rustls update.

November 11: [iOS 42964475962](https://github.com/kzahel/yepanywhere/actions/runs/42964475962)
on `23021f5e6` passes all 23 native tests and reaches typing, background and
relaunch assertions. It then misses `QA host switch ready` at
`LiveAppTests.swift:127`, before the native Switch Host tap. The exported
xcresult activity and failure hierarchy show the sidebar still closed after
the Open sidebar coordinate tap. This is an earlier boundary than the
original finding: there is no captured DOM pointer/click receipt establishing
whether the opening tap reached React. No interaction code or acceptance
limit was changed on this evidence.

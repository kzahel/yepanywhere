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

The fresh `ae932ec61` [run 42967078878](https://github.com/kzahel/yepanywhere/actions/runs/42967078878)
fails earlier at concurrent-update accounting instead: all 37 inputs arrive,
maximum paint acknowledgement is 48 ms, but `stream=0`. The probe's
beforeinput counters already define the keyboard-edit interval; its extra
instantaneous DOM-focus condition can exclude transcript mutations between
XCTest's separate literal-key calls. A browser probe with a real key, blur,
transcript update and next key reproduces that exclusion. Counting transcript
mutations over the beforeinput interval preserves the overlap and 100 ms
checks without depending on transient AX/DOM focus agreement. This does not
explain or close the earlier sidebar-opening finding.

On `40af82310`, [run 42970345191](https://github.com/kzahel/yepanywhere/actions/runs/42970345191)
fails at `LiveAppTests.swift:62`, waiting for keyboard readiness before the
first input. The fixture now targets the composer's current element frame,
as its existing navigation taps already do, and captures the immediate focus
state. The opt-in input probe also records the last delivered DOM pointer's
control, coordinates and relative time in the failure hierarchy. This
separates a missed native tap from an absent readiness notification; all
keyboard, overlap, draft and 100 ms assertions remain required.

The frame-targeting candidate `c266ca15a` passes the complete
[iOS run 42972762062](https://github.com/kzahel/yepanywhere/actions/runs/42972762062),
including simulator native/UI tests, sequential typing and stream overlap,
draft/background/relaunch/host-picker assertions and unsigned device linking.
This qualifies that candidate's full workflow, while the older missing
sidebar-opening event still lacks a captured delivery mechanism and remains
an open reliability finding.

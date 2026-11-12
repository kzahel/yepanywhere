# Coordinated release qualification, November 10, 2026

## Release scope

Prepare npm 0.12.0, Desktop Stable 0.10.0, Chrome extension 0.1.5, website
1.14.0 with its stable remote client, and Android companion 0.1.4 CI builds
for internal testing. Android public-beta promotion and the experimental
Android host are outside this cut. The maintainer authorized publication
after reviewing the preflight and explicitly accepted Android's remaining
input-latency qualification. Manual desktop upgrade qualification is scoped
to one OS; tagged CI retains its normal platform/signing gates.

Desktop was tagged separately on November 12 as 0.10.0 rather than the
prepared 0.8.0: Latest had meanwhile published 0.9.6901, and a 0.8.0 Stable
would have ranked below it, stranding Latest users who switch to Stable.

## Source preflight

Source `ed2535a42527c2d70696f0d292dbd781f8067824` passed:

- [General CI](https://github.com/kzahel/yepanywhere/actions/runs/42773955473):
  lint, formatting, typecheck, unit tests, dependency audits, website build,
  native platform checks and browser coverage. Browser reports contain 593
  passing cases, 12 skipped and three flaky cases: frozen public sharing,
  file-viewer scroll restoration and dragged transcript selection.
- [Runtime/SQLite](https://github.com/kzahel/yepanywhere/actions/runs/42773956023)
  across all nine platform/runtime jobs.
- [Installed npm acceptance](https://github.com/kzahel/yepanywhere/actions/runs/42774312129),
  including real Claude and Codex executables against scripted loopback model
  APIs, tool output, streaming and restart/history. The downloaded archive's
  source and SHA-256 were independently verified. That manual run used the
  former root fallback version 0.7.0; tagged publication must accept 0.12.0.
- [Desktop packaging](https://github.com/kzahel/yepanywhere/actions/runs/42774327483)
  on macOS Apple Silicon, macOS Intel and Windows x64.
- [Exact extension ZIP acceptance](https://github.com/kzahel/yepanywhere/actions/runs/42774316402)
  and [read-only store authentication](https://github.com/kzahel/yepanywhere/actions/runs/42774320616).
  The store reports 0.1.4 published.
- [Android build and native instrumentation](https://github.com/kzahel/yepanywhere/actions/runs/42774323812),
  including direct/security and mux/100 MiB upload scenarios.
- [Latest remote deployment](https://github.com/kzahel/yepanywhere/actions/runs/42775119766).

## Retained findings and limits

Android emulator typing maxima were 232.3 ms direct and 131.9 ms mux. The
existing two-second emulator allowance passed, but those measurements exceed
the shared 100 ms requirement. Publication does not close the
[emulator input-budget gap](../../gaps/android-emulator-input-acknowledgement-budget.md)
or establish fresh physical-phone timing acceptance. The maintainer accepted
this qualification limit for the internal release; no assertion was relaxed.

The extra [native source app/browser matrix](https://github.com/kzahel/yepanywhere/actions/runs/42774408977)
passed the provider suite, both platforms' API/app cases and the Linux browser
leg. The macOS Claude browser case failed after backend restart: completed
stream output did not appear within 15 seconds, and its retained trace showed
the page at Loading while the frontend reconnected. The input assertions
preceding restart passed. The cause remains unresolved; this does not establish
lost native history or a failure of installed desktop packaging. This separate
source-wrapper qualification is not the npm or desktop publication gate. The
[open recovery finding](../../gaps/native-source-reload-macos-loading-after-restart.md)
retains the reproduction boundary for diagnosis.

The release retains these findings rather than rerunning or weakening them to
claim complete qualification. New release metadata still requires same-source
CI and exact-artifact publication checks. Store review, actual desktop upgrade,
physical Android update/resume and older-server client smoke checks remain
separate evidence boundaries.

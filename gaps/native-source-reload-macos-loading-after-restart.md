# macOS source-reload browser remains Loading after backend replacement

At source `ed2535a42527c2d70696f0d292dbd781f8067824`, the extra
[native matrix run 42774408977](https://github.com/kzahel/yepanywhere/actions/runs/42774408977)
fails the macOS Claude case in `packages/client/e2e/native-app-reload.spec.ts`
at the completed-response visibility assertion after backend restart. The
retained trace shows a frontend navigation and a Loading page; the
`BROWSER_STREAM_COMPLETE` marker does not appear within the 15-second guard.
The case has not reached its later explicit page-reload/history assertions.

Both platforms' API/app cases, the provider suite, the Linux browser leg and
the other two macOS browser cases pass. The failing case's per-prefix and
100 ms input checks preceding restart also pass. These results neither
establish lost provider history nor qualify the failed recovery boundary.
No causal browser profile or isolated reproduction has yet distinguished a
frontend readiness/test-budget issue from a product recovery defect.

Inspect the retained `native-app-macos-latest-1` trace and align frontend
navigation, API readiness and browser state before choosing a repair. Keep
completion/history semantics and the 100 ms input limit. This source-wrapper
scenario is separate from the passing installed npm and packaged desktop gates.
It was not repaired during the coordinated release because the maintainer
requested publication after reviewing the preflight; its cause remains open.

Found 2026-11-10 while qualifying the coordinated npm, desktop, web, extension
and Android companion release.

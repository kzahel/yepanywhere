# Artifact viewer Edit source dialog intermittently fails to appear

[CI run 36887819900](https://github.com/kzahel/yepanywhere/actions/runs/36887819900)
on `b8346ebab` reported the artifact viewer icon-mode case as flaky. At
`packages/client/e2e/artifact-viewer.spec.ts:244`, the exact `Edit source`
dialog never appeared within the existing 5-second assertion; its retry
passed. The shard's uploaded browser evidence includes both first-attempt
screenshots and the error context for
`artifact-viewer-viewer-ico-87485-ugh-Shift-and-middle-clicks`.

Found beside the native mobile CI repair. That repair does not touch artifact
viewer editing, and this wait is not the native typing requirement. Diagnose
the mode transition from the uploaded evidence before choosing a change;
no assertion or retry policy has been weakened to hide it.

Found 2026-10-01 while repairing simulator and native WebView CI.

## Broad local failure 2026-10-10

The full browser run at `debb025bb` also failed the icon-mode case, plus four
other cases in `packages/client/e2e/artifact-viewer.spec.ts`: frame-local Find,
framed PDF handoff, saving a frame-generated file, and authenticated Edit links.
Their expected dialog, frame or controls were absent. This broader symptom
must not be attributed to the earlier CI mode transition without diagnosis.

The Find case's error context shows a fatal
`Cannot read properties of null (reading 'useRef')` in `BrowserRouter`, with
Vite-optimized React/router dependency paths. A duplicate React runtime is a
hypothesis, not a confirmed cause. Reproduce the component fixture and inspect
dependency identity before changing viewer behavior or increasing timeouts.

Evidence is under
`packages/client/test-results/9ebe4732-5fad-49db-945a-f9ab17b547b5/`, notably
`artifact-viewer-finds-with-73ba7-me-only-from-its-own-Ctrl-F/error-context.md`.
Full local output is retained in
`/local/graehl/ya-boot/final-deep-browser.{out,err}`.
The startup bundle does not run on this viewer route, but the run does not
establish whether these failures predate the startup series. No assertions
were relaxed. Contributing-model: 6-astra.

## Local failure 2026-11-07

The first case, `artifact-viewer.spec.ts:136`, failed once in a full local
run on 2026-11-07, with the uncaught frontend proxy error that `23021f5e6`
later fixed (its gap was retired there).

## Full-run failure 2026-11-08

A full browser run (`pnpm --filter client test:e2e --grep-invert "physical
Android"`) in a worktree fails
`packages/client/e2e/artifact-viewer.spec.ts:136` ("replaces the derived
file address and acknowledges sequential manual typing during updates") at
`e770fca38` and at each plan 181 slice: the `Address name` field is never
found, after the frontend proxy throws `Cannot write headers after they are
sent to the client` (`packages/server/src/frontend/proxy.ts:132`). The case
passes when its file runs alone. Not diagnosed; the proxy error is the
first lead.

## Proxy lead after `23021f5e6`

The frontend proxy fix in `23021f5e6` (2026-11-11) removes the error named
above. `limited-instructions.spec.ts` and `limited-browser-defaults.spec.ts`,
which failed first attempts with it in 30 CI runs from 2026-11-07, have not
failed with it since. Recheck this case under a full run before diagnosing
further: the proxy lead may be the whole of the 2026-11-07 and -08 failures,
but not of the earlier mode-transition or `useRef` symptoms.

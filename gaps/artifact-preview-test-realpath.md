# Driven-page artifact preview test assumes an uncanonicalized temp path

`packages/client/scripts/artifact-capture.test.ts`, test
"packages an existing driven page without replacing its screenshots or owning
its browser", compares commentary against the supplied screenshot path.
`writeCapturePreview` returns the canonical path instead. On macOS, `/var/...`
temporary paths resolve to `/private/var/...`, so the exact Markdown assertion
fails even though it refers to the same screenshot.

Reproduces in isolation with:

```sh
pnpm --filter @yep-anywhere/client test scripts/artifact-capture.test.ts -t 'packages an existing driven page'
```

Align the expected path with the preview contract (likely `realpath`) and keep
the checks that the existing screenshot bytes and browser ownership survive.
This is outside optional SQLite storage; no artifact capture code changed in
that implementation.

Found 2026-09-08 during the full workspace suite for optional SQLite support.

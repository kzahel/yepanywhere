# Full browser run fails source disposal and dictated Send, isolated cases pass

The collection-stream repair's four-worker full browser run reported three
failures after 600 passes (15 skips, four later serial cases not run):

- `multi-host-secure-coexistence.spec.ts:698`, both legacy and mux: disposing
  one runtime then fetching from the remaining runtimes received HTML where
  JSON was expected (`Unexpected token '<'`).
- `speech-caret-insertion.spec.ts:307`: sequential keys after a held dictated
  Send were prefixed by `set aside draft`, instead of starting in the cleared
  composer. This is a value-retention failure, not a latency-budget failure.

All three passed in one isolated, one-worker invocation (46.1 seconds including
build/setup). This establishes a load/order-sensitive failure, not its cause or
absence in CI. The latest main CI `43167914478` fails an independent Inbox
ordering assertion before providing a green browser baseline. No timeout,
assertion, retry count, transport fixture or speech behavior was weakened here.

Investigate same-worker prior-case state and source-runtime identity for the
HTML response, and draft/Send settlement ordering for speech. Evidence:
`/tmp/collection-fix-e2e.log`, `/tmp/collection-fix-e2e-rerun.log`, and the
error contexts under client `test-results/32d4ed2b-6acb-496e-a3eb-09a4e8ace492/`.

Found 2026-11-12 during full browser verification of collection streaming.

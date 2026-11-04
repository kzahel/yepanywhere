# OpenCode session-creation e2e misses its scripted replies on CI

`packages/client/e2e/opencode-session-creation.spec.ts:14` ("OpenCode
hosted/local keeps public identity through streaming, native confirmation,
reload and cold continuation") intermittently fails on the `e2e-tests (1/2)`
CI shard. The scripted assistant text never becomes visible within the 5 s
expect timeout: `OWNED_OPENCODE_CREATION_REPLY` (line 103) on one attempt,
`OWNED_OPENCODE_CONTINUED_REPLY` (line 111) on others.

Evidence from kzahel CI runs on `main`:

- `8d5dfe5d3` (run 41763375258): both variants flaky, passing on retry.
- `4b0f3dc1b` (run 41794993630): hosted variant failed all three attempts;
  local variant flaky.

Not fixed in place: it was found while unbreaking the Chromium sandbox on CI,
which it predates and is unrelated to. It needs diagnosis first. Candidates
are reply delivery racing the native-confirmation identity rebinding, or a
cold-continuation path that drops the first streamed reply. The uploaded
`e2e-failures-shard-1-*` artifacts hold the traces for the failing attempts.

Found 2026-11-04 while making CI green after the Chromium sandbox change.

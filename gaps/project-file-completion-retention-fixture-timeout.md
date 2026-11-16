# The 100-project completion retention fixture can exceed its time budget

The macOS Node 24.22.1 desktop release preflight timed out
`projectFileCompletion.test.ts`'s 100-project retention/expiry case at its
unchanged 30-second limit. Its ten-case file took 42.34 seconds including
cleanup. An isolated one-worker rerun passed all ten cases in 26.34 seconds
(23.94 seconds of test work). Earlier source CI runs measured this case at
5.24 and 6.89 seconds. These observations do not establish the cause of the
local slowdown.

The case creates 100 real non-Git project inventories, in pairs matching the
service's two scan slots, and checks retention, refresh and seven-day expiry.
Keep those assertions while investigating native Git launches and metadata
rechecks; do not raise the limit or remove the scale assertion just to recover
release checks. The implementation and this test were unchanged by the
release's source-wrapper shutdown repair.

Local evidence is retained under ignored `tasks/desktop-release-012/` in
`wrapper-tests.log` and `completion-isolated.log`.

Found 2026-11-16 during desktop 0.12.0 release preflight.

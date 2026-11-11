# Client unit suite emits unowned jsdom navigation diagnostics

The required workspace `pnpm test` run on 2026-10-30 passes, but its client
process prints two `Error: Not implemented: navigation (except hash changes)`
jsdom diagnostics. The asynchronous stacks end in
`HTMLHyperlinkElementUtils-impl.js` and a timer, without identifying the test
that activated the hyperlink. The captured run is
`tasks/http-api-v0/test.log` (local, gitignored); 661 client files and all
7,017 client tests passed.

The HTTP v0 change touches no client implementation or browser interaction.
No navigation diagnostic appears in its focused core/auth/storage run.
An unowned asynchronous event cannot safely be fixed by suppressing jsdom or
changing global link behavior in this server task. Locate the triggering test,
then prevent/replace only its irrelevant document navigation or move its real
navigation assertion to a browser boundary, preserving the intended behavior.

Found 2026-10-30 while implementing the isolated local HTTP v0 API.

2026-11-01: plan 171's phase-2 workspace run repeats the same two asynchronous
navigation diagnostics (7,064 client tests pass). The slice changes server
identity/storage and native detail reads, and its 79 focused checks are clean.
The diagnostic still cannot be attributed from its timer-only stack; no global
link behavior or jsdom suppression was introduced. Evidence: ignored
`tasks/session-identity/phase-2-test.log`.

2026-11-04: the relationship-writer workspace run repeats the same two
timer-only navigation diagnostics while all 7,110 client tests pass. The slice
changes SQL ownership and server admission only; its focused writer/admission
checks are clean. Attribution still requires a separate client fixture audit,
so no global navigation or jsdom suppression was added. Evidence: ignored
`tasks/session-relationships/slice-4-qualified-unit.log`.

2026-11-06: hiding healthy session-creation notices repeats the same two
timer-only jsdom navigation diagnostics in the passing Node 24.22.1 workspace
run (7,127 client tests). The focused startup component checks and browser
no-flash/typing checks are clean. Neither navigation event can be attributed
from these stacks, so changing global links or suppressing jsdom diagnostics
would expand this presentation fix into an unrelated fixture audit. Evidence:
ignored `tasks/creation-notice-test-node24.log`.

2026-11-10: CSS ownership plan 191 step 1's passing final workspace run emits
five timer-only navigation diagnostics, with 7,333 client and 7,256 server
cases passing. The 91 focused CSS-tooling/Git Status cases emit none. No
navigation implementation was changed; attribution still requires a separate
fixture audit rather than global link suppression. Evidence: ignored
`.artifacts/design-tour/191-comparison/logs/workspace-final.log`.

2026-11-11: the Audit-page cleanup's passing workspace run repeats five
`Error: Not implemented: navigation (except hash changes)` diagnostics with
only jsdom timer stacks (7,375 client and 7,341 server tests pass). The focused
design-index test and desktop/phone browser cases are clean. This playground
change does not change production navigation; identifying the source still
requires the separate fixture audit described above. No global navigation
suppression was added. Evidence: ignored `.artifacts/design-audit/tests.log`.

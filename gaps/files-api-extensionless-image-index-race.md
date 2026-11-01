# Extensionless-image route fixture can lose its primed path evidence

On 2026-11-01 a full workspace run failed
`test/api/files.test.ts` → `embeds the resolved SVG for an extensionless document
image`. The response remained 200, but rendered `<p>Frontier</p>` instead of an
image carrying the resolved SVG's `data-media-path`. The run had 6,744 passing
server tests and this one failure; the client suite passed all 7,064 tests.
The unchanged Files API file subsequently passed in a focused four-file run
(122 checks, 5.19 s). This disagreement establishes a nondeterminism signal,
not its cause. The original red run remains in the local ignored
`tasks/session-identity/phase-3-external-test.log` evidence.

`primeProjectFiles` performs a sparse-index probe, waits 100 ms on macOS
(10 ms elsewhere), then probes again. Its comment acknowledges delayed native
fixture-creation events. The renderer deliberately consumes known-only path
facts, and losing certified path membership makes an extensionless image fall
back to its alt text. A delayed invalidation after the second probe would
explain the response, but index generations and watcher delivery were not
captured at the failed instant, so that mechanism remains unproved.

Diagnose with controlled path-index/watch delivery and generation evidence.
Keep real filesystem-invalidation coverage, while deciding whether this route
fixture should own a stable, explicitly primed snapshot. Do not widen the
settling sleep or suppress the fallback. This was adjacent to provider-native
session observation; its renderer/path-index fixture contract is separate and
was left unchanged. The identity implementation still requires a final green
workspace run; a later green run does not erase this failure.

Found 2026-11-01 while qualifying plan 171's native file-observation slice.

# Tool display native coverage does not span every provider conversion

Tactical 124's original step 5 requires evidence for distinct normalization paths
that claim each display variant. The registry is exhaustive, but the native
matrix is not. Its initial 80 cases mostly reconstructed native envelopes from
the same display fixtures, allowing an inaccurate PDF shape to pass both gates.

The review correction adds independent observed Claude 2.1.223 shapes, SDK-only
PDF/image controls, real Claude JSONL reads, multi-record lifecycle and child
sidecar ownership checks, Grok Read/Bash, and Codex OSS shell/Read conversion
pairs. See `topics/stream-persisted-render-parity.md` for exact evidence classes.

Still missing: independent cases for the other Grok conversions, non-shell
Codex OSS items, Gemini ACP notifications and their unavailable input/result
facts, Pi extension-defined tools, and observed specimens for the remaining
declared variants. Gemini/OpenCode cases still enter constructed session data
after their storage readers. SDK native transport/session wiring is outside
these deterministic conversion-method tests. Paid sessions are not required
to close these gaps; extend injected adapter/reader cases and add sanitized
shapes as specimens become available.

The bounded correction fixes demonstrated regressions and improves the highest
value seams. It deliberately does not claim complete native-path coverage or
turn every provider's transport into a new integration project. Delete this
entry only when the remaining matrix has explicit independent evidence or an
approved narrower obligation.

[Tactical 127](../docs/tactical/127-captured-provider-fixtures.md) now has a first
real Claude Haiku/Codex Luna baseline with native files, pre-conversion live
records, and offline reader/adapter replay in the ordinary server tests.
See the [capture manifest/recipe](../packages/server/test/fixtures/captured/README.md).
Mounted presentation, the wider scenario matrix, and full transport replay
remain pending; this does not close the broader gaps above. The corpus also
guards the repaired Codex native code-mode failure-status regression.

Found 2026-09-10 during the independent tactical 124 implementation review.

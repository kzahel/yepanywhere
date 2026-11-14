# Claude source index tip can diverge from buildDag's active tip

The Claude source index advances its tip on an ordinary append when the new
row's parent is the current tip and its timestamp is not older
(`ClaudeSourceIndex.commit` in `packages/server/src/sessions/claude-source-index.ts`,
`extendClaudeLinear` in `sessions/claude-linear-writer.ts`). Neither path knows
whether an existing row already names the appended uuid as its parent.
`buildDag` (`sessions/dag.ts`) only picks leaves, so the two disagree when one
does:

- An earlier row `E` names an absent parent `F`. When `F` is appended under
  the tip, the index makes `F` the tip, while `buildDag` keeps `E` because `F`
  now has a child. Reproduced 2026-11-14 with the in-memory index: index tip
  `F`, `buildDag` tip `E`.
- A progress row whose uuid an existing row names as its parent turns that
  row's walk into buildDag's line-order fallback, which can change
  branch-length tie-breaking; the index keeps its previous tip.

Both cases need a child written before its parent, which ordinary Claude
writes do not produce, but the detail view's active branch then differs from
the complete reader's. It also blocks a bounded Claude resume guard: an index
tip that differs from `buildDag`'s can certify a resume as safe where the
complete check blocks, so the guard keeps its complete read
([provider history](../topics/provider-history-facts.md)).

Fix: keep a fact of parent uuids referenced but not yet present (in the
in-memory index and as a durable fact; `claude_transcript_nodes` holds only
`generation, uuid, active`). An append whose uuid is in that set, progress
rows included, is not a linear extension and goes through the full metadata
selector. With that fact, the resume guard can take the indexed tip and walk
a bounded tail behind it, falling back to the complete check when the walk
leaves the tail.

Found 2026-11-14 while bounding the Claude resume guard (gpt-6.1-sol review).

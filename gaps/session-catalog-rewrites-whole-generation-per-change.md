# Remaining population work around session catalog changes

[Plan 189](../docs/tactical/189-session-catalog-in-sqlite.md) moved immutable
JSONL generations into transactional SQLite rows on 2026-11-09. Plan 190 now
also removes the parsed native catalog mirror and changed-file generation
construction. Known file updates use indexed row lookups and explicit
upserts/removals; unrelated rows/stores survive without being yielded again.
The catalog retains only a bounded parsed point cache. Project views retain
SQL aggregates rather than per-session membership maps. Optional question
checks and creation/activity confirmation use scoped rows.

Lists and Inbox share a derived SQL query owner with keyed overlay updates,
grouped counts and page/tier hydration. Compatible completed checkpoints can
restore without normalizing the cold population again. These replace the
historical full-walk/whole-generation paths described in this file's history;
they do not certify all plan 190 targets. See
[catalog ownership evidence](../docs/research/190-catalog-sql-ownership.md),
[collection query contract](../topics/session-collection-queries.md) and
[catalog publication contract](../topics/session-catalog-observation.md#sql-catalog-ownership-and-partial-publication).

Still open:

- New Codex/Gemini files and Claude files in empty or ambiguous stores still
  require discovery to establish membership. Classify a single new file from
  verified native facts before removing that conservative fallback.
- First-ever/invalidated list projection builds remain population-sized.
  SQL checkpoint import/index construction is also population-sized, although
  it avoids cold JavaScript catalog/metadata hydration. A canonical mutation
  while the owner is absent invalidates the checkpoint; keyed durable catch-up
  would avoid a full rebuild in that case.
- Native project aggregation still visits eligible rows in SQL. Complete
  consumer/discovery reads explicitly materialize the requested corpus.
  Migrate consumers by their access pattern; moving a walk to SQL alone does
  not make it bounded.
- Bounded session/Inbox and project/ProjectQueue clients now receive shared
  authoritative query changes behind separate capabilities. Complete search,
  oversized views and transcript rendering retain their existing read paths;
  full combined-scale qualification remains open.
- Grok/OpenCode internal watcher reports from sessions outside YA and writes
  predating watcher startup still need reliable reconciliation. Activity
  inside YA rescans only the affected internally observed store.

The next architectural workstream is bounded long-transcript ingestion for
both Claude and Codex, followed by client change delivery/rendering. Preserve
full-rebuild parity and the [plan 190](../docs/tactical/190-active-session-cost-at-scale.md)
review gates throughout.

# Provider history facts and queries

Topic: provider-history-facts

Status: proposed architecture, 2026-11-14. Claude's durable index exists; the
shared query boundary, Codex facts and caller migrations do not. Runtime work
proceeds in scoped slices that each update this document.

## The rule

**Answering a question about a session's history costs in proportion to the
answer, not the history. Keeping the answers current costs in proportion to
what changed, not to how many sessions exist.**

Concretely:

- A tail page, an older page, a preview excerpt, a resume-safety check or an
  open-question lookup reads a small index plus the native bytes of the
  records it returns. It never decodes a whole transcript to find them.
- An append updates the index from the appended bytes. A session nobody asks
  about costs nothing. Nothing scans the corpus at startup or on a timer.
- Reading complete history is a named operation (export, diagnostics,
  explicit backfill, a first build) with its own budget, never a silent
  fallback inside a lightweight request.

New history-derived features add a **query** to this boundary, not another
scanner, cache or cursor scheme of their own.

## Why: two growth axes

Average session length and total session count are both growing, and each
breaks a different assumption.

| Axis | What grows | Cost today when unindexed | Target |
| --- | --- | --- | --- |
| Length | Bytes in one session | A preview or tail read decodes the whole rollout. Plan 190's qualification measured a Codex preview refresh reading 495 MB / 154k lines with ~493 MB heap growth (since bounded; delivery step 1). | Per-request bytes and decode bounded by the selected window plus bounded prefix facts. |
| Count | Sessions on the host | Cross-session features (search, issue association, questions, vocabulary) each keep their own reader and cursor, and cold or reset paths rescan. Catalog lists already use SQL. | Background work proportional to appended bytes; first builds on demand or in explicit, resumable, yielding batches. |

Neither is an outage today. The goal is a design that stays sensible and
defensible as both keep growing, rather than one that is optimal for a
specific benchmark.

## What exists

| Piece | Status |
| --- | --- |
| [Claude durable source index](claude.md#durable-source-facts-and-incremental-writer-ownership) | Implemented. Compact source facts, logical positions, tool ownership and task checkpoints in the profile's SQLite. Unchanged sources reopen and ordinary appends update without rebuilding the history graph ([index evidence](../docs/research/190-claude-durable-index.md), [writer evidence](../docs/research/190-claude-sql-writer.md)). Unseen files and exceptional rewinds/branches still need a full pass. This is the pattern to extend. |
| [Codex compact-tail windows](codex-sessions.md#compact-tail-source-reads) | Implemented. Blockwise native windows and an append cache; detail and v0 conversation both pass the summary hint that activates them. Complete-reader fallbacks remain for other shapes. No durable logical facts. |
| Latest-state point reads (`sessions/transcript-tail.ts`) | Implemented for the hover excerpt. A backward line reader over plain JSONL with a byte budget, plus one single-flight per file version that retains the answer, including unknown. The primitive for further latest-state questions. |
| [Session catalog and summary index](session-catalog-observation.md) | Implemented. Cross-session lists come from SQL; [summary fidelity](session-summary-fidelity.md) governs complete-summary claims. Not a transcript-window index. |
| [Shared append framing](../docs/tactical/192-transcript-indexer.md) | Step 1 implemented: one append source and cursor model under issue indexing and content search. Its common runner is still under review. |
| [Durable relationships](session-relationships.md) | Implemented SQL query service with its own authoritative writers. A neighbor, not a cache to fold in. |

The missing piece is the middle: one internal query module, typed per
provider, that every lightweight reader calls, backed by Claude's index and an
equivalent Codex index.

## Design

```text
native files / inherited segments / provider DB
    -> source acquisition + version validation      (per provider adapter)
    -> compact provider facts in SQLite             (typed per provider)
    -> bounded query module                         (shared entry points)
    -> consumer projections and their checkpoints   (owned by each consumer)
    -> app / v0 / share adapters and presentation compiler
```

Live activity, permission requests, queue ownership and token deltas keep
flowing through the existing live runtime. They never wait for an index
write, and the index adds no per-token SQLite writes. Finalized live records
may contribute facts, deduplicated by explicit source identity.

### Source acquisition and versions

Each provider adapter owns its source locations, framing, provisional tails,
mutation detection and read budgets, and reports a source **generation** plus
the covered frontier. Identity uses the existing native binding (server,
profile, storage family, native session ID) resolved through
[session identity](session-identity.md); a path is not a session.

Validation is append-only by design: inode/device plus bounded head and
accepted-end probes, as `sessions/transcript-ingestion.ts` already does.
These probes do not prove that no historical byte changed, and hashing the
whole prefix on every append would defeat the cost bound. A byte offset is one
adapter's locator, not the universal cursor: Codex inherited segments need
ancestor evidence, and OpenCode needs per-session row evidence rather than the
shared database file's stat.

Identical concurrent work joins one owner with independently cancellable
waiters. Results computed under different visibility or projection versions
are never shared as if equivalent.

### Facts worth retaining

Small, typed, rebuildable from native history:

- source/segment identity, accepted frontier and validation evidence;
- stable native occurrence IDs with payload locators, role/type, timestamps;
- logical positions: turn, visible-group and compaction boundaries, anchors;
- branch links, selected path, rewind revision, inherited cut points;
- tool ownership and bounded reducer checkpoints (tasks) needed outside a
  selected window;
- summary witnesses, latest-eligible-prose locators and similar point facts;
- explicitly skipped, malformed, provisional or unsupported regions.

Historical payload (text, thinking, tool output, media) stays in native
storage and is read by locator. Facts carry two versions: the source
generation and the semantic projection revision, because a YA rewind can
change visibility without changing a byte. Keep typed tables per provider.
Claude's forest/rewind/queue selector is adapted, not rewritten as a generic
fold. There is no universal JSON key/value facts table and no forced common
normalized transcript store.

### Query families

| Query | Answers | Cost expectation |
| --- | --- | --- |
| Window | Latest or anchored N turns / visible groups / compactions. | Indexed seek, then payload reads for selected records only, plus bounded prefix facts. |
| Page | Before/after a stable anchor. | Same as window; truthful older/omitted coverage; stale anchors keep current behavior. |
| Point | Latest eligible agent prose, summary fields, open questions, task state, last safe resume row, native cut point. | Indexed point/range read; no payload reconstruction. |
| Forward batch | Records after a consumer's cursor, under a declared visibility/text policy. | Bounded records/bytes per batch, resumable, explicit reset evidence. |
| Complete traversal | Export, comparison, backfill, provider operations. | Explicit, budgeted, streaming; never reached as a fallback from the rows above. |

These are internal entry points; app/v0 wire contracts stay as they are.

**Compatibility: none needed, by construction.** This effort is a server-internal
refactor under the [capability rules](server-capabilities.md#when-to-add-one):
no new routes, fields, events or changed meanings, so no capability, protocol
version or compatibility-floor change. Any client/server version pairing
behaves as before, only cheaper. An honest "unknown" maps to an absence the
wire already carries: a preview refresh with no excerpt returns
`lastAgentText: null` and emits no `session-updated` event (the hovercard
ignores the body), and v0 conversation already reports partial coverage.
Exposing new states to clients (for example a visible "building" or "stale"
coverage) or a new query parameter is outside this effort; it gets its own
review and prefers an optional field whose absence is the documented fallback
over a new capability.

Every result states its source generation, projection version, covered range
and freshness, and distinguishes never-indexed, building, current, stale and
unsupported. An empty result never stands in for any of those. Each query
carries byte, record, output and deadline budgets plus cancellation. Selecting
20 visible messages must not decode megabytes of excluded tool output to find
them; oversized mixed-content records may need block locators or a bounded
decoder. Where facts are missing, the answer is explicit partial coverage or
an admitted bounded build, not a hidden complete read.

### Consumers own their projections

Issue evidence, search text, vocabulary aggregates, question state and usage
classification remain separate projections with their own checkpoints. A
consumer commits its output and progress together; the shared source
advancing does not acknowledge any consumer. Each consumer declares which
visibility it uses (active path, YA display forest, all evidence occurrences
or leaf-only preview).

All Sessions text search is one such downstream consumer. It can reuse
source identity, generations, locators and reset evidence, but its corpus,
matching, postings and backfill stay with
[content search](all-session-content-search.md) and its
[gap](../gaps/all-sessions-search-index.md). Being indexed through byte N is
not the same as search having indexed through byte N.

A common forward scheduler is justified only once real consumers agree on
eligibility, outcomes and transaction ownership (the
[indexer plan's second review](../docs/tactical/192-transcript-indexer.md#second-review--2026-11-13)).
Request-path queries never wait behind background replay.

### Authorization, storage and lifecycle

Authorization stays with app/v0/share services ([security](security.md),
[principals and grants](principals-and-grants.md)): they resolve the grant
before acquisition, filter cross-session queries before decoding payloads and
apply their own redaction. Internal facts are not a public API, and source
evidence is never creation or execution authority.

SQLite is [required infrastructure](required-sqlite.md); use the existing
portable adapter, prepared statements and short synchronous transactions in
app data only. Claude facts stay in the profile `discovery.sqlite` for now.
Where new facts live (shared database, per-session files or a hybrid, see the
[session-scoped sketch](../gaps/sketches/prefer-per-session-sqlite-over-global-keyed-by-session.md))
is decided by real query plans, writer contention and disk reclamation, not
assumed.

Three retention classes:

| Class | Examples | Rule |
| --- | --- | --- |
| Rebuildable facts | Positions, boundaries, branch facts, witnesses. | Versioned against native evidence; bounded disk budget, incremental cleanup, retired under fenced publication. |
| Domain state | Relationships, question answers/dismissals, learning aggregates. | Owned by its domain; never garbage-collected because a source disappeared. |
| Working data | Decoded payload windows, provisional overlays, in-flight reads. | Process-wide byte/entry bounds; no full in-memory mirror. |

Compact facts can still contain sensitive text; each retained field needs a
purpose and a size bound. Native deletion makes payload unavailable, and
results say so rather than reconstructing from partial facts. Startup
migrations create schema without reading provider history.

## Consumers

Inventory of current history readers (server paths under
`packages/server/src/`). A migration rechecks its callers; a future consumer
adds its row here before adding a reader.

| Consumer | Query | Notes |
| --- | --- | --- |
| Session detail: tail, older pages, reconnect catch-up, in-session search (`routes/session-detail-routes.ts`, `sessions/bound-session-reader.ts`) | Window, page | Preserve rewind groups, task snapshots, global IDs and counts. |
| v0 conversation and read-follow (`experimental/provider-conversation-source.ts`, `core-api/conversation.ts`) | Window, page | Codex passes the same summary hint as detail, so eligible rollouts take the compact tail. Select visible groups before acquiring payload. Pending attention stays with live owners. |
| Preview and hovercard (`getLastAgentExcerpt`, `routes/sessions.ts`) | Point | Done for Claude and Codex: a bounded tail read, with no complete-read fallback ([contract](session-hovercard-recent-activity.md#on-demand-refresh-of-idle-previews-focus--hover)). Remaining: the recap overlay comparison loads the session summary; Pi parses its session; Gemini, Grok, OpenCode and Antigravity take a named complete read. The Claude scan approximates the active branch. |
| Complete summaries, model/context (`sessions/reader.ts`, `sessions/codex-reader.ts`, `indexes/SqliteSessionSummaryIndex.ts`) | Point | Head and tail facts have different freshness; reducers keep token/context semantics. |
| Async questions (`sessions/codex-async-questions.ts`) | Point, forward | Answer/dismissal state is domain state, not rebuildable facts. |
| Task lists and cross-window state (`claude-source-index.ts`, `claude-linear-writer.ts`) | Prefix facts | A tail must not lose state created before it. |
| Tool details and media ([media handles](session-media-handles.md)) | Point by locator | Large bodies load on demand; an omitted body is not an absent result. |
| Resume guard, rewind boundary, fork/clone (`session-claude-resume-guard.ts`, `sessions/fork.ts`) | Point | The Claude guard still loads the complete session. Its tip is selected across the whole file, and the source index's maintained tip can diverge from that selection ([gap](../gaps/claude-index-tip-diverges-from-dag-on-forward-parent.md)), so a bounded check waits on an exact tip fact. Incomplete facts never certify a safe resume or copy. |
| Codex launch-settings recovery (`sessions/codex-launch-settings.ts`) | Point | Done: the latest `turn_context` from a bounded tail read. A fork that references its parent (`history_base`), a compressed rollout or a final turn beyond the budget takes the named complete read, because a missing answer would launch with default permissions. |
| Instruction restoration history (`readInstructionHistory` in `app.ts`) | Prefix facts | The ledger folds every read since the session began: files opened before a compaction are the ones it restores after it, so a tail would drop them. A named complete read per resumed launch until a durable fold exists. |
| Children, nested harness evidence, lineage (`ProviderChildRelationshipService`, `claude-harness-history.ts`) | Point | Prefer native headers/sidecars; evidence is not authority. |
| Content search (`routes/session-content-search.ts`, `sessions/issue-text-reader.ts`) | Forward | Separate project; see above. |
| Issue associations (`services/issues/IssueIndexer.ts`) | Forward | Keeps its scheduler, eligibility and atomic output/checkpoint commits. |
| Speech vocabulary (`services/voice/vocabulary-sessions.ts`) | Forward | Today a changed session is re-paged end to start, so any append rereads its history. Opt-in replay; live arrival is a separate input ([gap](../gaps/vocabulary-learning-has-no-live-tail.md)). |
| Shares, exports, diagnostics (`PublicShareService`, `maintenance/debug-routes.ts`) | Window or complete | Complete traversal is legitimate here, and only here, explicitly. |
| Proposed: usage ledger ([accounting](session-usage-accounting.md)), branch navigation ([session tree](provider-session-tree.md)) | Forward, point | Not built by this effort; facts should not preclude them. |

## Provider coverage

| Source shape | Starting point | Still to qualify |
| --- | --- | --- |
| Claude JSONL + rewind metadata | Durable index and writer. | First-build cost, exceptional branch/queue rebuilds, visible-prose selection, secondary-reader rewind policy. |
| Plain Codex rollout | Summary hints, blockwise windows, append cache. | Route all lightweight callers through the eligible path; add durable facts where repeat queries justify them. |
| Codex inherited/compressed history | Segment-aware reader with complete fallbacks. | Ancestor and cut evidence, decompression cost; a leaf path is not complete history. |
| Pi JSONL tree | Selected-leaf reader. | Branch/leaf version; an append may not extend the visible path. |
| OpenCode database | Session-row readers. | Per-session row/WAL evidence and stable page order. |
| Grok, Gemini, Antigravity | Existing readers. | Unsupported or explicitly expensive until audited. |

The first useful queries do not wait for every provider.

## Delivery order

Each slice migrates named callers, removes their hidden complete reads, and
measures bytes acquired, records decoded, SQL rows visited, retained memory
and disk growth, separating first-build from steady-state cost. Message counts
alone are not evidence. Parity is checked against the incumbent full reader on
deterministic histories, covering cold, restart, unchanged, append,
provisional, truncate/replace, rewind, branch, malformed/oversized records and
cancellation. [Measurement-host rules](performance-regression-suite.md#performance-measurement-hosts)
apply; UI-affecting changes keep the sequential-typing gate.

1. **Length axis, point query (done 2026-11-14):** bounded latest-agent
   excerpt for Claude and Codex; preview's complete-read fallback removed for
   them. The 200 largest local Codex rollouts (13–512 MB) answered in 182 ms
   total, one unknown; the excerpt matched the complete read on 299 of 299
   compared rollouts. v0 conversation now passes the Codex summary hint.
   Codex launch-settings recovery followed: it matched the complete read on
   507 of 534 sampled local rollouts, the other 27 ending in a turn longer
   than the budget and taking the named complete read.
2. **Length axis, windows:** app detail and v0 conversation share one
   eligible Claude/Codex window path with cancellation and coverage; no
   caller-specific complete fallback.
3. **Codex durable facts:** the smallest Codex logical-position index that
   makes windows and point queries survive restart without a rescan.
4. **Count axis:** connect issue/search/question/vocabulary forward reads to
   the same source generations and reset evidence, keeping their projections.
   Decide the common runner from these concrete consumers.
5. **Remaining readers and lifecycle:** resume guard (after an exact
   indexed tip), instruction-restoration fold, evidence consumers; disk
   budget, cleanup and crash recovery before any broad backfill.

## Non-goals

- A text-search index (separate project, above).
- Public API or wire changes.
- A common background scheduler before consumers agree on its contract.
- Copying historical payload into SQLite, or one normalized transcript store.
- Startup corpus backfill, per-session timers or new native watchers
  ([architecture mandates](architecture-mandates.md)).
- Replacing working owners (relationships, issue scheduler, summary index)
  merely to complete an abstraction.

Related open gaps: [conversation acquisition](../gaps/conversation-window-acquisition-cost.md),
[rewind visibility](../gaps/rewind-records-ignored-by-secondary-readers.md),
[search index](../gaps/all-sessions-search-index.md),
[vocabulary live arrival](../gaps/vocabulary-learning-has-no-live-tail.md),
[index tip divergence](../gaps/claude-index-tip-diverges-from-dag-on-forward-parent.md),
[active-session cost](../gaps/active-session-tab-background-cost.md).
The [roadmap](../docs/roadmap/README.md) owns priority.

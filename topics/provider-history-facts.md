# Provider history facts and queries

Topic: provider-history-facts

Status: the rule is in force. Trimmed 2026-11-15 from a proposed shared query
architecture to a list of concrete readers; each fix updates the tables here.

## The rule

**Answering a question about a session's history costs in proportion to the
answer, not the history. Keeping the answers current costs in proportion to
what changed, not to how many sessions exist.**

Concretely:

- A tail page, an older page, a preview excerpt or a latest-state lookup reads
  a small index or the end of the file, plus the native bytes of the records
  it returns. It never decodes a whole transcript to find them.
- An append updates derived facts from the appended bytes. A session nobody
  asks about costs nothing. Nothing scans the corpus at startup or on a timer
  ([architecture mandates](architecture-mandates.md)).
- Reading complete history is a named, deliberate operation listed in
  [Consumers](#consumers), never a silent fallback inside a lightweight
  request.

The work is to remove the whole-file reads that break this, one reader at a
time. It is not a new layer. A history-derived feature uses one of the
[existing homes](#where-derived-facts-live) rather than adding a scanner, cache
or cursor of its own.

## Why

Session length and session count both keep growing, and transcript sizes vary
widely between hosts: one maintainer host's largest Claude transcript is 81 MB
and its largest Codex rollout 512 MB, while plan 190's qualification fixture
carries 465 MB of Claude history. A whole-file read of a large session stalls
the event loop and grows the heap by about the file's size; plan 190 measured
a Codex preview refresh reading 495 MB / 154k lines with ~493 MB of heap
growth before it was bounded. Neither axis is an outage today. The aim is to
stay sensible as both grow.

## How to fix a reader

Ask what the reader needs, then use the matching tool.

| The reader needs | Use |
| --- | --- |
| Latest state: the last row, the last agent prose, the last turn's settings | A tail read (`sessions/transcript-tail.ts`): a backward line reader with a byte budget and one single-flight per file version. It must be able to answer "unknown". |
| A window or a position: pages, counts, anchors, state as of a point | The provider's index: Claude's durable index, Codex's compact-tail reader. |
| Everything since last time | The shared append source and cursor ([indexer plan](../docs/tactical/192-transcript-indexer.md)), with the consumer's own checkpoint. |
| The whole history by nature: export, diagnostics, a fold with no durable state yet | A named complete read, recorded as deliberate in [Consumers](#consumers). |

Every fix follows these rules:

- **Unknown is honest.** It maps to an absence the wire already carries, or to
  a named complete read where a wrong answer is unsafe. Incomplete facts never
  certify a safe resume, a safe copy or a permission level.
- **Parity is checked against the whole-file reader** on real local
  transcripts, plus deterministic cases for shapes real data rarely has:
  out-of-order rows, rewind, branch, provisional tail, truncate/replace and
  oversized records. "Rare" does not pass a safety check.
- **Evidence is bytes read and records decoded**, not message counts
  ([measurement hosts](performance-regression-suite.md#performance-measurement-hosts)).
- **No wire change** (see [Compatibility](#compatibility)).

## Where derived facts live

One home per kind of fact. A new fact extends a home; it does not add a
process-local map.

**Durable derived facts go in SQLite**, in the profile's
[rebuildable cache database](required-sqlite.md#rebuildable-cache-database),
`cache.sqlite`. No new JSON cache files. In-process state is allowed only as
bounded working data that a restart can lose.

The cache database is separate from `discovery.sqlite`, which holds state
that cannot be rebuilt (manual titles, seen state, drafts, issue decisions).
A cache schema change therefore chooses, per change, between altering the
tables in place and starting from an empty file, and it never blocks a
downgrade. The Claude transcript index moved there on 2026-11-15; on one
maintainer host it was 167 MB of a 288 MB `discovery.sqlite`. The session
catalog and collection caches (78 MB there) stay in `discovery.sqlite`:
triggers tie them to session metadata, so they cannot move without redesign.

| Home | Holds | Notes |
| --- | --- | --- |
| [Claude durable index](claude.md#durable-source-facts-and-incremental-writer-ownership) (`claude_transcript_*`) | Source facts, logical positions, tool ownership, task checkpoints, summary witnesses. | In `cache.sqlite`. Ordinary appends update it without rebuilding the history graph. An unseen file and exceptional rewinds/branches still take a full pass. Its tip can diverge from `buildDag` ([gap](../gaps/claude-index-tip-diverges-from-dag-on-forward-parent.md)). |
| [Codex compact-tail reader](codex-sessions.md#compact-tail-source-reads) | Blockwise native windows and an append cache. | In process only. Durable Codex facts are added when a measured query needs them, not before. |
| [Session catalog and summary index](session-catalog-observation.md) | Cross-session lists and summaries, in `discovery.sqlite`. | [Summary fidelity](session-summary-fidelity.md) governs complete-summary claims. Not a transcript-window index. |
| Tail reads (`sessions/transcript-tail.ts`) | Nothing durable: one retained answer per file version. | The default for latest-state questions. |
| [Shared append source](../docs/tactical/192-transcript-indexer.md) | One append cursor model under issue indexing and content search. | Its common runner is still under review. |
| [Durable relationships](session-relationships.md) | Its own SQL service and writers. | A neighbor, not a cache to fold in. |

Fold a one-off cache into a home when its owner is next changed, not as a
project of its own. Known candidates to examine: `codexFullSummaryCache`
(`sessions/codex-reader.ts`, a 256-entry in-process map) beside the SQL
summary index, and the cache in `experimental/conversation-acquisition.ts`,
which hashes its committed prefix after each append and no longer serves
production conversation reads. One JSON-file cache over provider history
remains: `SessionDiscoveryIndex` (`indexes/SessionDiscoveryIndex.ts`) writes
per-directory JSON shards under `indexes/session-discovery/`. It belongs in a
table.

Historical payload (text, thinking, tool output, media) stays in native
storage and is read by location; it is not copied into SQLite. Tables stay
typed per provider. Startup migrations create schema without reading provider
history.

## Consumers

Current history readers (server paths under `packages/server/src/`). A future
consumer adds its row here before adding a reader.

| Consumer | Needs | Status |
| --- | --- | --- |
| Preview and hovercard (`getLastAgentExcerpt`, `routes/sessions.ts`) | Latest state | **Done** for Claude and Codex: a bounded tail read with no complete-read fallback ([contract](session-hovercard-recent-activity.md#on-demand-refresh-of-idle-previews-focus--hover)). The Claude scan approximates the active branch. Pi, Gemini, Grok, OpenCode and Antigravity take a complete read. |
| Codex launch-settings recovery (`sessions/codex-launch-settings.ts`) | Latest state | **Done.** The latest `turn_context` from a tail read. A fork that references its parent (`history_base`), a compressed rollout or a final turn beyond the budget takes the named complete read, because a missing answer would launch with default permissions. |
| Session detail: tail, older pages, reconnect catch-up, in-session search (`routes/session-detail-routes.ts`, `sessions/bound-session-reader.ts`) | Window | **Bounded** for Claude after the first build and for eligible Codex rollouts. Preserves rewind groups, task snapshots, global IDs and counts. |
| v0 conversation and read-follow (`experimental/provider-conversation-source.ts`, `core-api/conversation.ts`) | Window | **Bounded** on the same readers; Codex passes the summary hint. Message selection still happens after normalization ([gap](../gaps/conversation-window-acquisition-cost.md)). |
| Task lists and cross-window state (`claude-source-index.ts`, `claude-linear-writer.ts`) | State as of a point | **Bounded** by the Claude index. A tail must not lose state created before it. |
| Rewind boundary row (`sessions/claude-rewind-bound.ts`) | Latest state | **Done.** The bound is the non-empty string uuid of the last non-progress row, in file order, among lines that parse, read from the tail. It needs no branch selection and does not depend on the rest of the transcript loading; whenever the complete read succeeds, the two agree. No such row inside the budget, a file that changed during the read, or a read error takes the named complete read, whose result or failure stands, because a missing bound makes the rewind group fall back to timestamps. |
| Codex complete-reader fallbacks (`sessions/codex-reader.ts`) | Window | **Open.** Reference-backed forks, compressed rollouts, old or unknown cursors and results needing omitted tool context take the complete reader. Codex has the largest files. A leaf path is not complete history; inherited segments need ancestor evidence. |
| Restart and handoff source (`loadRestartSourceSession` in `routes/sessions.ts`, ten call sites) | Mixed | **Open.** Loads and normalizes the whole session. Some calls use only the title and the latest user message. |
| Speech vocabulary (`services/voice/vocabulary-sessions.ts`) | Everything since last time | **Open.** A changed session is re-paged end to start, so any append rereads its history. Opt-in feature; live arrival is a separate input ([gap](../gaps/vocabulary-learning-has-no-live-tail.md)). |
| Claude resume guard (`routes/session-claude-resume-guard.ts`) | Latest state on the current branch | **Deliberate complete read**, once per resume, until the index tip is exact ([gap](../gaps/claude-index-tip-diverges-from-dag-on-forward-parent.md)). The current branch is selected across the whole file, so a tail alone cannot certify it. |
| Instruction restoration (`readInstructionHistory` in `app.ts`) | Whole history | **Deliberate complete read**, once per resumed launch. The ledger folds every read since the session began: files opened before a compaction are the ones it restores after it. |
| First build of an unseen Claude file; exceptional branch, rewind and queue selection | Whole history | **Deliberate.** One streaming pass, then indexed. |
| Shares, exports, diagnostics (`PublicShareService`, `maintenance/debug-routes.ts`) | Window or whole history | **Deliberate.** Complete traversal is legitimate here. |
| Complete summaries, model/context (`sessions/reader.ts`, `sessions/codex-reader.ts`, `indexes/SqliteSessionSummaryIndex.ts`) | Summary facts | Not audited. Head and tail facts have different freshness; reducers keep token/context semantics. |
| Async questions (`sessions/codex-async-questions.ts`) | Latest state, forward | Not audited. Answer and dismissal state is domain state, not a rebuildable fact. |
| Tool details and media ([media handles](session-media-handles.md)) | One record by location | Large bodies load on demand; an omitted body is not an absent result. |
| Children, nested harness evidence, lineage (`ProviderChildRelationshipService`, `claude-harness-history.ts`) | Latest state | Not audited. Prefer native headers and sidecars; evidence is not authority. |
| Fork and clone (`sessions/fork.ts`) | Whole history | **Deliberate.** The copy is proportional to the history. It holds the source file as one string rather than streaming it. |
| Content search (`routes/session-content-search.ts`, `sessions/issue-text-reader.ts`) | Forward | Separate project; see below. |
| Issue associations (`services/issues/IssueIndexer.ts`) | Forward | Keeps its scheduler, eligibility and atomic output/checkpoint commits. |
| Pi, OpenCode, Grok, Gemini, Antigravity readers | Various | Not audited: unsupported or explicitly expensive until they are. |
| Proposed: usage ledger ([accounting](session-usage-accounting.md)), branch navigation ([session tree](provider-session-tree.md)) | Forward, position | Not built by this effort; facts should not preclude them. |

## Consumers own their projections

Issue evidence, search text, vocabulary aggregates, question state and usage
classification remain separate projections with their own checkpoints. A
consumer commits its output and progress together; the shared source
advancing does not acknowledge any consumer.

All Sessions text search is one such downstream consumer. It can reuse
source identity, generations, locators and reset evidence, but its corpus,
matching, postings and backfill stay with
[content search](all-session-content-search.md) and its
[gap](../gaps/all-sessions-search-index.md). Being indexed through byte N is
not the same as search having indexed through byte N.

A common forward scheduler is justified only once real consumers agree on
eligibility, outcomes and transaction ownership (the
[indexer plan's second review](../docs/tactical/192-transcript-indexer.md#second-review--2026-11-13)).

## Compatibility

None needed, by construction. This is a server-internal change under the
[capability rules](server-capabilities.md#when-to-add-one): no new routes,
fields, events or changed meanings, so no capability, protocol version or
compatibility-floor change. An honest "unknown" maps to an absence the wire
already carries: a preview refresh with no excerpt returns
`lastAgentText: null` and emits no `session-updated` event, and v0
conversation already reports partial coverage. Exposing a new state to
clients is outside this effort and gets its own review.

Authorization stays with the app, v0 and share services
([security](security.md), [principals and grants](principals-and-grants.md)):
they resolve the grant before reading and apply their own redaction. Derived
facts are not a public API and are never creation or execution authority.

## Delivery order

Each step removes one reader's hidden whole-file read and records its evidence
here.

1. **Tail reads for latest state (done 2026-11-14).** Hover excerpt for Claude
   and Codex: the 200 largest local Codex rollouts (13–512 MB) answered in
   182 ms total, one unknown, and the excerpt matched the complete read on 299
   of 299 compared rollouts. v0 conversation passes the Codex summary hint.
   Codex launch-settings recovery matched the complete read on 507 of 534
   sampled rollouts; the other 27 end in a turn longer than the budget and
   take the named complete read.
2. **Rewind boundary row (done 2026-11-15).** A tail read, defined on its
   own (see [Consumers](#consumers)). Evidence on one maintainer host's local
   data: of 3,879 Claude transcripts, the tail answered 3,878 with the
   complete read's answer and was unknown on one, a single row without a
   uuid, which took the complete read. None differed and no complete read
   failed. The tail reads took 0.6 s in total against 11 s for the complete
   reads.
3. **Codex complete-reader fallbacks.** Count how often each fallback fires on
   real rollouts, then bound the ones that do.
4. **Restart and handoff source.** Audit what each of the ten calls uses;
   calls that need only the title and latest user message take the summary
   plus a tail read.
5. **Speech vocabulary.** Resume from a saved position instead of re-paging.
6. **Claude index tip, then the resume guard.** Fix the divergence in place:
   track parent ids that are referenced but not yet present, and send an
   append matching one through the existing full selector. Gate it on a
   comparison of the index against `buildDag` across real transcripts and
   synthesized out-of-order cases. Then the guard reads the indexed tip.
7. **Later, when measured:** a durable instruction-restoration fold, Codex
   position facts that survive a restart, and the unaudited readers above.

## Non-goals

- A shared query module, a common result envelope (generation, projection
  version, coverage, freshness states) or a generic budget and cancellation
  contract. Add one when two real consumers need the same thing.
- Redesigning the Claude index's tables, or changing which branch counts as
  current. `buildDag` stays the reference; rewriting it is separate work.
- A text-search index (separate project, above).
- Public API or wire changes.
- A common background scheduler before consumers agree on its contract.
- Copying historical payload into SQLite, or one normalized transcript store.
- Startup corpus backfill, per-session timers or new native watchers.
- Replacing working owners (relationships, issue scheduler, summary index)
  merely to complete an abstraction.

Related open gaps: [conversation acquisition](../gaps/conversation-window-acquisition-cost.md),
[rewind visibility](../gaps/rewind-records-ignored-by-secondary-readers.md),
[search index](../gaps/all-sessions-search-index.md),
[vocabulary live arrival](../gaps/vocabulary-learning-has-no-live-tail.md),
[index tip divergence](../gaps/claude-index-tip-diverges-from-dag-on-forward-parent.md),
[active-session cost](../gaps/active-session-tab-background-cost.md).
The [roadmap](../docs/roadmap/README.md) owns priority.

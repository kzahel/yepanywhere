# Transcript indexer

Topic: transcript-indexer

Status: proposed 2026-11-13, checked against the code at `153768485`.
Revised the same day after a plan review (Codex `gpt-6.1-sol`, high effort);
the revision changes the consumer transaction boundary, keeps issue job
state, keeps projections consumer-specific, and reorders the later steps.
Not started. The revised plan needs a second review before step 1.

## Goal

One server component reads each provider transcript forward from where it
last stopped, reads every new byte once, and hands the new records to every
feature that derives state from transcripts. Features declare what they want
indexed and own their projections and checkpoints; they do not each frame,
schedule and detect rewrites on their own.

Today four features derive state from transcripts, each with its own reader,
trigger, checkpoint and reset rule, and none shares work with the others:

| Feature | Reads | Remembers where it stopped | Providers |
| --- | --- | --- | --- |
| Issue references | `readIssueTextBatch`, 64 KiB framing, its own boundary hash | yes: `issue_index_jobs.cursor` | Claude, Codex |
| All-sessions search | the same reader, cursor round-tripped to the client | no (nothing stored) | Claude, Codex |
| Codex async-question previews | last 2 MiB of the rollout, backward | no: rescans on every append | Codex |
| Speech vocabulary learning | each changed session whole, through `reader.getSession` | per-session version and cutoff; catalog changes since its last mark | every reader |

Two byte-framing and cursor implementations exist side by side:
`sessions/transcript-ingestion.ts` (detail reads, the Claude durable index,
the Codex entry cache) and `sessions/issue-text-reader.ts` (issues, search).
Gemini, Grok, Pi, OpenCode and Antigravity sessions are invisible to issue
references and search because only the Claude and Codex readers implement
`readIssueTextBatch`.

### Measured cost of the question preview (2026-11-13)

`scripts/perf-repro/active-session.mjs` with tracing added to
`readCodexAsyncQuestions`, against a production server on 5,000 sessions
(2,500 Codex) and one 50 MB Codex session being written:

- A fresh catalog scans every non-archived Codex session once, up to 2 MiB
  each: 2,501 scans, 143 MiB, about 1 s CPU for the small synthetic files.
  The maintainer's real store has 226 uncompressed rollouts, 136 of them
  over 2 MiB; a fresh catalog would read about 370 MiB.
- A restart with unchanged files does no scans: the projection survives in
  the catalog row.
- An active session appended five times a second costs about 1.5 full
  rescans a second (3 MiB/s read, 6 ms/s CPU), about 7% of the server's
  main-thread work during the writes. Two subscribers trigger a scan per
  append: catalog reconcile and `ExternalSessionTracker`. Debouncing (200 ms
  watcher, 300 ms catalog and tracker batches) is the only bound.
- The preview cache was keyed by path, so `/tmp` and `/private/tmp`
  spellings each computed. `153768485` keys it by device and inode.

The cost is bounded, not alarming. The reason to act is structural: each
new transcript-derived feature would add another reader, and the question
preview cannot carry server-side state (dismissal, answered-in-composer)
because it is recomputed from a file tail.

### Non-goals

- **The Claude durable index** (`claude-durable-index.ts`,
  `claude-linear-writer.ts`) stays separate. It is a request-path cache that
  lets the transcript view serve windows of a long Claude session without
  reparsing it. It needs Claude's raw branch structure and swaps whole
  generations on rewinds. It may later read through the same source
  adapter; it does not become a consumer.
- **The session summary index** stays as it is. It owns complete-summary
  fidelity rules ([session summary fidelity](../../topics/session-summary-fidelity.md))
  this plan does not change.
- **No shared normalized projection.** Issues, search, questions and
  vocabulary keep their own visibility rules. The indexer shares framing,
  cursors, fences, scheduling and reads, not message conversion.
- **No live-arrival path.** Vocabulary's live tail comes from finalized
  provider messages, not from the indexer (step 6).
- **No new file watcher.** The indexer is driven by catalog changes, which
  already coalesce file events.
- **No change to provider formats or to native transcripts.** They remain
  authoritative; indexes are rebuildable caches.
- **No client change** until the question-state step, which needs a
  capability.
- **Antigravity** stays out until its history acquisition is qualified
  (step 7).

## Shape

### Source adapters

A source adapter turns one session's native storage into bounded batches of
raw records after an opaque cursor. It owns framing, partial final records,
segments, coverage diagnostics, and detecting that the source was replaced,
truncated or rewritten. It does not normalize.

```ts
interface TranscriptSourceAdapter {
  provider: ProviderName;
  /** Kind of change this storage supports; decides the cursor's meaning. */
  kind: "append" | "document" | "database" | "immutable";
  readBatch(
    session: SessionCatalogRow,
    cursor: string | null,
    budget: { bytes: number; records: number; deadlineMs: number },
    signal: AbortSignal,
  ): Promise<{
    records: RawRecord[];     // provider-native, with segment and byte span
    cursor: string;           // opaque, checkpointed by each consumer
    sourceVersion: string;    // includes branch metadata versions (below)
    reset: boolean;           // earlier state is invalid; consumers start over
    done: boolean;            // no more complete records before the end
    partial: boolean;         // budget or deadline stopped the batch
    recordErrors: boolean;    // malformed or oversized records were skipped
    diagnostics: SessionContentDiagnostic[];
  }>;
}
```

`partial`, `recordErrors` and `diagnostics` carry over from
`IssueTextBatch` so skipped records never count as complete coverage.

Adapter kinds, by provider:

| Kind | Providers | Cursor | Reset when |
| --- | --- | --- | --- |
| append | Claude, Codex (with `history_base` segments), Pi, Grok `chat_history.jsonl` | segment, byte offset, `transcript-ingestion` fence (dev/ino, head and boundary probes) | replaced, truncated, fence probe differs, branch metadata changes |
| immutable | compressed Codex rollouts | done flag | never changes |
| document | Gemini session JSON | source version plus count and id of the last emitted message | the file no longer extends the emitted prefix |
| database | OpenCode `opencode.db` | last message key/time | the session's rows no longer extend the emitted prefix |

**Branches.** An append fold is only valid while the visible branch only
grows. Two cases break that without breaking the byte fence:

- Claude rewinds change the session's rewind records, not the transcript
  ([gap](../../gaps/rewind-records-ignored-by-secondary-readers.md)).
- A Pi append can select a different branch.

The adapter's `sourceVersion` includes the rewind-record version (Claude) and
the selected leaf (Pi). A change resets consumers that declare
`branchSensitive`. Consumers that index every record regardless of
visibility, as issue evidence does today, ignore it. Claude DAG visibility
(`collectVisibleClaudeEntries`) needs the whole transcript and is never run
on a batch; a consumer that needs visible-branch semantics either declares
`branchSensitive` and accepts resets, or stays off Claude.

### Consumers

A consumer is configuration, a projection and its own checkpoint. It never
reads files. Applying a batch has two phases:

```ts
interface TranscriptIndexConsumer<Prepared> {
  id: string;                 // "issues", "async-questions", "vocabulary"
  version: number;            // bump to reindex every session
  providers: ProviderName[];
  branchSensitive: boolean;
  /** Settings-driven; disabling pauses, it does not delete. */
  enabled(settings: ServerSettings): boolean;
  /** Per session: archived, recent-days, provider. Ineligible pauses. */
  eligible(row: SessionCatalogRow, settings: ServerSettings): boolean;
  /** Cursor to start a session this consumer has never seen; null = beginning. */
  startCursor(row: SessionCatalogRow, adapter: TranscriptSourceAdapter): Promise<string | null>;
  /** The consumer's committed cursor and version for a session. */
  checkpoint(session: SessionKey): { cursor: string | null; sourceVersion: string } | null;
  /** Async, outside any transaction; may yield. Converts and extracts. */
  prepare(session: SessionKey, batch: AdapterBatch, signal: AbortSignal): Promise<Prepared>;
  /** Sync and bounded: writes output and checkpoint together, or is idempotent. */
  commit(session: SessionKey, prepared: Prepared, cursor: string): void;
  /** The source reset or the consumer's version changed. */
  reset(session: SessionKey): void;
  /** The session left the catalog (tombstone). Not called on ineligibility. */
  forget(session: SessionKey): void;
}
```

- `prepare` does what cannot run in a SQLite transaction: provider
  conversion, `captureChunked` (which yields between chunks), anything
  async. SQLite rejects async and nested transactions
  ([required SQLite](../../topics/required-sqlite.md)).
- `commit` writes the consumer's output and its cursor in one
  synchronous transaction in the consumer's own database. The checkpoint
  lives next to the output, so a crash can never advance the cursor past
  output that did not land.
- A consumer whose output is written asynchronously (vocabulary's deferred
  writer to its own database) records its cursor through that same writer,
  or makes replay idempotent and records the cursor only after the write
  is durable.
- Ineligibility (aged out of the recent-days window, archived) pauses and
  keeps progress and evidence, as
  [issue associations](../../topics/issue-session-associations.md) require.
  Only a tombstone calls `forget`.

### Storage

The runner owns no cursors. It keeps a scheduling table in
`discovery.sqlite`:

```sql
CREATE TABLE transcript_index_queue (
  consumer TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_version TEXT NOT NULL,   -- catalog row version that queued it
  state TEXT NOT NULL,            -- queued | running | paused | failed
  error TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (consumer, session_id)
) WITHOUT ROWID;
CREATE INDEX transcript_index_queue_order
  ON transcript_index_queue (state, priority DESC, updated_at);
```

Losing this table loses only scheduling: the runner rebuilds it by comparing
each consumer's `checkpoint().sourceVersion` with the catalog.

Each consumer owns its output and checkpoint tables:

- **Issues** keep `issue_index_jobs` as their checkpoint, with
  `catalog_key`, `project_id`, coverage states and the deletion receipts in
  `IssueStore.delete` that join it. Step 2 moves scheduling out of it; it
  does not rename or drop it.
- **Questions** add their own tables (step 3), cursor included.
- **Vocabulary** keeps its separate database and adds its cursor there.

### Scheduling and fan-out

- One runner subscribes to `session-catalog-updated` and reads
  `readChanges(since)`, as `IssueIndexer` and `VocabularyLearning` each do
  today. A changed row queues its session for every enabled, eligible
  consumer whose checkpoint `sourceVersion` differs. Unarchiving an
  unchanged file makes it eligible again and queues it, as the catalog's
  question pass does today
  ([`RetainedSessionCollections.ts`](../../packages/server/src/services/RetainedSessionCollections.ts)).
- One worker drains the queue by priority: the open or viewed session first,
  then active sessions, then backfill.
- **Fan-out.** Consumers whose checkpoints for a session hold the same
  cursor share one read: the runner reads the batch once, then runs each
  consumer's `prepare` and `commit` in turn. In steady state every consumer
  is current, so an append is read once for all of them. A consumer that is
  behind (newly enabled, version bumped, paused) catches up with its own
  reads until its cursor meets the others. One consumer's failure marks only
  its queue row `failed`.
- **Publication.** A consumer whose output feeds a catalog projection
  publishes it from `commit`: it patches the catalog row only if the row's
  source version still equals the batch's, and the patch emits the usual
  catalog change. This replaces the catalog's own enrichment pass, so the
  last question or answer in a session appears without waiting for another
  append. Until a session's first commit, its projection stays unknown, as
  it is today while a preview is pending.
- Budgets carry over from `issue-text-reader`: 8 MiB or 2,000 records per
  batch, 1 MiB per record, a 30 s deadline, yielding between batches.
- Settings changes and tombstones fence and requeue as `IssueIndexer` does.

## Steps

### 1 — one append-source adapter

Rebuild `issue-text-reader.ts` on `transcript-ingestion.ts` framing as the
append source adapter, returning raw records with coverage diagnostics.
`readIssueTextBatch` becomes the adapter plus the existing
`normalizeIssueEntries` projection; content search likewise keeps its own
projection. The cursor format gets a new layout version; an old cursor
restarts the session from zero, which the issue occurrence dedupe already
tolerates.

No behavior change: issue evidence, coverage states and search results are
identical before and after on a copy of the maintainer's profile.

### 2 — the runner, with issues as the first consumer

Add `transcript_index_queue` and the runner. Port `IssueIndexer` to a
consumer:

- Its sweep, queue order and pause move into the runner.
- `captureChunked` runs in `prepare`; evidence and the `issue_index_jobs`
  cursor commit together in `commit`.
- `observe` (viewed windows) stays with the consumer.
- `issue_index_jobs` keeps its columns and meaning. The migration only adds
  the queue table and seeds it from jobs in `queued` or `paused` state.
  Native-key moves, tombstones and paused-job resumption keep their current
  code paths and tests.

Issue settings (`issueAssociations`) keep their meaning and become the
consumer's `enabled` and `eligible`.

### 3 — Codex async questions as a consumer

The consumer folds the leaf rollout's Codex records into rows:

```sql
CREATE TABLE async_questions (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  question_index INTEGER NOT NULL,
  match_key TEXT NOT NULL,        -- full title, whitespace folded
  preview TEXT NOT NULL,          -- title clipped to 320 characters
  asked_turn INTEGER NOT NULL,    -- user-turn ordinal when asked
  asked_at TEXT,
  answered_turn INTEGER,          -- set by a later quote reply
  PRIMARY KEY (session_id, message_id, question_index)
) WITHOUT ROWID;
CREATE INDEX async_questions_match ON async_questions (session_id, match_key);
CREATE TABLE async_question_sessions (
  session_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  source_version TEXT NOT NULL,
  user_turns INTEGER NOT NULL,    -- current user-turn ordinal
  tail_started INTEGER NOT NULL,  -- first read began after byte 0
  turns_since_start INTEGER NOT NULL
) WITHOUT ROWID;
```

Answer matching follows the
[provider output contract](../../topics/provider-output-contract.md): a
quote reply resolves only the **nearest preceding** question with that full
match key. If that question is already answered, the reply resolves nothing;
it does not fall through to an older duplicate. This is what today's backward
scan with a set of reply keys produces.

Preview equivalence with today's scan:

- **Scope.** Only the leaf rollout file, not `history_base` ancestors, as
  now. Compressed rollouts stay unknown (no adapter), as now.
- **Start.** A session never seen starts at the first complete record in
  its last 2 MiB and sets `tail_started`. A session created after the step
  ships is followed from byte 0.
- **Limits.** The read returns questions with `user_turns - asked_turn < 32`,
  newest 128. Rows aged 32 turns or more are pruned in `commit`.
- **`omitted`.** True when more than 128 qualify. Also true when
  `tail_started` or `history_base` is set and fewer than 32 user turns have
  been folded since the start. Otherwise false. This matches the backward
  scan's rule that reaching 32 turns clears omission.
- **Reset.** Replacement, truncation or a fence change deletes the session's
  rows and restarts from the tail rule.
- **Publication.** `commit` publishes the session's preview to the catalog
  row with the current wire shape (`questions[]` with `age`, `askedAt`;
  `omitted`), guarded by source version.

Then delete `readCodexAsyncQuestions`, its single-flight cache, the catalog's
question pass in `RetainedSessionCollections`, and the
`deferAsyncQuestions` plumbing. `ExternalSessionTracker` reads previews from
the catalog row.

Contract changes: [session summary fidelity](../../topics/session-summary-fidelity.md)
replaces the 2 MiB backward preview with the rules above. Any observable
difference found by the step 3 gate needs review before the old scan is
deleted; an unchanged wire shape alone does not establish compatibility.

### 4 — server-side question state

Add a state table keyed like `async_questions` with `dismissed_at` and
`moved_to_composer_at`, a write route, and a capability. Clients with the
capability write dismissals to the server and read them back with the
previews; local storage stays as the offline copy and the path for older
servers. Counts then agree across devices, and dismissed questions leave the
server's counts instead of being filtered in every client.

This step changes a client/server contract and needs the
[compatibility review](../../DEVELOPMENT.md#clientserver-compatibility-review)
before it starts.

### 5 — adapters for Pi, Grok, Gemini and OpenCode

Add the append adapter for Pi (branch-sensitive) and Grok, the document
adapter for Gemini, and the database adapter for OpenCode. Issue references
and search then reach these providers by adding them to the issue
consumer's `providers` and writing their projections. This comes before
vocabulary so vocabulary does not lose providers it reads today.

### 6 — vocabulary replay as a consumer

`VocabularyLearning`'s replay becomes a consumer:

- **Window.** `startCursor` and `prepare` apply the look-back window per
  message timestamp. Widening the window resets the consumer for sessions
  that now qualify; narrowing it does nothing.
- **Checkpoint.** The cursor is written through the vocabulary database's
  deferred writer with the counts it covers. Replay is idempotent per
  message id within a session.
- **Pause and resume.** Disabling collection pauses the consumer.
  Re-enabling resumes from the checkpoint: text written during the pause is
  replay, gated by the window.
- **Providers.** Any provider without an adapter keeps the current
  `reader.getSession` path until one exists.

This retires whole-session rereads of a changed session. The cited
per-publication walk
([gap](../../gaps/speech-vocabulary-scan-per-catalog-publication.md)) is
already narrowed to `readChanges` since the last mark; reconcile that gap
entry when this step lands.

The live tail
([gap](../../gaps/vocabulary-learning-has-no-live-tail.md)) is a separate
path from finalized provider messages, with explicit live provenance. A
message reaching the indexer while collection is on is not evidence of live
arrival: restart catch-up, newly discovered history and rewritten sources
reach it too. The live path and replay deduplicate by message id.

### 7 — later

- Antigravity, after owner-aware history acquisition, a shared process
  budget and WAL-aware source versions are qualified. History comes through
  ACP `session/load`, which can update native continuation metadata, so it
  is not a database adapter
  ([Antigravity](../../topics/antigravity.md)).
- A disk-backed search consumer
  ([all-sessions search index](../../gaps/all-sessions-search-index.md)).
- Reading the Claude durable index's appends through the append adapter.
- Per-session databases for consumer output if
  [that sketch](../../gaps/sketches/prefer-per-session-sqlite-over-global-keyed-by-session.md)
  is adopted.

## Review gates

- **Plan review** of this revision before step 1.
- **Step 1:** issue evidence, coverage states and search results identical
  before and after on a `VACUUM INTO` copy of the maintainer's profile,
  served by a second server on a port other than 3400.
- **Step 2:** the migration on that copy; issue jobs resume where they
  stopped; no evidence lost or duplicated; deletion receipts unchanged.
- **Step 3:** `active-session.mjs` with the scan trace: question reads per
  append drop from about 2 MiB to the appended bytes, and the cold catalog
  reads no more than the old preview did. Question previews and `omitted`
  identical to the old scan for every session on the copied profile; each
  difference is listed and reviewed.
- **Step 4:** the compatibility review and its capability.
- **Step 6:** learned counts on the copied profile match the current replay
  for the same window.
- **Each step:** the server's main-thread time during writes is no higher
  than before, and no single `commit` exceeds the budget measured in step 2.

## Testing

- Adapter tests per kind: partial final record, truncation, replacement with
  the same size, a rewrite that keeps the boundary probe (see the warning in
  the [search index gap](../../gaps/all-sessions-search-index.md)),
  `history_base` segments, compressed rollouts, malformed and oversized
  records reported as partial coverage, a Claude rewind with unchanged
  bytes, and a Pi branch switch.
- Runner tests: fan-out reads each byte once for consumers at the same
  cursor; a lagging consumer catches up without rereading for the others; a
  consumer's failure pauses only that consumer; a version bump resets only
  that consumer; ineligibility pauses without forgetting; tombstones call
  `forget`; a crash between `prepare` and `commit` replays the batch; a
  publication with a stale source version is dropped.
- Question consumer: nearest-preceding resolution with duplicate titles and
  repeated replies; titles longer than 320 characters; ages from turn
  ordinals; the 128 and 32 limits and `omitted` transitions; `reset` after
  rewrite; tail start.
- Migration fixtures: a historical-prefix `issue_index_jobs`, preservation
  of every column, and an older server refusing the newer schema.
- Existing issue and search tests keep passing unchanged through step 2.

## Risks

- **Synchronous SQLite writes on the event loop.** `commit` is synchronous.
  Batches stay bounded, `prepare` does the heavy work, and the worker yields
  between consumers and batches; commit latency is measured in step 2.
- **A consumer bug blocks its own progress.** Failures mark that consumer's
  queue row `failed` with its error and do not stop other consumers or the
  read.
- **Branch-sensitive resets.** Each Claude rewind resets branch-sensitive
  consumers for that session and rereads it. Acceptable at current rewind
  rates; measure in step 5.
- **Codex forks reread parent segments.** A fork follows its parent's
  segments up to the fork point, as the issue reader does now, so parent
  bytes are read once per fork. Acceptable at current fork counts; see open
  questions.
- **Rewrite detection is probabilistic.** Fences sample the head and the
  bytes before the cursor; they do not hash the whole prefix. A rewrite that
  preserves both probes and grows the file is missed. This is today's
  behavior for issues and the Claude durable index.

## Open questions

- Should Codex fork segments be indexed once per file, with answered state
  per leaf session, instead of once per fork?
- Should the open session's appends bypass catalog coalescing so questions
  and search see them sooner than 300 ms?
- Should consumer output live in per-session databases from the start, or
  wait for that sketch to be adopted?

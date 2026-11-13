# Transcript indexer

Topic: transcript-indexer

Status: proposed 2026-11-13, checked against the code at `153768485`. Not
started. Plan review is the first gate.

## Goal

One server component reads each provider transcript forward from where it
last stopped, reads every new byte once, and hands the new entries to every
feature that derives state from transcripts. Features declare what they want
indexed; they do not each read, schedule, checkpoint and reset on their own.

Today four features derive state from transcripts, each with its own reader,
trigger, checkpoint and reset rule, and none shares work with the others:

| Feature | Reads | Remembers where it stopped | Providers |
| --- | --- | --- | --- |
| Issue references | `readIssueTextBatch`, 64 KiB framing, its own boundary hash | yes: `issue_index_jobs.cursor` | Claude, Codex |
| All-sessions search | the same reader, cursor round-tripped to the client | no (nothing stored) | Claude, Codex |
| Codex async-question previews | last 2 MiB of the rollout, backward | no: rescans on every append | Codex |
| Speech vocabulary learning | the whole session through `reader.getSession` | whole-session checkpoint only | every reader |

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
- **No new file watcher.** The indexer is driven by catalog changes, which
  already coalesce file events.
- **No change to provider formats or to native transcripts.** They remain
  authoritative; indexes are rebuildable caches.
- **No client change** until the question-state step, which needs a
  capability.

## Shape

### Source adapters

A source adapter turns one session's native storage into bounded batches of
entries after an opaque cursor. It owns framing, partial final records,
segments, and detecting that the source was replaced, truncated or rewritten.

```ts
interface TranscriptSourceAdapter {
  provider: ProviderName;
  /** Kind of change this storage supports; decides the cursor's meaning. */
  kind: "append" | "document" | "database" | "immutable";
  readBatch(
    session: SessionCatalogRow,
    cursor: string | null,
    budget: { bytes: number; records: number; deadlineMs: number },
  ): Promise<{
    entries: RawEntry[];      // provider-native, for consumers that need them
    messages: Message[];      // normalized by the existing provider normalizer
    cursor: string;           // opaque, stored by the indexer
    reset: boolean;           // earlier state is invalid; consumers start over
    done: boolean;            // no more complete records before the end
  }>;
}
```

Adapter kinds, by provider:

| Kind | Providers | Cursor | Reset when |
| --- | --- | --- | --- |
| append | Claude, Codex (with `history_base` segments), Pi, Grok `chat_history.jsonl` | segment, byte offset, `transcript-ingestion` fence (dev/ino, head and boundary probes) | replaced, truncated, fence probe differs |
| immutable | compressed Codex rollouts | done flag | never changes |
| document | Gemini session JSON | source version plus count and id of the last emitted message | the file no longer extends the emitted prefix |
| database | OpenCode `opencode.db`, Antigravity | last message key/time | the session's rows no longer extend the emitted prefix |

The append adapter is `issue-text-reader.ts` rebuilt on
`transcript-ingestion.ts` framing, returning raw entries and normalized
messages instead of issue text. `normalizeConversationEntries` already
normalizes bounded Claude and Codex batches; the other adapters need the
equivalent bounded entry point from their readers.

### Consumers

A consumer is configuration plus a projection. It never reads files.

```ts
interface TranscriptIndexConsumer {
  id: string;                 // "issues", "async-questions", "vocabulary"
  version: number;            // bump to reindex every session
  providers: ProviderName[] | "all";
  input: "messages" | "entries";
  /** Settings-driven; disabling pauses, it does not delete. */
  enabled(settings: ServerSettings): boolean;
  /** Per session: archived, recent-days, provider, viewed. */
  eligible(row: SessionCatalogRow, settings: ServerSettings): boolean;
  /** Where to start a session this consumer has never seen. */
  start: "beginning" | { tailBytes: number };
  /** Runs inside the transaction that advances this consumer's cursor. */
  apply(session: SessionKey, batch: Batch, tx: SqlTransaction): void;
  /** The source reset, or the consumer's version changed. */
  reset(session: SessionKey, tx: SqlTransaction): void;
  /** The session left the catalog or became ineligible. */
  forget(session: SessionKey, tx: SqlTransaction): void;
}
```

`apply` and the cursor advance commit together, so a consumer sees each
batch exactly once without deduplicating by content hash. The issue
consumer's occurrence dedupe stays for its existing evidence rows; it is no
longer what makes restarts safe.

### Storage

One progress table in `discovery.sqlite`, replacing `issue_index_jobs`:

```sql
CREATE TABLE transcript_index_progress (
  consumer TEXT NOT NULL,
  session_id TEXT NOT NULL,
  consumer_version INTEGER NOT NULL,
  source_version TEXT NOT NULL,   -- catalog row version when last read
  cursor TEXT,                    -- adapter-opaque; NULL = not started
  state TEXT NOT NULL,            -- queued | current | paused | failed
  error TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (consumer, session_id)
) WITHOUT ROWID;
CREATE INDEX transcript_index_progress_queue
  ON transcript_index_progress (state, priority DESC, updated_at);
```

Each consumer owns its output tables. Issues keep theirs. The question
consumer adds its own (step 4).

### Scheduling and fan-out

- One runner subscribes to `session-catalog-updated` and reads
  `readChanges(since)`, as `IssueIndexer` and `VocabularyLearning` each do
  today. A changed row queues its session for every enabled, eligible
  consumer whose recorded `source_version` differs.
- One worker drains the queue by priority: the open or viewed session first,
  then active sessions, then backfill.
- **Fan-out.** Consumers whose cursors for a session are equal share one
  read: the runner reads the batch once and applies it to each in turn, each
  in its own transaction with its own cursor advance. In steady state every
  consumer is current, so an append is read once for all of them. A consumer
  that is behind (newly enabled, version bumped) catches up with its own
  reads until its cursor meets the others.
- Budgets carry over from `issue-text-reader`: 8 MiB or 2,000 records per
  batch, 1 MiB per record, a 30 s deadline, yielding between batches.
- Settings changes and tombstones fence and requeue as `IssueIndexer` does.

## Steps

### 1 — one append-source reader

Rebuild `issue-text-reader.ts` on `transcript-ingestion.ts` framing as the
append source adapter, returning raw entries and normalized messages.
`readIssueTextBatch` and content search become thin projections over it.
The cursor format gets a new layout version; an old cursor restarts the
session from zero, which the issue occurrence dedupe already tolerates.

No behavior change: issue evidence and search results are identical before
and after on a copy of the maintainer's profile.

### 2 — the runner, with issues as the first consumer

Add `transcript_index_progress` and the runner. Port `IssueIndexer` to a
consumer: its sweep, queue, fences and pause move into the runner; its
`captureChunked` projection and `observe` (viewed windows) stay with the
consumer. The migration copies `issue_index_jobs` rows to
`consumer = 'issues'` and drops the old table.

Issue settings (`issueAssociations`) keep their meaning and become the
consumer's `enabled` and `eligible`.

### 3 — Codex async questions as a consumer

The consumer folds Codex entries into rows:

```sql
CREATE TABLE async_questions (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  question_index INTEGER NOT NULL,
  title TEXT NOT NULL,            -- clipped to 320 characters
  asked_turn INTEGER NOT NULL,    -- user-turn ordinal when asked
  asked_at TEXT,
  answered_turn INTEGER,          -- set by a later quote reply
  PRIMARY KEY (session_id, message_id, question_index)
) WITHOUT ROWID;
CREATE TABLE async_question_turns (
  session_id TEXT PRIMARY KEY,
  user_turns INTEGER NOT NULL     -- current user-turn ordinal
) WITHOUT ROWID;
```

- A `user_message` advances the session's turn ordinal and marks the nearest
  unanswered question with a matching full title answered, as
  `collectQuoteReplies` does now.
- Age is computed at read time: `user_turns - asked_turn`.
- `start: { tailBytes: 2 MiB }`. A session never seen starts at the last
  2 MiB, as the preview does now, and records that earlier history was
  omitted. Sessions created after this step starts are followed from the
  beginning.
- `reset` deletes the session's rows; the next read rebuilds them.
- The catalog row's `asyncQuestions` and the list responses are filled from
  these tables with the current wire shape (previews, `age`, `askedAt`,
  `omitted`), so no client changes.
- Delete `readCodexAsyncQuestions`, its single-flight cache, the catalog's
  question pass in `RetainedSessionCollections`, and the `deferAsyncQuestions`
  plumbing. `ExternalSessionTracker` reads question previews from the table.

Contract changes: [session summary fidelity](../../topics/session-summary-fidelity.md)
loses the 2 MiB preview rule; the
[provider output contract](../../topics/provider-output-contract.md)
keeps its observable discovery semantics.

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

### 5 — vocabulary learning as a consumer

`VocabularyLearning` becomes a consumer over normalized messages, with its
look-back window as `eligible` and `start`. That retires its whole-session
rescans on version change and its per-publication walk of the whole catalog
([gap](../../gaps/speech-vocabulary-scan-per-catalog-publication.md)). The
live-tail contract in
[vocabulary learning has no live tail](../../gaps/vocabulary-learning-has-no-live-tail.md)
follows naturally: entries reaching the indexer while collection is on are
arrivals, not replays. Its separate database and bloom filter stay.

### 6 — adapters for the other providers

Add the append adapter for Pi and Grok, the document adapter for Gemini, and
the database adapter for OpenCode and Antigravity. Each consumer that
declares `providers: "all"` then covers them without consumer changes:
issue references and search reach every provider for the first time.

### 7 — later

- A disk-backed search consumer
  ([all-sessions search index](../../gaps/all-sessions-search-index.md)).
- Reading the Claude durable index's appends through the append adapter.
- Per-session databases for consumer output if
  [that sketch](../../gaps/sketches/prefer-per-session-sqlite-over-global-keyed-by-session.md)
  is adopted.

## Review gates

- **Plan review** before step 1.
- **Step 1:** issue evidence and search results identical before and after
  on a `VACUUM INTO` copy of the maintainer's profile, served by a second
  server on a port other than 3400.
- **Step 2:** the migration on that copy; issue jobs resume where they
  stopped; no evidence lost or duplicated.
- **Step 3:** `active-session.mjs` with the scan trace: question reads per
  append drop from about 2 MiB to the appended bytes, and the cold catalog
  reads no more than the old preview did. Question previews identical to
  the old scan for every session on the copied profile.
- **Step 4:** the compatibility review and its capability.
- **Each step:** the server's main-thread time during writes is no higher
  than before.

## Testing

- Adapter tests per kind: partial final record, truncation, replacement with
  the same size, a rewrite that keeps the boundary probe (see the warning in
  the [search index gap](../../gaps/all-sessions-search-index.md)),
  `history_base` segments, and compressed rollouts.
- Runner tests: fan-out reads each byte once for consumers at the same
  cursor; a lagging consumer catches up without rereading for the others; a
  consumer's failure pauses only that consumer; a version bump resets only
  that consumer; tombstones call `forget`.
- Question consumer: quote replies answer the nearest matching question,
  ages from turn ordinals, `reset` after rewrite, tail start marks omission.
- Existing issue and search tests keep passing unchanged through step 2.

## Risks

- **Synchronous SQLite writes on the event loop.** Each batch commits per
  consumer. Batches stay bounded and the worker yields between them; commit
  latency is measured in step 2.
- **A consumer bug blocks its own progress.** Failures mark that consumer's
  row `failed` with its error and do not stop other consumers or the read.
- **Codex forks reread parent segments.** A fork follows its parent's
  segments up to the fork point, as the issue reader does now, so parent
  bytes are read once per fork. Acceptable at current fork counts; see open
  questions.
- **Rewrite detection is probabilistic.** Fences sample the head and the
  bytes before the cursor; they do not hash the whole prefix. A rewrite that
  preserves both probes and grows the file is missed. This is today's
  behavior for issues and the Claude durable index.
- **Migration of issue jobs.** A failed copy must leave `issue_index_jobs`
  in place; the step 2 migration is reviewed on its own.

## Open questions

- Should Codex fork segments be indexed once per file, with answered state
  per leaf session, instead of once per fork?
- Should the open session's appends bypass catalog coalescing so questions
  and search see them sooner than 300 ms?
- Do Antigravity's stores expose a stable per-message key for the database
  adapter?
- Should consumer output live in per-session databases from the start, or
  wait for that sketch to be adopted?

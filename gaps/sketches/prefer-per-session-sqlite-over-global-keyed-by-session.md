# Session-scoped SQLite state has no rule about when it should be its own database

YA has one convention for session-scoped SQLite state, and it is implicit:
put it in a shared database and key it by session id. `discovery.sqlite` holds
issue evidence, links and index jobs that way, and the learned-vocabulary
database holds scan checkpoints that way. Nobody chose that over the
alternative; it is what the first table did and what every table since has
copied.

**The preference to adopt.** Where per-session SQLite databases would suffice,
prefer them to one global database with the session id as part of the key. The
exception is real and expected to be common: it does not apply where the state
answers cross-session generation or other cross-session queries, which a
per-session file cannot serve without opening all of them.

## Why the shared shape costs something

Each of these was observed in this repository rather than argued from
principle:

- **Deleted state never returns its space.** `discovery.sqlite` on the
  maintainer's host is 30 MB, of which 7620 of 7638 pages are free list, left
  behind when a migration dropped the speech vocabulary tables. Auto-vacuum is
  off, so the file cannot shrink. A per-session database is deleted with its
  session and the space is simply gone.
- **One writer serializes everything.** SQLite admits a single writer per file
  regardless of which rows are touched, so unrelated session-scoped writes
  queue behind each other. Separate files are the only way that becomes
  parallel, and this is the one benefit that would be *lost* by splitting if
  the writers were never concurrent to begin with — worth measuring, not
  assuming.
- **A shared table invites the sweep.** The write storm fixed in
  `0a02dd5fc` was a per-row bookkeeping update issued across every session in
  the catalog. That operation is only expressible because every session's row
  sits in one table. Per-session storage makes "touch every session" an
  obviously expensive thing to write rather than a one-line loop.
- **Hot rows are write amplification.** Any global counter or shared summary
  row is rewritten by every scanner output. On a rollback-journal database
  that is a dirtied page and a journal create/write/delete per result.

## What addressing this means

Audit today's session-scoped tables against the preference and record the
verdict for each, because a first look suggests most of the issue tables fall
under the exception rather than the rule:

- `external_issues` and `session_issue_links` are cross-session by definition;
  the feature exists to answer which sessions mention one issue.
- `session_issue_evidence` feeds a listing that counts distinct sessions per
  issue (`IssueStore.ts:246`), so it is queried across sessions.
- `issue_index_jobs` is per-session scan state, but the worker selects the next
  batch across all sessions (`IssueIndexer.ts:230`) and coverage groups by
  state across all of them (`:342`). Per-session files would need that queue to
  live somewhere else.
- Learned-vocabulary scan checkpoints are per-session; the vocabulary counts
  they feed are a cross-session aggregate.

Then measure what the split costs before committing to it: the floor size of an
empty database (an initialized `discovery.sqlite` with no rows is 73728 bytes,
and the maintainer's host has 1409 catalog rows), the open file handle count,
and the prepared-statement budget that `YEP_SQLITE_STATEMENT_CEILING` exists to
protect, since every open database carries its own statements.

When the audit and the measurement agree, this stops being a gap and becomes
permanent development guidance alongside the rest of
[required SQLite](../../topics/required-sqlite.md).

Found 2026-09-10, proposed by the maintainer while tracing a write storm whose
shape came from every session's bookkeeping living in one table.

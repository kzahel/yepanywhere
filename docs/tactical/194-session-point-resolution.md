# Efficient session identity and backing-store resolution

Status: implemented, reviewed and verified 2026-11-17. Opus 5.5 high reviewed
and revised the plan before compaction and implementation. The Fable 5.2
review and the primary agent's reproductions were addressed, and a Fable
follow-up review approved the fixes. Primary verification is complete (see
[Implementation and verification](#implementation-and-verification)).
The maintainer requested this plan, that review, explicit compaction
before Opus implementation, a Fable 5.2 medium review, Opus fixes,
verification, and a final commit. Both delegated sessions use bypass
permissions and the Work Claude pool; Opus uses weekly pace. The maintainer
authorized the Codex SQL locator and the bounded identity/source consolidation
below; no provider version, API or protocol refresh is requested.

## Problem and evidence

Opening a known session should cost a point lookup plus the history requested.
The identity store already resolves YA ids (`resolveYa`), scoped native refs
(`lookupNative`) and viewer addresses (`lookupViewerNative`) with indexed SQL,
and callers already pass a typed `SessionIdentityLookup`. The unbounded cost is
physical location. `CodexSessionReader.findSessionFile` checks the shared
`codexRootFileIndex`, then a fork hint, then calls `scanSessions()`, which
enumerates the whole native tree. It never consults Codex's own
`threads(id PRIMARY KEY, rollout_path)` row. Every Codex point method funnels
through it: `getSession`, summaries, `getSessionFilePath`,
`getNativeSessionRef`, `getSessionProjectPath`, agent/child lookups and resume.

A second, separate Codex point ladder exists:
`CodexSessionScanner.getSessionProjectPath` finds one non-subagent session by
calling `scanAllSessions()` over its own cache, and
`findNativeSessionProjectAcrossProviders` prefers it (or constructs a fresh
`CodexSessionReader`) for legacy native addresses.

A read-only diagnostic of a roughly 5 MB local rollout measured its actual
entry acquisition at 18–44 ms. A fresh reader with the persisted discovery
index spent 365 ms locating it across 245 directories and 3,825 files, even
though every discovery record hit. A native SQL point query found its path in
0.38 ms. These are diagnostic observations, not controlled performance
ratchets, and they do not prove the entire original 739 ms route acquisition
bucket was discovery work. The root index is process-wide per sessions-root
string, so the walk is paid when that owner is cold: the first lookup after
start, after `invalidateCache()` deletes the root, or for a root keyed by a
different string. Bound readers are keyed by `native.storageScope` (a realpath)
while catalog readers use the configured `project.sessionDir`; where those
differ they do not share a root index. Private session identifiers and paths
stay out of the committed evidence.

Relevant existing work and boundaries:

- [Provider history facts](../../topics/provider-history-facts.md): point and
  window questions must not silently become whole-history scans; extend the
  existing owners rather than adding another cache or scanner. Add the locator
  to its consumer inventory.
- [Cold-storage startup gap](../../gaps/sqlite-backed-cold-storage-startup.md)
  and [SQLite cleanup](../../gaps/sqlite-cleanup-and-wins.md), especially the
  native thread-index/discovery work: this plan addresses point resolution,
  not whole-catalog SQL listing, JSON shard migration, or watcher removal.
- [Native thread-index research](../research/codex-native-thread-index.md):
  watcher hints and child locators are adopted, general SQL listing is deferred.
  Its recorded write semantics bind this plan: a row is deferred until history
  persists and can lag but should not lead its rollout; `codex exec` may write
  no row; compression never updates `rollout_path`; archiving moves the file
  and then updates the row; nothing prunes rows whose file is gone.
- [Identity](../../topics/session-identity.md),
  [Codex discovery](../../topics/codex-metadata-scanner.md),
  [Codex sessions](../../topics/codex-sessions.md) and
  [catalog point lookups](../../topics/session-catalog-observation.md#accepted-session-point-lookups)
  own the current contracts.
- [Runtime-portable SQLite](../../topics/required-sqlite.md#runtime-portable-sqlite):
  read-only open, explicit columns, finalize every statement, no backend-only
  API.
- [Architecture](../../ARCHITECTURE.md) and the
  [roadmap](../roadmap/README.md) retain their existing broader priorities;
  this is the maintainer-selected session-opening repair.

Upstream precedent (pinned `references/codex` at `rust-v0.169.0`):
`rollout/src/list.rs` `find_thread_path_by_id_str_in_subdir` first asks
`threads` for `rollout_path`, resolves `.jsonl` then `.zst`, accepts it only
when the head `session_meta.id` equals the thread id, and otherwise falls back
to a filename search. `state/migrations/0001_threads.sql` makes `id` the
primary key. `thread-store/src/local/revert_thread.rs` persists a replacement
rollout before `replace_rollout_path_if_current` swaps the row, and removes the
replacement on conflict.

## Intended contract

Resolution has two layers that stay separate. Identity resolution maps an
explicitly typed YA address or provider-native address to the canonical YA
identity and exact native scope using the existing identity store and
`SessionIdentityLookup`; native strings are never guessed to be YA ids, a bare
native id matching several stores stays ambiguous, and pending/unbound/deleted
identities keep their existing outcomes. Physical point location maps one
native thread id within one native root to its winning rollout file and is
provider-owned. Neither layer adopts or creates identities outside the
existing explicit discovery boundary, and neither acquires a summary or
transcript.

For Codex, physical point location is one locator shared by the reader and the
scanner. Its order is: the accepted root index; the YA fork hint; the native
`threads` row; then the existing enumeration. A valid indexed thread on a cold
root must be found without enumerating the store or reading unrelated rollout
headers. Every SQL outcome other than a validated hit (no database, unsupported
schema, busy/locked, missing row, stale path, mismatched head, archived or
outside path) falls back to enumeration with today's result; SQL absence is
never native absence. Within one root a thread id is a primary key, so the
locator never chooses among stores; cross-store ambiguity remains the identity
layer's concern.

The row names the logical thread's current physical rollout, as upstream
resumes it. It does not prove a filename-newer sibling is absent, for example
during the revert window before the row swap. A SQL candidate is published
through `observePoints`, so an already known newer file keeps precedence under
`isNewerCodexSessionFile`, and the watcher or next enumeration converges.
Logical thread lookup never serves physical ancestor lookup by rollout id
(`findRolloutPathById`), because a suffixed `<thread>_<rollout>` file's rollout
id is not a `threads` key.

## Implementation steps

### Codex native thread locator module

Add a domain-named module beside `codex-root-file-index.ts` (for example
`codex-thread-locator.ts`). `codex-reader.ts` is at 3,760 of its 3,761-line
budget, and `app.ts` and `routes/sessions.ts` are exactly at budget, so new
logic goes into the module and the hubs receive only net-neutral or shrinking
wiring. Run `pnpm source:budgets --record` if lines are freed.

- Factor the read-only open/realpath/device-inode lease from
  `codex-spawn-index.ts` into one shared helper used by both the spawn index and
  the locator, rather than a third open path. Likewise reuse, not copy, the
  canonical-to-configured root mapping in `codex-thread-index.ts` `locate`
  (configured root and its realpath; archived roots and outside paths are not
  active hits).
- Query `SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?` with
  explicit columns and a positional parameter, prepared once per finite lease
  and finalized before close. Cite the `rust-v0.169.0` sources above. Skip SQL
  for a non-UUID id. Set no busy timeout: the adapter is synchronous, so a wait
  would block the event loop; busy or locked means fallback. Use only
  `codexStateDatabasePath(sessionsDir)`, never `CODEX_SQLITE_HOME`.
- Validate before publication: the mapped path, its plain-then-zstd
  representation via `findCodexRolloutRepresentation`, the filename thread id,
  and the head `session_meta.id` read through the reader's existing
  `readSessionMeta` (discovery-index header proof by file stamp is acceptable).
  Do not filter subagents or project here. Generic `findSessionFile` is
  root-wide and returns subagents (`getAgentSession` depends on it); only the
  fork-hint branch filters project. Callers that need narrower semantics filter
  the result.
- Publish exactly as the fork-hint branch does. Capture `readVersion()` before
  the SQL read, refuse when the reader is retired, retry when the root no longer
  `accepts` that read, and return `getSession(id)` after `observePoints`. Add no
  cache, registry, single-flight owner or timer.
- Return a small typed outcome (hit or a fallback reason) so tests and a bounded
  debug log can distinguish reasons without logging private paths.

### Route Codex point consumers through the locator

- Replace the scan-first tail of `CodexSessionReader.findSessionFile` with the
  locator, moving the fork-hint/scan ladder out of the hub if that keeps the hub
  within budget. All reader point methods inherit it without per-route edits.
- Make `CodexSessionScanner.getSessionProjectPath` use the same locator first
  and keep its non-subagent filter and enumeration fallback. Make the Codex
  branch of `findNativeSessionProjectAcrossProviders` reach the locator through
  whichever of the scanner or reader it already uses. No second SQL path.
- Leave `getNativeSessionRefs`, listing, the watcher, the child spawn locator
  and `findRolloutPathById` unchanged.

### Bounded identity/source consolidation

The identity layer already has indexed SQL, a typed lookup and a viewer
resolver, and none of it is the measured cost. Do not add a route-level
resolver that wraps `resolveExistingSessionIdentity`, `boundSessionSource`,
`resolveSessionReader` and project routing; that would be another wrapper
over the same fallback ladders across dozens of frozen-hub call sites.
Consolidate only the duplicated decision: both `boundSessionSource` and
`resolveExistingSessionIdentity` derive "stored, legacy, or resolve a YA id"
from `SessionIdentityLookup` with the same inline ternary. Give that one
exported function beside `SessionIdentityLookup` and use it in both, keeping
`boundSessionSource`'s identity-mismatch throw and `null` for unbound
identities. If inventory finds another identical copy outside frozen hubs,
include it; otherwise record retained adapters (legacy ladders, project
routing, Claude filename-case proof, Grok/Pi native project paths) as
deliberately unchanged.

Do not thread "resolved source evidence" through route callers. After the
first point lookup, later calls in the same request hit the root index. Change
a caller only if a test shows it re-enumerating.

### Integration and race coverage

Use actual temporary SQLite databases and rollout files, reusing the
`codex-thread-index.test.ts` schema and home builders. Each case uses its own
root because the root index is process-wide. Assert work counters, not wall
time.

- Cold hit: a fresh reader over a root with many unrelated rollouts across
  date directories resolves the indexed thread through `getSessionFilePath`
  and one detail or summary read. It records no scan (`getLastScanMetrics()`
  stays null, or the directory/header counters are zero) and returns the same
  file that enumeration would. This must fail against the scan-first code. Do
  it once through the reader and once through `getSessionProjectPath` for the
  scanner path, including a subagent thread the reader returns and the scanner
  excludes.
- Alias: a symlinked configured root, plus macOS's `/var` → `/private/var`,
  maps canonical row paths back under the configured root.
- Fallback table, one parameterized test: no database, `threads` without
  `rollout_path`, missing row, row naming a missing file, row whose head
  belongs to another thread, archived row, outside row. Each returns the
  enumeration result.
- Representation: the row names plain while only `.zst` exists; both exist and
  plain wins.
- Precedence: a root that already knows a filename-newer rollout keeps it when
  SQL names the older one; a cold root returns the SQL-named rollout, and a
  later enumeration converges on the newer one.
- Race: hold the head read on a controllable promise, then invalidate the
  root or complete an enumeration before releasing it. The stale result must
  not publish under the old authority, and the retry returns the current file.
  Use no timers.
- Run under the vitest `YEP_SQLITE_STATEMENT_CEILING` so a per-call prepare or
  a missing finalize fails.
- Identity consolidation is behavior-preserving. Existing YA, scoped-native,
  viewer-ambiguity and pending/unbound tests must pass unchanged; add a test
  only for behavior that actually changes.

Do not add mocked wiring assertions or a second test for every consumer. One
reader and one scanner case prove the funnel.

### Local diagnostic and documentation

Re-run a focused read-only diagnostic of a cold SQL hit and a forced fallback,
with directory, file and header counts and bytes. State the host and runtime,
and keep it distinct from the original report. Also record whether the host's
configured Codex sessions root equals its realpath `storageScope`; if not,
bound and catalog readers keep separate cold roots, which the locator
mitigates. Record root-key canonicalization as a follow-up rather than
widening this slice. A read-only open may create WAL/SHM sidecars, as in
production. Do not restart the user's server or providers, write their native
DB or history, or use their primary browser.

Update [Codex discovery](../../topics/codex-metadata-scanner.md) and/or
[Codex sessions](../../topics/codex-sessions.md) with the point-lookup order,
validation and fallback contract; the provider-history consumer inventory; and
the thread-index research status for exactly this adopted locator. Leave
catalog, watcher and SQL listing work open.

### Verification, review and commit

Run focused regressions, then `pnpm lint`, `pnpm format:check`,
`pnpm typecheck` and `pnpm test`, warning-free. No client change is planned,
so no browser check. Record durations and macOS-only qualification;
Linux/Windows path, alias and SQLite-sidecar behavior are inferred, not run.

The primary session owns the workflow: after Opus reviews and revises this
plan, compact its session through YA's queue, verify the compaction receipt,
then ask it to implement without committing. Launch an independent Fable 5.2
medium Work-pool reviewer through v0; give findings to Opus and verify its
fixes, with follow-up review for substantive remaining issues. Commit only the
completed task files after final verification, with one `Contributing-model:`
trailer per contributing model. Do not push unless requested.

## Implementation and verification

Implemented 2026-11-17 against `3174062293f7`; both reviews and final
verification are complete.

- `sessions/codex-thread-locator.ts` owns the order root index → fork hint →
  validated `threads` row and returns `found`, `retry` or a typed `fallback`
  reason. `CodexSessionReader.findSessionFile` and
  `CodexSessionScanner.getSessionProjectPath` call it and enumerate only on
  fallback. `findNativeSessionProjectAcrossProviders` reaches it through
  either of those, with no route changes.
- `codex-thread-index.ts` now exports the finite read-only lease
  (`openCodexStateQuery`) and the canonical-to-configured mapper
  (`createCodexRolloutPathMapper`). The spawn index, the change hints and the
  locator share them. `readCodexSessionFile` in `codex-discovery.ts` is the
  one head-to-locator mapping used by the reader and the locator.
- `selectStoredIdentity` beside `SessionIdentityLookup` replaces three
  identical copies of the choice, in `boundSessionSource`,
  `resolveExistingSessionIdentity` and session-detail loading. The legacy
  ladders, project routing, Claude filename-case proof and Grok/Pi native
  project paths are deliberately unchanged.
- `codex-reader.ts` shrank from 3,760 to 3,720 lines. Its budget was recorded
  down to match, and no other hub grew.

Tests (`test/sessions/codex-thread-locator.test.ts`) use real temporary
`state_5.sqlite` databases and rollouts through a fixture now shared with the
thread-index tests:

- **Cold hit.** A cold reader and scanner answer indexed threads with no scan
  and only the target heads read. The detail read returns that thread's
  transcript title. The reader returns a subagent and the scanner excludes
  it.
- **Aliases.** The macOS `/var` alias and a symlinked configured root both
  map correctly.
- **Fallbacks.** One parameterized table covers every fallback reason except
  `escaped`, which has its own case. The reasons are: no database, schema
  without `rollout_path`, missing row, missing file, head mismatch, filename
  mismatch, archived, outside and non-UUID id. Each returns the enumeration
  result.
- **Representations.** The `.zst`-only and plain-plus-`.zst` representations
  resolve correctly.
- **Revert.** A lagging row loses to a newer rollout, a later enumeration
  converges, and a row naming the suffixed post-revert rollout hits without a
  scan.
- **Races.** An invalidation or completed enumeration during the head read
  causes a retry, never a stale publication.
- **Retirement.** A reader closed during the head read, or before the lookup
  (with a row or without one), returns no session, publishes nothing and
  never enumerates. A live reader still finds the thread afterwards.
- **Symlink escape.** A row naming a valid rollout reached through a
  symlinked directory or file below the root falls back as `escaped`.
  Enumeration also returns none, and the watcher hints skip the row without
  declaring the index foreign.

Mutation checks were reverted afterward:

- Disabling the SQL step failed 14 of the 16 cases that existed then.
- Removing the authority recheck fails the invalidation race.
- Removing canonical containment fails both escape cases.
- Removing either retirement fence (before publication, or before
  fallback/SQL) fails the retirement case.

The vitest statement ceiling applies to every lease.

Final checks, all passing and warning-free, macOS only, logs in
`/tmp/ya-194/fix-*`:

- the focused regressions (26 files, 221 tests);
- `pnpm lint` (33 s);
- `pnpm format:check` (1 s);
- `pnpm typecheck` (55 s);
- `pnpm test` (185 s): server 7,588 passed and 97 skipped; client 7,437;
  shared 992; relay 139; push-broker 45.

Focused runs must use the safe-home wrapper
(`node ../../scripts/run-with-safe-home.js --temporary-home vitest run ...`).
Plain `npx vitest` uses the real home, and two unrelated identity tests failed
there.

### Review disposition

The Fable 5.2 medium review and the primary agent's synthetic reproductions:

- **Retirement fence: fixed.** The guard was checked only before SQL. A
  reader closed during the head read still published, and a closed reader
  fell back to a full scan. The locator now returns `retired` before SQL,
  immediately before any fork-hint or row publication (synchronous with
  `observePoints`), and instead of a fallback. The reader returns null.
- **Physical escape: fixed.** Lexical containment let a row reach a valid
  rollout through a symlinked directory below the root, which enumeration
  ignores. The shared mapper now requires the canonical candidate to equal
  the canonical root plus the same suffix. That preserves configured-root
  aliases and plain/zstd precedence. The watcher hints skip an escaped row,
  which also closes the same path into the watcher's change events.
- **Tautological detail assertion: fixed.** The test now asserts a non-null
  session, its id, and the title parsed from its first user turn.
- **Suffixed post-revert row: covered,** as a cold SQL hit with no scan.
- **Lagging row on a point-only root: accepted and documented, no code
  change.** Upstream resumes the same row. Detecting a newer sibling would
  need a directory listing or discovery beyond this slice. The
  [contract](../../topics/codex-metadata-scanner.md#thread-point-lookups)
  states:
  - the revert, crash and stale-database triggers;
  - that convergence needs an enumeration or invalidation of the same root
    key;
  - the separate bound/catalog keys and the scanner's inherited staleness;
  - the extra SQL read on a miss.

  Root-key canonicalization stays a follow-up.
- **Nits: fixed.**
  - A filename mismatch now reports `mismatched-name`.
  - The fixture's schema comment names `rust-v0.167.0` through
    `rust-v0.169.0`.
  - The plan's case wording no longer miscounts.
- **Residual limits, recorded rather than changed:**
  - A busy/locked database is handled by inspection of the `catch`; there is
    no test.
  - Bun, Linux and Windows are not exercised. Windows canonical-path forms
    are expected to fall back safely.
  - No route-level end-to-end zero-enumeration test was added.

The follow-up Fable review confirmed these fixes and accepted the documented
limits. Its remaining nits were this status line and the case wording above.

The local diagnostic ran read-only on macOS with Node 25.8.2, the maintainer's
`~/.codex` (3,826 rollouts in 245 directories), and a `/tmp` copy of the
persisted discovery index. It used three recent indexed threads, each on a
fresh root owner.

| Path | Directories | Head reads | Time |
| --- | --- | --- | --- |
| Cold SQL hit through `getSessionFilePath` | 0 | 1 | 0.45–1.6 ms |
| SQL row alone | – | – | 0.5–1.4 ms |
| Forced enumeration fallback | 245 | 3,826 discovery hits, 0 first-line reads | 78–115 ms |

The configured root equals its realpath `storageScope` on this host, so bound
and catalog readers share one root key here. Root-key canonicalization
remains a follow-up. This diagnostic measures discovery only. It does not
reproduce the original `readMs=739` bucket or show how much of it was
discovery, and it makes no relay or browser claim.

## Scope exclusions

This plan does not change the default two-compaction history selection or its
fewer-boundaries complete-reader semantics; add durable Codex transcript
position tables; replace whole-catalog discovery or `getNativeSessionRefs`
with SQL; canonicalize root-owner keys; use `threads` for archived or physical
ancestor lookup; remove watchers; change grants or hosted compatibility; tune
UI/rendering; or promise the reported relay/browser delay is resolved without
corresponding evidence.

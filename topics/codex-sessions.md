# Codex Sessions

> Codex sessions are provider-owned rollout files that YA reads as durable
> transcript state, grouped by `session_meta.cwd` rather than by directory
> layout; YA must preserve that provider storage model without turning rollout
> discovery into unbounded repeated work.

Topic: codex-sessions

Related topics: [codex-metadata-scanner](codex-metadata-scanner.md),
[provider-refresh](provider-refresh.md),
[session-context-actions](session-context-actions.md),
[session-ownership](session-ownership.md),
[architecture-mandates](architecture-mandates.md).

## Storage Shape

The active Codex provider path is the installed Codex CLI/app-server. Codex
owns local durable history under the Codex home directory, normally:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl
```

Each rollout is append-oriented JSONL. The first record is expected to be
`session_meta`, carrying the session id, cwd, timestamp, and related provider
metadata. YA uses that head metadata to answer questions Codex's directory
layout does not answer by itself:

- which project/worktree a rollout belongs to;
- which rollout id should be listed and opened;
- how to seed a session summary before reading the whole transcript.

This differs from Claude. Claude's local session path already encodes the
project directory, so project discovery can start from directory names. Codex
stores by date, so project discovery requires metadata.

### Native archived history

With the standard `sessions` root, ordinary project discovery, session lists,
and detail also read its sibling `archived_sessions`, even when `sessions`
does not exist. Native archive storage is not YA's own archived metadata flag;
YA filters continue to use the latter. A custom root not named `sessions`
does not implicitly expose sibling directories.

The same physical rollout copied into both roots appears once, with its active
copy preferred. Plain JSONL wins over zstd within a root. Archive/unarchive
moves retain the logical ID and are observed without restarting YA; detail
resolution repairs a disappeared cached path. Compressed-only archives require
native zstd support. Discovery never moves or rewrites provider files.

### Reference-backed fork history

Paginated Codex rollouts may store a fork as a small child file whose
`session_meta.history_base` points to an immutable prefix of another rollout.
The reference contains the source rollout id plus exclusive ordinal and byte
cutoffs. YA treats that chain as the child's logical transcript:

- the selected child's `session_meta` is the sole canonical metadata record;
- each root-to-leaf segment contributes only its local ordinal range, bounded
  by the descendant's exact frozen cutoff;
- later appends to an ancestor never enter an existing child; and
- ancestors may themselves be reference-backed, archived, or zstd-compressed.

Codex `thread/revert` keeps the logical thread id stable while switching its
SQLite row to a new immutable physical rollout. The replacement filename is
`rollout-<timestamp>-<thread-id>_<rollout-id>.jsonl`: `session_meta.id` remains
the stable thread id before `_`, while `history_base.thread_id` follows the
physical rollout ids. YA parses and validates both identities, selects the
newest physical rollout when scanning files for one logical thread, and keeps
older physical rollouts available as lineage ancestors. A fork may inherit
through a reverted rollout, so ancestor metadata is validated against the
stable thread id in its own filename rather than against the fork's id.

The history reference identifies the immutable rollout id encoded in the
provider filename, not a YA URL id substitution or a stable provider session
tree id. Resolution searches active and archived Codex roots, prefers the
plain representation when both plain and compressed copies exist, and fails
closed on a missing ancestor, cycle, identity mismatch, unsafe ordinal/byte
value, split JSONL record, or inconsistent cutoff. Detail surfaces report such
a lineage problem as a reader error after the leaf was found; summary/list
surfaces omit a session they cannot safely summarize.

Standalone and legacy rollouts retain the single-file read path. A
reference-backed detail cache reconstructs the immutable prefix on its first
read and then extends only from new leaf bytes. Physical compact-window
scanning is ineligible because leaf offsets are not logical-history offsets;
compact-tail and older-page requests use the established complete logical read
plus in-memory boundary selection. Provider-child ownership projection remains
physical to avoid assigning inherited subagents to the fork, while logical
detail parsing still recovers inherited agent mappings for navigation.

An interrupted turn appears as an aborted-turn row. If Codex includes an error
with that interruption, the row displays the provider's error message in both
the live stream and the persisted transcript. A plain user interruption keeps
the ordinary interruption label.

One deliberate exception to "YA never rewrites provider-owned rollouts": when
the user explicitly Kills a Codex session, YA renames its rollout with a
`.killed-<timestamp>` suffix so no resume path (YA or Codex app-server) can
find it. The rename is reversible and the content untouched; see
`topics/heartbeat.md` § Unowned Resume Exemptions and
`packages/server/src/sessions/resume-exemption.ts`.

## Process-Scoped Subagent Depth

The server-wide **Subagent nesting limit** is snapshotted for each newly started
or resumed Codex provider process. Numeric values `0` through `4` are sent as
`agents.max_depth` in the app-server config for `thread/start`, `thread/resume`,
and `thread/fork`; **Provider default** stores `null` and omits that key. YA
defaults the setting to `1` and never writes `~/.codex/config.toml`.

Pinned Codex core source describes `agents.max_depth` as a V1 multi-agent-thread
limit and explicitly says V2 ignores it. The Providers caption must retain that
limitation; YA must not imply that the setting constrains Codex V2 or Codex OSS
without a separately verified control.

## Service Tier

YA sends the selected tier (`priority` for Fast) on thread start/resume and
on every `turn/start`, and changes it live with `thread/settings/update`.
Codex does not restore the tier on resume or record it in the rollout, so
YA's launch settings are the only record. See [service tier](service-tier.md).

## Per-Turn Cyber Access Program

The server-wide **Cyber access program** setting names the access program YA
requests when the selected model permits it. **Let Codex choose** is the default
and omits `cyberAccessProgram` from `turn/start` entirely. The three named
selections send `standard`, `daybreakBlue`, and `daybreakRed` respectively.
`YEP_CODEX_CYBER_ACCESS_PROGRAM`
supplies the startup fallback and a saved setting takes precedence.

The field is read per turn and not retained by Codex, so YA sends the current
selection on each user turn rather than at thread scope. Before sending an
explicit selection, YA queries `model/list` through that session's app-server,
including hidden models and following pagination. If the selected model's
nonempty `availableAccessPrograms.cyber` list excludes the selection, YA omits
the field before the first attempt. Thus an account advertising only `standard`
for GPT-6 Astra never requests Daybreak for Astra, while its eligible models
still receive the configured Blue or Red selection. Model changes are checked
on the next turn. YA never substitutes one named program for another.

Missing or empty access-program metadata preserves the existing explicit
selection and refusal recovery for older Codex catalogs. A failed catalog
request fails the turn rather than treating the failure as permission. YA uses
the app-server's catalog caching rather than retaining a second eligibility
cache. YA-internal helper turns, such as the ephemeral recap thread, never send
the program. Requesting a program does not grant access; Codex and the backend
still enforce account, authentication and model eligibility.

Enrollment belongs to the signed-in ChatGPT account and is checked per model.
The one server-wide selection can therefore reach an account or model that is
not enrolled, for example after switching the Codex home to another
subscription. The backend refuses such a turn with HTTP 403; observed bodies
include `The requested Cyber access program is not authorized for this model.`
and `Daybreak isn't available for this model.` Enrollment can also depend on
how the account signed in, such as device auth without a hardware key, so YA
treats any 403 on a turn that requested a program as that refusal without
matching the body. The status comes from `codexErrorInfo`, else from Codex's
`unexpected status 403` error text. A native retry notification reports that 403
as `responseStreamDisconnected` and puts the denial text in
`additionalDetails`, while its main message is `Reconnecting... n/max`.
YA recognizes that refusal on the first notification, interrupts the native
retry, and waits for the refused turn's completion before starting another.
It does not wait for Codex's reconnect budget to expire. YA then reruns the
turn at once without the program and without resending the user's input.
The refusal appears as a
retrying warning, not a turn failure. YA remembers the refusal for that
account, model and program for the provider instance's lifetime, so later
turns handled by that instance send no program and do not fail first. With
isolated provider workers, this memory is session-local. The account is
identified by the `account/read` type and email and is read once per session.
If it cannot be read, the refusal applies only to that
session. The same 403 on a turn that requested no program is an ordinary
failure. `Thread.daybreakEnabled` is a separate client-saved choice used by
Codex's terminal UI; it does not itself select a turn's access program or grant
access. YA neither writes nor consumes it.

## Content-filter blocks

From Codex 0.160, a response the content filter blocks is retried after Codex
records a developer message wrapped in `<content_filter_guidance>`. Its text
tells the agent how to recover, either Codex's built-in wording or a per-model
replacement from the model catalog. YA hides other developer messages but shows
this one as a "Response blocked by content filter" row. The guidance is shown
in full, never collapsed, because the message is the only durable record that a
block happened; the retry's own error is transient. The live
`rawResponseItem/completed` and persisted response item share the provider's
message id, so a backfill merges them into one row.
`packages/server/src/codex/contentFilterBlock.ts` recognizes the message for
both paths.

## App-server notification correlation

YA stamps every app-server notification at the stdout boundary with a
monotonic receipt sequence, receipt time, queue depth, and provider/synthetic
source. Immediately before each `turn/start`, including an overload retry, it
captures the latest receipt sequence as that turn's queue barrier.

A turn-scoped notification whose different turn id was already received at or
before that barrier is stale backlog. YA suppresses it rather than replacing
the active turn or publishing old content as fresh activity. Consecutive stale
records produce one structured aggregate warning. A different turn id received
after the barrier remains eligible to replace the submission id because Codex
Core can report an active id that differs from the `turn/start` response; that
resynchronization warning includes the receipt sequence, barrier, queue age,
queued-ahead count, source, and provider-reported start time. This boundary is
sequence-based rather than a timing heuristic.

## Read Surfaces

There are two main YA surfaces over the same rollout tree:

- `packages/server/src/projects/codex-scanner.ts` discovers Codex projects by
  recursively finding rollout files, reading first-line `session_meta`, and
  grouping by canonical cwd.
- `packages/server/src/sessions/codex-reader.ts` lists and loads Codex sessions
  for a project. Listing also needs rollout metadata. Detail loading normalizes
  either a complete rollout or an authorized compact-tail source window for
  rendering.

`ProjectScanner` and route-level provider catalogs try to share this work
within a request path, while `SessionIndexService` persists provider-neutral
session summaries. `SessionDiscoveryIndex` now persists normalized provider
head metadata for observed rollout files under
`{dataDir}/indexes/session-discovery/`, including optional source fingerprints
for replacement detection. These layers reduce duplicate reads, but only
provider-owned files are authoritative.

### Detail entry-cache concurrency

`CodexSessionReader` may retain parsed detail entries for a rollout and extend
that cache when the provider appends JSONL. The cache update is a read as well
as a write: a detail request that observes cached byte boundary `S` and source
size `T` reads `[S, T)`, parses it, appends the entries, and advances the cached
boundary.

That transition has one in-flight owner per reader and session id. Concurrent
detail requests join the owner and recheck the cache after it finishes; they
must not independently read and append the same source range. The owner covers
the source check, bounded file read, parse, and cache publication. The retained
flat entry array is internal to the reader: only the owner mutates it, and
callers receive array copies.

Array-copy isolation must not discard exact-snapshot normalization reuse.
Copies issued from one accepted retained snapshot share a normalization
identity, so repeated detail projections reuse the same normalized messages.
An append, replacement, invalidation, or caller-side structural mutation
changes the entry sequence and must not reuse that projection. A caller can
therefore mutate its private array without poisoning the reader's retained
entries or making a different snapshot appear unchanged.

Plain-JSONL cold and incremental reads decode bounded byte chunks while
carrying incomplete JSONL records as raw bytes across both chunk boundaries and
cached append passes. They decode only complete lines or a complete final
record, and never materialize a whole rollout or appended suffix as one
JavaScript string. Each pass consumes exactly the byte count from its source
stat. Bytes appended after that observation belong to a later pass. A short
read fails rather than publishing entries under a byte boundary the reader did
not consume. A complete JSON record without its final newline may be accepted;
an incomplete trailing record remains provisional and is combined with the
next append without corrupting a split UTF-8 code point. Once head metadata has
identified a rollout, a detail-read failure is reported as a reader failure
rather than being converted into session absence.

A reference-backed warm cache also retains the leaf's expected next ordinal.
Every appended complete record must continue that ordinal sequence before the
reader publishes any of the new entries, so warm and cold reads reject the same
malformed lineage.

### Compact-tail source reads

For an uncursored compact-tail detail request over a large plain rollout, the
reader can avoid parsing and retaining the hidden prefix. The optimization is
eligible when the file is larger than 2 MiB times the requested compact-boundary
count and a cached session summary describes a valid prefix of the rollout.
An indexed summary may predate strict file growth; the reader refreshes
tail-derived fields from the live window. See
[indexed head fields](session-compact-tail-pagination.md#indexed-head-fields-for-a-session-still-being-written).
It scans backward from the captured end of file in fixed 1 MiB blocks, carrying
only the JSONL fragment that crosses each block boundary, until it finds the
requested Nth `compacted` record.

If the boundary exists, the reader parses only from that record through the
captured end. It tags parsed entries with their absolute source byte offsets so
normalized fallback identities remain stable across bounded and complete reads.
Compact-boundary ids encode that offset explicitly. If the route's turn selector
starts later than the compact boundary, it returns a source cursor for the first
visible row without replacing that row's durable message identity. The bounded
suffix is not published as a complete-entry cache snapshot. The route also
requires an omitted prefix to retain an older-history cursor; it fails rather
than presenting the suffix as the start of the session.

Incremental catch-up may retain that suffix in the existing append cache after
verifying the durable cursor and tool dependencies within it. Cache identity
includes the source start, so complete reads cannot mistake a suffix for full
history. Compactions rotate the retained suffix; unchanged reads reuse
normalization and ordinary appends parse only new bytes. Old or unknown cursors
and results needing omitted tool context use the complete reader. See the
[incremental contract and diagnostic comparison](session-compact-tail-pagination.md#incremental-catch-up).

A source-backed `beforeMessageId` continues the same reverse scan from the
cursor byte instead of the end of file. The reader finds the requested Nth
preceding `compacted` record and parses only the range from that boundary up to,
but not including, the cursor. If fewer than N preceding boundaries exist, it
reads only `[0, cursor)` and marks that page as the beginning of history. The
ordinary Load older control and older-history reverse search both use this path
through the same two-boundary session-detail request.

If the initial file has fewer requested boundaries, the summary is absent or
stale, the size crossover is not met, the source is compressed, or the located
range does not begin with a compact record, the reader uses the complete forward
path. Old or unparseable older-page cursors also use that established fallback.
This preserves the contract that fewer than N initial boundaries returns the
complete transcript while keeping valid plain-rollout pages blockwise.

A three-repetition diagnostic on the 538,524,921-byte recovery rollout measured
the detail read after an equivalent full-summary warm-up. The complete reader
took 4.07–4.38 seconds, retained 192,108 entries, and added 1.03–1.04 GB RSS.
The two-boundary tail took 30.5–30.7 ms for 855 entries and added 13–17 MB RSS;
the preceding two-boundary page took 37.7–39.4 ms for 1,503 entries and added
22–24 MB RSS. Both bounded modes retained zero complete-entry cache bytes. The
shared host had one non-overlapping agent and production services, so these are
diagnostic relative results rather than ratchet-grade absolute timings.

Cache invalidation advances the reader's cache revision before clearing
retained entries. Work started under an older revision may finish its file read
but cannot publish; the active request re-observes the source and retries. An
invalidation does not remove the in-flight owner and thereby permit a second
writer to race it.

Compressed rollouts remain full-read snapshots because their representation is
not append-derived. Cache retention is still bounded separately by the reader
memory work in tactical 038; eviction policy and concurrency ownership are
independent contracts.

## Compression And Representation

Upstream Codex can compress cold rollout files from:

```text
rollout-....jsonl
```

to:

```text
rollout-....jsonl.zst
```

The Codex Rust source treats this as a representation change, not a deletion:
compressed files are read through a line reader, and a compressed rollout can
be materialized back to plain `.jsonl` before append. Upstream also gives
plain `.jsonl` precedence when both representations exist.

YA should mirror the same logical identity rule:

- the canonical rollout identity is the plain `.jsonl` stem;
- `.jsonl` and `.jsonl.zst` are two representations of that rollout;
- if both exist, read the plain `.jsonl`;
- a compression transition must not make a session disappear.

## Current Gaps

Codex session support is correct for ordinary small local trees, but the
current shape has important scale and representation gaps:

- The durable `rollout file -> session_meta` catalog exists as a
  provider-neutral discovery index. It now detects common replacement and
  shrink/truncation cases through source fingerprints and cached file size,
  but a same-path overwrite that keeps the same file identity and
  non-shrinking size can still keep cached head metadata until a stronger
  validation pass exists.
- `CodexSessionScanner` now records project-scan metrics and slow logs for
  file walking, discovery-index behavior, plain/zstd precedence, and
  cache-backed compressed discovery. `FileWatcher` now records rescan duration,
  files walked, emitted create/modify/delete counts, overlap skips, and
  adaptive periodic-rescan delay. `CodexSessionReader` now records
  session-list scan metrics for shared-cache status, file walking,
  discovery-index behavior, plain/zstd precedence, parsed/skipped metadata,
  and filtered subagent sessions.
- `session_meta` is effectively append-immutable, and the Codex adapter now
  reuses cached metadata across ordinary append/mtime/size changes.
- Recursive discovery is still O(number of rollout files). Date-bucket layout
  is not yet used as a first-class pruning/indexing primitive.
- Provider archived sessions are not modeled as a first-class YA source. Codex
  has an archived-session concept; YA's ordinary Codex session path currently
  centers on the configured active sessions directory.
- Compression is a representation detail, but YA must not pay whole-transcript
  decompression cost just to rediscover head metadata. `.jsonl.zst` rollouts are supported
  when the active runtime exposes native `node:zlib` zstd APIs; unavailable
  implementations skip compressed rollouts cleanly. Runtime eligibility alone
  does not replace this capability check.
- The session id visible in YA must remain explicit. Provider-native resume
  handles, filename ids, and `session_meta.id` mappings must not silently swap
  the user-facing YA session id without a documented provider contract.
- Provider-child discovery is an unbounded read surface today.
  `CodexSessionReader.listProviderChildSessions` bypasses the streaming
  `readAgentMappings` projection and calls full `readEntries` with caching
  disabled. Because the process-list route invokes it for every active and
  recently terminated row, client `session-updated` revalidation repeatedly
  parses unchanged parent rollouts. This is the demonstrated owner of the
  2026-08-04 sustained server CPU incident, not a speculative scanner cost;
  see [provider-child-sessions](provider-child-sessions.md) for the correction
  contract.

## Near-Term Direction

The next durable improvements should build on the provider-neutral discovery
index without letting it diverge from provider-owned history:

1. Add an explicit validation strategy for same-identity, non-shrinking header
   overwrites. Current source-fingerprint and shrink checks cover common
   replacement/truncation cases without rereading ordinary appends.
2. Extend metrics and watcher-path coverage around canonical-stem
   rename/compression/delete reconciliation; scanner tests and metrics now
   cover a `.jsonl -> .jsonl.zst` transition preserving the session.
3. Re-read head metadata only when the rollout is new, cached metadata is
   missing or invalid, the file appears replaced/truncated, or an explicit
   validation pass marks the cache suspect.
4. Extend scanner instrumentation before broadening scope: dirty scopes and
   skipped date buckets once date-bucket probing exists.
5. Replace full-entry provider-child discovery with one shared, versioned
   child-summary projection. Coalesce identical in-flight versions, retain only
   child lifecycle facts, and inspect ordinary appends incrementally.

Invariant: the discovery index is derived and non-authoritative. YA must first
observe a provider file and only then reuse indexed metadata for that file. A
deleted or rotated provider file must disappear from YA lists immediately even
if its discovery shard still contains a stale record.

This keeps YA faithful to Codex's local transcript model while preserving the
resource-quiescence requirement from
[architecture-mandates](architecture-mandates.md).

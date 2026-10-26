# Session Index Validation

> How the session index decides a cached summary is still fresh, why
> shared-container providers (OpenCode's `opencode.db`) must not be
> stat-validated, why the TTL walk revalidates in the background instead of
> blocking a request, and why WS-tunneled requests must not queue behind a
> slow validation.

Topic: session-index-validation

See also:

- [`opencode-backend.md`](opencode-backend.md) — the OpenCode reader whose DB
  anchor motivated the shared-file rules here.
- [`sidebar-session-ordering.md`](sidebar-session-ordering.md) — the main
  consumer of `/api/sessions` freshness.
- [`session-summary-fidelity.md`](session-summary-fidelity.md) — the boundary
  between complete indexed summaries and bounded list projections.
- [`session-catalog-observation.md`](session-catalog-observation.md) — the
  install-wide observer, generation, and cold-row freshness hierarchy.

## Validation paths

`SessionIndexService` keeps one persisted index per (provider, project) scope
(`{dataDir}/indexes/*.json`) and revalidates it two ways:

- **Incremental** (watcher-driven): dirty sessions go through the reader's
  `getSessionSummaryIfChanged(sessionId, projectId, cachedMtime, cachedSize)`.
- **Full validation**: on first request per scope and whenever the last full
  validation is older than `SESSION_INDEX_FULL_VALIDATION_MS` (default 30s).
  Every enumerated session is checked.

List, title, cached-summary, and single-summary callers share one cold load per
scope. They never install separate mutable index objects from the same disk
revision. Each watcher or explicit invalidation also advances a scope change
revision. Incremental, full, and single-summary validation clears dirty state
only if that revision is unchanged when its async work finishes. An
invalidation that arrives during parsing therefore remains pending for the
next applicable validation instead of being erased by the older completion.

## Stale-while-revalidate

### Failed filesystem observations

Claude and Codex readers distinguish absent/empty/invalid metadata from an
I/O failure. Sharing locks, temporary permission failures, and transient device
errors must not certify an empty summary. Project discovery and indexed
list/title reads keep accepted entries and leave validation pending. A later
request retries without another filesystem event. Cold reads cannot invent
history; genuinely missing files disappear after successful validation. Direct
transcript reads may still report an unavailable source while it is locked.

For merged Claude sources, an empty or malformed earlier replica must not
hide the same ID in a later usable directory. Summary, detail, file-path, and
index enumeration select the usable source. Replica probing stops at the first
parseable entry rather than loading the whole transcript just for selection.

See [native session discovery verification](../docs/development/native-session-discovery-verification.md)
for executable filesystem/HTTP checks and manual acceptance.

The TTL walk is a consistency backstop for missed watcher events, so a
request must not pay for it in-line. When full validation is due only
because the TTL lapsed and the scope has a usable index — validated earlier
this run, or loaded from the persisted `{dataDir}/indexes/*.json` — the
request is served from that index immediately (watcher-flagged dirty
sessions still get their cheap row-level refresh first) and the walk runs
in the background. Background walks are deduped per (scope, options)
validation key and serialized across scopes so the per-project walk behind
`/api/sessions` cannot stampede the filesystem.

Changes the background walk finds are pushed to clients as bus events
(`session-updated` for changed rows, `session-created` for rows not
previously indexed — the client summary store upserts by id, so replays
are safe). Known gaps: deleted sessions have no removal event and
disappear only on the next refetch, and a directory-dirty scope (watcher
saw a create/delete) still validates in-line so a list fetch racing the
client's own created/deleted handling never sees the file missing.
Blocking full validation remains for first-ever scans (nothing usable to
serve) and for `SESSION_INDEX_FULL_VALIDATION_MS=0`, which keeps its
validate-every-request contract.

Measured on the dev corpus (2026-07-03): first `/api/sessions` after 30s
idle went from 1.2–2.35s (post-`feec8fb6`) to ~6ms via curl and 25–90ms
inside a fresh browser window's boot burst; that window's sidebar session
list populated at ~1.45s instead of ~2.7s, with the remainder dominated by
dev-mode module loading and app boot, not API stalls. Warm-restart first
requests serve the persisted index the same way instead of blocking
~2.2s. Because a validated scope now persists its index even when empty,
only the first-ever list of a scope (fresh data dir) still blocks.

## The freshness contract

- **Per-file sessions** (Claude/Codex/pi jsonl, Gemini json, OpenCode
  file-tree json): the entry's `filePath` is exclusive to the session, so
  full validation compares `stat(filePath)` mtime/size against the cached
  `fileMtime`/`indexedBytes`. Cheap and exact.
- **Shared-container sessions** mark their enumeration entries
  `sharedFilePath: true` (`ISessionReader.listSessionFiles`). The container's
  stat says nothing about one session — its mtime moves on any write, and the
  cached keys are *row-derived*, so a stat compare can never match. Full
  validation must instead call `getSessionSummaryIfChanged`, whose units the
  reader owns end to end (OpenCode: session row `time_updated` + message
  count). Unchanged rows count as cache hits; changed rows re-summarize
  through the same cheap row read, never the heavy parse queue.
- **Reader `IfChanged` contract**: "unchanged" must be terminal. The OpenCode
  chain (DB row → file tree → CLI) previously returned the same `null` for
  "row unchanged" and "not in DB", so an unchanged DB session fell through to
  a per-session `opencode export` spawn on every validation.
- **Provider-specific semantic repair** may reject an unchanged persisted row
  only when the row itself proves it violates the current summary contract.
  Claude titles beginning with a local-command caveat are re-read once and
  replaced by the first non-meta user title; unrelated provider rows keep their
  existing cache entries instead of paying a global index rebuild.
- **A repair aimed at older readers is dated by the index version**, never by a
  field current writers still produce. The persisted `version` says which
  reader wrote the entries, so a repair runs on indexes below the version that
  ended it and stops once the index is rewritten. A repair keyed on the field
  instead re-runs forever: `isEmpty` marks a transcript that yields no summary,
  which current validation still records, so deleting every `isEmpty` Claude
  row re-parsed those transcripts on every index load. Ending such a repair
  raises the current version, and every structurally compatible predecessor
  stays accepted, so the bump dates entries without rebuilding any index.
- **Legacy CLI sessions** (pre-1.16 projects with no DB row) are probed from
  one shared `opencode session list` spawn (module-level cache,
  `OPENCODE_CLI_LIST_CACHE_TTL_MS`), whose output is global — verified not
  cwd-scoped — so N legacy projects no longer pay N spawns per burst, and
  per-session `export` spawns are out of the validation path entirely.

The mtime and byte count on an indexed row mean the complete summary covers
that exact file version. A bounded list/head read must never advance those
markers. Lightweight collection routes may project a stat-validated complete
row or use a separately typed list reader on mismatch while leaving the row and
its dirty signal intact for the next complete consumer.

Violating any of these re-derives every affected summary once per full
validation. Measured on the primary dev machine (2026-07-03, ~40 OpenCode
sessions across 6 scopes): first `/api/sessions` after 30s idle cost 8.2s
before, 2.2s after (remaining cost ≈ one 1.1s CLI list spawn plus serialized
scope walks); calls inside the TTL are ~10ms either way.

## Cold scans

A brand-new data dir still parses every session once (31s measured for the
full dev-machine corpus): summary parsing is serial by default
(`SESSION_INDEX_SUMMARY_PARSE_CONCURRENCY=1`, in-process worker mode off).
Raising the default is the obvious follow-up lever, but it needs its own
contrastive run — the concurrency=1 default protects the event loop while
parses run in-process.

## Relationship to the retained catalog

The 30-second full-validation TTL is a backstop once a specific complete-index
scope is selected; it is not permission for every broad collection request to
select and validate every project/provider scope. Global Sessions, Inbox,
stats, queue-title, and hover collection projections read the retained compact
catalog and target changed, uncertain, live, or client-promoted rows.

An old cold scope does not receive another complete-summary validation merely
because its last check is older than the TTL. Provider/file evidence, an exact
complete-summary consumer, or bounded catalog repair selects it. This prevents
the supported 10,000-project shape from multiplying a per-scope consistency
backstop into a periodic fleet scan while preserving exact validation for
explicit detail consumers.

## Transport head-of-line blocking

The WS transports (direct WS and relay) serialize inbound message handling
per connection (`ws-relay.ts` messageQueue) — required for SRP handshake
order, replay sequence checks, and upload chunk order. Tunneled HTTP
`request` messages are the exception: each is independent and self-answering
(`handleRequest` matches responses by id and never throws), so the router
dispatches them without awaiting. Otherwise a slow `/api/sessions`
revalidation blocks `/api/settings` and every other tunneled call behind it —
plain-HTTP clients never had that coupling, and hosted/relay clients showed
it as "settings waits for the sidebar to populate". Covered by
`ws-relay-request-concurrency.test.ts`.

# Mixed Claude and Codex server cost during Inbox navigation

Measured on 2026-11-27 at `33d7e92e5` for [plan 190](../tactical/190-active-session-cost-at-scale.md). The most repeatable foreground cost was authorizing one session draft after another session's transcript changed. The first Inbox visit also triggered expensive source-review discovery. A separate Codex rollout-header reread depended on the spelling of the provider root.

## One draft read after an unrelated append

A real browser opened a Claude session from Inbox and returned. While it was back in Inbox, the driver appended to a known Codex rollout in another project, waited for that exact row's source version to change in SQLite, and opened another Claude session. It then revisited that same Claude session with no intervening write. All seven opens showed the expected latest message.

| At 8,380 catalog rows | Three opens after separate appends | Three immediate revisits |
| --- | --- | --- |
| Complete catalog rows returned to draft requests | 8,380 each | 0 each |
| Draft response elapsed time, instrumented browser run | 447, 373, 1,139 ms | 1.8, 1.1, 1.5 ms |
| Same route in isolation, with SQL and filesystem probes removed | 111, 111, 112 ms | 1.1, 1.3, 1.2 ms |

A second timing-only run sent an unrelated authentication-status GET five milliseconds after starting each draft read. It took 79.6, 74.6 and 128.3 ms alongside the three rebuilds, versus 0.9, 0.9 and 0.6 ms alongside the three repeats. This directly measured interference with another client request.

The isolated control addressed the same draft on every request. Each successful request returned its empty draft and recovery state. Browser request elapsed time includes overlapping work and host scheduling. The 1,139 ms sample alone cannot establish a one-second event-loop stall.

The draft route asks the shared access resolver for the session's project. A changed catalog generation invalidates its entire session-to-access-facts map. The next resolution reads every native row, projects public identities and rebuilds the map. Stable generations reuse the result. A scoped lookup should retain cross-project ambiguity handling, creation/live ownership, moves, activity freshness and fail-closed behavior during publication. [Draft authorization](../../packages/server/src/routes/drafts.ts) · [Access resolver](../../packages/server/src/auth/sessionAccess.ts) · [App wiring](../../packages/server/src/app.ts) · [Existing catalog point-read gap, item 15](../../gaps/sqlite-cleanup-and-wins.md)

### Scoped access follow-up

The scoped resolver on top of `33d7e92e5` passed the same browser sequence. The three opens after distinct unrelated appends each selected exactly **one** native candidate and issued zero complete catalog SELECTs. All seven session opens showed their newest message. The two draft requests on each post-append open took 1.7/2.0, 2.0/3.0 and 1.8/2.3 ms. The earlier trace had one draft request per post-append open. Row counts are summed over all draft requests for the open.

## Empty source-review Inbox

The browser requested `GET /api/review/inbox` when entering Inbox. Even after the retained project counts matched the fixture, its first request called `ProjectScanner.listProjects()`, entered retained reconciliation, and read the full native catalog. At 60, 2,010 and 8,380 total sessions, the request took 24, 122 and 1,074 ms respectively. A second large profile using physical paths took 968 ms. The initial retained sessions query separately built its first projection. Neither full scan repeated on every Inbox return.

The repeat cost depends on project count. Holding the native history fixed at 2,010 sessions and changing only its distribution, each of three requests in fresh five-second cache buckets cloned two review stores with two projects, or 251 stores with 251 projects. Every response contained zero items. At 251 projects the three requests took 10.5, 12.3 and 9.9 ms. Each same-bucket repeat cloned zero stores and took under 1 ms. A review-specific source of projects with unread submissions would need to pick up newly visible projects and externally changed review state. [Review Inbox route](../../packages/server/src/routes/review-inbox.ts) · [Store snapshot](../../packages/server/src/review/ReviewCommentService.ts) · [Project scanner](../../packages/server/src/projects/scanner.ts)

### Scoped review Inbox follow-up

After discovery settled in the 8,380-session fixture, the first browser review request took 14.8 ms and returned zero complete catalog rows. The earlier physical-root run took 968 ms and returned 8,380. The new request checked the two possible review file locations in each of two visible projects, without opening a review store. With 2,010 sessions spread across 251 projects, the first request made 502 presence checks and took 22.4 ms. The next three fresh five-second windows took 1.1, 1.3 and 1.0 ms with zero review-file checks, canonical loads or snapshot clones. The earlier run cloned 251 stores in each window. All responses were empty. The route tests separately start with a real unread review on disk, discover it when its project becomes visible, update its displayed name, and remove it after explicit acknowledgment.

## First Codex open after discovery through a symlink

Two otherwise equivalent profiles used the same shape of populated native thread and spawn-edge tables. One opened the configured Codex root through its physical path and one through a symlink. Both had ten sessions of interest, 8,370 unrelated sessions and one additional native child. Before opening a Codex session, both servers had already enumerated 4,191 Codex rollouts with 4,191 discovery-index hits. Both subsequently returned the correct child of the exact parent and rendered the final answer.

| First Codex open | Physical root | Symlink to the same kind of root |
| --- | ---: | ---: |
| Rollout headers reread in the child-relationship scan | 0 | 4,190 |
| Bytes read by file handles inside that scan | 0 | 24,756,460 |
| New enumerations in two subsequent Codex opens | 0 | 0 |

The smaller indexed pair reproduced 0 versus 1,005 header reads. In that physical-path run a fresh enumeration statted the files and hit all 1,006 cached metadata records. The distinction matters because watcher-epoch changes can legitimately require re-enumeration without rereading headers. A separate pair returned the real child with and without Codex's native state database.

The configured scanner keys its discovery index by a resolved lexical path. A bound reader requests the index again using the physical native storage scope. A symlink gives the same files two registry keys and shard hashes. The foreground detail request starts child discovery asynchronously, so the bytes represent competing background work. A repair should share discovery facts for the same verified root while preserving distinct stores, symlink retargeting, watcher recovery and child-header proof. [Discovery-index keys](../../packages/server/src/indexes/SessionDiscoveryIndex.ts) · [Codex reader](../../packages/server/src/sessions/codex-reader.ts) · [Child demand](../../packages/server/src/sessions/provider-child-sessions.ts) · [Relationship contract](../../topics/session-relationships.md)

## Other repeat costs and controls

- **Retained recents.** Three direct requests for ten visits and three for an empty list each loaded 25,140 catalog rows at the largest size. The empty GETs took 77–81 ms compared with under 1 ms at 60 rows. The ten returned visits matched the exact ten session IDs and included both providers. Browser switches recorded visits with POSTs. The retained recents GET was exercised separately. [Recents route](../../packages/server/src/routes/recents.ts)
- **Sandbox history.** Three profiles each contained 512 private historical Codex rollouts and their persisted metadata, plus 2,010 ordinary mixed sessions. Only the number with a recorded project-write selection varied. Nine reads of an unrelated public project returned 0, 2,160 or 4,608 sandbox candidate IDs at 0, 240 or 512 qualifying sessions. At 512 they also issued 4,608 individual metadata SELECTs, including on warm repeats. Each session was Codex and the Claude directory projection discarded it. The working set holds 256 entries. A query for distinct applicable provider/project roots would avoid enumerating or hydrating these sessions. This tested persisted Linux-style sandbox state on macOS. [Sandbox directory projection](../../packages/server/src/app.ts) · [Metadata hydration](../../packages/server/src/metadata/SessionMetadataService.ts) · [Working set](../../packages/server/src/metadata/metadata-working-set.ts)
- **Changed files.** Separate watcher runs waited for SQLite to accept the specific changed row and for the existing project's count to include each new session. At both sizes, ordinary Claude and Codex appends and a new Claude file in a known store caused zero complete catalog row reads. One new Codex file read all 61 or 8,381 previously accepted rows. The active project finished at 12 sessions in both cases. Indexless profiles also exhibited the documented background watcher pass, with 4,190 Codex file stats in a quiet large-profile pass. [Structural discovery gap](../../gaps/session-catalog-rewrites-whole-generation-per-change.md) · [Indexless watcher finding, item 8](../../gaps/active-session-tab-background-cost.md)
- **Ordinary revisits.** The three primary browser runs each opened ten sessions from Inbox twice. The initial circuits completed 159, 161 and 164 API requests, and the repeats completed 118, 118 and 106. All 60 opens verified the session URL and its unique newest answer in the viewport. Across the three repeated circuits there were zero complete catalog reads. Three additional warm retained project-list GETs at each size also read zero full catalogs.

## Reproduction and interpretation

The standalone server fixture launched the source server on loopback with a private app-data directory, home, provider roots and disposable browser. It loaded the production client built from the same checkout. Sessions alternated Claude and Codex within each project. The ten opened histories included one 40-turn transcript per provider and four one-turn transcripts per provider. Older unrelated histories were split equally. All were text with synthetic tool traffic. Catalog row counts came from the rows returned by the complete native SQL SELECT. Server-side file counters measured logical bytes read and successful metadata calls. Async request context distinguished a running request from detached background work. The focused path-spelling experiment additionally counted reads inside the reader's uncached enumeration and recorded its native scan metrics. A separate timing-only server omitted SQL and filesystem wrappers.

This was direct localhost navigation with one browser, synthetic writes, and no live model processes. Host capacity was Darwin arm64, 14 CPUs and 48 GiB RAM, Node 24.22.1. Host samples and raw request observations accompany the run bundle. Elapsed times are local observations. Counts, visible-message checks, returned child identity, accepted file versions and same-generation controls establish the scope of repeated work. [Standalone process](../../packages/client/e2e/support/ya-server-process.ts) · [Transcript generators](../../scripts/perf-repro/scenario-transcripts.mjs) · [Navigation fixture](../../scripts/perf-repro/issue-navigation.mjs) · [Measurement guidance](../../topics/performance-regression-suite.md)

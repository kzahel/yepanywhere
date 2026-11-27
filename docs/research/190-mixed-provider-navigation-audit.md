# Mixed Claude and Codex server cost during Inbox navigation

After the two fixes, the largest reproduced freeze during ordinary browsing came from closing a native transcript-directory watcher on macOS. A separate full-catalog reconciliation occurs when a new Codex session appears. [Watcher comparison](#a-native-directory-watcher-blocks-session-switching-on-macos) · [New-session comparison](#separate-new-codex-sessions-in-an-existing-project) · [Replay commands](#replaying-the-mixed-profile-experiments)

The original baseline was measured on 2026-11-27 at `33d7e92e5` for [plan 190](../tactical/190-active-session-cost-at-scale.md). The most repeatable foreground cost was authorizing one session draft after another session's transcript changed. The first Inbox visit also triggered expensive source-review discovery. A separate Codex rollout-header reread depended on the spelling of the provider root.

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

## Browsing ten sessions after both fixes

Two cold, indexed profiles on server revision `acc4d7cce` each opened the same ten Claude/Codex sessions from Inbox twice. They then opened one Claude session after an accepted append in another project's Codex session and immediately reopened it. All 44 browser opens showed the expected latest answer and completed a successful draft read for the exact session.

| Unrelated sessions | First Inbox full rows | First ten switches, requests / full rows | Second ten switches, requests / full rows | Draft candidates after the write / stable revisit |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 60 | 162 / 60 | 109 / 0 | 1 / 0 |
| 8,370 | 8,380 | 161 / 8,380 | 117 / 0 | 1 / 0 |

The first Inbox's session-list projection and a subsequent cold reconciliation still read the history once each. In the large run the second read occurred while a session-detail request was open. The first review Inbox and the later draft reads returned zero full rows. At 2,010 sessions, the 2-project and 251-project review cases made 4 and 502 review-file checks on first access. All three fresh windows in each case returned empty results with zero additional presence checks or store loads. In the warm large-profile circuit, the longest completed session-detail handler took 20 ms. The server's maximum event-loop delay during that same circuit was 2.55 s (2.28 s at the smaller size). These were text sessions without new rollouts in that circuit. The warm circuits used 592 ms of server CPU over 12.5 s and 667 ms over 11.8 s respectively. Individual opens took up to 2.6 and 3.1 s. The timer delay alone could reflect blocking or scheduling. The focused experiment below directly measured native watcher teardown.

## A native directory watcher blocks session switching on macOS

This is the first fix to tackle for **opening and leaving existing sessions**. On this Mac, leaving a session can synchronously close the last native watcher for its transcript directory. Node waits inside that call. The server cannot handle the next request in the meantime, even though the process may be using little CPU. A production stall recording from a fresh 60-session fixture reported a 6,235 ms loop delay. Of a 10.46 s profile window, 7.05 s of sample time had the stack `FSWatcher.close → SharedDirectoryWatcher.release → FocusedSessionWatchManager.releaseDirectoryWatch` (leaf first). Sampled wall time includes waiting in native code.

The controlled replay timed the actual synchronous `FSWatcher.close()` calls for the private Claude and Codex transcript trees. On the control pass, two additional leases on those same directories kept their native handles alive while the real browser still subscribed and unsubscribed. The driver closed the browser and released both leases separately at the end. This exercises the current sharing implementation with a second owner. It changes only the test workload.

| Warm ten-session circuit on macOS | Native closes | Total time inside close | Largest single close | Maximum loop delay | Circuit elapsed |
| --- | ---: | ---: | ---: | ---: | ---: |
| 50 unrelated, ordinary | 16 | 7.09 s | 2.01 s | 2.02 s | 9.61 s |
| 50 unrelated, extra leases | 0 | 0 | 0 | 19 ms | 4.30 s |
| 8,370 unrelated, ordinary | 16 | 6.88 s | 2.84 s | 2.85 s | 9.78 s |
| 8,370 unrelated, extra leases | 0 | 0 | 0 | 13 ms | 4.70 s |

All four runs passed all 22 URL, latest-answer and draft checks. Warm circuits read zero full catalog rows. At the larger size the final release of the two control leases still took 976 ms inside native closes, including one 756 ms call. Merely delaying the last close can move the freeze to another time. These close timings are macOS observations on one host. The measurements identify the blocked call in the isolated server. Attribution on a live installation requires its own stall sample.

**Recommended next change.** Fix the lifecycle of the native transcript-directory watcher first. Release session interest immediately and prevent the server's request thread from waiting on slow native closes. A bounded watcher worker on macOS is one option to measure. Short-lived directory reuse can reduce churn, but the eventual last close must also meet the latency target. Verify final unsubscribe, watcher budgets, replacement/rename recovery, no delivery to departed sessions, exact updates to active sessions and clean shutdown. The current contract explicitly closes the last native watch, so keep those ownership guarantees if moving it to another thread. Test the normal unpinned replay on macOS and verify other supported platforms. [Focused session watcher](../../packages/server/src/watcher/FocusedSessionWatchManager.ts) · [Native watch ownership](../../packages/server/src/watcher/SharedDirectoryWatcher.ts) · [Observation contract](../../topics/session-catalog-observation.md) · [Prior macOS worktree watcher incident](../tactical/113-live-worktree-resource-safety.md)

## Separate new Codex sessions in an existing project

After the draft and review Inbox fixes (`6e887eb00`, `acc4d7cce`), a separate repeatable population-sized cost was accepting a **new Codex session** in a project YA already knew. The browser was closed for this experiment. Each singly created session had one completed turn. A second client sent only authentication-status requests during each change.

| Watcher input, in order | Complete rows read, 50 unrelated | Complete rows read, 8,370 unrelated | Hash rows read, 8,370 unrelated |
| --- | ---: | ---: | ---: |
| Settled Claude append | 0 | 0 | 0 |
| Settled Codex append | 0 | 0 | 0 |
| New Claude session | 0 | 0 | 0 |
| First new Codex session | 61 | 8,381 | 8,381 |
| Second, separately accepted new Codex session | 62 | 8,382 | 8,382 |
| Three more Codex sessions written together | 63 | 8,383 | 8,383 |

The counts matched in four separate profiles, with and without a usable native thread index at both sizes. The two large-profile SELECTs read different columns of the same existing catalog entries. Each burst shared a single reconciliation in these runs. The project finished with exactly 16 sessions in every cell, and the six new sessions returned their own final answers. There is also a cold-start freshness issue. The first Claude append after closing Inbox overlapped a full background reconciliation. The observed time until SQLite showed the changed file was 7.9/1.9 s in the small indexed/indexless pair and 39.0/7.9 s in the large pair. The 39.0 s window used 1.29 s of process CPU and read 8,380 full rows. The cause of the remaining wait is open. Treat it separately from the settled new-session cost.

In the large indexed run, the first new Codex file caused **4,193 Claude file stats and 4,211 Codex file stats** in the watcher window. The server read about 164 KiB of provider file contents and made two native catalog upserts. Most of the work was checking other sessions. The status client's maximum round trip was 5 ms in the quiet control, 2–9 ms during settled appends, and 42 and 53 ms during the two separate Codex arrivals. Event-loop maxima in those arrival windows were 82 and 79 ms. The three-file burst had a 66 ms maximum status round trip. These are individual synthetic observations on the instrumented host.

**Cause.** The changed-file path first looks for an existing catalog row. A new Claude file can inherit a verified project from siblings in its store. A Codex date directory can contain many projects. For a new Codex file the targeted classifier gives up, loads all previous catalog rows and walks the provider stores. The publication step compares hashes across the whole catalog again. This preserves membership today, but repeats the discovery work for each separately arriving Codex session. [Changed-path classifier and fallback](../../packages/server/src/sessions/catalog-adapters/collection-catalog-adapters.ts) · [Reconciliation](../../packages/server/src/services/RetainedSessionCollections.ts) · [Hash inventory and upserts](../../packages/server/src/services/session-catalog-sqlite.ts)

**Second priority, for new-session creation.** When YA sees a new Codex rollout, verify its native session ID, storage root, current file version and project directory against the rollout's own metadata. If those facts identify one known project, publish just that row and its project count. Keep full discovery for incomplete headers, ambiguous identities, conflicting native metadata, moves, and files replaced during the read. Compare the resulting stores, visible identities, counts and answers with a clean full rebuild. The first target is zero complete catalog and hash-inventory reads for each proven arrival at both population sizes. The warm browsing replay should still show the latest answer on every open. [Open structural-discovery gap](../../gaps/session-catalog-rewrites-whole-generation-per-change.md)

## Replaying the mixed-profile experiments

These commands replay the post-fix navigation, empty-review and new-arrival comparisons against one build. The earlier timing-only, symlink, sandbox and retained-recents experiments have separate protocols. From the repository root with Node 24 and pnpm, build the browser client once. The runner uses Playwright's Chromium, a fresh loopback server and a disposable physical profile for **each invocation**. No provider processes are needed.

```bash
pnpm install --frozen-lockfile
pnpm --filter @yep-anywhere/shared build
pnpm --dir packages/client exec playwright install chromium
export YEP_E2E_RUN_DIR="$(mktemp -d)"
VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS=true VITE_DISABLE_ONBOARDING=true \
  pnpm --dir packages/client exec vite build --outDir "$YEP_E2E_RUN_DIR/client-dist" --emptyOutDir

mixed() { node --import tsx --conditions=source scripts/perf-repro/mixed-navigation.mjs "$@"; }
for n in 50 8370; do
  mixed --case navigation --population "$n"
  mixed --case navigation --population "$n" --pin-watches
  mixed --case arrival --population "$n"
  mixed --case arrival --population "$n" --indexless
done
for p in 1 250; do mixed --case review --population 2000 --projects "$p"; done
```

The runner prints the path to its JSON result. Use `--out NEW.json` to choose an unused output file. Allow cells to finish sequentially for timing comparisons. The fixture removes the private profile at the end. The close timings survive in the JSON. To retain an optional raw stall profile, copy it from the disposable data directory’s `logs/stalls/` while the run is active. The server logs the data directory at startup.

- **Navigation** waits for exact project counts, opens ten distinct mixed sessions from Inbox twice, then opens the same Claude session after an accepted write to an unrelated Codex session and once more without a write. Every open checks the URL, the session-specific newest answer in the viewport, and a successful draft response for that ID with a recovery field. Add `--pin-watches` to hold one extra lease per active transcript directory and compare native close time and server loop delay.
- **Arrival** closes the browser after the first Inbox visit. After an initial watcher update and a quiet control, it appends to each provider, creates a Claude session, creates two Codex sessions separately, then writes three more in a burst. Each change waits for its exact catalog row or source version in SQLite. Validation reads check the project count and each new session's ID and answer, outside the mutation sample. A separate localhost client polls authentication status during each sample to measure interference. The native-index fixture updates the new rollout's thread path, cwd and timestamp as it writes the file. The rollout store is separate from Codex's private CLI home so CLI startup cannot backfill the indexless control. The runner checks the database's presence and successful watcher queries against its exact path.
- **Review** measures first Inbox access and three fresh five-second cache windows, each followed by a same-window repeat. Both project-count cells contain 2,010 sessions.

The preload measures selected SQL statement times and returned rows, successful provider-root async stat, readdir, open and readFile calls, and logical bytes from wrapped file reads and createReadStream. The remaining catalog SELECTs have separate aggregate counters. `fullRows` counts the full native row SELECT, `hashInventoryRows` the separate catalog hash inventory, and `catalogUpserts` actual native row upserts. Each snapshot waits for finite API requests to finish or close. Request starts, closes, completed response statuses and longest completed request are recorded separately. The ten-second draft-change long poll may cross a boundary. SQL/filesystem work is charged at completion to the active API request or to background. Stack samples identify the caller. Process CPU covers everything in the sample, including the probe. Client round trips include time waiting for the server to handle the request. The result also records the server event-loop histogram (10 ms resolution), Git revision and dirty state, client bundle hash, host samples and per-open browser elapsed times. [Replay runner](../../scripts/perf-repro/mixed-navigation.mjs) · [Isolated fixture](../../scripts/perf-repro/mixed-navigation-fixture.mjs) · [Probe](../../scripts/perf-repro/mixed-navigation-probe.mjs)

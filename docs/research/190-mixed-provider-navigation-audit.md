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

The original replay isolated a stall when **opening and leaving existing sessions**. On this Mac, leaving a session can synchronously close the last native watcher for its transcript directory. Node waits inside that call. The server cannot handle the next request in the meantime, even though the process may be using little CPU. A production stall recording from a fresh 60-session fixture reported a 6,235 ms loop delay. Of a 10.46 s profile window, 7.05 s of sample time had the stack `FSWatcher.close → SharedDirectoryWatcher.release → FocusedSessionWatchManager.releaseDirectoryWatch` (leaf first). Sampled wall time includes waiting in native code.

The controlled replay timed the actual synchronous `FSWatcher.close()` calls for the private Claude and Codex transcript trees. On the control pass, two additional leases on those same directories kept their native handles alive while the real browser still subscribed and unsubscribed. The driver closed the browser and released both leases separately at the end. This exercises the current sharing implementation with a second owner. It changes only the test workload.

| Warm ten-session circuit on macOS | Native closes | Total time inside close | Largest single close | Maximum loop delay | Circuit elapsed |
| --- | ---: | ---: | ---: | ---: | ---: |
| 50 unrelated, ordinary | 16 | 7.09 s | 2.01 s | 2.02 s | 9.61 s |
| 50 unrelated, extra leases | 0 | 0 | 0 | 19 ms | 4.30 s |
| 8,370 unrelated, ordinary | 16 | 6.88 s | 2.84 s | 2.85 s | 9.78 s |
| 8,370 unrelated, extra leases | 0 | 0 | 0 | 13 ms | 4.70 s |

All four runs passed all 22 URL, latest-answer and draft checks. Warm circuits read zero full catalog rows. At the larger size the final release of the two control leases still took 976 ms inside native closes, including one 756 ms call. Merely delaying the last close can move the freeze to another time. These close timings are macOS observations on one host. The measurements identify the blocked call in the isolated server. Attribution on a live installation requires its own stall sample.

### Focused watch teardown fix

macOS focused views now share one worker that opens, observes and closes their directory handles. Unsubscribe discards the listener immediately. An open queued behind a slow close skips a view that has already left. The first notification after attachment asks live views to check their exact files. The existing per-view poll also covers delays and native failures. The shared 1,024-slot budget includes native closes in progress. The empty, unreferenced thread can serve the next click until the process idle sweep retires it. Callers that need synchronous coverage before directory enumeration still acquire synchronous leases. Releasing such a caller's own handle can still take time on the main thread. [Shared lease ownership](../../packages/server/src/watcher/SharedDirectoryWatcher.ts) · [Worker host](../../packages/server/src/watcher/FocusedDirectoryWorker.ts) · [Focused observation](../../topics/session-catalog-observation.md)

| Ordinary warm ten switches | Circuit before → after | Server loop maximum before → after | Main-thread transcript closes after | Actual worker closes in window | Longest worker close | Longest posted open to ready |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 unrelated | 9.61 → 4.30 s | 2,020 → 13 ms | 0 | 2 | 2,726 ms | 514 ms |
| 8,370 unrelated | 9.78 → 4.74 s | 2,850 → 13 ms | 0 | 17 | 388 ms | 150 ms |

Both unpinned macOS Node 24.22.1 runs had zero complete catalog reads during warm navigation (120/118 API requests). Each run verified 24 session opens including the typing controls. Across the full runs the worker retired all 48 requested registrations in each profile and closed all 14/33 handles actually attached. Each profile used one worker and observed its exit. Counts cross phase boundaries when a close overlaps the next click. Fast navigation can cancel an open before it reaches the filesystem. An individual view may still wait behind another native operation. Compiled Node 24.22.1 and Bun 1.3.14 on macOS delivered actual file changes with referenced watches and exited naturally after unref or close. Linux and Windows keep their original native backend.

A separate large-profile run opened both providers in two browser tabs and waited until both native directory registrations were ready. While typing in one tab, it closed the other tab and appended a unique answer to the remaining transcript. All 26 prefixes retained focus in the original editor for each provider. Maximum keydown-to-second-frame time was 20.4 ms for Claude and 30.7 ms for Codex. The appended answers reached the viewport in 378 and 142 ms respectively. A final repeat using the shared watch entry point and lifetime-bound idle sweep verified the same 52 keys (maximum 24 ms). Answers reached the viewport in 1,371/856 ms. Its ten warm switches took 4.82 s with a 13 ms loop maximum while the worker spent 4.14 s in seven closes (largest 1.81 s). An active transcript may still wait for a worker event or its existing poll while another watch closes. The update times include browser delivery and rendering. The two supplemental focused leases in a small control produced zero worker closes during the warm circuit; releasing them at the end produced two confirmed native closes.

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

**Next candidate, for new-session creation.** When YA sees a new Codex rollout, verify its native session ID, storage root, current file version and project directory against the rollout's own metadata. If those facts identify one known project, publish just that row and its project count. Keep full discovery for incomplete headers, ambiguous identities, conflicting native metadata, moves, and files replaced during the read. Compare the resulting stores, visible identities, counts and answers with a clean full rebuild. The first target is zero complete catalog and hash-inventory reads for each proven arrival at both population sizes. The warm browsing replay should still show the latest answer on every open. [Open structural-discovery gap](../../gaps/session-catalog-rewrites-whole-generation-per-change.md)

### Same date directory, different project

After watcher fix `0f1c5393c`, the arrival replay added a Codex rollout for a second, already-known project in the same date directory as a just-accepted rollout from the active project. The second project previously had history on an earlier date. Each cell verified that only the second project's count went up, that the active project stayed at 16, and that the new public session returned its own latest answer. A subsequent write to that same file also returned its updated answer. A separate driver check called YA's uncached rollout metadata reader on the two neighboring files. Both native IDs and working directories matched their separate accepted rows. This checks what can be established from the files in this fixture. [Rollout metadata reader](../../packages/server/src/sessions/codex-discovery.ts)

| Arrival in the second project | Existing catalog rows read | Catalog hashes read | Successful async file stats (Claude / Codex) | Upserts |
| --- | ---: | ---: | ---: | ---: |
| 50 unrelated, native index present | 66 | 66 | 33 / 51 | 2 |
| 8,370 unrelated, native index present | 8,386 | 8,386 | 4,193 / 4,215 | 2 |
| 8,370 unrelated, native index absent | 8,386 | 8,386 | 4,193 / 4,211 | 2 |
| First append after verifying the arrival, both large cells | 0 | 0 | 0 / 17 | 2 |

The browser was closed during mutations. The large indexed arrival used 368 ms of process CPU in its observed window. A second client's longest status request took 47 ms, versus 2 ms while quiet. The same large cell's earlier known-project Codex arrival also read 8,381 rows and 8,381 hashes. Known-file Claude and Codex appends and a new Claude transcript read zero of each. Independent background work can cross sample boundaries, especially the indexless watcher inventory. The timing samples come from one host.

The complete SQL read came from the structural fallback in the changed-path classifier. Samples of async stats from **both** providers show the full catalog builder calling `readFileRow` to check prior files. These sampled stacks identify callers only. Full-path checks for a *known* Codex file and the Codex indexing consumer already read its metadata directly. A narrow implementation should reuse that reader, prove the canonical store, version, ID and project for an ordinary new file, and publish one partial change. Include the second project's count and unchanged first project in the acceptance check. Keep full discovery when files move, identities conflict, or membership is uncertain. Compare the result to a clean rebuild. [New-file fallback](../../packages/server/src/sessions/catalog-adapters/collection-catalog-adapters.ts) · [Project file proof](../../packages/server/src/projects/project-discovery-facts.ts) · [Existing Codex file-event consumer](../../packages/server/src/indexes/SessionIndexService.ts)

One separate large indexed attempt missed the 120-second deadline waiting for the **first Claude append** to be accepted and never entered the settled arrival experiment. A fresh indexed run accepted this first write within its 0.86-second sampling window. The timeout did not establish whether the native watcher missed the write or publication lagged. The replay now captures exact-file bus event counts, catalog publications and whether the stored version still matches the old version or the file on disk when this first-write check fails. A subsequent successful large indexed run saw one matching file-change event and two catalog-update notifications in the 1.86-second first-write window. A single refresh can emit both notifications. The counter includes all catalog notifications in the window, and file-event matching requires the same path spelling.

### Bounded acceptance of a new Codex rollout

YA now checks a new plain rollout's header and filename against the configured root, the scanner’s visible project and an existing Codex catalog member of that project. A point lookup checks for a live or tombstoned thread key. The reader shares the verified file location even when the native thread row has yet to commit. Ordinary growth during summary acquisition rechecks the header. A replacement, changed project, competing rollout or uncertain owner goes through discovery. An append crossing a summary read can publish an identity-only row until the next observed write settles it. [Arrival classifier](../../packages/server/src/sessions/catalog-adapters/codex-catalog-arrival.ts) · [On-disk rebuild and race checks](../../packages/server/test/sessions/codex-catalog-arrival.test.ts)

Each isolated profile accepted the two separately created threads, the three-thread burst and the arrival in a second project with **zero complete catalog rows and zero inventory hashes read** in each of those four mutation windows. The active project ended at 16 and the archive project at 51 or 8,371. Detail checks verified every public ID and latest answer, including the subsequent append in the archive project.

| Second-project arrival | Full rows before → after | Hash rows before → after | Successful async stats after (Claude / Codex) |
| --- | ---: | ---: | ---: |
| 50 unrelated, indexed | 66 → 0 | 66 → 0 | 0 / 19 |
| 50 unrelated, index absent | — → 0 | — → 0 | 2 / 22 |
| 8,370 unrelated, indexed | 8,386 → 0 | 8,386 → 0 | 2 / 22 |
| 8,370 unrelated, index absent | 8,386 → 0 | 8,386 → 0 | 2 / 4,221 |

In the large indexed cell the same window previously made 4,193 Claude and 4,215 Codex stats. Process CPU fell from 368 to 72 ms in this single comparison. In the large indexless cell the remaining thousands of stats sampled in the window came from the independent file watcher's full-tree rescan. The ordinary Codex append control also recorded 4,206 stats. Removing catalog work does not eliminate that observer cost. The integration regression drops the shared reader cache and checks zero reader tree walks for an absent database, a missing native row and a committed row, including two real writes during acquisition.

A separate large-profile Chromium circuit verified all 24 opens and revisits. The ten warm switches made 120 API requests, read zero full catalog rows and took 4.71 seconds with a 12 ms maximum server loop delay. Both 26-character typing checks retained every prefix and focus during a provider write and neighboring tab close. Maximum two-frame acknowledgements were 25.7 ms for Claude and 21.5 ms for Codex. These are macOS observations on generated histories.

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
  mixed --case navigation --population "$n" --typing
  mixed --case navigation --population "$n" --pin-watches
  mixed --case arrival --population "$n"
  mixed --case arrival --population "$n" --indexless
done
for p in 1 250; do mixed --case review --population 2000 --projects "$p"; done
```

The runner prints the path to its JSON result. Use `--out NEW.json` to choose an unused output file. Allow cells to finish sequentially for timing comparisons. The fixture removes the private profile at the end. The close timings survive in the JSON. To retain an optional raw stall profile, copy it from the disposable data directory’s `logs/stalls/` while the run is active. The server logs the data directory at startup.

- **Navigation** waits for exact project counts, opens ten distinct mixed sessions from Inbox twice, then opens the same Claude session after an accepted write to an unrelated Codex session and once more without a write. Every open checks the URL, the session-specific newest answer in the viewport, and a successful draft response for that ID with a recovery field. Add `--pin-watches` to hold one extra lease per active transcript directory and compare native close time and server loop delay. On macOS both leases use the focused worker. The replay records posted-open to ready, posted-release to acknowledgment and time inside actual worker-native closes. At the end it waits for worker exit and balances opened/closed handles. Add `--typing` to open a second provider tab, close it while typing 26 real keys in each provider’s composer during a transcript append and check every retained prefix, editor focus and the newest visible answer.
- **Runtime lifecycle** checks the compiled worker independently. After `pnpm --filter @yep-anywhere/server build`, run `node scripts/perf-repro/focused-watch-runtime.mjs` on macOS and repeat with `bun` as its argument. An external writer changes the file while the child owns a referenced watch. A separate unreferenced child must exit naturally.
- **Arrival** closes the browser after the first Inbox visit. After an initial watcher update and a quiet control, it appends to each provider, creates a Claude session, creates two Codex sessions separately, then writes three more in a burst. It creates a rollout for a second known project in that same date directory and verifies the first append after opening its detail. Each change waits for its exact catalog row or source version in SQLite. Validation reads check the project count and each new session's ID and answer, outside the mutation sample. A separate localhost client polls authentication status during each sample to measure interference. The native-index fixture updates the new rollout's thread path, cwd and timestamp as it writes the file. The rollout store is separate from Codex's private CLI home so CLI startup cannot backfill the indexless control. The runner checks the database's presence and successful watcher queries against its exact path.
- **Review** measures first Inbox access and three fresh five-second cache windows, each followed by a same-window repeat. Both project-count cells contain 2,010 sessions.

The preload measures selected SQL statement times and returned rows, successful provider-root async stat, readdir, open and readFile calls, and logical bytes from wrapped file reads and createReadStream. The remaining catalog SELECTs have separate aggregate counters. `fullRows` counts the full native row SELECT, `hashInventoryRows` the separate catalog hash inventory, and `catalogUpserts` actual native row upserts. Each snapshot waits for finite API requests to finish or close. Request starts, closes, completed response statuses and longest completed request are recorded separately. The ten-second draft-change long poll may cross a boundary. SQL/filesystem work is charged at completion to the active API request or to background. Full-read stacks identify the SQL caller. For provider async stats, the probe samples the first call start and every 512th thereafter, capped at 16 examples per provider per window. The samples identify possible call paths and do not estimate their proportions. Process CPU covers everything in the sample, including the probe. Client round trips include time waiting for the server to handle the request. The result also records the server event-loop histogram (10 ms resolution), Git revision and dirty state, client bundle hash, host samples and per-open browser elapsed times. [Replay runner](../../scripts/perf-repro/mixed-navigation.mjs) · [Isolated fixture](../../scripts/perf-repro/mixed-navigation-fixture.mjs) · [Probe](../../scripts/perf-repro/mixed-navigation-probe.mjs)

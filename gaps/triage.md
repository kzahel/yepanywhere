# Gap triage

Reviewed 2026-09-14. Contributing-model: gpt-6-astra.

This is a disposition of all 93 gap entries present at the start of this pass,
not an implementation queue or a claim that every historical report still
reproduces. The [roadmap](../docs/roadmap/README.md) remains the product-priority
owner: supported releases and continuous delivery come first. No runtime fixes
or dependency upgrades were made during this triage. Disposition: 63 active
entries, 27 sketches, and three closed entries (one pair of active entries is
a duplicate report of the same scratch-space fixture defect).

The maintainer subsequently authorized fixing the strongest candidates, with
vocabulary learning held for discussion. The selected follow-up covers
zero-match search display, Settings search confirmation, scanner shutdown,
Grok live duplicates, and preview Refresh. Scanner shutdown is fixed and
verified through app disposal with a deliberately blocked filesystem write.
Settings search now supports background navigation and explicit form submission,
verified with immediate controls and persisted Enter submission in the browser.
Grok and zero-match search need current affected events: their initial causal
theories do not explain the inspected implementation. Preview Refresh passed
durable catalog/live-update checks, including the reported grouping sequence;
the intermittent incident remains open because no cause or repair is established.

Readiness means a bounded owner and an observable pass/fail outcome, not just
a short proposed patch. Impact is the expected benefit to affected users:
**high** prevents loss, wrong content, crashes, or blocked work; **medium**
improves a recurring interaction; **low** addresses an uncommon edge or polish.
**Dev** means developer/CI impact rather than a visible product improvement.
Scope is **S** (one mechanism), **M** (several related boundaries), or **L**
(migration, multiple providers, or broad lifecycle work); these are judgments,
not time estimates. Evidence describes the entry's recorded evidence unless
the row explicitly says **checked now**. Reproduce on current code before fixing.

Keep concrete incidents and unfinished correctness obligations in `gaps/`, even
when diagnosis is hard. Move proposals, accepted tradeoffs without demonstrated
harm, and work needing a selected design into `gaps/sketches/`. A detailed wish
list can still be a sketch; a hard-to-reproduce crash is still a defect.
Moving an entry preserves its user direction, constraints, and approval gates.

## Best candidates for a bounded implementation pass

Listed in suggested order within this group. The outcome column is a proposed
closure test, not a report of a test run. Compatibility and security decisions
remain prerequisites wherever the underlying entry requires them.

| Entry | Impact | Scope | Evidence / readiness | Testable success condition and main caveat |
| --- | --- | --- | --- | --- |
| Settings search confirmation — closed | Medium | S–M | Fixed; 57 focused tests and three browser cases pass | Webhook URL saves with Enter directly in results; immediate theme controls remain operable; background navigation preserves selection and control clicks. Native label activation targets the checkbox. |
| Scanner writes after disposal — closed | Medium / Dev | S–M | Fixed; real app disposal regression and 17 related tests pass | Disposal awaits the active snapshot write, drops queued snapshots and rejects subsequent scans. Evidence: `packages/server/test/projects/scanner-shutdown.test.ts`. |
| [Vocabulary live arrival](vocabulary-learning-has-no-live-tail.md) | Medium | M | Missing feed located; replay-only observe caller checked now | With look-back zero and no browser watching, finalized arrivals update both selections; later replay does not double count; deltas and disabled collection do not count. |
| [Vocabulary catalog scan scheduling](speech-vocabulary-scan-per-catalog-publication.md) | Medium, scale-dependent | M | Repeated whole-catalog work located | An unchanged publication does bounded work; one changed session does not scan all sessions; learning still converges. Measure work counts and user-visible cost before claiming a speedup. |
| [Slow-request presentation](client-requests-have-no-deadline.md) | Medium | M | Request deadline already exists; remaining presentation is concrete | Delayed responses show an explanatory waiting state and usable retry; stale responses cannot replace newer results; deadline errors are distinguished. Choose one shared presentation owner. |
| [Instruction discovery in private harness homes](sandbox-harness-instruction-read-access.md) | High for sandbox users | M | Omitted bootstrap entries located | Real sandboxed Claude/Codex discovers global and project instructions, including symlinks, while outside writes remain denied. Native harness behavior is part of acceptance. |
| [Speech storage placement signal](vocabulary-scratch-placement-is-never-surfaced.md) | High on network homes | M | Placement changed; remaining warning contract is explicit | A vocabulary storage problem reaches the existing placement banner with the correct reason, without duplicate banners; verify actual database behavior before adding a refusal. Separate from migration UI. |
| [Claude alias-project history](claude-symlink-project-transcript-routing.md) | High on macOS/aliases | M | Real Claude reproduction with durable transcript | A session created through a symlink retains the same YA id and complete history after stop/restart; no duplicate project/session rows. Preserve existing identities. |

## Concrete gaps that need diagnosis, a boundary decision, or a larger slice

These remain active gaps. High impact does not make the proposed implementation
straightforward. The next step deliberately distinguishes investigation from closure.

| Entry | Impact | Scope | Evidence / blocker | Next step and eventual success condition |
| --- | --- | --- | --- | --- |
| [Zero-match search rows](conversation-view-zero-match-grep.md) | Medium | Uncertain | Checked now: Codex no-match normalization already succeeds; ordinary completed tools already fold into activity | Capture the affected tool result and media classification. No-match search must fold without a spurious image; genuine failures and intentional commentary must remain visible. |
| [Grok live duplicate output](grok-live-assistant-double-echo.md) | High | M, uncertain | Checked now: live/replay first-event identity exists; sampled project transcripts do not support an empty-chunk mismatch | Capture both duplicate identities and compare their buffering boundaries through live output, backfill and reload. Do not substitute approximate content deduplication for the missing cause. |
| [Preview Refresh disconnect](experimental-preview-refresh-disconnect.md) | High | M, uncertain | Checked now: two real browser runs pass repeated fresh-catalog and later live-update checks, including the reported grouping sequence | Preserve the regression and capture connection close/error evidence on recurrence. Passing current checks does not identify a repair for the intermittent incident. |
| [Unconfirmed send loss](unconfirmed-send-loss-across-reload.md) | High | L | Multiple incidents; missing durable receipt boundary | Design capability-gated submission receipts. Reload/restart must distinguish accepted, delivered, rejected and unconfirmed; resend must not duplicate delivery. |
| [Blank page after reconnect](background-relay-reconnect-blank-page.md) | High | M, uncertain | Real whole-shell blank; logging amplifier fixed, root cause unproved | Capture hidden-tab reconnect before manual recovery; shell and ongoing session updates must both recover after server replacement. |
| [Message-storm usability](session-stays-usable-under-message-storm.md) | High | M–L | Actual storm; original compaction loop fixed | Bound the workload and select an interaction budget; a user can open controls and terminate during sustained traffic, with bounded retained/rendered work. |
| [Slow sidebar after restart](sidebar-slow-after-server-restart.md) | High | M | Retained-catalog separation landed; affected-tab verification pending | Measure first usable sidebar after replacement with a large catalog and slow discovery; verify the landed separation on the reported path before new changes. |
| [Codex wake switch delay](codex-wake-session-switch-delay.md) | High | M, uncertain | Slow requests observed; no captured causal stall | Separate wake, catalog, detail and browser clocks; unrelated session navigation must remain usable while another session wakes. Fix the measured owner. |
| [Async reply reminder](async-question-reply-reminder-state.md) | Medium | S–M | Live report; existing browser tests pass | Capture exact question/storage/source identity across reply; acknowledged inline answer removes its reminder live and after reload without clearing other questions. |
| [Long-session motion recurrence](long-session-old-content-motion-recurrence.md) | Medium | M | Several proved causes fixed; trim-paint candidate unproved | Real-browser compaction-prefix trim and reattach show no intermediate painted jump or old-row reinsertion; distinguish data from geometry. |
| [Reload banner/control overlap](reload-banner-overlaps-delivery-during-width-transition.md) | Medium | S–M | Observed, exact width trigger not reliable | Sweep the sidebar-hide transition with frame geometry; banner never intersects visible send controls during transition or at rest. |
| [Session worktree file links](session-worktree-file-links.md) | High | M–L | Exact 403/wrong-source reproduction | Verified session worktree opens exact bytes in raw and in-app viewers; no arbitrary sibling grant or same-relative-path substitution. Coordinate with source identity work. |
| [Remote views use local files](remote-session-project-views-use-local-files.md) | High | L | Wrong source coordinate located | Divergent local/SSH trees prove every session-entered file/Git/media action reads the remote source or fails explicitly. Requires transport, authorization and capability design. |
| [Global file-event fanout](global-activity-stream-file-fanout.md) | Medium–High at scale | L | Unfiltered fanout located | Define compatible subscriber interests, then measure serialization/bytes while preserving required updates for old and new clients. |
| [Cold-store startup](sqlite-backed-cold-storage-startup.md) | High at scale | L | Reported startup cost; candidate store, not measured attribution | Measure startup owners, select one cold store, and prove bounded reads plus restart/interrupted-migration durability before extending migration scope. |
| [Lower WebSocket admission](lower-websocket-message-admission.md) | High resource bound | L | Existing 100 MiB compatibility allowance | Finish the linked rollout decision; all direct/relay parsers enforce the lower limit while supported peers still transfer large content correctly. |
| [Native no-new-privileges](native-server-no-new-privs.md) | High security boundary | L | Missing native policy; deliberate privilege behavior undecided | Resolve the existing enforcement plan; prove effective policy before provider launch and supported platform behavior. Not a silent default change. |
| [Environment marker migration](agent-facing-env-markers.md) | Medium | M–L | Six outputs and consumers enumerated | Reader-first compatibility migration; spawn/resume/remote/Bash bridge preserve complete canonical pairs, legacy fallback and stale-value clearing without token disclosure. |
| [Late ACLI declaration](acli-commentary-late-declaration.md) | Medium | M | Live/replay discrepancy described | Deliver invocation capability before first preview across split streams; live and replay agree without reclassifying already painted content. Requires producer contract. |
| [Native skill metadata activation](workflow-skill-metadata-activation.md) | Medium | M–L | Provider path evidence; wire/provenance work required | Inert native skills activate metadata on Claude/Grok/Codex, including symlinks and replay; listings and disabled presentation do not activate it. |
| [Claude task resource links](claude-task-resource-links.md) | Medium | M | Live field currently skipped | Safe links correlate to the originating tool and survive live/persisted reconciliation without duplicate transcript truth. Decide URI contract first. |
| [Forwarded image duplication](code-mode-forwarded-image-duplication.md) | Medium | M | Observed nested/outer duplicate | Forwarded nested result presents once while independent intentional repeats remain visible; prove provenance before cross-call deduplication. |
| [Nested launcher backlink](nested-harness-session-not-linked-to-launcher.md) | Medium | M | Outbound edge exists; reverse index absent | Index known resumed-child launch edges and navigate child to launcher, with capability fallback. Fresh unknown-id discovery is a separate slice. |
| [HTML viewer inspection](html-document-viewer.md) | Medium | L | Interactive serving landed; concrete gesture/lifecycle remainder | Select viewport/zoom and pan/pinch slice; preserve controls, state and source identity across inline/expanded/parked forms; complete direct/relay/browser checks. |
| [Legacy frozen-share Markdown](legacy-frozen-session-shares-keep-plain-markdown.md) | Low–Medium | M | Historical immutable payload limitation | Choose safe local rendering or explicit replacement revision; old shares gain usable links without mutating snapshots or broadening file authority. |
| [Reviewed SVG bypass](svg-sanitization-for-unreviewed-renderers.md) | Medium preventive | M | Current reviewed renderers work; trust seam is copyable | First name and constrain the reviewed bypass with tests; only add an SVG allowlist when a real consumer requires it. Security review precedes policy widening. |
| [Artifact revocation management](artifact-grant-revocation-ui.md) | Medium | M | Explicitly deferred but concrete missing control | Select inventory/capability contract; owner can list and revoke one artifact grant without confusing it with a public share. Respect prior deferral. |
| [Native tool-display coverage](tool-display-native-provider-coverage.md) | Medium / Dev | L | Independent fixture coverage partially landed | Add independent specimens per missing conversion and exercise real reader/adapter seams; constructed display fixtures alone do not prove native shape. |
| [Provider side-effect controls](provider-session-side-effect-controls.md) | Medium cost/control | L | Several controls verified; others only believed absent | Audit one provider at a time, test located controls and replace unknown claims with bounded evidence; preserve initialization-only limitations. |
| [xAI timeout range](xai-smart-turn-timeout-range.md) | Medium | S–M | September 8 vendor range report; rejection untested | Reverify vendor contract, choose stored-value migration, and cover 5000/10000 ms through direct and server paths with older-client behavior explicit. |
| [Split-style URL links](ansi-styled-url-spans.md) | Low | S–M | Located renderer limitation; explicitly deferred | A URL crossing ANSI style runs forms one safe link and retains styles; control cases preserve plain text. Small but uncommon. |
| [Alias at pagination seam](project-path-basename-alias-pagination-seam.md) | Low | M | Known bounded-window tradeoff | If prioritized, carry bounded prefix facts; older-page loading restores intended alias without future text retargeting earlier rows or scanning hidden history. |
| [Native browser Find](transcript-render-window-native-find.md) | Low–Medium | M–L | Accepted windowing limitation | Select a browser-compatible contract; off-window matches become accessible without unbounded DOM. Existing YA search remains required. |
| [Quick Answer cache misses](quick-answer-fork-cache-efficiency.md) | High cost when enabled | External / M | Measured misses; maintainer disabled use pending evidence | Wait for usable upstream behavior, then measure first-child cache use with representative warm parents; no speculative runtime patch or automatic re-enable. |
| [CI platform holes](ci-platform-coverage-holes.md) | High release / Dev | L | Concrete coverage inventory; matrix cost/scope decision | Select platform-sensitive tests or cadence; actual native CI runs cover the chosen contract. Linux desktop/iOS scope is not implied by adding tests. |
| [Windows validation baseline](windows-validation-baseline.md) | High release / Dev | L | Hundreds of recorded failures; mixed independent families | First split path-setup, ACL, database cleanup and checkout-format ownership; each needs native regressions, followed by a truthful full aggregate. |
| [Server test typechecking](server-tests-not-typechecked.md) | Medium / Dev | L | Excluded tests and staged plan | Ratchet typed coverage under the existing plan until every server test participates in root/CI checks; do not bypass fixture contracts. |

## Maintenance, duplicate and stale-entry handling

These are generally useful for reliable delivery, but their direct product
impact is lower or unestablished. Do not buy green tests by hiding production
failures, increasing every deadline, or suppressing diagnostics.

| Entry | Impact | Scope | Judgment | Success condition / next action |
| --- | --- | --- | --- | --- |
| [Readiness-check startup budget](project-queue-readiness-test-startup-budget.md) | Dev, recurring CI | S | Strong maintenance candidate; shared 100 ms budget checked now | Hung child is killed; successful reuse gets justified startup headroom and passes under supported suite load. Runtime deadline unchanged. |
| Scratch-space tmpfs fixture — closed | Dev, host portability | S | Fixed; five tests pass | Filesystem-boundary fixture controls free space and filesystem type; accepted disk and rejected tmpfs overrides are covered without depending on the host mount. |
| Second scratch-space report — closed | Same as preceding row | S | Same repair, not another work item | Duplicate incidents recorded on 2026-09-13 and 2026-09-14; both reports close with `packages/server/test/lib/scratchSpace.test.ts`. |
| [Git-status suite timeouts](git-status-tests-timeout-under-suite-load.md) | Dev | M | Loaded failure, isolated pass | Record subprocess timing under supported concurrency; meaningful deadlines pass without hiding hung Git. |
| [Completion watcher deadline](project-file-completion-watcher-test-deadline.md) | Dev | S–M | Loaded failure, isolated pass | Establish watcher readiness and observe the nested addition under suite load; no arbitrary sleep. |
| [Multi-host setup deadline](multi-host-e2e-setup-timeout.md) | Dev | M | Repeated near-budget startup | Identify contention or justify startup budget; both legacy and mux harnesses reliably start and tear down under the declared workload. |
| [Grok Bash environment probes](grok-acp-bash-session-env-probes.md) | Dev / possible provider | S–M | Focused macOS failures | Diagnose shell startup, then prove fresh/resumed Bash receives the exact session id; retain identity assertion. |
| [Relay sidebar update notice](relay-sidebar-test-update-notice.md) | Dev | S | Concrete unrelated overlay | Fixture controls/dismisses update state and ordinary click reaches sidebar; notice retains separate coverage, no force-click. |
| [Full-suite timer/diagnostic failures](full-suite-timing-and-diagnostics.md) | Dev | M–L | Several independent failures | Start with deterministic supervisor iterator/timer ownership, then assert intentional diagnostics individually; full suite ends without leaked timers or unexpected warnings. |
| [Session-detail timing warning](session-detail-test-timing-warning.md) | Dev | S–M | Overlaps preceding diagnostic family | Reproduce with resource evidence; control fixture timing or fix measured augmentation work, retaining production slow-request diagnostics. |
| [Bun Vitest loader](bun-vitest-shared-zod-loader.md) | Dev / Bun confidence | M | Repro command; production loader passes | Supported test-loader configuration collects affected schemas under Bun; do not rewrite production imports merely to satisfy Vitest. |
| [Runtime tooling warnings](runtime-cutover-tooling-warnings.md) | Dev | L | Umbrella of dependencies and console debt | Split by owning transport/build/logging boundary; each replacement preserves behavior and lowers real warnings, not the budget. |
| [Dependency advisories](production-dependency-audit-advisories.md) | Low current exposure / Dev | M | Recorded unreachable paths; conditional revisit | Re-audit when the recorded trigger fires and verify consuming paths before upgrades. No new vulnerability verification performed here. |
| [Proposal-topic placement](proposal-topics-bypass-sketches-companion.md) | Low / docs | M | Concrete doc-ownership inconsistency | Preserve approved decisions, move candidate mechanics and update all links; no product implementation implied. |

## Moved to sketches

These are retained ideas, not discarded requirements. Promotion needs the
specific decision or evidence below and a bounded acceptance test. A move does
not revoke an earlier authorized direction; it distinguishes that direction
from work ready for implementation.

| Entry | Potential impact | Scope | Why it is a sketch | What would make it actionable |
| --- | --- | --- | --- | --- |
| [Boot cache baseline](sketches/cache-miss-boot-baseline.md) | Medium cost visibility | L | Store, estimator and useful alert threshold unchosen | Select a bounded observation store and validate baseline behavior on known warm/cold and changed-boot examples. |
| [High-cadence sidebar catch-up](sketches/cached-sidebar-high-cadence-catch-up.md) | Medium–High | M | Hypothesized cross-product; no demonstrated failure | Run the stated cadence comparison and define convergence/resource ceilings; promote a reproduced failure or a bounded coverage task. |
| [Commit/session attribution](sketches/committed-change-session-attribution.md) | Medium | L | Git-notes direction authorized; detection, granularity and rewrite handling open | Choose first note granularity and commit-detection boundary; demonstrate correct mixed-session attribution without changing commits. |
| [Confusing settings umbrella](sketches/confusing-settings.md) | Medium–High | L | Many independent product/data-model decisions | Extract one approved interaction or diagnostic slice with an owner and test; do not implement the umbrella as one task. |
| [Full-stack degradation injection](sketches/full-stack-degradation-injection.md) | High diagnostic potential | L | Broad experiment infrastructure; useful first target unselected | Pick one observed failure and one perturbation boundary with a bounded recovery oracle before building a general framework. |
| [Live full-state backup](sketches/live-full-state-backup.md) | High | L | Complete store inventory and cross-writer barrier unresolved | Inventory authoritative state, choose availability/consistency boundary, then prove restore during concurrent mutation. |
| [Storage migration UI](sketches/network-filesystem-banner-offers-no-migration.md) | High for affected installs | L | Destination persistence and safe descriptor lifecycle undecided | Design recoverable whole-directory copy and next-start discovery; enumerate every writer and verify restart opens the new state. |
| [Oversized hub modules](sketches/oversized-hub-modules.md) | Indirect maintainability | L | No selected ownership split or observable user gain | Select a concrete leaking boundary and behavior-preserving extraction; size alone is not success. |
| [Per-session SQLite preference](sketches/prefer-per-session-sqlite-over-global-keyed-by-session.md) | Unmeasured | L | Architectural hypothesis; many current tables need global queries | Audit one candidate and compare contention, handles, space and query cost before choosing a migration or rule. |
| [Completion persistence](sketches/project-file-completion-persistence.md) | Medium on large projects | M | Explicitly optional; cold/restart benefit unmeasured | Measure cold inventory cost, select a disposable cache, and prove freshness across restart/checkout without project writes. |
| [Common-word basename aliases](sketches/project-path-basename-common-word-false-positives.md) | Low | S–M | Accepted tradeoff pending actual frustration | Collect disruptive false positives and intentional controls before choosing a filter. |
| [Extra basename replay scan](sketches/project-path-basename-replay-scan.md) | Unmeasured performance | M | Optimization hypothesis without measured cost | Measure no-link/early-link/collision cases; replace only if end-to-end improvement preserves prefix causality. |
| [Longer suffix aliases](sketches/project-path-suffix-aliases.md) | Low–Medium | M | Optional extension; memory/time bound unchosen | Select supported suffix behavior and budget; prove earlier links cannot be retargeted by later text. |
| [Project readiness overrides](sketches/project-queue-readiness-overrides.md) | Medium | M | Explicitly deferred extension plus separate blocking-mode proposal | Request the inherit/custom/none slice, test persistence and resolver behavior; keep blocking checks separate. |
| [Project speech vocabulary](sketches/project-specific-speech-vocabulary.md) | Medium–High | L | Ranking, project contributions and visualizer scope not selected | Choose transcript-only first slice and compare relevant selections across two projects with reset/fallback tests. |
| [Frozen file/revision shares](sketches/public-frozen-file-revision-shares.md) | Medium | L | Immutable target, payload, offline delivery and inventory unresolved | Select one immutable target and capability; prove captured bytes survive source change/deletion and revoke works. |
| [Quarto document rendering](sketches/quarto-aware-document-view.md) | Medium for document work | L | Useful outcome, but execution containment and first semantic slice unresolved | Choose inert preview support or explicit isolated render first; prove source binding, no project writes and missing-tool fallback. |
| [Cross-device scroll memory](sketches/server-synced-session-scroll-memory.md) | Medium | M–L | New server state and cross-device ordering decisions | Specify identity/order and capability fallback; two devices merge monotonically with bounded writes. |
| [Learned speech-error model](sketches/speech-recognition-error-modeling.md) | High potential | L | Requires reliable labels, retention and measured recognition benefit | Select consented correction evidence and held-out paired audio evaluation; distinguish edits from actual errors. |
| [Vocabulary ranking approximations](sketches/speech-vocabulary-ranking-approximations.md) | Unmeasured quality | M–L | Accepted approximations; reservation already addresses part of concern | Measure a concrete ranking miss or durability cost; compare one change against current selection and responsiveness. |
| [Transcript margin notes](sketches/transcript-margin-notes.md) | Unknown until content chosen | M | No note type or producer selected | Pick one useful note and responsive placement contract; verify dense notes and scroll stability. |
| [Suspected cut-off turn marker](sketches/unflagged-mid-sentence-turn-endings.md) | Low–Medium | M | No authoritative signal; heuristic fails across providers | Decide provider scope and false-positive tolerance, then validate held-out endings; display uncertainty honestly. |
| [Virgin instruction environment](sketches/virgin-new-session-option.md) | Medium specialized | L | Provider mechanisms and credential/discovery lifecycle need proof | Pick provider scope and verify global-instruction omission while preserving project instructions, auth, resume and sandbox behavior. |
| [Removing durable seen filter](sketches/vocabulary-seen-filter-may-be-redundant.md) | Potential simplification | L | Competing cursor/watermark/error-tolerance designs | Compare existing acquisition cursor first; choose exactness contract and prove replay/restart behavior against live learning. |
| [Future sandbox schema delivery](sketches/ya-facility-schema-delivery.md) | Conditional only | M | Explicitly no current defect; stricter sandbox is hypothetical | Reopen only when an actual harness-denied schema cannot use the existing authorized delivery path. |
| [Yacron scheduler](sketches/yacron-scheduler.md) | High automation potential | L | New subsystem; variant, admission and management UI unresolved | Select standalone or integrated first slice and its durable dispatch/receipt oracle under the existing roadmap. |

## Closed as already fixed

Removed the stale files after checking current implementation and existing
regressions. The three relevant client test files passed all 67 tests on
2026-09-14. This validates these specific closures, not the whole backlog.

| Former entry | Fix / current evidence | Disposition |
| --- | --- | --- |
| `artifact-cli-tests-inherit-viewer-origin.md` | `f017501c3`; both launcher URL variables are reset and capture CLI tests pass | Closed; no additional fix needed. |
| `artifact-browser-policy-warnings.md` | `9173cd5d8`; unsupported Bluetooth directive removed; capture tests cover host-policy notice handling | Closed. The intentional dedicated-origin sandbox pair remains; Chromium may still emit its generic notice, which is excluded from artifact-authored warnings. |
| `public-share-revoke-empty-state-test.md` | `d1fa7492c`; removal assertion awaits the asynchronous effect; current full modal test file passes | Closed as a repaired test race; no claim of a new production revocation fix. |

## Follow-through

Prefer one selected entry per implementation pass. Record current reproduction,
owning mechanism, scope, and its closure test before editing runtime code.
Use the maintenance group when a failing gate blocks that pass; do not confuse
a cheap fixture repair with a high-impact product improvement. Keep difficult
incidents visible until evidence closes them, and promote sketches only after
their decision or measurement prerequisite is satisfied.

This pass checked current source for the artifact environment fix, the shared
100 ms readiness fixture, the undefined banner variable, the replay-only
vocabulary observe call, and the crash's named state setter. Other rows are
document triage, not fresh reproductions, performance measurements, vendor
audits, or security assessments. Existing recorded dates and limitations remain
in the individual entries.

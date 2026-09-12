# Roadmap

Last updated: 2026-09-12.

This is Yep Anywhere's canonical product-priority overview. Keep initiative
status, the next action, and major blockers here; keep implementation steps in
`docs/tactical/` and durable behavior contracts in `topics/`. Planning stays in
the repository and does not require epics, ticket numbers, or pull requests.

## 1. Publish the desktop and mobile apps with continuous delivery

**Highest priority.** Make Yep Anywhere available as supported public releases
on desktop, iOS, and Android, with CI covering every distribution and an
automatically published **Latest** channel for bleeding-edge builds. Desktop
should graduate from its current beta positioning; mobile should reach the
App Store and Google Play, not stop at internal testing.

**Status:** in progress. The API/client development sequence is selected: a
minimal multi-server web demo first with Android following closely on the same
simplified contracts. The offline TypeScript/Kotlin schema and bounded server
Conversation producer, shared subscription owner, bounded native acquisition and
experimental HTTP/SSE/WebSocket bindings are implemented. Typed TypeScript/Kotlin
read helpers and the first multi-server web preview at `/-/preview` are implemented.
The Android preview screen remains next. iOS is deferred
to a later scoped effort.
Exact API and mobile release scope remain design work.

### Current baseline

- Signed macOS and Windows desktop releases already exist. The
  [desktop release QA log](../testing/desktop-release-qa-log.md) records
  installer and updater validation; the
  [public distribution catalog](../../site/src/data/distributions.ts) still
  identifies desktop as beta.
- The web client and npm server are available. The
  [Latest remote-client workflow](../../.github/workflows/latest-remote-client.yml)
  already deploys the exact successful CI commit after pushes to `main`.
- [Desktop CI](../../.github/workflows/desktop-ci.yml) packages and signs
  desktop releases. [Nightly Desktop](../../.github/workflows/nightly-desktop.yml)
  publishes verified `main` changes to Latest; the first signed nightlies and
  the unchanged-source skip have passed release validation. The
  [2026-09-10 nightly run](https://github.com/kzahel/yepanywhere/actions/runs/34450193826)
  is blocked by a release-creation authorization error (HTTP 403); credential
  repair is excluded from the current CI repair work.
- The [server runtime matrix](https://github.com/kzahel/yepanywhere/actions/runs/34485119811)
  now passes full packaged startup on Linux, macOS and Windows across all four
  Node versions and the pinned Bun runtime, including clean npm installations.
- [Android CI](../../.github/workflows/android-app-ci.yml) tests and builds
  application artifacts but does not publish them to Google Play. Android
  implementation exists; neither native mobile app is publicly published.
- Linux remains supported through the server/web distribution. The current
  desktop installer matrix is macOS and Windows; a Linux desktop installer
  would need its own scope and release criteria.

### Release outcomes

- [ ] Establish and meet desktop release criteria, then publish and present
  desktop as a supported release rather than beta. Reuse existing signed
  installer and updater evidence instead of restarting the packaging work.
- [ ] Decide the first mobile release scope and its acceptance criteria.
- [ ] Complete and publish Android on Google Play and iOS on the App Store.
  Automated internal testing is an intermediate milestone, not completion.
- [ ] Give every distribution CI verification and automated release delivery:
  website/web client, npm server, desktop, Android, and iOS. Extend existing
  workflows rather than creating a parallel release system.
- [ ] Publish passing, relevant `main` changes to Latest channels without a
  manual version bump, release tag, or upload for each preview build. Include
  signed desktop updates, Android internal testing, and internal TestFlight;
  broader mobile testing must respect platform review and distribution rules.
- [ ] Make each platform's latest available build easy to find, with its
  version, source commit, publication state, and installation path. A failed
  or still-processing build leaves the previous successful build available.

### Latest channel expectations

Desktop starts with nightly publication at 02:37 UTC, skipping unchanged
packaged inputs, plus manual dispatch for recovery and validation. Same-app
Stable/Latest selection and signed nightly publication are available. Windows
installed-upgrade acceptance passed, including channel persistence and data
preservation. Installed macOS upgrade acceptance remains blocked by the test
VM's suspended-state restore failure, pending approval for recovery; see the
[desktop release QA log](../testing/desktop-release-qa-log.md).
Continuous per-commit desktop delivery remains a later extension of this
foundation.

Continuous publication should make builds available as soon as verification,
packaging, signing, and platform processing allow; it is not restricted to a
nightly schedule. Coalesce superseded pending work when necessary instead of
building an ever-growing release queue. Store availability and device update
timing are separate; hourly automatic installation is not a guarantee.

Desktop discovers the available update and offers it through a banner or
equivalent notice. The user approves installation through one Update action;
publication must not silently install or restart the desktop app. Mobile
installation follows the user's platform update preferences.

Stable and Latest remain distinct choices. Latest clients must preserve the
supported older-server fallbacks; joining Latest must not require upgrading
every paired machine together. Versioning, signing, installation, update, and
compatibility checks belong to the release criteria, not just compilation.

### Mobile scope decisions and next action

The 2026-09-12 direction is a [Simple Client API](../../topics/simple-client-api.md)
that returns server-owned summaries and condensed Conversation data through
transport-independent, generated TypeScript/Kotlin contracts initially. The API
starts under `/api/experimental/` and can evolve incompatibly; stable namespace,
versioning, and support policy are explicit promotion decisions before public
mobile reliance. Start with a minimal web client at an unlisted Latest URL,
connecting to multiple YA servers from the first useful slice and experimenting
with sidebar grouping by machine, project, and issue. Android Compose follows
closely in small vertical slices and shapes the contract early. iOS transport,
Swift decoding and SwiftUI are deferred; React Native is not selected. Message
limits count user/agent messages rather than turns, with history/reconciliation
complexity kept below the frontend.

The demo is an API consumer with a new small state machine, not a full-web
rewrite prerequisite. Native remains focused on Conversation view, with rich
activity, files, complex settings, and unsupported actions using the full-web
alternative. Exact action coverage and store-release acceptance remain open.

**Next action:** continue the [web/Android demo plan](../tactical/130-simple-client-api-and-three-client-demo.md).
The [offline contract spike](../../packages/shared/contracts/README.md) has shared
Claude/Codex-derived and synthetic examples, generated TypeScript/Kotlin decoding
with unknown fallbacks, and an explicit two-compaction-then-message-count rule.
The shared compiler extraction and automatic Conversation projection are now
implemented, followed by the shared subscription owner and bounded live API. The
[concrete operation/capability review](../tactical/130-simple-client-api-and-three-client-demo.md#first-live-operation-review-proposal-2026-09-12)
was approved on 2026-09-12. The deliberate-entry web preview now consumes live
Conversation snapshots with a temporary existing-catalog adapter. A self-hosted
browser entry at `/-/preview` also connects to the serving server through
same-origin HTTP/SSE, without relay or saved pairing. Android session cards now
open a native Compose Conversation preview through saved source leases, with
history controls, live finalized snapshots, and explicit reconnect. An encrypted
direct-server AVD proof covers native navigation, rotation, live updates and
foreground lifecycle. Next evaluate both previews against everyday sessions on
Latest, review the SourceOverview operation, and extend indexed
history acquisition beyond the initial hard-budget refusal. Partial-message token
assembly is deferred; finalized-message snapshots update live.
Measure the recorded cost budgets; offline fixtures are not live integration.
Desktop release and continuous-delivery work continue independently.

Start from these existing plans and contracts:

- [Mobile companion product shape](../project/mobile-companion-app.md)
- [Simple Client API and web/Android demo](../tactical/130-simple-client-api-and-three-client-demo.md)
- [Native Android multi-host runtime](../tactical/084-android-native-multi-host-runtime.md)
- [Bundled web over native transport](../tactical/083-android-bundled-web-native-transport.md)
- [Conversation view](../../topics/conversation-view.md) and
  [portable transcript compiler](../../topics/portable-transcript-compiler.md)
- [Desktop distribution contract](../../topics/desktop-v0.md)
- [Trusted client packaging](../../topics/trusted-client-packaging.md) and
  [client/server compatibility](../../topics/remote-hosted-compatibility.md)

## Later directions

These remain candidates behind publishing and continuous delivery, not a
ranked or approved implementation queue. Recheck current code and owning
documents before defining work.

| Direction | Existing context / decision still needed |
| --- | --- |
| Multi-machine experience across the full web and desktop clients | The simple-client demo above now owns the first grouping experiment; broader adoption follows evidence from that work and [source runtimes](../../topics/client-source-runtime-topology.md). |
| Related work across repositories | [Issues & PRs](../../topics/issue-session-associations.md) now has experimental, default-off automatic ticket/URL discovery from viewed sessions and a configurable recent-session window, durable evidence, search and correction controls. Conservative URL/known-prefix matching, durable Jira project learning, and session-grouped browsing are implemented and locally validated. SQLite migrations and compatibility gating are implemented. Multi-server issue grouping enters the simple-client demo above; workstream/branch inference and tracker synchronization remain deferred. |
| Parallel work within one repository | Follow the [workstreams proposal](../../topics/workstreams.md), which uses ordinary lane clones; do not revive the old automatic-worktree sketch as an approved design. |
| Scheduling | Follow [yacron](../../topics/yacron.md) and its [open gap](../../gaps/yacron-scheduler.md); the first management UI remains a design prerequisite. |
| Agent command runtime | Opt-in [`ya-agent self`](../../topics/agent-self.md) implements ownership and model/effort evidence reporting. Use operator-managed global instructions initially; defer automatic advertisement, private input, broader session access, and scheduling integration. |
| Node 22 and built-in SQLite | Follow the approved [runtime cutover plan](../tactical/123-node-22-builtin-sqlite-cutover.md): raise the server runtime floor now, retain older-server hosted frontend support with advisory runtime warnings, and gate new SQLite-backed features by their exact capabilities before considering any separate frontend cutoff. |
| Source workflow depth and traceability | Build on [Source Control](../../topics/source-control.md), [review handoff](../../topics/source-review-to-session.md), and [commit/session attribution](../../gaps/committed-change-session-attribution.md). Additional Git or terminal controls need a concrete user workflow. |
| Provider maturity and other deferred work | Consult the owning provider topics and [deferred backlog](../../topics/deferred-roadmap.md); its local ordering does not override this product priority. |
| macOS backend reload continuity | [Provider-host port](../tactical/128-macos-provider-host.md) completed for Node source checkouts: live Claude/Codex reload, approval, durable resume, concurrent sessions and terminal cleanup verified. Native CI passes on Linux, Apple Silicon/Intel Mac and Windows fallback; [evidence](../../topics/reload-safe-provider-runtimes.md#macos-live-verification-2026-09-12) records the exact runtime scope. The separate [Claude project-alias history gap](../../gaps/claude-symlink-project-transcript-routing.md) remains open. This developer iteration work does not displace release delivery. |

## What changed from the old roadmap

The February 2026 list is superseded. Status/diff browsing, line-review
comments, and signed desktop installers are existing capabilities, not new
feature proposals. Source Control remains deliberately bounded; the old
stage/commit/PR checklist is not an approved expansion. The former blanket
"Not Planned" exclusions are retired rather than carried forward as current
product decisions.

The [T3 Code analysis](../competitive/t3code.md) informs this reprioritization.
Provider-native session continuity remains a central differentiator; release
availability and a coherent multi-machine mobile experience make it easier to
use. Further feature comparisons do not displace the publishing priority.

# Roadmap

Last updated: 2026-09-05.

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

**Status:** in progress, with mobile product scope still a design blocker.
The release outcome is decided; the first mobile release design remains open.

### Current baseline

- Signed macOS and Windows desktop releases already exist. The
  [desktop release QA log](../testing/desktop-release-qa-log.md) records
  installer and updater validation; the
  [public distribution catalog](../../site/src/data/distributions.ts) still
  identifies desktop as beta.
- The web client and npm server are available. The
  [Latest remote-client workflow](../../.github/workflows/latest-remote-client.yml)
  already deploys the exact successful CI commit after pushes to `main`.
- [Desktop CI](../../.github/workflows/desktop-ci.yml) has release packaging
  and signing machinery, with publication tied to desktop release tags.
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

The leading direction is a native multi-machine interface with condensed
Conversation view as the only native transcript presentation initially.
Source browsing, file viewing, detailed activity, and complex settings may use
embedded web screens. This is a design direction to resolve, not a settled
release checklist: the native/web boundary, action and approval coverage,
navigation, and minimum scope for each platform still need decisions.

**Next action:** reconcile the existing mobile plans into a concrete first
release scope and acceptance criteria, while defining the stable desktop and
Latest delivery work that can proceed independently. Mobile design should not
block desktop publication or the continuous-delivery foundation.

Start from these existing plans and contracts:

- [Mobile companion product shape](../project/mobile-companion-app.md)
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
| Multi-machine experience across web and desktop | Extend the native-mobile direction through [source runtimes](../../topics/client-source-runtime-topology.md); decide the unified attention and navigation surface. |
| Related work across repositories | Explore lightweight grouping of existing sessions, repositories, and optional ticket/PR links; no tracker replacement or cross-repository scheduler is decided. |
| Parallel work within one repository | Follow the [workstreams proposal](../../topics/workstreams.md), which uses ordinary lane clones; do not revive the old automatic-worktree sketch as an approved design. |
| Scheduling | Follow [yacron](../../topics/yacron.md) and its [open gap](../../gaps/yacron-scheduler.md); the first management UI remains a design prerequisite. |
| Source workflow depth and traceability | Build on [Source Control](../../topics/source-control.md), [review handoff](../../topics/source-review-to-session.md), and [commit/session attribution](../../gaps/committed-change-session-attribution.md). Additional Git or terminal controls need a concrete user workflow. |
| Provider maturity and other deferred work | Consult the owning provider topics and [deferred backlog](../../topics/deferred-roadmap.md); its local ordering does not override this product priority. |

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

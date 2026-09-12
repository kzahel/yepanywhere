# Project Directory Storage

> YA-managed caches, viewer state, metadata, and retained assets stay out of
> project directories by default. A single global setting may opt into
> project-local storage; Git exclusion is a safeguard after consent, never a
> substitute for consent.

Topic: project-directory-storage

Status: implemented in current source after `0.7.0`; no stable npm release
contains the policy yet. Source Review mutable state is revision-safe across
repeated mode changes. The pre-correction writer audit remains below as release
and compatibility history.

Settings surface: [Storage Settings](storage-settings.md).

## Scope

This topic owns every write YA itself makes inside a selected project root or
that project's Git metadata in order to retain YA state. It includes:

- hidden directories such as `.yep/` and `.attachments/`;
- caches, indexes, viewer state, uploaded assets, review state, and retained
  tool output;
- `.git/info/exclude` and YA-owned refs or objects under the repository's Git
  directory; and
- project-local temporary files used to publish any of the above.

It does not turn YA into a read-only editor. Provider/agent file mutations,
explicit Source Control operations, and an export whose project destination
the user directly selects are user-requested project operations rather than
YA-managed storage. A feature cannot evade this contract merely by calling its
state an artifact: if YA chooses the path and retains the data for later use,
the storage policy applies.

## Default Contract

The default global mode is **App data only**. In that mode:

- opening, adding, scanning, rendering, replaying, or indexing a project or
  session makes no YA-managed write inside the project or its Git metadata;
- uploading an attachment stores it below the configured YA data directory;
- performance indexes and viewer caches remain in memory or in bounded,
  disposable data-directory storage;
- persistent feature state is namespaced by project below the configured YA
  data directory; and
- a feature that cannot work without project-local storage remains unavailable
  or explains the required opt-in. It never silently changes the mode.

The alternative global mode is **Store YA assets with projects**. It is an
explicit opt-in. It authorizes eligible YA-managed features to use one
documented project-local YA root, preferably `<project>/.yep/`, subject to
symlink, tracked-path, and containment checks. It does not enable a new class
of retention by itself. For example, project-local mode chooses a location for
durable tool-result media only after the separate preservation feature has
also been enabled.

The global choice is stored below the YA data directory, not in a marker file
inside each project. Per-project overrides are deliberately deferred. They may
be added if real demand appears, but the first implementation has one global
policy only. `YEP_DATA_DIR` remains the configuration mechanism for the central
location; v1 adds no custom-path setting.

## Git Exclusion Is Not Consent

Creating or editing `.git/info/exclude` is itself a project-metadata write. YA
must not do it in **App data only** mode, even if an exclusion would keep the
working tree visually clean.

After the user opts into project-local storage, YA may best-effort add its one
documented storage root to the clone-local exclude file when that root is not
already ignored. It must not edit a committed `.gitignore`. An already tracked
storage root is unsafe for implicit YA output; do not place new state there
without a separate explicit operation. Exclusion reduces accidental commits,
but does not address checkout growth, backups, cloud synchronization, privacy,
or the user's ownership of the project namespace.

The tracked-path check fails closed. Only Git's explicit “not a repository”
result permits a non-Git project to proceed without `ls-files`; a timeout,
missing executable, permission problem, or other inspection failure aborts the
write before YA creates `.yep` or edits Git metadata.

## Feature Retention And Location Are Independent

Every feature answers two questions separately:

1. **Should this data be retained at all?** Durable preservation of otherwise
   ephemeral output is a user-visible feature and defaults off unless an
   explicit product decision says otherwise. V1 has no persistent tool-media
   cache; a future cache with automatic eviction is a separate policy.
2. **Where does enabled durable data live?** **App data only** selects the YA
   data directory. The project-local opt-in selects the documented project
   root where the feature supports it.

A location setting cannot silently enable attachment retention, tool-result
preservation, review history, or any later storage family. Likewise, enabling
one retained-data feature does not grant permission for unrelated project
writes.

## Upgrade, Disable, And Legacy Data

When a server first gains this policy, absent stored settings resolve to
**App data only** and **Load on demand**, including for upgraded installations.
The upgrade itself does not move, merge, rewrite, exclude, or delete existing
`.attachments/`, `.yep/`, or Git refs. Existing project-local data may remain
readable for compatibility, but read compatibility is not permission to
refresh or grow it.

Switching from project-local storage back to **App data only** stops future
project writes immediately. Cleanup and migration are separate explicit
actions. A failed or unsafe selected location never falls back from app-data
mode into the project.

## Mode Transitions And Split State

The location setting routes new additive payloads and coordinates the mutable
Source Review authority; it is not a bulk payload migration or cleanup action.
General compatibility reads still try the selected location and then the other
location. That selected-first order is safe only when retained objects are
immutable and additive and a same-key collision is either impossible or
verified to contain the same bytes.

Source Review `review-comments.json` does not use selected location or file
modification time as authority. Each persisted mutation increments a logical
revision and stores a SHA-256 digest of the domain state. Reads inspect both
roots, select the highest valid logical revision, and reject equal-revision
divergence. Legacy stores without the metadata remain readable as revision
zero. This prevents a project A → app-data B → project sequence from reloading
A and stranding B. Modification time cannot provide that guarantee: clocks can
differ, atomic replacement changes times, and a restored backup may be newer on
disk but older logically.

The routed storage families have different transition requirements:

| Family | Storage semantics | Required transition behavior |
| --- | --- | --- |
| Source Review `review-comments.json` | Authoritative mutable state | Transfer or losslessly reconcile before the new mode becomes authoritative. Never choose solely by selected location or modification time. |
| Source Review `request.json` | Immutable, submission-ID-keyed manifest | Treat both roots as an additive union and reject a same-ID byte mismatch. |
| Source Review `response.json` | Agent-written mutable outcome snapshot | Keep an active submission pinned to one directory, or quiesce and transfer it with the review state. A global toggle must not make YA watch a different path from the agent. |
| Exact Source Review captures | Immutable content-addressed bytes: Git objects in project mode, SHA-256 files in app-data mode | Read the union without rewriting old objects. Preserve the project capture ref; disabling project storage does not authorize deleting it. |
| Completed attachments | Intended append-only payloads under UUID-prefixed names, but not content-addressed | Read both roots. A transfer must validate same-name bytes rather than overwrite; current lookup relies on UUID uniqueness. |
| Preserved tool-result media | Content-addressed blobs plus records whose IDs include the content hash and session context | Read the validated union. Copying is optional and must remain idempotent; preservation remains a separate opt-in. |
| Git author palette | Derived, regenerable cache | Invalidate and regenerate in the destination. Do not migrate it as authoritative state. |
| `.git/info/exclude` and the Source Review capture ref | Additive project metadata | Leave existing entries and refs in place when disabling project storage. Cleanup is a separate explicit operation. |

`ProjectStoragePolicy` serializes mode changes and writes a durable central
intent journal before invoking registered transition participants. The Source
Review participant synchronously blocks new review operations, drains admitted
operations, and then examines retained projects plus the project scanner's
current project set. Projects with no durable review state remain untouched.
For each durable store it loads both roots under the revision rule above, writes
and verifies that state at the target location, and only then invokes the
durable settings commit. A failed preflight, copy, verification, or settings
write before settings replacement leaves the old mode selected. A genuine
directory-flush error after settings replacement completes the committed mode
transition and reports the durability error; it cannot undo the replaced file.
See [cross-platform persistence](server-runtime.md#cross-platform-file-persistence).
A later attempt consumes any stale intent
and repeats the idempotent reconciliation. After a successful mode publication,
retained review stores are released so subsequent operations reload under the
new routing choice.

Immutable submission manifests remain a cross-root union. Equal submission IDs
must contain exactly the same request bytes or the operation fails. An accepted
request remains pinned to the directory that actually contains its manifest;
the provider prompt and response observer use that directory even after the
global mode changes. Exact captures remain content-addressed union members.
These rules keep active review work on one physical path without treating the
mode as authority.

The transition coordinator is a participant seam. Every future authoritative
mutable storage family must register its own quiesce, reconcile, verify, and
commit wrapper before the storage capability can cover it. Active writers must
be quiesced or remain pinned to their original location for their full
lifecycle. Disposable caches should be cleared rather than ported.

### Explicit migration and cleanup

Large retained payloads should not be recursively moved as a side effect of
changing the global setting. A mode change may span many projects, filesystems,
and active sessions; an in-place move can fail halfway and makes a quick
settings request responsible for unbounded work.

The preferred product split is:

1. the mode control selects the destination for new additive payloads, subject
   to the authoritative-state preflight above;
2. a separate **Migrate existing data** action copies eligible old data into
   the selected location with durable progress, byte or hash verification,
   no unverified overwrite, and idempotent restart; and
3. a separate cleanup phase removes an old copy only after YA proves that no
   persisted reference or active writer still depends on its physical path.

Copy completion does not by itself prove cleanup safety. Provider transcripts
contain the absolute paths originally sent for attachments, so deleting a
successfully copied attachment can still break a resumed agent that follows
the old path. Existing attachments should remain readable at both locations
until YA has a durable logical-reference or compatibility strategy for those
transcripts. Preserved tool-result media is a better cleanup candidate because
its blob bytes are hash-validated and normal reads use logical media IDs.

The migration action must report work and blockers by project and storage
family. It must never collapse “copied,” “source safe to delete,” and “source
deleted” into one success state.

Downgrading to a server without the policy can reintroduce that older server's
write behavior. A new client connected to such a server must not claim the
project is protected; the compatibility fallback below explains the limitation.

## Pre-Correction Writer Audit — 2026-08-03

| Writer | Current trigger and location | Setting today | Released behavior | Required correction |
| --- | --- | --- | --- | --- |
| Attachments | An explicit upload or staged-send materialization writes `<project>/.attachments/<session>/`. Current source may also create a local Git exclude. | None. The setting described in `attachment-storage.md` was never implemented. | npm `0.5.0` through `0.7.0` write project-local attachments; those releases do not contain the later shared exclude helper. | Write below the YA data directory by default; use the project root only after the global opt-in. Keep legacy project paths readable. |
| Tool-result media | Live image results and durable session-detail loads materialize blobs and catalogs below `<project>/.yep/tool-results/<session>/`; merely reading image-bearing history can grow it. | None. | Added after `0.7.0`; no stable npm release contains it. | Restore lazy transcript-backed handles without persistent copies. Default-off preservation captures only new results emitted by managed sessions, never historical reads; its location follows this policy. |
| Git author palette | Fetching or adding a project starts a background warm that writes `<project>/.yep/git-author-palette.json`. | None. | Added after `0.7.0`; no stable npm release contains it. | Keep the palette in memory or in the YA data directory. Project browsing is read-only in the default mode. |
| Source-review drafts and submissions | Comment mutation writes `.yep/review-comments.json`; submission preparation writes `.yep/source-review/<id>/request.json`. Some reads can rewrite normalized state. | Submission capture is default-off, but basic review drafts have no storage-location gate. | Added after `0.7.0`; no stable npm release contains it. | Store private state centrally by default. If an agent needs a review artifact, deliver it without ambient project storage or require the global project-local opt-in. |
| Source-review capture ref | When the default-off submission workflow captures a projection, it writes Git objects and updates `refs/yep/source-review/captures`. | `sourceReviewSubmissionsEnabled`, default off; no project-storage gate. | Added after `0.7.0`; no stable npm release contains it. | App-data mode cannot create YA-owned Git refs or objects. Use central snapshots or require project-local opt-in. |
| Managed-directory exclusion | First creation of `.yep/` or `.attachments/` may append to the resolved `.git/info/exclude`. | None. | Added after `0.7.0`; no stable npm release contains it. | Resolve the global policy before directory creation; exclude only after project-local opt-in. |

The audit also checked the project path index, which reads the filesystem on
demand and writes nothing anywhere; the user-authored `.yepignore` crawl input
it once read was removed with the crawl (`project-path-links.md`). Explicit
file-edit, Git Pull/Push, and workstream operations are outside this
storage-state table; they remain governed by their own explicit-action and
safety contracts.

## Released-Server Corpus

This is a core trust and filesystem-default change, so the 60-day compatibility
corpus applies. As of 2026-08-03 the applicable stable npm releases are
`0.5.2`, `0.6.0`, `0.6.1`, `0.6.2`, and `0.7.0`; the latest-two rule is already
covered by `0.6.2` and `0.7.0`. `0.5.0` and `0.5.1` fall just outside the
minimum horizon but are included in the audit because `0.5.0` introduced the
project-local attachment default.

All stable releases from `0.5.0` through `0.7.0` lack a storage-policy setting
and write uploads to `.attachments/`. No stable release contains tool-result
materialization, source-review project state, the author palette, or the shared
Git-exclude helper. Those behaviors exist only in current source after the
`0.7.0` tag.

## Advertised Capability And Hosted Fallback

The implementation advertises a permanent exact capability named
`project-directory-storage-policy`. Advertisement means all of the following
are true, not merely that a settings field parses:

- `GET /api/settings` returns `settings.projectDirectoryStorage`;
- `PUT /api/settings` accepts that field;
- the value is `"app-data" | "project"` and defaults to `"app-data"` when
  absent;
- every writer in the audit routes through the policy before touching a
  project or its Git metadata;
- mode changes reconcile and verify revisioned authoritative Source Review
  state before publishing the new mode; and
- disabling project storage stops future additive writes without bulk-migrating
  or deleting legacy data.

The registry entry's `introducedIn` value is the first release that implements
the complete invariant; do not advertise it from a partial implementation. No
stable release through `0.7.0` advertised the capability. The maintainer
explicitly accepted broadening its meaning for post-`0.7.0` source builds that
briefly advertised routing-only semantics rather than creating a second gate
before the first stable release.

Without the capability, a new client omits the field and makes no unsupported
settings write. The storage setting should remain visible but read-only with an
update-required explanation: older servers may write uploads into project
directories and cannot enforce **App data only**. Hiding the control entirely
would incorrectly imply there is no relevant policy difference.

This fallback preserves ordinary use of older servers. It does not pretend the
new client can stop an old server's filesystem behavior.

Tool-result preservation has a separate permanent
`tool-result-media-preservation-policy` capability. It owns
`settings.toolResultMediaPreservation: "on-demand" | "preserve"` and attests
that historical reads never create copies, preservation applies only to new
managed-session results, and preserved copies are not pruned automatically.
The exact Settings presentation and absent-capability behavior are in
[Storage Settings](storage-settings.md).

## Implementation Acceptance

Tests prove the project tree and Git metadata remain byte-for-byte unchanged
in **App data only** mode while YA:

- lists, adds, opens, and indexes a project;
- loads image-bearing live and historical sessions;
- uploads and sends an attachment;
- creates, edits, previews, and submits source-review state under every
  independently enabled review mode; and
- requests Git browse and blame data.

Project-local mode needs complementary tests for explicit opt-in, safe root
creation, legacy reads, tracked/symlink rejection, and Git-exclude behavior.
Data-directory stores need their own containment and declared-lifecycle tests.
Tool-result preservation is deliberately unbounded only after its separate
explicit opt-in; no automatic pruning may be inferred from moving it out of a
checkout.

## Related Topics

- [Attachment storage](attachment-storage.md)
- [Session media handles](session-media-handles.md)
- [Storage settings](storage-settings.md)
- [Source Review → New Session](source-review-to-session.md)
- [Server capabilities](server-capabilities.md)
- [Vanilla defaults](vanilla-defaults.md)
- [Hard development rules](hard-development-rules.md)

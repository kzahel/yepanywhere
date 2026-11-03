# Attachment Storage

> User-uploaded attachments are explicit agent context, but their storage
> location is governed by the global project-directory policy. App-data
> storage is the default; project-local storage requires prior opt-in.

Topic: attachment-storage

Parent contract: [Project Directory Storage](project-directory-storage.md).

Settings surface: [Storage Settings](storage-settings.md).

[rendez uploads](rendez.md) are a separate opt-in intake path. Their
persisted attachment paths use the authorized local-media route, while normal
browser uploads retain the storage and narrow upload routes described here.

Status: corrected in current source after `0.7.0`; no stable npm release
contains the storage-location setting yet. The release history below explains
the missing-capability warning for older servers.

## Initial-session admission

[Durable creation](session-identity.md#creation-consolidation--november-3) seals
staged or retained raw initial files and inline images before accepting the
session. Accepted claims outlive draft/Queue cleanup and materialize beneath the
permanent YA id before native dispatch. Limited raw paths must belong to that
account's staged draft. Inline images are bounded to 32 MiB decoded in total,
ordinary files to 64 MiB each, and the combined selection to 64; the existing
2 GiB/profile claim bound applies. Unsupported native inline-image adapters
save failure before effects. Literal document references retain text semantics.
Template preparation uses this same claim owner. Older-server client fallback
and public staged capability 146 keep their existing restricted meanings.

## Why Attachments Are Stored

Pre-session drafts are isolated by acting account. Limited-user draft uploads,
validation, deletion and materialization use a separate persisted staging index;
knowing another account's batch and attachment IDs grants no access. Direct
WebSocket uploads and relay uploads retain the account's staging store through
completion and cancellation. Template preparation accepts staged references,
creates its session, materializes those references under the normal storage
policy, then sends the preparation message with the attachments. Project Queue
items keep their staged attachments in the queuing account's store
([Project Queue](project-queue.md#attachments)).

On servers advertising `draft-sync-v1`, completed staging references follow
[draft synchronization](draft-synchronization.md). Current synced references and
their seven-day release grace protect originals from deletion and staging TTL.
Queue transfer copies protected originals; a draft may reference several batches
owned by the same account. Upload progress and unfinished bytes remain local to
the uploading device.

The composer offers recent prompts and a scrollable upload gallery, retained
only in this browser and separated by server and acting username. It keeps up
to 50 prompts and 50 uploaded files within a 100 MiB file budget. Choosing a
recent upload stages a fresh copy; it does not reuse another session's access.
The paperclip opens the native picker; right-click or a downward swipe opens
the attachment panel. Recent uploads start collapsed above the memo and file
actions nearest the composer. Session composers also record upload history.
Entries retain their project/session origin when known and show relative age;
generic clipboard names such as `image.png` are omitted. Older entries lacking
origin metadata are labeled unknown. Image hover previews use the same large,
viewport-bounded placement as attachment chips. This remains browser-local
history, not a server-wide attachment inventory.

With the browser-local Appearance setting *Recent prompt rail* on (off by
default: dragging prompts in is a YA-novel interaction), new-session and
standalone project-template composers show recent prompts as a column of
small dashes at the left edge of the text box; off, neither composer shows
it or reads prompt history for it. Each 14×2 px dash
has a 36×36 px activation target, enlarged to 44×44 px for a coarse pointer.
Hover, keyboard focus or touch press previews the prompt; dragging shrinks
the preview to half size and follows the pointer. A caret shows the text
insertion position. Inserted text lands on its own line: a newline separates
it from text before or after it on the same line, and no newline is added
on a side that already ends a line or has no text. Release inside inserts without
replacing existing text;
release outside, pointer cancellation or Escape dismisses without editing.
Enter or Space inserts at the composer's saved cursor. Read-only and disabled
composers refuse insertion. The rail scrolls through up to 50 prompts and
does not expose another account's history after switching accounts.

An uploaded file must survive long enough for the provider to read it, for a
queued message to deliver it, and for the transcript to display or download it.
That is intentional attachment persistence initiated by the upload action. It
does not imply consent to place the bytes inside the selected project.

Two locations have existed:

- **YA data directory:**
  `<data-dir>/uploads/<base64url(project)>/<session>/`. This was the original
  implementation. It is centrally confined and project-namespaced.
- **Project directory:** `<project>/.attachments/<session>/`. This became the
  runtime default in commit `46bb9929` and first shipped in npm `0.5.0`.

Project-local storage made an attachment easy for a provider running in the
working tree to discover. That convenience is real, especially under a
provider sandbox, but it does not justify an ambient project write. A Git
exclude only hides the symptom from `git status`; it does not address checkout
growth, synchronization, backups, privacy, or ownership of the project
namespace.

Candidate private-input behavior is recorded separately in the
[agent command runtime sketch](agent-command-runtime.sketches.md); it is not a
current attachment-storage contract.

## Release History And Pre-Correction Behavior

Before this correction there was no implemented attachment storage setting.
The earlier "Configuration — v1" prose in this topic described a design that
never landed.

Stable npm releases `0.5.0`, `0.5.1`, `0.5.2`, `0.6.0`, `0.6.1`, `0.6.2`, and
`0.7.0` route uploads to `<project>/.attachments/<session>/` whenever the upload
route resolves a project path. They retain the older data-directory location
as a read fallback.

Those stable releases predate the shared managed-directory helper and do not
themselves guarantee a `.git/info/exclude` entry. Source between the `0.7.0`
tag and this correction called `ensureManagedProjectDir`, which could create
the top-level directory and append `.attachments/` to the clone-local exclude
file automatically.

Pre-session staging was already central and temporary. Before this correction,
materializing a staged file into a real session moved it into the same
project-local final location, so staging did not avoid the policy issue.

## Location Resolution

The first implementation uses the one global
`projectDirectoryStorage: "app-data" | "project"` setting from the parent
contract. There is no per-project override.

### App data only — default

Final attachments are written below:

```text
<data-dir>/projects/<project-key>/attachments/<session-id>/
```

Uploading and sending an attachment must not create `.attachments`, `.yep`, or
a Git exclusion. The provider prompt names the actual attachment path. If a
provider's filesystem policy cannot read the central path, YA explains that
limitation or requires the user to opt into project-local storage; it does not
change modes silently.

### Store YA assets with projects — explicit opt-in

Attachments may be written below the one documented YA project root. The
preferred new-write shape is:

```text
<project>/.yep/attachments/<session-id>/
```

This avoids creating another top-level hidden namespace. The implementation
may retain `.attachments/` as a compatibility read location, but must not keep
using it as an independent automatic write root merely because older versions
did.

Before the first project-local write, validate containment, reject symlinked or
already tracked managed roots, and apply the parent topic's opt-in Git-exclude
policy. A failure does not fall back by writing somewhere else inside the
project.

## Agent Delivery Contract

The delivered message includes an explicit path and small safe metadata such
as filename, MIME type, size, and image dimensions. The surrounding label must
not hard-code "files in `.attachments`" when the actual location is central or
under `.yep/attachments`.

Attachments remain provider input. They are distinct from tool-result media,
which is viewer output and is never appended automatically to a later turn.
See [Session Media Handles](session-media-handles.md).

## Read And Serve Compatibility

The narrow attachment route remains the browser-facing read boundary:

```text
GET /api/projects/:projectId/sessions/:sessionId/upload/:filename
```

It may check, in policy-defined order:

1. the current central app-data location;
2. the opted-in current project-local location; and
3. legacy `<project>/.attachments/<session>/` and legacy central paths.

A file is materialized under the session id known at upload time, which
can differ from the logical session the client is viewing. Confirmed
sources of divergence: the YA-generated provisional startup id used for a
brand-new session's first turn (the provider reports the canonical id
only after launch — see [Session ID Remap Events](session-id-remap.md)),
and an explicit session fork, whose new id inherits turns whose
attachments live under the source id. A current-version plain resume does
not rotate the id (verified 2026-08-07 against live session files:
entries carry only the filename's own `sessionId` across many resumed
turns).

Files are never moved to follow an id change: the delivered prompt names
the physical path, and a provider may re-read it at any later turn. The
persisted turn therefore also tells the browser where the file lives, and
the client derives the URL's `<session>` segment from the physical
directory in the persisted path — never from the viewed logical session
id. Persisted paths from both Windows and POSIX hosts retain this routing
identity; client parsing accepts either platform's directory separator. Only
the `<project>` segment uses logical identity, because an
app-data project key is not reversible to a URL project id. The route
performs exact lookups only; it does not search sibling session
directories.

Reading a legacy attachment never authorizes creating, refreshing, migrating,
or excluding that directory. The public response does not expose a new broad
filesystem read capability merely because physical storage moved.

Authenticated file viewers treat
`<data-dir>/projects/<project-key>/attachments/` as always readable, even
when the uploads file-access toggle is off. That path is YA-managed
attachment storage, not an arbitrary extra folder. A `Read` of an
attachment therefore opens in the same file viewer as a project file
instead of returning `400 Invalid file path`.

Public shares, frozen or live, may open the same attachment only when that
exact path appears in the share body. The viewer uses the existing
share-scoped file route and bearer secret; the client keeps
attachment-shaped `~/` or absolute paths as the share `path` instead of
dropping them as outside-project. The share still does not grant
`/etc/passwd` or other app-data files just because they were mentioned.

## Durable initial attachments

For the qualified owner Claude/Codex creation workflow, immutable input bundles
live in app-data `uploads/creation-inputs/`, outside draft staging and its TTL.
The common [creation owner](session-identity.md#selected-ownership-boundary)
commits their path-free metadata/digest claim with the accepted prompt and YA id.
Clients submit staged references, never arbitrary server file paths. Validation
uses the authenticated staging account and canonical metadata. Several batches
from that account are allowed; another account's ids confer no access.

Provider startup follows materialization under that saved YA id using the normal
location policy. Queue completion or draft cleanup cannot expire accepted bytes.
Pre-effect failure retains the claim for explicit retry; partial copies publish
atomically and equal-sized changed files refuse delivery. Profile claims are
limited to 2 GiB and 64 files per creation; refusal preserves the source draft.
Deletion releases the logical claim. Unclaimed bundles/partial directories older
than seven days are reclaimed on the first attachment creation after process
startup, with no per-session cleanup loop. Final transcript attachment retention
remains governed below. This is not an immediate deletion or periodic retention
promise.

The exact optional capability `session-creation-staged-attachments` (146), plus
the selected provider's text-creation bit, gates this request. Supported released
servers in the existing creation compatibility audit lack it, so newer clients
retain create/materialize/send there. No new staged field or acceptance claim
is sent on that fallback. An explicit `creation-not-accepted` refusal allows a
corrected submission without clearing its files or text; ambiguous failures keep
the original recovery identity. Newer unfinished file pastes also survive
acceptance of an earlier selection. Other retained launch shapes still use their existing
flow pending the consolidation ledger.

## Retention And Cleanup

Attachment retention and cleanup remain incomplete. Central storage makes a
bounded age/size policy and global cleanup practical; project-local opt-in
requires equally explicit per-project reporting and cleanup.

Changing storage mode does not move or delete existing attachments. A future
cleanup/migration action must show exact paths, sizes, and consequences before
mutation. Legacy reads remain until a separately approved compatibility
decision removes them.

## Capability Gate

The location control is part of the permanent
`project-directory-storage-policy` capability. Without it, a new client sends
no storage field and warns that the older server may write uploads into project
directories. See the parent topic for the full release corpus and absent-gate
behavior.

## Related Topics

- [Project Directory Storage](project-directory-storage.md)
- [Agent Command Runtime Sketch](agent-command-runtime.sketches.md)
- [Storage Settings](storage-settings.md)
- [Session Media Handles](session-media-handles.md)
- [Security](security.md)
- [Pre-session Attachment Staging](../docs/tactical/028-pre-session-attachment-staging.md)

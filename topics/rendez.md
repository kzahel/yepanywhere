# rendez uploads

> rendez sends files copied into a project's `.rendez` directory to a
> selected agent session, including the session most recently messaged by the user.

Topic: rendez

The YA server watches `.rendez` itself and prepares images with its bundled
`sharp` dependency; nothing else needs installing. Watching needs POSIX
symlinks: it is tested on Linux, expected to work on macOS, and unavailable on
Windows. `latest-session` follows Claude and Codex sessions. YA delivers
directly to sessions it owns and reaches others through the provider host.
Filesystem watching does not require provider hosting.

YA's watcher is an independent JavaScript/TypeScript implementation of part
of the Python `rendez` helper in
[graehl/agents](https://github.com/graehl/agents/blob/master/topics/rendezvous.md).
It speaks the same on-disk protocol, so the two read each other's records and
never resend each other's deliveries. What YA deliberately leaves to the
helper is listed under [Optional helpers outside YA](#optional-helpers-outside-ya).

## Enable monitoring

Monitoring defaults off. In **Settings → Message Delivery**, search for
`rendez`. **Watch .rendez uploads by default** sets the default for every
project. Below it, a table gives each project **On**, **Inherit** or **Off**.
It opens showing only the overrides that change behavior, which with the
default off means the projects set On. **Show all** lists every project, plus
any configured path that is no longer a project so it can be cleared, and
**All inherit** removes every override. Each change applies at once; header
Undo restores the default and every project choice from when the pane opened.
A server without the `rendez-uploads` capability shows update guidance instead
of the controls; the client sends no unsupported settings write.

Turning a project on attaches nothing by itself. Its observer, and with it the
`.rendez` directory and its Git exclusion, waits until a session in that
project accepts an actual user message after the project was turned on; a
message sent before turning it on does not count. A project whose `.rendez`
already exists attaches without waiting, so a server restart resumes watching.
Trying settings out therefore leaves no trace in any project. Turning a project
off stops its observer and keeps its files.
On servers supporting [active-compose](#attach-to-the-active-new-session-draft),
opening an eligible new-session composer also starts watching its enabled
project, without requiring a first message or an existing session.

With the `rendez-project-status` capability, each watched row also shows
**watching** while its observer runs, or **starts at your next message**
(**waiting** on narrow screens) while it waits for a message or a live session.
The pane reads `GET /api/settings/rendez/status` on open, after each change,
and every 10 seconds while it is visible. Without the capability the table
shows no status and the client makes no status request.

The optional-feature compatibility review covered stable v0.9.0, v0.9.1 and
v0.9.2, none of which has rendez code. `rendez-uploads` has permanent ID 131 and
`rendez-project-status` ID 133; both are version-implied from 0.9.4 and change
no existing capability's meaning. Before release, ID 131 was renamed from
`rendezvous-uploads` and the settings field from `rendezvous` to `rendez`; an
old `rendezvous` settings entry is ignored. The `delivery` field joined ID
131's settings contract before release, so no separate capability gates its
control; a pre-release dev server that advertises 131 without it drops the
field and keeps the old turn-end delivery. Delivered turns still carry the
message origin `rendezvous`, a persisted value shared with the provider host.

The settings and burst limits are also available through the authenticated
`PUT /api/settings` API:

```json
{
  "rendez": {
    "enabled": false,
    "projects": { "/work/project": true },
    "windowMs": 1000,
    "maxPerWindow": 10,
    "delivery": "auto"
  }
}
```

`delivery` is `auto`, `steer` or `queue`; absent means `auto`.

Set `enabled` to `true` for the global default. Each absolute project-path entry
overrides that default; omit an entry to inherit it. YA checks live projects
every 30 seconds and at each user message to a project that is on, with at
most 32 observers and 1,024 directory watches across them. Turning the setting
off stops its observers. An observer failure is logged and requires a settings
change to retry.

At most one observer serves a project. YA records itself in
`.rendez/.observer.json` while watching and removes the file when it stops. If
that file names another live observer, such as `rendez watch --turns`, YA logs
that watching is deferred and checks again every 30 seconds. A file left by a
crashed or restarted process on the same host is replaced automatically. One
left by a process on another host, for example over NFS, must be deleted once
that process is gone.

## Upload from another machine

Enable `.rendez` monitoring for the project, then send a normal message to the
session that should receive your files. The watcher creates a
`<project>/.rendez/latest-session` destination on the machine running the agent.
With SSH access to that machine, upload a screenshot from your desktop:

```bash
scp screenshot.png user@host:/work/project/.rendez/latest-session/
```

Replace `user@host` and `/work/project` with your SSH destination and project
path. This also works from Windows OpenSSH or a WSL shell. The receiving
machine watches the directory; your desktop does not need to invoke
`agentctl` or know the session id. Each completed upload appears as an
attachment in the session composer before becoming a user turn.

## Composer draft and countdown

Session-addressed uploads join the existing shared session draft, preserving
its text and attachments. With no text, incoming captures share a ten-second
auto-send countdown. Each new capture resets the active countdown; only the
latest attachment shows its countdown and progress border. Earlier attachments
look like normal attachments. The countdown sends the waiting captures together
in one message, rather than one turn per capture.
Text already in the draft, or typing before the deadline, keeps the upload
for normal Send. Erasing that text does not restart auto-send. Removing an
attachment cancels its countdown. A draft held for Send stays held when more
captures arrive; a countdown never sends only part of the draft.
Arrivals reconcile while typing instead of waiting for the normal quiet-save
debounce. In enabled projects, or with captures already visible, Send reads the shared draft
before collecting attachments, including captures received by the server whose
previews have not arrived yet. It respects deliberate removals and records the
expanded submission so successful Send clears those captures too. A concurrent
draft conflict or failed read stops Send with recovery retained. A capture
received after that collection belongs to the next draft. Existing servers
without draft synchronization retain browser-local collection.
Send consumes the attachments through the ordinary browser upload path;
untouched uploads use rendez delivery below.

The deadline belongs to the server and runs without an open browser. Text
changes and removals sync immediately while a deadline is active. The server
arbitrates manual materialization against auto-send to prevent a duplicate
at the deadline. If auto-send is refused, the attachment returns to the draft
for manual Send. Server restart retains staged attachments for manual Send;
it never replays an old countdown. Upload receipts acknowledge draft staging,
not provider acceptance or completion.

One shared next-deadline timer owns at most 256 pending uploads. Additional
uploads stay in their drafts without automatic delivery, subject to the
100-attachment draft limit and existing watcher burst limits. The client
countdown stops ticking while its tab is hidden and refreshes on return.

Compatibility review (2026-10-26): stable `v0.10.0`, `v0.10.1`, `v0.10.2`
and `v0.11.0` have staged attachment references without `rendezAutoSendAt`
or `rendezPath`. These optional draft response annotations add no endpoint
or capability requirement: absence renders the ordinary attachment chip and
keeps the server's existing immediate delivery. Clients may cancel a current
deadline with null; servers canonicalize its path and numeric deadline.
Existing clients can edit and send the shared draft; server-side text
observation also cancels the countdown when a client omits the annotations.

## Uploads during a running turn

After the composer countdown, an untouched upload takes the path and
presentation of a typed send, chosen by **Uploads during a running turn** in
the rendez card (`rendez.delivery`):

- **Steer** adds it to the current turn, as a steered message, where the
  provider supports steering, so it reaches the agent before commentary sent
  after it. Without steering support it waits for the turn's end.
- **Queue** holds it as a visible queued message that can be cancelled or
  steered from the queue until the turn ends.
- **Auto**, the default, repeats how the user last sent a message while that
  session was working, and steers before there is one. The server learns that
  from each send's delivery choice; a browser's per-session Enter toggle is
  otherwise invisible to it.

With steering disabled, as before this setting, every upload during a long
turn waited for its end and arrived merged with the others, after the
user's steered commentary about them, while each showed as already sent.
An idle session receives an upload when its countdown ends in every mode.

Delivery reaches only a live session. `latest-session` points at the session
you last messaged in the project, and nothing arrives while that session is not
live: delivery is non-reviving by default, and an inactive target is not
resumed just because another session in the project is live. Each session you
have messaged also gets its own `.rendez/<session-id>/` destination, which
delivers to that session under the same live-only rule even after you message
another one.

For repeated screenshot transfers, ordinary rsync preserves unchanged files:

```bash
rsync -a screenshots/ user@host:/work/project/.rendez/latest-session/
```

Use rsync's normal temporary-file-and-rename behavior; avoid `--inplace` and
`--append`. YA treats an upload as complete once it has not changed for one
second, so a direct `scp` that stalls longer, or is interrupted, can deliver an
incomplete file; the completed file then arrives as a new upload. rsync's final
rename avoids both. Destination files
stay in place, so subsequent rsync runs can compare size and modification time.
The watcher applies the same test: an original whose size and modification
time match its last capture is not reread, so restarts stay cheap however many
originals accumulate. A changed one is compared by content, so an unchanged
upload is never delivered twice and an overwritten name with new content is.

Uploads may sit in nested folders, such as `latest-session/123/shot.png`.
Folders are noticed when created or moved in, and each file in them is
delivered separately under its inbox-relative name. Symlinks are not followed.
rsync creates only the last component of a missing destination path, and
`--mkpath` creates its parents.

Write into `latest-session/`, never over `latest-session` itself. Until a
session in the project has been messaged, the watcher points it at
`.no-session-messaged-yet/inbox`, which never exists, so `test -d`, scp and
rsync fail instead of creating a directory nobody delivers from. After the
first user message it stays pointed at the latest session. If `latest-session`
is nevertheless an ordinary directory, which rsync creates when the pointer is
missing, nothing was listening for those files: the next user turn, or the
watcher's start, moves that directory to `.rendez/unrouted/<epoch-ms>-<id>/`
without delivering it and restores the pointer.

## Accidental bulk transfers

Upload preparation starts immediately. By default, each route admits at most ten uploads
per rolling 1,000 ms, with at most ten uploads awaiting queue acceptance across
the project. `windowMs` and `maxPerWindow` configure those limits. Acceptance
can mean staged in the draft; it does not wait for model completion.

Excess arrivals are **held**, never automatically sent later. After overload,
new arrivals remain held until four quiet windows pass (four seconds by
default). That reset applies only to future uploads. One additional message
says many files were uploaded, potentially unintentionally, and identifies the
held records under `.rendez/delivered/<route>/`. Those records include the
incoming paths and hashes; held originals are not separately archived.
Holds undo accidental high-rate placement; YA offers no way to release one.
To send a held file anyway, copy it again under a new name after the quiet
period. The `rendez` helper's manual `unhold` also works on these records.

The watcher ignores dot-prefixed temporary files and directories. Normal rsync
publishes completed files by rename; `--delay-updates` can produce a rapid burst
at the end, which these limits hold. Keep temporary files in rsync's usual
location or a hidden directory, not as non-hidden files inside the watched
inbox. [rsync manual](https://download.samba.org/pub/rsync/rsync.1)

## Choose the recipient

### Attach to the active new-session draft

Upload to `<project>/.rendez/active-compose/` to attach files to the visible
new-session composer, or use the ordinary `latest-session` destination when
there is no active composer claim. `active-compose` is a separate symlink;
neither `latest-session` nor explicit session destinations change meaning.

The server owner has one reconciled new-session draft per server, independent
of project selection. A visible ordinary new-session composer with a confirmed
project acquires its claim when opened, foregrounded, or reconnected. The last
acquisition wins across windows and devices. Renewals cannot reclaim ownership
from a newer claimant. Fork/handoff/template composers and limited accounts do
not acquire this filesystem destination.

The visible claimant renews every 15 seconds. Hiding the tab, navigating away,
changing project, starting the session, or disconnecting releases its claim.
Leaving or reloading the page sends that release as a request that outlives
the page; where the connection cannot outlive it, the lease expiry below applies.
Loss of the browser expires eligibility after 45 seconds; the shared server
cleanup sweep restores the fallback symlink within another minute. During that
cleanup delay, stale draft deliveries fail rather than reaching a session.
Window blur alone does not release it: using a screenshot tool must not change
the destination. A hidden tab does not renew, and an older visible window does
not take over merely because its renewal is due.

The project must have rendez monitoring enabled. Opening an eligible composer
can start its observer before any session exists or has received a message.
Accepted files become normal protected staging references in the shared draft;
they appear as attachments without sending a turn or creating a session.
Reconciliation can apply attachment-only changes while typing, retaining the
text and selection. Normal Send later consumes the draft attachments.

Capture fixes the claim identity. A claim that ends during preparation fails
that delivery; it never retargets the upload to another claim or session.
Existing files and delivery records stay on disk. Burst limits and held-file
behavior still apply; an overload diagnostic is recorded rather than inserted
as draft text. The internal `ya-new-session-draft` route is YA-owned and is not
a provider session or a target for the standalone helper's turn delivery.

The optional `rendez-active-compose` capability (ID 135) advertises
`POST /api/rendez/compose` with `claimId`, `projectId` (null releases), and
`acquire`. It requires POSIX watching, server settings and draft storage.
The 2026-10-24 compatibility review checked stable `v0.10.0`, `v0.10.1`,
`v0.10.2` and `v0.11.0`; none has this contract. Without the capability clients
send no claim requests. Existing session uploads and draft editing remain
available. The uploader must explicitly select the new destination.

**Separate active-compose destination** (vs. redirecting latest-session):
opening a draft must not intercept a transfer explicitly addressed to the
last-messaged or a named session.

### Session destinations

`latest-session` follows the last session accepting an actual user message in
that project. Coordination requests, takeover notices, automated turns, and
rendez uploads do not change it. Once an upload is received, its recipient
is fixed. For an ongoing transfer stream that must stay with one session, use
the stable directory returned by an explicit subscription instead.

Monitoring is opt-in, with a global default and a per-project override.
YA watches projects with a verified live session or an active new-session
compose claim. Live sessions include those known to the provider service but
not owned by YA. It attaches a project only
as [Enable monitoring](#enable-monitoring) describes. Watcher ownership is
independent: YA can use its own live-session state when provider hosting is
disabled. An explicit helper subscription can opt into revival separately.
The first creation adds `/.rendez/` to the checkout's local Git exclusions.
Disabling monitoring stops delivery without deleting the files.

## Files and attachment history

Any file type can be uploaded. An automatically sent upload becomes one user turn whose
`User uploaded files:` section is the same one browser attachments use, so YA
shows it as an attachment. The incoming file remains the original. Delivery
stores a separate snapshot under `.rendez/delivered/<route>/<delivery-id>/`.
PNG, JPEG, WebP, and GIF snapshots larger than the receiving session's
preparation profile are resized and recompressed; a GIF becomes a PNG of its
first frame. Other files are delivered as copied. A file over 64 MiB, or an
image over 64 megapixels, is not delivered and is logged.
Messages refer to this stable snapshot, so overwriting an incoming screenshot
does not change the image in an older message.

YA presents one attachment with its filename and thumbnail. The original can
be opened while its content still matches that upload; after an overwrite,
the retained prepared copy is sufficient. There is no permanent second archive
of full-size originals. Recorded snapshot paths are matched after resolving
filesystem aliases through the same file-access policy. Browser uploads keep
their existing [attachment storage policy](attachment-storage.md); enabling
rendez does not migrate them or require all attachments to share one
storage directory.

## Optional helpers outside YA

YA implements watching, delivery as user turns, burst holds and the settings
above. The Python `rendez` helper in the
[graehl/agents repository](https://github.com/graehl/agents) has more, which YA
intentionally does not reimplement. Sessions and senders that want these can
use the helper directly; its
[rendezvous topic](https://github.com/graehl/agents/blob/master/topics/rendezvous.md)
documents commands, delivery state, native-provider fallback, and the shared
protocol:

- **Acknowledged receipt for the uploader.** `ssh host rendez --project oss
  receive --wait 123/shot.png < shot.png` publishes one upload from stdin into
  the route `latest-session` points at, or `--route`. It refuses when no
  observer is listening, so YA watching must be on, and creates subfolders. A
  taken name gets `-2`, `-3` and so on, and the rename is atomic, so YA sees
  one completed file. It reports the `.rendez`-relative destination, such as
  `session-a/123/shot.png`, and with `--wait` whether YA accepted, failed or
  held the upload. A YA-served receipt route is
  [sketched](../gaps/sketches/rendez-upload-receipt-route.md).
- **In-session watching.** Inside a session, `rendez watch` receives uploads to
  that session's own `.rendez/<session-id>/` destination as tool output,
  alongside YA watching or without it. Showing that output as user turns with
  visible attachments is
  [sketched](../gaps/sketches/rendez-in-session-observer.md).
- **Watching without YA.** With YA monitoring off for a project,
  `rendez watch --turns --project <path>` serves `latest-session` and every
  other route by sending turns through the provider service. Do not run it
  while YA watches the same project; the observer marker above refuses that.
  Watching consumes no model turns while idle.
- **Releasing held uploads and reviving targets.** The helper's manual
  `unhold` releases a held upload, and an explicit helper subscription can opt
  into reviving an inactive session; YA does neither.

Broadcast subscriptions remain a future extension.

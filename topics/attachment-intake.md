# Attachment intake

> Attachment intake brings user-selected files into the existing composer
> pipeline without changing submitted text or granting the browser new native
> editor capabilities.

Topic: attachment-intake

Status: desktop file drop, desktop paste, installed-PWA image share, and session audio memo
attachment paths are implemented.

See also:

- [Attachment storage](attachment-storage.md) — durable server-side storage
  after the composer accepts and sends an attachment.
- [Composer rich input](composer-rich-input.md) — why attachments do not
  require the proposed rich editor.
- [Media rendering and routing](media-rendering-and-routing.md) — presentation
  and retrieval after intake.

## Product contract

Desktop file drops on New Session forms and existing session content use the
same attachment pipeline as the file chooser and paste. A dashed accent border
and “Drop files to attach” overlay appear only while files are dragged over the
target. The overlay follows the visible content bounds and clears on leaving,
drop, Escape, window blur, or owner retirement. It does not take keyboard focus.
Text and link dragging retain their ordinary browser behavior.

Multiple files become ordinary removable draft attachments with the existing
image preparation, upload progress and error handling. Dropping never starts a
session or sends a message. Folder drops reject the whole selection with an
error; directories are not traversed. Disabled/read-only creation forms,
pending session creation, parked sessions and the text-only /btw composer do
not accept file drops. File drops over a disabled target still prevent browser
navigation to the dropped file. No new server route or capability is required.
This established, explicitly invoked attachment affordance is always available;
it adds no idle UI and does not modify submitted text.

Desktop clipboard paste reads file items from the existing textarea paste
event and hands them to the normal pending-attachment pipeline. It does not
interpret arbitrary clipboard HTML as an attachment.

The capability-gated projects-page editor for an existing Project Queue item
uses the same file-item paste boundary and staged upload preparation. Its Save
operation may combine retained queue-owned references with newly uploaded
draft references; Discard requests cleanup of only the latter, with staging
expiry as the fallback. A server without `project-queue-attachment-editing`
keeps this editor text-only and receives no attachment mutation.

An accepted attachment is composer content even when the text field is blank.
A completed attachment can be sent without accompanying text. Completed or
still-uploading attachments make empty-draft affordances inactive; an upload
that is still in progress does not become sendable until it completes.
Direct start, resume, and queue APIs apply the same content rule. A current
client connected to an older server without
`attachment-only-session-messages` retains the draft and asks for a server
update or accompanying text instead of sending a request that server will
reject.

An installed browser progressive web app (PWA) advertises an Android image
share target. Its service worker accepts at most eight `image/*` files and at
most 64 MiB across one share. A rejected or non-image share is not persisted.
Accepted files are held in browser-local IndexedDB for at most one hour; at
most four pending share records are retained, with the oldest record evicted
first.

The share target redirects to the most recently open session, including a
session hidden by the Android share sheet. When no session is open, it opens
New Session in the most recent client's direct or relay context. The redirect
carries only an opaque browser-local share id.

The mounted composer reads the record without consuming it, offers the files
to the same attachment pipeline as ordinary paste, and deletes the record only
after that consumer accepts them. Navigation or unmount before handoff, and a
consumer rejection, retain the record until its normal expiry or capacity
eviction. This deliberately prefers a possible duplicate retry to silent data
loss. The one-shot URL parameter is removed after accepted handoff or after an
error has been surfaced, so a failed render does not loop indefinitely.

Android keyboard image insertion is a separate native-editor contract. Gboard
uses `InputConnection.commitContent`, whose accepted MIME types come from a
native view's `EditorInfo`; browser JavaScript cannot add those MIME types to a
textarea. YA therefore does not claim keyboard image insertion as a supported
web path.

## Image upload quality

**Settings → Message Delivery → Image upload quality** controls future browser
attachments. Search for SD, HD, image, screenshot, resize, compression or
resolution. The existing browser-local preference stays SD by default; changes
also reach already-open composers in other tabs. Pane Undo restores the value
from when the pane opened. This is separate from server-side `.rendez` watching.

SD preserves up to 2000 px on the long edge where the selected model supports
it, replacing the former fixed 1024 px cap. HD uses the adapter's upper target.
Neither enlarges a small image. The current profiles are:

| Session capability | SD | HD | Encoded file budget |
| --- | --- | --- | --- |
| Known Claude 4.7+ model, including resolved aliases | 2000 px | 2576 px | 3 MiB |
| Older or unresolved Claude model | 1568 px | 1568 px | 3 MiB |
| Codex harness | 2000 px | 2048 px | 4 MiB |
| Other adapters | 2000 px | 2000 px | 4 MiB |

JPEG/WebP encoding uses quality 90 for SD and 95 for HD when preparation is
needed. PNG remains lossless. Images within both limits retain their bytes;
oversized files are resized, then reduced further if necessary to meet the
byte budget. Decode/encode failure prevents upload and surfaces an error.
Non-images and unsupported image formats keep the ordinary file path; browsers
without `createImageBitmap` retain the original-file fallback. Existing staged
attachments are not reprocessed after a setting or model change. For New
Session and Project Queue, the model selected when attaching determines the
profile; a later launch-target change cannot recover discarded detail.

The model may also downscale for its pixel/patch budget. HD does not request
OpenAI `original` detail: the current Codex path is bounded to 2048 px.
[OpenAI's image guide](https://developers.openai.com/api/docs/guides/images-vision)
and the pinned Codex image utility distinguish that path from 6000 px original
detail. [Claude's vision guide](https://platform.claude.com/docs/en/build-with-claude/vision)
defines the 1568/2576 px tiers; large histories with more than 20 images may
require 2000 px or smaller, so SD is the general-purpose default.

`GET /api/providers` and `GET /api/providers/:name` expose optional
`imageSizing.profiles` on each provider and model. A model profile overrides
the provider profile; the browser contains no model catalogue. Both values
come from `services/image-preparation.mjs`, also used by the provider host's
`imagePreparationProfile` for filesystem delivery (SD using its launch model).
No extra request is made per attachment.

Compatibility review, 2026-10-18: stable v0.9.1 and v0.9.2 have the existing
provider queries and optional `imageSizing` guidance, but no profiles. Field
presence gates the extension; absent profiles use legacy sizing guidance,
or 2000 px when unavailable, with a 3 MiB preparation budget. No new endpoint,
request field, or capability meaning is introduced. Standing maintainer
compatibility approval applies.

## Design decisions

- **Adapter-owned preparation profiles** (vs. browser model tables or a new
  per-upload probe): existing provider discovery carries the same policy used
  by filesystem delivery. The client selects by the current model and resizes
  before transferring bytes.

- **Independent memo capture with a disposable ASR subscriber** (vs. saving
  the dictation provider's input): transcript toggles must not control the
  original audio, and the attachment must remain 24 kHz even when STT uses
  16 kHz. Streaming STT owns cloned tracks; deferred STT reads the finished WAV.
- **Ordinary file delivery** (vs. a new native-audio provider contract): the
  existing attachment route exposes the recording to model tools without
  implying that every selected model natively understands audio.
- Use the PWA share target and existing attachment pipeline rather than a
  server upload endpoint. The service worker needs no YA session authority and
  the composer remains the acceptance boundary.
- Bound both records and retained payload size. A small record-count cap alone
  does not bound IndexedDB consumption when one share contains many or very
  large images.
- Separate read from acknowledgement. IndexedDB transaction completion proves
  only that bytes were read, not that the composer retained them.

## Observable checks

- A valid image share redirects with one opaque `__ya_share` id and becomes
  pending composer files.
- A ninth file, more than 64 MiB total, or a share with no image receives an
  error response and creates no record.
- A pending record remains readable until the consumer resolves acceptance;
  explicit acknowledgement makes a later read empty.
- An open relay session keeps its relay path and existing query parameters;
  otherwise New Session opens in the same relay context.
- Desktop file paste and PWA share intake converge on the same pending-file
  behavior.
- Project Queue inline paste preserves, adds, and removes queued attachments in
  one update when advertised, while the absent-capability path stays text-only.
- Direct start, resume, and queue requests accept empty text with a completed
  attachment; an older server receives no such unsupported request.

## Audio memo attachments

The new-session and existing session composers can record a microphone memo as a
mono 24 kHz signed PCM16 WAV. Desktop Attach opens the file chooser;
Shift-click records. Touch Attach opens **Share to session**. Right-click and
long-press open the same menu on small/coarse-pointer screens, including the
toolbar Hide action. On fine-pointer screens at least 900 px wide, right-click
opens the shared attachment panel. Recents start collapsed; Record audio memo
and Choose files sit at the bottom, next to the composer. The session panel
always targets the current session. New Session's alternate Attach panel also
offers recording, and Shift-click starts it directly. Toolbar
settings can override the device-local primary action with files, menu, or
recording. The alternate is recording, except when recording is primary, when
it is files. In an existing session, Ctrl+Shift+Space starts a memo or stops
and sends the current take.
Ordinary microphone dictation remains separate.
The memo shortcut checks its key combination before reading composer visibility;
ordinary typing must not force layout for that unrelated shortcut.

In New Session, the recording surface says **Tap here to stop & start session**.
It creates the session, uploads the WAV, then submits the typed draft and
optional transcript as the first turn. Upload failure retains the take for
retry; Cancel preserves the typed draft and removes the pending take.

The large waveform surface, captioned **Tap anywhere here to stop & send**,
commits the take. Restart discards the take and begins again; Cancel discards
it and preserves typed text. Capture readiness follows real audio frames.
Microphone denial, interruption and missing frames surface errors. Capture is
bounded to ten minutes; interruption or the limit retains the stopped take for
explicit retry rather than sending it automatically.

**Include transcript** defaults on, as explicitly requested for this flow,
and persists within the browser window. It uses the selected available server
or direct Grok STT backend; browser-native dictation cannot transcribe a saved
recording and is not silently replaced with another backend. When unavailable,
the user can select an STT backend or turn the checkbox off to send audio only.
Streaming previews are draft feedback. Turning off discards the transcript
and disposes its subscriber while recording continues. Turning back on defers
whole-recording transcription until stop. Smart Turn and spoken commands never
commit, cancel, or strip words from a memo.

Normal stop requires no second Send. Transcription and upload settle before
the ordinary session submission. A transcription or upload failure retains
the take for retry, with transcript-off available to omit a failed ASR result.
The original WAV is always attached. Transcribed words become a separately
labeled `🎤 Audio transcript` suffix after typed text; audio-only turns with no
typed text use `🎤 Audio memo`, so existing servers receive nonempty text.
The outgoing text is retained in the composer's existing recovery draft until
the session confirms delivery. No new server route or capability is required.

Verification covers actual browser audio capture, WAV header/sample encoding,
ASR disposal without microphone loss, deferred whole-recording transcription,
Cancel preserving typed text, upload failure/retry, and a session request with
the uploaded WAV and transcript suffix. Browser coverage uses Chromium with
fake microphone hardware and mocked STT; real phones and vendor recognition
quality are not established by those checks.

The transcription plan is selected when microphone acquisition completes, so
streaming backend metadata that arrives during permission/startup is honored
without restarting the recording. Cancelling during acquisition must not start
a late transcription subscriber.

Held recording and playback/monitor capture remain separate follow-ups:
[hold gesture](../gaps/sketches/audio-memo-hold-to-record.md) and
[source selector](../gaps/sketches/audio-memo-source-selection.md).

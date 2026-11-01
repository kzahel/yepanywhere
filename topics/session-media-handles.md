# Session Media Handles

> Replace inline transcript media with authenticated, lazy server handles
> without making persistent copies by default. Durable tool-result preservation
> is a separate default-off feature whose location follows the global
> project-directory storage policy.

Topic: session-media-handles

Parent storage contract:
[Project Directory Storage](project-directory-storage.md).

Settings surface: [Storage Settings](storage-settings.md).

Status: corrected in current source after `0.7.0`; no stable npm release
contains media handles or the preservation policy yet. The permanent
capability declares `0.7.1` as its first complete release.

Use this document before changing provider message normalization, session
detail REST payloads, transcript media renderers, image-bearing tool results,
public share transcript capture, or the session-detail ingest boundary.

## Problem

Provider transcripts legitimately store binary media as JSON strings. Codex
uses `data:image/...;base64,...` URLs in session JSONL; Claude-style messages
can carry `{ type: "image", source: { type: "base64", data } }`; structured
image results can carry data URLs or path-only references.

Sending that representation through every YA session-detail response is
expensive:

- the response pays full image size even if the user never expands it;
- relay traffic carries the bytes as part of the encrypted JSON body;
- the browser retains large UTF-16 base64 strings in transcript caches; and
- presentation varies across provider formats.

That performance problem requires lazy media delivery. It does not require YA
to preserve another durable copy of every image, and it does not authorize a
project write.

## Separate Decisions

Three concerns must remain independent:

1. **Lazy delivery:** replace inline bytes in the client-facing transcript with
   metadata plus an opaque authenticated handle.
2. **Durable preservation:** retain bytes that might otherwise disappear, such
   as a path-only result in `/tmp`. This is a user-visible data-retention
   feature and defaults off.
3. **Storage location:** if preservation is enabled, use app-data storage by
   default or the project only after the separate global project-local opt-in.

Calling preservation a cache or implementation detail does not change its
retention semantics.

## Default Lazy Handle Model

During session materialization, the server detects media, validates the safe
raster type, removes inline base64 from the client-facing payload, and builds
a size- and lifetime-bounded process-memory catalog behind an opaque media id.
The browser receives metadata and fetches the bytes only when the image is
viewed. The transient response is `no-store` and creates no disk entry.

If a transient handle expires, rematerializing the provider-owned session can
rebuild it while the source remains available. Persistent indexing or a disk
read-through cache is an optional optimization only after measurements justify
it; neither exists in the first implementation.

Live output can arrive before provider persistence catches up. Default
on-demand mode uses the same bounded process-memory catalog. With preservation
explicitly enabled, a newly emitted result also crosses into the durable store
at this live managed-session boundary.

A path-only result is available while its permitted source path exists. When
the source disappears and preservation was not enabled, the media ref becomes
unavailable with an explicit reason. YA does not snapshot it silently.

For a bound Grok session, native image/video permission resolves the recorded
root, original project and actual native directory. A YA id or moved working
project is never substituted into a native path. Media handles are fetchable
under the effective working project even when that existing directory contains
no provider transcripts. This does not widen session grants or foreign-root
file permission; [Grok's source contract](grok.md#native-source-identity-and-observation)
owns the native address.

## Session-detail projection boundary

Provider normalization may carry extracted inline bytes as private ingest
metadata while keeping them out of ordinary enumerable message fields. The
authenticated session-detail route must consume that metadata after selecting
the authorized history window and before any generic clone, serialization, or
projection step that retains only public fields. A `stored` descriptor returned
by session detail must already name a fetchable entry in the media catalog.

Historical materialization is copy-on-write. It may return replacement
tool-result messages, but it must not mutate provider-reader or normalization
caches. After materialization, the route detaches the small descriptor-bearing
window before task pruning, Markdown augmentation, or any other response-only
mutation. This ordering both preserves cache isolation and keeps inline base64
out of the detached clone.

Route-level regression coverage must exercise the complete persisted path:
provider entry normalization, private candidate consumption, response
detachment, session-detail serialization, and a byte fetch through the returned
media handle. A direct normalizer-to-materializer test alone does not cover the
projection boundary.

## Public Shape And Fetch Route

Session responses contain presentation metadata and handles, never retained
base64 payloads:

```ts
type TranscriptMediaRef =
  | {
      state: "available";
      toolCallId: string;
      id: string;
      mimeType: string;
      byteLength: number;
      width?: number;
      height?: number;
      filename?: string;
    }
  | {
      state: "unavailable";
      toolCallId: string;
      reason:
        | "invalid-image-data"
        | "source-unavailable"
        | "storage-unavailable"
        | "too-large"
        | "unsupported-media";
      filename?: string;
      claimedMimeType?: string;
    };
```

The exact migration from the current `stored`/`rejected` names is an
implementation compatibility detail. The invariant is that a handle does not
promise or imply that YA made a durable copy.

The authenticated route remains:

```text
GET /api/projects/:projectId/sessions/:sessionId/media/:mediaId
```

The client fetches through the active source transport:

- direct mode: credentialed HTTP fetch;
- relay mode: `connection.fetchBlob(path)`, then `URL.createObjectURL(blob)`.

Collapsed media rows fetch no bytes. Expanded rows lazily fetch and render an
object URL. Do not render a bare `/api/...` URL directly in `<img>` because a
relay-origin page does not share the server origin.

## Client image action contract

An opaque media handle gives the client authenticated bytes plus presentation
metadata; it does not give the image a filesystem identity. The shared image
menu therefore always derives actions from capabilities:

- a fetchable handle supports Open, Download, and Copy image;
- a stable viewer link is absent because the raw media route is not an
  application viewer and a transient object URL is not durable;
- an inline/data-backed result has no path merely because the server decoded
  it into a transient handle or preserved content-addressed blob; and
- a single path-backed `ViewImage`/`ImageView`/image `Read` result may use the
  already-visible tool-input path client-side when it unambiguously describes
  that result. Multiple media items never inherit one guessed path.

The server catalog may retain `originalPath` to re-open a permitted path, but
that internal locator and any app-data or project-local preservation path are
not client-facing coordinates. Public shares continue to omit host absolute
paths. Any future public `sourcePath` field needs an explicit capability,
authenticated/public-share redaction rules, and a clear distinction between
the source file and the captured image bytes.

## Optional Durable Preservation

Durable tool-result preservation is default-off and requires a dedicated
setting. Enabling project-local storage alone does not enable it.

The setting is
`toolResultMediaPreservation: "on-demand" | "preserve"`, defaulting to
`"on-demand"`. When preservation is enabled, capture the authoritative returned
bytes for new results emitted while YA is managing a session; use a permitted
source path only for a path-only result. Capture happens at the live
tool-result boundary even when no client is connected so temporary sources do
not disappear first. Validate file signatures, reject script-capable formats
such as SVG, record safe metadata, and content-address identical bytes. Blob
and catalog writes remain atomic and hash-verified.

Preservation is not a historical read-through cache:

- enabling it starts no scan, import, migration, or backfill;
- provider replay and persisted history are not new results;
- session-detail loads, pagination, and image fetches never create preserved
  copies;
- disabling it stops later captures without deleting prior copies; and
- a provider that cannot distinguish new output from replay cannot implement
  preservation by treating replay as new output.

Physical location follows the global policy:

- **App data only:**
  `<data-dir>/projects/<project-key>/tool-results/<session-id>/`;
- **Store YA assets with projects:**
  `<project>/.yep/tool-results/<session-id>/` after explicit opt-in and safety
  checks.

Preservation has no automatic age limit, size eviction, garbage collection, or
pruning. It may grow without bound, and the Settings copy states that plainly.
On disk pressure or write failure, YA does not interrupt the provider turn,
delete an older copy, or silently change location; it keeps any still-available
transient on-demand handle.

There is no persistent server disk-cache mode in v1. If measurements later
justify avoiding cold transcript scans or repeated decoding, a bounded cache
with eviction is separate product work and a separate remotely advertised
capability. It is not implemented by weakening the preservation promise.

Preserved tool output is viewer state, not provider input. It is never listed
as an attachment or supplied automatically to a later turn.

## Pre-Correction Implementation Audit — 2026-08-03

Commit `800a4598` replaced the earlier lazy-locator proposal with unconditional
materialization below `<project>/.yep/tool-results/<session-id>/`. It captures
both live results and images encountered while reading durable session history.
There is no setting and no automatic retention or garbage collection.

Observed in one project after seven days of current-source use:

- 352 image blobs: 342 PNG and 10 JPEG files;
- 391 small catalog records;
- 258.8 MiB of blobs across five Codex sessions; and
- most path-backed captures copied from `/tmp` or `/private/tmp`.

The originating implementation commit explicitly listed automatic retention
and garbage collection as deferred. This growth satisfies the documented
trigger for revisiting that decision.

No stable npm release contains the audited implementation: the latest stable
release, `0.7.0`, predates `800a4598`. Existing source checkouts after that tag
may already contain `.yep/tool-results` data. The current correction leaves
those files in place and reads them only as a compatibility source.

## Legacy Data And Upgrade Behavior

The policy correction does not delete, migrate, rehash, or add exclusions for
existing `.yep/tool-results` during upgrade. In app-data mode the server may
read legacy project-local records for compatibility, but it does not refresh,
repair, or grow them.

Any later cleanup or historical-import action is separate explicit product
work. The first correction does not add one.

## Metadata And Layout

The server extracts cheap safe metadata while replacing payloads:

- MIME type from validated signatures rather than extension claims;
- decoded byte length and a content hash;
- dimensions for PNG, JPEG, GIF, and WebP where practical; and
- a safe filename from provider metadata or a stable synthetic name.

Known dimensions reserve bounded layout space. Unknown dimensions use a
bounded loading placeholder. The browser-local inline-expansion preference
remains default-off and does not alter storage or preservation policy.

## Security Contract

Media fetches must:

- use the same authenticated session access check as the transcript;
- never accept a client-supplied filesystem path;
- use opaque ids mapped server-side;
- validate source containment and returned bytes;
- send accurate `Content-Type` and `X-Content-Type-Options: nosniff`;
- reject script-capable media without an explicit safe rendering path; and
- work over the encrypted relay request channel.

Public shares require a share-scoped media manifest. A raw session id plus
media id never grants public access.

## Non-Goals

- Do not rewrite provider-owned JSONL as the first correction.
- Do not expose line numbers, byte offsets, JSON pointers, host paths, or
  `.yep` paths as public media identifiers.
- Do not move conversion to the browser; that still transfers the base64.
- Do not make inline expansion default-on.
- Do not treat huge non-media output such as stdout as part of this policy.
- Do not expose a preservation blob path as the image's absolute file path.
- Do not label the authenticated byte route as a stable viewer link.

## Possible server-backed refinements

- Add a stable application viewer coordinate for session media whose access
  and lifetime are explicit, relay-safe, and share-aware. Keep the existing raw
  media route as a byte response rather than retroactively changing its
  meaning.
- If tool input cannot identify a path-backed image, add an optional semantic
  source coordinate to authenticated metadata. Gate it as a new capability,
  omit it for inline data, and redact host paths from public shares.
- If measurements show repeated decoding or relay fetches are material, add a
  bounded read-through cache independently from durable preservation. It needs
  byte and age eviction, source-runtime/session scoping, and no project writes
  by default.
- Consider conditional fetch metadata such as an immutable content hash or
  ETag for preserved blobs so repeated clients can validate safely without
  promising that transient on-demand handles are durable.

## Acceptance

In the default configuration, loading live or historical image-bearing
sessions leaves the project tree and Git metadata unchanged and creates no
durable media copy. An expired transient handle can be rebuilt by
rematerializing provider persistence; the descriptor returned by that reload
is immediately fetchable. An expired path-only image may report unavailable.

With preservation explicitly enabled, tests cover new results emitted by
managed sessions with and without a connected client, provider replay
rejection, absence of historical-read writes, configured location, content
deduplication, corruption handling, write failure, direct/relay fetches, and
transition from live temporary bytes to provider-backed or preserved media.

## Related Topics

- [Project Directory Storage](project-directory-storage.md)
- [Storage Settings](storage-settings.md)
- [Attachment Storage](attachment-storage.md)
- [Media Rendering And Routing](media-rendering-and-routing.md)
- [Server Capabilities](server-capabilities.md)

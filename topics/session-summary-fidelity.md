# Session Summary Fidelity

> Session list projections are bounded, partial facts. They may enrich list
> surfaces and normalized client records, but they must never masquerade as a
> complete transcript summary or advance the full-summary cache's freshness.

Topic: session-summary-fidelity

See also:

- [`client-global-store.md`](client-global-store.md)
- [`inbox.md`](inbox.md)
- [`session-catalog-observation.md`](session-catalog-observation.md)
- [`session-index-validation.md`](session-index-validation.md)
- [`codex-metadata-scanner.md`](codex-metadata-scanner.md)

## Summary classes

`SessionSummary` is the complete server summary contract for one transcript
version. Required fields such as `messageCount` describe the whole transcript;
tail-derived fields such as context usage, current model, and recent agent text
are present when the provider can derive them.

`SessionListSummary` is a bounded projection for collection routes that need
only identity, title, provider, recency, and optional user-owned list
decorations:

- `id`;
- `projectId`;
- `title`;
- `fullTitle`;
- `updatedAt`;
- `provider`;
- `asyncQuestions` when independently observed within its bounded recent
  window, including an explicit indication of omitted history;
- `customTitle`, `isArchived`, and `isStarred` when an upstream enrichment
  already supplied them.

Unknown full-summary values are absent from the list type. A list reader must
not manufacture placeholder counts or expose an early model as though it were
the current model. Providers may obtain the projection from native metadata, a
bounded transcript-head read, or a complete summary that is already known
fresh.

List `updatedAt` is provider activity recency, not necessarily a literal file
modification timestamp. Plain Codex rollouts on Windows use the later of file
modification and change time because the last-write timestamp may remain stale
while Codex holds its append handle open. YA-owned collection rows may advance
further to the live process's later message time. These recency overlays do not
claim that message count, model, context usage, or tail text were re-observed.

## Reader and index contract

A readable Claude transcript containing only setup or system records is a real
session with zero conversation messages. Complete summaries and session detail
must remain available with a null title when no user prompt exists; supported
system records remain available through the normal transcript path. Zero
conversation messages alone must not produce `Session not found`. Existing
negative Claude summary-cache entries are revalidated on load. Missing or
unreadable transcripts retain their existing failure behavior.

Claude `informational` system records with nonblank text render in the ordinary
transcript as historical system notices, even without conversation messages.
Warning-level notices use the existing warning styling; other levels use a
neutral information notice. Provider text and source timestamps are preserved,
using the transcript's normal message-age display. These records do not create
persistent current-status banners. Setup records without displayable text stay
hidden.

A provider that implements a lightweight list-summary reader must bound its
work independently of transcript tail size. Reading enough head data to find
stable metadata and the first user title is allowed; scanning to EOF merely to
populate fields outside `SessionListSummary` is not.

Codex question previews read bounded head metadata and at most the final 2 MiB,
not a full parse. They stop at 128 questions or 32 subsequent user turns and
retain only 320-character preview titles. A process-wide, source-versioned
single-flight cache retains at most 8 MiB of preview results and rejects a
result when the rollout's stat version changes during the read. Compressed
rollouts leave this optional projection unknown. A fresh indexed Codex row
without the projection supplies its base facts to the lightweight reader, which
acquires the question preview without rereading the transcript head. Dirty or
stat-mismatched rows cannot supply this hint. Neither this acquisition nor its
cache advances complete-summary freshness or rewrites the complete index. The
observable discovery and omission semantics live in
[`provider-output-contract.md`](provider-output-contract.md#discovery-from-inbox-and-session-navigation).

Reference-backed forks and reverted rollouts mark inherited history as omitted
when the leaf has not established that it is older than 32 user turns. A short
leaf with no local questions therefore cannot claim a complete empty inventory.
The preview does not traverse ancestors; the logical detail reader still
recovers inherited questions. This preserves bounded collection reads at the
cost of leaving inherited questions out of the bounded preview.

The persisted session-summary index remains a complete-summary cache:

- a fresh complete row may be projected down to `SessionListSummary`;
- a dirty or stat-mismatched row may fall back to the lightweight reader;
- a lightweight result must not replace the complete row;
- a lightweight result must not update the row's indexed byte count, file
  mtime, or any equivalent "fully summarized through here" marker;
- serving a lightweight collection must not clear watcher dirty state needed
  by a later complete-summary consumer.

Complete summaries are durable rows in the server's required SQLite database.
Their retention does not expire. For compact-tail detail reads only, an indexed
prefix may supply head-derived facts even while a watcher has marked the row
dirty, provided stat validation proves the file is unchanged or has grown under
the existing append-only rule. That permission does not clear dirty state,
advance complete-summary freshness, or publish old counts as newly observed.
A shrunk file or a same-size file with a changed mtime cannot supply this hint.
Tail-derived model/context facts are refreshed from the requested source window.

In retained collection mode, acquiring a Codex base row explicitly defers the
question projection. The catalog publishes base rows first, then reads optional
previews for non-archived sessions. Exact retained rows need no repeated head
read. Claude titles use a bounded 256 KiB prefix; native providers may remain at
identity fidelity when they have no cheap title. Unknown title/full-prompt,
message count, and tail detail fields are omitted from retained responses.
Known client details survive these partial observations.

These bounds are per session, not per reader, so a reader that fronts several
authoritative roots — a sandboxed Codex project's private root alongside the
global one — hands the indexed base row and the question deferral to every root
it asks. A wrapper that answers with fewer arguments than it received silently
puts its own projects back on an unbounded question read while every other
project keeps the bound.

On the existing complete-request path, providers without a lightweight reader
retain their existing complete-summary
fallback. This preserves provider behavior while allowing providers with large
append-only transcripts to opt into bounded list work.

## Partial observation contract

REST collection projections and activity events are field patches when reduced
into the client summary store:

- an omitted field preserves an existing value;
- `undefined` means "not observed", not "clear this field";
- an explicit nullable value may clear only a field whose event or snapshot
  contract defines that meaning;
- a newer low-fidelity observation must not replace a known complete value with
  a placeholder or approximation;
- observing a newer `updatedAt` does not imply that message count, model,
  context usage, or recent-agent text were observed at the same fidelity.

Producers must therefore construct patches by selecting known fields. They must
not spread a list projection over a complete summary and must not copy values
from a compatibility-shaped head result into complete-summary event fields.

`ExternalSessionTracker` follows the same rule. Codex file changes use the
bounded list reader and may emit title, `updatedAt`, and observed question
previews; they do not emit
message count, model, context usage, or recent-agent text. The owned Codex SDK
and later complete-summary reads remain authoritative for those fields.
Providers whose tracker read is complete may continue emitting their exact
fields.

## Inbox behavior

Inbox needs title and transcript recency for filtering, tiering, sorting, and
unread checks. It does not require message count, model, context usage, or
recent-agent text.

Its optional model/thinking badge reads live process state or saved launch
settings, independently of this list projection. It does not parse a transcript
or promote a requested launch alias into a complete summary's reported model.

For providers with a lightweight list reader, an Inbox refresh:

- reuses a complete indexed row only when that row is still fresh;
- otherwise reads the bounded list projection;
- does not wait for a full parse of a changed large transcript;
- does not alter what later complete-summary consumers receive.

Global Sessions, project session lists, Inbox, process labels, and other
collection surfaces should read the retained compact catalog described in
[`session-catalog-observation.md`](session-catalog-observation.md). They may
project a fresh complete index row but must not require one. Explicit session
detail and features whose contract names complete-summary fields keep using the
complete index path.

## Cleanup ledger

| Area | Current compatibility | Desired direction | Trigger |
| --- | --- | --- | --- |
| Head reads | Production bounded consumers use `SessionListSummary`; Codex retains `readMode: "head"` only inside its typed adapter and direct parser tests. | Retire the compatibility-shaped reader option when no external/internal test contract needs it. | Changing the Codex summary reader API. |
| Activity events | Codex external tracking emits only list-known title/recency and bounded question previews; complete index and non-Codex tracker events retain exact fields. | Use dedicated discovery/list events if another producer cannot provide the complete `session-created` shape. | Adding a partial session-creation producer. |
| Client freshness | Content fields currently share a coarse observation timestamp. | Split freshness by field or fidelity if independent producers begin updating overlapping content fields at materially different precision. | Evidence of a newer partial field blocking a valid richer update. |

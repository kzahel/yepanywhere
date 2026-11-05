# Provider Child Sessions

> Provider child sessions are provider-launched units of delegated work that YA
> discovers from provider persistence and displays beneath their canonical YA
> parent session without promoting provider-native child IDs into YA session IDs.

Topic: provider-child-sessions

Related topics: [provider-session-tree](provider-session-tree.md),
[session-detail-data-layer](session-detail-data-layer.md),
[vanilla-defaults](vanilla-defaults.md),
[codex-sessions](codex-sessions.md)

The [durable relationship contract](session-relationships.md) selects a shared
SQL model coordinating native children, trusted v0 creator links, forks,
`/btw` and other relationships. [Plan 176](../docs/tactical/176-durable-session-relationships.md)
tracks migrated sources and remaining qualification. Claude, Codex, Grok and OpenCode application reads
use this durable model; retained provider paths are described below.

## Identity contract

The parent YA URL session ID remains canonical. Claude child transcript IDs and
Codex child thread IDs are provider-native handles used to find child content;
they must not become top-level `AppSessionSummary` rows, URL session IDs, or
process identities merely to make the child visible.

This differs from a provider session tree. A tree projects parent links within
one provider transcript. Provider child sessions are separately executed work
launched by a parent tool call, possibly with their own provider transcript.
They also differ from YA-owned `/btw` asides, which are real YA sessions with
their own canonical YA session IDs.

`ProviderChildSessionSummary` is the shared navigation shape. It carries the
provider-native child ID, canonical parent ID, launch tool-call ID and provider
description/type when available. `ISessionReader.listProviderChildSessions`
is the provider boundary that supplies native summaries. Application process,
collection and detail projections resolve the bound native parent/root once and
replace the returned parent id with the canonical YA id. Stored unbound parents
do not enumerate an ambient same-string native parent; child handles remain
native beneath the public parent-scoped `/agents/:child` route.

## Provider persistence

Claude's current SDK stores child JSONL and metadata sidecars below
`<native project session dir>/<native parent session id>/subagents/`. The metadata sidecar
is authoritative for `toolUseId`, description, agent type, and spawn depth.
The older project-level `subagents/` and `agent-*.jsonl` layouts remain readable
for inline transcript compatibility, but do not provide enough parent scope for
the navigation summary contract.

Claude's SQL acquisition reads only the exact physical parent's directory and
bounded metadata sidecars (64 KiB each), never the parent or child JSONL body.
Native children keep the physical `subagents` directory as their identity
scope. A failed or missing parent is unavailable, while an existing parent
without child files can establish an empty observation. Missing or malformed
optional metadata makes the observation partial and preserves previously
accepted titles and launch anchors. Scope ownership must survive merged
readers, including nested merges; a failure in the selected scope cannot fall
through to another root containing the same native id.

This directory proves ownership by the native session. `spawnDepth` is display
metadata; it does not by itself prove which internal agent launched another
agent. Deeper actor-to-actor nesting needs independent native evidence and
remains unqualified by the direct-child scenario.

Codex stores a child as a separate rollout. Its own immediate-parent header
proves structure, with bounded nickname/role/depth metadata. Current v2 native
`SubAgentActivity` start records correlate the launch call with the child id;
older `spawn_agent` outputs also carry a native id. Review/compaction and
internal delegates remain outside the qualified navigation source. Those records enrich launch
anchors, but copied fork history alone cannot establish parenting. Child
rollouts remain excluded from top-level session and project counts.

Grok stores `SubagentMeta` at
`<parent session dir>/subagents/<id>/meta.json` and a sibling child session
directory under the same encoded cwd. `child_session_id` equals `subagent_id`.
`GrokSessionReader.listProviderChildSessions` reads only those metas.
`getAgentSession` replays the child's `updates.jsonl`. Those child ids are
excluded from Grok top-level `listSessions` / `listSessionFiles`. Fork
`parent_session_id` on `summary.json` is not a subagent link.

Grok application enrichment uses the durable SQL source. Its explicit sidecar
parent/child ids must agree with the physical parent's canonical native header;
failed, oversized or copied mismatching metadata never establishes an empty
set or a new parent. The [Grok owner](grok.md#native-source-identity-and-observation)
defines its bounded acquisition and internal watcher channel. Existing legacy
top-level child exclusion still has its native metadata reader; migrating that
consumer is separate from nonblocking enrichment.

OpenCode application enrichment also reads accepted SQL facts immediately.
Its native 1.x `session.parent_id` proves the immediate parent; copied Task
parts and native fork history do not. One read-only statement acquires the
selected parent, descendants and necessary ancestors from a committed native
SQLite snapshot. A WAL-only change is visible without a changed main-file
mtime. Legacy JSON headers remain readable in their existing native namespace;
current database rows take precedence over frozen headers for the same id.
Missing/unreadable stores never establish an empty observation. Older schemas
without parent ids and malformed/cyclic metadata remain partial. Independently
valid siblings can still be accepted, and source loss preserves history.
Descendants keep their immediate parents rather than being flattened beneath
the viewed root. The [OpenCode owner](opencode-backend.md#durable-child-relationships)
defines bounded legacy acquisition and native observation.

## Presentation contract

Every reader returns children most recently active first, through the one
`sortProviderChildSessions` owner in `sessions/types.ts`; a merged reader
re-sorts across roots rather than concatenating per-root runs. Surfaces present
that order as given.

Provider child summaries are nested beneath the parent process on **Agents**.
Session-list cards repeat the child descriptions. A compact sidebar row keeps
its number-only count pill and, only when children exist, adds a disclosure
button. The outline is collapsed by default; expanding it renders child
title/type links beneath the parent without navigating the parent row.

The outline is a dense sub-list, not a second session list. Its row height,
the disclosure chevron, the overlay menu, and the unread dot all derive from
`--sidebar-row-min-height`, so a session with subagents is exactly as tall as
its siblings in either sidebar density. The indent is shallow, and the gutter
it creates carries a per-row activity rail: the freshest sibling is accented
and full height, siblings within five minutes of it are half-tinted, and older
ones stay muted. Those levels are relative to the freshest sibling rather than
the wall clock, so the rail repaints only when the summaries change and needs
no per-minute timer. The row title carries the absolute age. The
pill's tooltip begins with an explicit "N provider subagent(s)" label, followed
by the child descriptions. The pill uses ordinary sidebar text sizing and
retains a visible gap before the project label; neither glyph density nor title
truncation may make the count or project name overlap. A read row uses a quiet
grey pill; the existing session unread state strengthens its fill and weight,
then viewing the session settles it again without a separate child-count
acknowledgement state.

The parent session header shows one compact control when children exist. It
shows the total alone when none are recently active, or `active/total` when at
least one is. Recently active means the parent process is `in-turn` and that
child's transcript mtime is within the last three minutes. Existing process and
session events refresh the summaries; a bounded client clock recalculates the
age once per minute without polling provider transcripts or adding a server
contract.

Activating the header control opens the session's shared managed-detail window.
A menu selects the child whose read-only transcript is shown, and an action
opens that selected child in a new tab. The same session-level host, modal,
composer controller, and open / parked / closed lifecycle used by file and tool
activity viewers own the window. Parking preserves the mounted selector,
loaded transcript, scroll position, and other local state; the header control or
composer controller restores it, while close destroys it. The prior full-width
strip between the session header and transcript is absent, so it cannot obscure
older-message pagination.

Child links on Agents, session-list cards, the compact sidebar outline, and the
Task / spawn-agent "Open" control navigate to the read-only nested page
`/projects/:projectId/sessions/:sessionId/agents/:agentId`. That page and the
managed window share the existing `GET .../agents/:agentId` loader and transcript
renderer. Neither has a composer: provider children have no YA input channel.
The parent YA session ID stays in the URL; the sidebar highlights that parent
while the child page is open. The nested page composes its parent-session link
into the shared child title area rather than reserving a page-only header. That
title area stacks identity, read-only context, and actions when its own container
is narrow, then uses columns when the detail itself is wide; the full-page and
managed-window presentations therefore preserve the same information without
paying for the same vertical prelude at every width.

This is not optional YA-novel behavior under
[vanilla-defaults](vanilla-defaults.md): it restores visibility for work the
user explicitly caused through a first-party provider feature, and it adds no
new action or provider state mutation. A future interactive child-management
surface would need its own capability and default analysis.

## Freshness and resource use

Child discovery is filesystem- and rollout-backed; it does not spawn a provider
runtime. Claude JSONL and metadata creation events are both classified as
`agent-session` changes. The retained process snapshot also revalidates for
generic process and session progress, including `session-updated`; therefore a
provider-child implementation must make unchanged transcript versions cache
hits and must not turn ordinary token/file churn into a full parent-transcript
parse. Child creation may invalidate the bounded child projection. An append
with no child lifecycle record must cost at most incremental append inspection,
not a replay from byte zero.

Claude, Codex, Grok and OpenCode application detail, metadata, incremental catch-up and older pagination
read accepted profile SQLite facts without awaiting native acquisition. Unknown
or partial-empty observations omit enrichment; an accepted empty observation
returns `[]`. Known facts survive restart, missing native files and failed
reads. A later metadata event patches children without replacing messages,
scroll memory or the composer draft. Process and collection projections consume
the same SQL facts through the stored scoped native binding.

One profile coordinator owns a bounded source queue and finite coalesced work,
with no per-session timer. Explicit detail demand and native file observations
schedule acquisition outside request context. The Codex adapter reuses the
shared header catalog instead of reading the parent body. Source validation
checks the catalog identity, logical child version, watcher epoch and pending
changes; another reader consuming an invalidation cannot make stale proof
current. Incomplete enumeration stays partial across cache hits. Child facts
and discovery progress commit together in bounded SQL transactions. Ordinary
child mtime changes overlay activity from the catalog without SQL commits or
metadata broadcasts; only structural changes publish. File changes coalesce by
scope and target the proved current/previous parents. First list-only reads
register finite acquisition, including revalidation after restart; subsequent
accepted reads do not repeat it. An explicit
corrected native parent supersedes that child's older structural observation;
absence from a later enumeration does not erase historical facts.

Claude reuses the existing provider FileWatcher and its native-root hint.
Aliased watch roots must resolve to the bound physical scope before accepting
events. Child creation/deletion and sidecar changes schedule reconciliation;
an event naming only the exact parent or `subagents` directory does too. Some
native watchers collapse a newly created subtree to that directory event.
Ordinary child appends update a bounded activity overlay without SQL writes or
metadata broadcasts. The coordinator retains at most 128 pending native events
and shares two workers with acquisition. Overflow requests a finite source
refresh, and pending acquisition can progress during sustained event traffic.
Fresh requests share the registered reader lifecycle and its activity overlay;
they do not replace it with an empty factory instance or overlap acquisitions.
The watcher's initial baseline hands over once to registered source acquisition,
so a child created between a first read and deferred watcher activation is
reconciled without waiting for another native change. This is an internal
notification, not a client wire event or recurring scan.
Retiring a reader fences later batches and releases its source registration;
durable progress resumes after the last committed batch. Root locations outside
the configured provider watcher still reconcile on explicit detail demand;
continuous observation of those private roots remains separate qualification.

The older source-versioned direct-reader projection remains for retained raw
reader callers while adapters migrate. It incrementally inspects parent
launch records under an 8 MiB process budget; it is not the Codex application
read authority. Its pre-SQL benchmark remains available as
`pnpm --filter @yep-anywhere/server benchmark:codex-child-projection`. The
historical [startup investigation](../docs/tactical/089-main-thread-startup-cpu-investigation.md)
records why repeatedly parsing complete parents from process snapshots was
unacceptable. Current diagnostic detail scaling and restart evidence are in
plan 176; the old benchmark is not evidence of SQL publication/read latency.

The retained global session collection joins accepted SQL children using the
catalog's exact native id and storage scope after public-id projection. A
managed creation can use its SQL native binding before a catalog row exists.
An unscoped legacy catalog row does not guess a binding. These reads neither
open provider persistence nor register discovery, and still distinguish unknown
from accepted empty children. Only the authorized, filtered response page needs
child SQL queries; Inbox performs none. A new collection read sees structural
publication even when the native catalog generation has not changed.

The lazy agent-mapping route merges fresh native mappings with accepted SQL
launch anchors. Fresh non-placeholder anchors and provider aliases win; SQL
can restore missing anchors after source loss or replace an agent-id placeholder.
Ambiguous stored child or call ids produce no guessed mapping. Missing native
files do not erase stored anchors. Native failures still fail when no accepted
observation exists; accepted facts remain available when native reads fail.
This preserves pending-child discovery for existing clients without changing
the mapping response or requiring a new client preference. Actual native
fresh-plus-SQL launch anchors are qualified for Claude. The pre-existing
[Codex v2 mapping gap](../gaps/codex-v2-agent-mappings-miss-native-start-items.md)
remains separate from its qualified structural child discovery; Grok and
OpenCode currently publish no SQL launch anchor.

All Claude reader sidecar consumers require a regular metadata file of at most
64 KiB, with no-follow opening where supported. Mapping reads use it first.
A current sidecar launch id does not require a nonempty child transcript or
reading its body. Older sidecars fall back to streaming the first five header
lines after initial blank lines, retaining large legacy records with linear
chunk processing and without reading the rest of a long child. Invalid or oversized optional sidecars leave that
legacy fallback available. Retired readers return no fresh mappings.

Inline content follows the heavier session-detail path. Current Claude streams
route content by the provider child ID and map a parent tool call only when that
ID is actually present. Reload and lazy-load endpoints pass the canonical
parent ID into the reader, which makes current-layout discovery parent-scoped.

The Agents projection still comes from the process snapshot. Project and
global session lists attach children for idle parents too: Claude and Codex use
accepted SQL child facts and never start a cold parent rollout
parse for a list read. Claude and Codex metadata/detail attach accepted SQL facts and
schedule acquisition independently; retained adapters still request a fresh
listing for the open parent. `providerChildren` is optional on those existing
payloads; an omitted metadata field preserves any already accepted children. The nested child page uses the existing agent-session GET and does
not add a capability. A later indexed historical projection may replace the
per-parent readdir, but list reads must not parse child or parent JSONL.

## Other providers

Claude is the first provider with header control + managed detail + nested
page + idle-list summaries. Codex child rollouts already feed those surfaces:
list attach and session metadata use durable SQL facts, child content uses
`getAgentSession(childThreadId)`, and an unpublished cold
miss stays distinct from a published empty projection. Optionally overlaying
live `subagent_activity` text onto child detail while the parent is in-turn
remains open. Grok nested child discovery is landed: parent
`subagents/*/meta.json` feeds the existing header / detail / page / idle-list
surfaces, and child session dirs stay out of the top-level Grok list. TUI
tasks-pane kill remains out of scope.

OpenCode (including Copilot-via-OpenCode) stores task/subagent work as
sibling `ses_*` rows with `session.parent_id` (and legacy file-tree
`parentID`). `OpenCodeSessionReader.listProviderChildSessions` lists those
rows without walking messages. `getAgentMappings` maps parent `task`
parts to the child id so Task Open works. `getAgentSession` replays the
child's own messages. Child ids stay out of top-level OpenCode lists and
the session catalog. There is still no first-class YA `copilot` provider;
Architecture C live `subagent.started` events remain a later path.

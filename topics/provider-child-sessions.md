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

## Codex live notification ownership

Codex subagents share the app-server connection with their parent. A native
child can send command items, token usage, agent text and turn completion on
that connection with its own `threadId`; these frames have no Claude-style
`parent_tool_use_id`. Transport membership alone does not make them parent
messages or relationship evidence owned by the parent.

The Codex adapter checks an explicit thread id against its actual native root
before turn-id resynchronization, usage updates, background tracking and SDK
normalization. `thread/started` uses its nested thread id. Foreign-thread
frames follow the existing raw diagnostics policy, while global notifications
without a thread id retain their existing handling. Child requests and parent-owned delegation
items are unaffected. This prevents a child's command from being relabelled as
a managed parent's live Bash call. Native child headers and the child's own
transcript remain the discovery/content authorities.

The existing current-native child scenario now makes the actual child execute
a command through the scripted model endpoint. The command must be in the
child's native persistence and absent from the parent's Process stream; parent
wait/completion and the reopened SQL relationship projection still pass. No
new native startup or paid model call is added. The assertion fails before the
thread boundary and passes after it.

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

Actual OpenCode 1.18.9 nesting is qualified at depth two with an explicit
fixture-only Task permission and depth setting. A grandchild stays beneath its
immediate child parent in SQL and parent-scoped content reads; it neither
becomes a direct root child nor a top-level session. A refused deeper Task
allocates no fourth session or structural edge. The default child Task policy
and production depth selection are unchanged; broader depths/platforms remain
separate qualification.

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
the same SQL facts through the stored scoped native binding. Stored activity
times describe the last structural observation. Current activity overlays do
not become durable merely because an unrelated sibling changes.

An exact indexed native binding remains authoritative when its reader is absent,
retired or rejects that storage scope. Return that binding's accepted SQL facts,
including known empty versus unknown, without bare-id discovery or registration
of a mismatched source. A same-string parent in another native store cannot
replace those facts. Only an explicitly unindexed legacy lookup may retain the
older reader-only path.

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
register finite acquisition, including revalidation after restart. Subsequent
accepted reads return SQL immediately. For an already registered parent, a
request after 30 seconds may schedule one bounded metadata refresh; concurrent
requests coalesce with native events and foreground demand under the same
128-source/two-worker ceiling. Queued foreground/native work runs before aged
metadata work; already running acquisitions remain finite. Age alone schedules
nothing, and there is no per-session timer or added watcher. Normal native
observations remain the prompt update path. Unwatched private scopes can
remain stale until the next aged request or explicit fresh demand. An explicit
corrected native parent supersedes that child's older structural observation;
absence from a later enumeration does not erase historical facts.

A request-driven metadata refresh may inspect only the exact parent's native
metadata. Claude and Grok read that parent's child directory and sidecars;
Grok never falls back to project/root enumeration in this mode. OpenCode reads
the selected native SQLite lineage without loading its legacy JSON catalog.
Codex uses the pinned native `state_5.sqlite` parent index only as a locator,
then reads bounded, terminated, plain child-owned headers in the exact
physical session scope and project. Cross-project child headers are withheld
by this partial refresh. Attached actors whose own creation-parent header
differs are withheld. Parent bodies, prompts and provider-wide walks are not
inputs. A missing/older Codex index, nonconventional session-root layout or
custom SQLite-home location without a scoped locator can leave this cheap
refresh stale or unavailable; ordinary foreground discovery remains supported.
YA never borrows an ambient SQLite-home override for a different native scope.

Native SQLite connections are read-only, finite acquisition leases with reused
statements; SQLite may create WAL/SHM reader sidecars. File identity and fresh
logical selected rows fence replacement and WAL-only changes; bounded
own-header proofs fence file replacement while allowing ordinary body appends.
Reader retirement releases pending leases. Codex locator observations and
OpenCode's SQL-only refresh are partial, so they cannot certify an absent
legacy child or turn unknown into accepted empty. Metadata progress has a
separate checkpoint from full discovery and emits the existing metadata event
only when child facts change. Unsupported or failed cheap reads preserve
accepted facts and never escalate into a provider-corpus walk. Newly available
launch metadata may request ordinary finite discovery when cheap refresh is
unavailable or misses verified already-read anchors. Aged reads still publish
partial positive facts without escalating. No new client contract is used.

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

Direct Codex reader calls now use that same validated native header source.
There is no separate parent-body child projection or its process cache.
Explicit fresh reads share header acquisition, while synchronous accepted reads
perform no I/O and start no background work. Cold, expired, invalidated or
partial-empty header state remains unknown until explicit freshness is requested.
The application still uses durable SQL immediately; reader acceptance is a
native-adapter boundary, not another durable read authority. If unrelated
streaming invalidates both finite fresh attempts, the raw adapter preserves its
last proved view rather than returning a false empty list. Native read loss is
tolerated, and retirement returns no raw data. This historical fallback is never
used to publish SQL; durable acquisition still requires current source proof.
Raw project discovery checks the parent's cwd, while an already authorized
exact binding remains valid when its original YA project differs from a
fork/worktree's native working directory.

Own native parentage establishes structural visibility even when the parent's
launch record is missing, unfinished or lost to a rewrite. Titles, roles and
depth come from the child's native header. Already-read verified mappings can
supply launch anchors; an explicit agent-mapping request can acquire older
anchors independently. Accepted anchors are historical hints guarded by the
cached header's size/activity; pure accepted reads cannot revalidate file
identity. Fresh acquisition and SQL publication retain their physical-file
fences. Listing children never starts that parent-body read.
A fork that also explicitly carries a qualified native parent can have both
lineage and child relationships; copied launch history alone proves neither.

`pnpm --filter @yep-anywhere/server benchmark:codex-child-projection` now runs a
metadata/SQL diagnostic with automatic host evidence: twenty cold reader callers,
205 children and an 8 MiB parent, empty transcript caches, indexed SQL reads
and reopen after native content deletion. A negative control qualifies the
stream counter: Node verifies zero measured body streams; Bun reports the
counter unavailable when its module bindings cannot be intercepted. The
historical parent-body projection benchmark is retired. The
[older startup investigation](../docs/tactical/089-main-thread-startup-cpu-investigation.md)
explains why replaying parents from process snapshots was unacceptable. Current
detail scaling and restart evidence remain in plan 176.

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
fresh-plus-SQL launch anchors are qualified for Claude and Codex variants.
Grok and OpenCode currently publish no SQL launch anchor.

Codex lazy mappings and direct child projections share the audited native
started-item interpretation, including its legacy output fallback. Only a
started record correlated with an observed spawn call supplies an anchor;
interaction/completion records do not. Candidate outputs use parsed call-id
lookups rather than scanning every prior launch id for every output.

Already-read terminated parent records, including positive records in bounded
windows, may enrich SQL children. Empty or partial windows never certify
whole-file absence. The bounded relationship coordinator subscribes to exact-
parent metadata handovers while that native source is registered and releases
them with the reader. Discovery never starts another parent-body read to
acquire optional launch ids. An anchor is accepted only beside the child's own
scoped parent proof. Copied fork history cannot introduce a structural edge.
Stable native file identity/version checks and a bounded plain-file footer
check fence new durable extraction. Known historical anchors may survive
ordinary appends in that physical file. Replacement, unavailable enrichment
and source loss preserve accepted SQL history rather than fabricate an empty
set. Unterminated start records are not accepted by the lazy reader. Activity
with unchanged anchor sets does not notify the coordinator. Historical
metadata comes from the exact scoped SQL edge when the transient parser cache
is absent; it never supplies native parent proof. Validation reuses the
observation without repeating SQL lookups. A registered source remembers
accepted hints only for currently observed children, refreshing them when
transient native enrichment disappears before its newly emitted anchor was
remembered. Unchanged child versions retain their SQL revisions. A lazy read
can return its terminated prefix during ordinary same-inode growth without
caching that reply as complete-file proof. Physical replacement or shrink
remains a failed read. SQL stores bounded launch ids alongside native header
metadata, excluding delegated prompts and outputs.

All Claude reader sidecar consumers require a regular metadata file of at most
64 KiB, with no-follow opening where supported. Mapping reads use it first.
A current sidecar launch id does not require a nonempty child transcript or
reading its body. Older sidecars fall back to streaming the first five header
lines after initial blank lines, retaining large legacy records with linear
chunk processing and without reading the rest of a long child. Invalid or
oversized optional sidecars leave that legacy fallback available. Retired readers return no fresh mappings.

Inline content follows the heavier session-detail path. Current Claude streams
route content by the provider child ID and map a parent tool call only when that
ID is actually present. Reload and lazy-load endpoints pass the canonical
parent ID into the reader, which makes current-layout discovery parent-scoped.

The Agents projection still comes from the process snapshot. Project and
global session lists attach children for idle parents too. Indexed Claude,
Codex, Grok and OpenCode reads use accepted SQL child facts and schedule finite
acquisition independently when a source is available. They never wait for a
fresh native child listing. Unindexed legacy callers retain the reader-only
path. `providerChildren` is optional on those existing
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


### Owned Codex command evidence across API upgrades

The app-server adapter marks a live command only when the notification's
explicit native thread id matches its owned root thread, after the existing
foreign-child filter. This private marker lets internal relationship acquisition
withhold frames produced by older, still-running hosted workers. Presentation
correlation alone does not prove that an old worker attributed a frame to the
correct native owner. This changes neither provider-child membership nor its
public navigation projection; shell-launched harnesses remain a distinct
`launched_harness` relationship with command-observed trust.

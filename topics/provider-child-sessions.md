# Provider Child Sessions

> Provider child sessions are provider-launched units of delegated work that YA
> discovers from provider persistence and displays beneath their canonical YA
> parent session without promoting provider-native child IDs into YA session IDs.

Topic: provider-child-sessions

Related topics: [provider-session-tree](provider-session-tree.md),
[session-detail-data-layer](session-detail-data-layer.md),
[vanilla-defaults](vanilla-defaults.md),
[codex-sessions](codex-sessions.md)

The [durable relationship design](session-relationships.md) proposes a shared
SQL model coordinating native children, trusted v0 creator links, forks,
`/btw` and other session relationships. It preserves the identity distinctions
below and proposes removing fresh child acquisition from transcript delivery.
It is a design proposal; the current freshness paths documented here remain.

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

Codex stores a child as a separate rollout. The parent rollout's `spawn_agent`
function call/output pair supplies the launch tool-call ID, child thread ID,
role/prompt, and optional nickname; the child rollout supplies its durable
content and timestamp. Child rollouts remain excluded from top-level session
and project counts.

Grok stores `SubagentMeta` at
`<parent session dir>/subagents/<id>/meta.json` and a sibling child session
directory under the same encoded cwd. `child_session_id` equals `subagent_id`.
`GrokSessionReader.listProviderChildSessions` reads only those metas.
`getAgentSession` replays the child's `updates.jsonl`. Those child ids are
excluded from Grok top-level `listSessions` / `listSessionFiles`. Fork
`parent_session_id` on `summary.json` is not a subagent link.

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

The Codex implementation uses a source-versioned child projection shared across
reader instances. The projection retains launch and child facts, its byte
offset, and an incomplete final line, but never the full entry array. Exact
unchanged versions are cache hits; concurrent readers join one build; plain
JSONL growth inspects only the appended range; truncation, replacement, and
compressed-file changes rebuild from byte zero. Published work is re-statted
against device, inode, size, mtime, and ctime, and a late completion cannot
replace accepted state for another source version. The retained projections
share an 8 MiB process-wide byte budget.

The process-list route consumes the latest accepted projection and starts
refresh in the background. An unpublished cold miss returns `undefined` and
omits child enrichment; a published empty projection returns `[]`. Neither
value may start a parent-rollout parse. A later snapshot attaches children
after publication. Direct reader callers retain fresh-by-default semantics,
retry one source race, and fall back to the last accepted projection if the
source keeps changing.

This replaces the prior violation: `createProcessesRoutes` enriched every
active and recently terminated row by awaiting
`listProviderChildSessions`, while `CodexSessionReader` called `readEntries`
with `cache: false` and parsed the complete parent rollout on every process
snapshot. The 2026-08-04 investigation in
[`docs/tactical/089-main-thread-startup-cpu-investigation.md`](../docs/tactical/089-main-thread-startup-cpu-investigation.md)
demonstrated sustained multi-core CPU and hundreds of logical GiB of repeated
input from that path.

The reproducible server benchmark uses a 6,289,985-byte synthetic parent
rollout and 20 simultaneous callers. It measured 20 legacy full parses versus
one projection build, 125,799,700 versus 6,289,985 logical source bytes (95.00%
avoided), and 183.08 ms versus 9.07 ms median wall time across five samples
(20.18x). Cold latest-accepted lookup returned in 0.535 ms. The accepted value
retained 611 estimated bytes and populated zero full-entry-cache sessions. Run
`pnpm --filter @yep-anywhere/server benchmark:codex-child-projection` to repeat
the measurement.

A regression for this boundary issues repeated process refreshes against one
unchanged large parent rollout. After at most one initial child-projection
build, it observes zero full-entry parses. Appending ordinary non-child records
does not rebuild from byte zero; appending a spawn/lifecycle record updates the
child summary without retaining the complete entry array. Truncation removes
children that are no longer in the source.

Inline content follows the heavier session-detail path. Current Claude streams
route content by the provider child ID and map a parent tool call only when that
ID is actually present. Reload and lazy-load endpoints pass the canonical
parent ID into the reader, which makes current-layout discovery parent-scoped.

The Agents projection still comes from the process snapshot. Project and
global session lists attach children for idle parents too: Claude uses the
cheap `subagents/` readdir already owned by `listProviderChildSessions`;
Codex uses only the accepted child projection and never starts a cold parent
rollout parse for a list read. Session metadata and session-detail attach a
fresh listing for the one open parent. `providerChildren` is optional on those
existing payloads; older servers omit it and the client treats absence as no
children. The nested child page uses the existing agent-session GET and does
not add a capability. A later indexed historical projection may replace the
per-parent readdir, but list reads must not parse child or parent JSONL.

## Other providers

Claude is the first provider with header control + managed detail + nested
page + idle-list summaries. Codex child rollouts already feed those surfaces:
list attach uses the accepted projection, session metadata and child detail use
a fresh listing plus `getAgentSession(childThreadId)`, and an unpublished cold
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

# Inbox

> Inbox is YA's session-attention view: it tiers sessions by pending input,
> active work, recent activity, and unread notification state rather than only
> by assistant replies awaiting response.

Topic: inbox

See also:

- [`agents-process-observability.md`](agents-process-observability.md) — the
  separate host process inventory and metrics surface.
- [`session-summary-fidelity.md`](session-summary-fidelity.md)
- [`session-catalog-observation.md`](session-catalog-observation.md)
- [`../docs/tactical/093-provider-session-reconciliation.md`](../docs/tactical/093-provider-session-reconciliation.md)
  — implementation handoff for install-gated provider catalogs and boot
  reconciliation.

## Route Contract

`createInboxRoutes` returns session rows, not arbitrary project work. The route
collects non-archived sessions across provider scanners, optionally filtered by
`projectId`, enriches them with live process state and notification state, then
places each session in the first matching tier.

The tier order is:

1. `needsAttention`: sessions with pending tool approval or a provider question
   waiting for user input.
2. `active`: sessions currently in turn, idle sessions retaining provider
   background work, or existing sessions targeted by queued or dispatching
   Project Queue work.
3. `recentActivity`: sessions updated in the last 30 minutes and not already
   assigned above.
4. `unread8h`: unread sessions updated within 8 hours and not already assigned
   above.
5. `unread24h`: unread sessions updated within 24 hours and not already
   assigned above.

Each tier is sorted by `updatedAt` descending and capped at 20 items. Archived
sessions are skipped before tiering.

**The walk is shared; the tiering is not.** Inbox is app-shell mounted, so a
herd of tabs reconnecting would otherwise run a herd of independent walks over
every project. The enriched row collection is single-flighted per
`(project filter, session-collection generation)` — the same clock and the same
deny-list over bus events that `GET /api/sessions` uses, described in
[`session-catalog-observation.md`](session-catalog-observation.md). Tier
membership is recomputed per request against the current clock and the current
Project Queue, because the tiers are wall-clock windows: retaining a tiered
response would freeze the 30-minute, 8-hour, and 24-hour boundaries at the
instant of the walk, and a session would sit in `recentActivity` until
something unrelated moved on the bus. Anything else added to the response that
depends on wall-clock time or on state outside the deny-list belongs on the
per-request side of that split.

Inbox's collection read requires only session identity, title, and recency. A
provider with a bounded list-summary reader may use it for dirty or uncached
sessions instead of completing a transcript-tail summary. That projection must
not update the complete-summary index or clear its dirty state; complete
consumers must still receive exact message count and tail-derived metadata.

`pendingInputType` is live process state, not durable session-summary state.
Inbox may place a session in `needsAttention` only when the owned process is
currently in `waiting-input` with an actionable request. A stale provider
approval callback left behind by a stop/interrupt must be resolved or ignored;
it must not keep an active or idle session in the approval tier.

## Startup Snapshot And Progressive Reconciliation

Inbox needs to discover provider activity that occurred outside YA or while YA
was down, but an ordinary page request must not become the trigger for a global
session scan. On startup, after retained provider runtimes reattach, the server
begins one eager background reconciliation. The route reads its retained
snapshot and never starts or waits for another corpus pass.

The initial response uses the last persisted tier/count snapshot immediately.
Each completed provider/project shard publishes a versioned delta in place, so
the sidebar count and Inbox rows become current as scanning progresses. This is
not user-triggered lazy loading: reconciliation begins at boot, but session and
project display stay independent of its completion. Provider file events update
touched sessions after the baseline; bounded later reconciliation covers events
missed while YA was down or a watcher generation was uncertain.

Discovery is provider-global, not project-by-provider. Each provider adapter
enumerates its native session store once in complete or recent-window mode,
exposes native session ids plus a bounded activity projection, and groups them
by canonical project. It must not rescan the same Pi, Grok, OpenCode, Codex, or
Claude store for every project. At the supported 10,000-project planning scale,
complete dormant projects may remain disk-backed while only changed/recent
shards enter live memory.

The provider-store pass is gated by install history. A provider enters the
eligible set only after this YA install successfully starts a session with it.
An adapter that has never been used is not asked whether it may have sessions
and its native store is not scanned. Migration seeds eligibility from existing
YA-owned launch/session metadata, never by probing native provider stores.
Selecting and successfully starting that provider records eligibility and
triggers its first provider-global catalog pass. Missing old sessions from a
never-used provider is an intentional heuristic trade-off: the user is unlikely
to expect YA discovery for a provider they have never used in YA.

The boot process snapshot is a separate projection. One same-user host scan
recognizes known provider harness roots and subtracts exact YA Supervisor or
retained-runtime ownership. It may recognize a never-used provider without
opening that provider's session store. A retained YA process establishes exact
session ownership. An external process may name a session only when a
provider-native session id, pid/lock record, or another exact provider contract
supplies the join. Cwd, mtime proximity, CPU, and “only one candidate” are
insufficient. Uncorrelated external harnesses remain useful in Agents but do
not manufacture Inbox session ownership or attention.

Reconciliation work is bounded and schedulable: coalesce identical store
versions, parse at bounded concurrency, yield between main-thread units or use
the parser worker, and expose shard/byte progress. No client is required to
remain connected for the boot pass, and no completed pass leaves a repeating
poll loop behind.

## Unread Meaning

Unread state comes from `NotificationService.hasUnread(session.id,
effectiveProviderUpdatedAt)`. For an unowned session this is the provider list
summary's transcript recency. For a YA-owned process it is the later of that
summary and nullable `Process.lastProviderContentTime`, because the live
runtime can observe a provider message before every supported filesystem
publishes its final write timestamp. Construction and reactivation leave that
clock null until a real provider message arrives, so process ownership alone
cannot manufacture recency or unread state. The same effective recency is
returned and used for sorting; recap overlays may still make a row newer for
display but never participate in the provider-unread comparison.

Provider receipt and provider content have separate clocks. Initialization,
command/skill inventory changes, configuration acknowledgements, token-usage
telemetry, and session-state notifications remain available for diagnostics
and live controls, but do not advance the content clock or make an idle session
unread. Actual provider output still advances recency before a filesystem flush.
Session detail, its metadata endpoint, project lists, global lists, and Inbox
all use this same effective content recency and keep recap-only freshness out
of the unread comparison.

Read/unread actions are server-owned. A `session-seen` event with an empty
timestamp means explicitly unread; a nonempty timestamp means read. Session
menus and list rows follow the current shared state without retaining a local
toggle that can mask a later server update.

Unread means YA believes the session changed after the user's last seen
marker. It is not limited to "an idle assistant produced output and now needs
a user response"; that narrower state belongs in `needsAttention` only when
the provider exposes pending input.

On Windows, a plain Codex rollout's list-summary recency uses the later of file
modification and change time. Codex retains its append handle for the session,
and Windows may defer the last-write timestamp until that handle closes even
though file size and change time advance. macOS/Linux and immutable compressed
Codex rollouts retain modification-time recency. A metadata-only Windows change
can therefore conservatively make an unowned Codex row unread; suppressing
visible output for the lifetime of an active rollout is the more serious
failure, and YA-owned sessions use the runtime clock as the stronger source.

When a mounted client receives `session-updated` for a row it currently shows
as read, the Inbox must re-evaluate the server-owned unread and tier state. New
agent activity therefore becomes unread without a manual refresh even when the
session was already present in an active or recent tier. An already-unread row
may patch additive content fields locally because the event cannot make it
more unread; `session-seen` remains the authority that clears that state.

Known caveat: for Claude JSONL sessions, `session.updatedAt` currently comes
from file mtime. YA's one-hour idle reap can abort the Claude SDK stream and
cause a mtime-only transcript touch, which may flip a previously read session
back to unread without a new visible provider message. See
[`2026-07-06-claude-idle-reap-mtime-unread.md`](../docs/project/2026-07-06-claude-idle-reap-mtime-unread.md).

## Project Queue Visibility

`getActiveProjectQueueSessionIds` includes queued and dispatching Project Queue
items whose target is `existing-session`, and those sessions land in `active`
if they were not already in `needsAttention`. Inbox renders them as ordinary
session rows with a Project Queue `Q` decoration.

A pending Project Queue item targeting a new session has no session row yet.
The client renders the queue record itself at the start of the `active` tier;
it does not invent or return a placeholder session from the Inbox route. The
row shows the queued prompt, project, age, and queue status, links to the
Projects page with that item highlighted, and labels `New session` beside the
`Q` decoration so it remains distinguishable from existing-session rows.

These client-side queue rows and decorations make Inbox more informative, but
they do not change the server tiering contract.

# Sidebar Session Ordering

> Sidebar rows follow the user's written turns. Opening a session, background
> output, and agent activity changes update row content without changing
> chronology.

Topic: sidebar-session-ordering

See also: [ui-architecture](ui-architecture.md),
[session-list-hidden-duplicates](session-list-hidden-duplicates.md),
[session-liveness](session-liveness.md), and
[scrollback-view-stability](scrollback-view-stability.md).

## User chronology

The sidebar's **Starred**, **Last 24 Hours**, and **Older** sections order loaded
sessions by the later of the most recent composer submission in this browser
and the last human turn the server reports for the session. Direct sends and
deferred queue submissions count, including a submission whose delivery fails.
Opening a session does not count: reading is not activity, so tapping a row
leaves the order alone. Passive assistant output, tools, heartbeat turns,
metadata refreshes, and active/idle transitions do not count either.

Sending to or queueing text for a session records the interaction before
delivery, so upload or provider delays cannot change its relative time. New
sessions enter through normal navigation and sort by creation time until
someone writes into them.

For sessions with neither a recorded submission nor a reported human turn,
creation time supplies a stable initial order. Missing creation times sort
last; session ID breaks ties.
General `updatedAt` is never used as evidence of user activity. Last 24 Hours
and Older use the same user/creation timestamp, so background work cannot move
a session between them. Active and queued sessions keep their badges and
duplicate-hiding protection without being pinned above other rows.

## Sections

The session list shows, top to bottom: **Starred**, manual categories,
**Last 24 Hours**, one section per limited user, and **Older**. Each session
appears once, in the first section that claims it: Starred, then its manual
category, then (for the superuser) the limited user who started it, then Last
24 Hours or Older by the chronology above. A starred session therefore stays
in Starred even when filed under a category. Empty sections are not shown.
Rows are never indented under a header, so every section keeps the same left
edge.

Clicking a section's name opens or closes it. A chevron after the name points
down while open and right while closed; a closed section shows its row count
at the right, with `+` when more rows exist than are loaded. Open/closed state
is browser-local, stored per fixed section and per named section (by
`category:<name>` or `user:<username>` key); named sections start open.

**Manual categories.** A row's menu offers *Move to category*, which expands
in place to the existing category names (the current one checked), *New
category…* (typed inline, confirmed with Enter), and *Remove from category*.
Choosing the current category again also removes it. A session holds at most
one category, a name stored in session metadata on the server, so every
device agrees. Names are normalized by collapsing whitespace and trimming, up
to 60 characters; an empty name means none. A category exists while a session
is filed under it: there is no separate rename or delete in v1. Category
sections sort by name, case-insensitively, and show uppercase like the fixed
sections. Their rows come from a dedicated `categorized=true` list feed, so a
filed session keeps its section however old it is.

**Limited-user sections.** For the superuser, sessions a limited user started
are grouped under that username, below Last 24 Hours, sorted by username. The
name keeps its own case and carries a small person glyph. A limited user's own
sidebar has no such section: they see only their own sessions. Grouping
applies to loaded rows, like Last 24 Hours and Older.

A server without `sidebar-session-categories` (releases through 0.9.3) shows
neither the menu entry nor either kind of named section, and the client sends
it neither `sidebarCategory` nor `categorized`.

## Fresh membership

Pointer, focus and touch do not hold order or section membership. Accepted
fresh data immediately determines the displayed sections: unstar, category,
archive, deletion, new arrivals and submissions may move or remove rows while
interaction remains inside the sidebar. User chronology above still applies;
background output itself is not a ranking signal.

The existing server collection owner still supplies the three session windows;
the [SQL snapshot API](session-collection-queries.md#sidebar-snapshots) is a
measured foundation, with default browser cutover deferred.
On capable servers, starred and categorized sections render accepted window membership, including
after deep pagination; an unrelated cached entity cannot restore an omitted
row. Older servers retain their existing acquisition path.

## Storage and ownership

`sessionInteractionOrder.ts` keeps up to 1,000 latest distinct session
submissions per connected source in browser-local storage. Same-tab consumers
share the existing local-storage store; other tabs receive storage events.
Invalid persisted entries are ignored. Records kept under the former
`yep-sidebar-interactions:*` key, which also held visits, are discarded when
the source's store is first opened, so a pre-change visit cannot keep a row
above later sends. If persistence is unavailable, the
existing storage helper retains coherent in-memory state. Clearing browser
storage or eviction of an old entry restores that row's creation-time fallback.

This is browser-local chronology over the server's loaded collection, not a
whole-history user-message index. Another device, provider-native terminal, or
agent-mediated session message does not update it. Existing server query
coverage and pagination still determine which sessions are available. The chronology layer adds no polling loop or project-directory writer.

`useSidebarSessionOrder` owns sidebar ordering and date classification above
the collection records. Shared collection selectors retain their existing
semantics for other consumers. Duplicate grouping preserves the resulting
order; it protects active, queued, current, owned, and lineage-related rows
under the existing duplicate-hiding contract.

A minimized desktop sidebar or closed mobile sidebar still releases its feed
interest under the existing sidebar-feed contract. When that feed becomes
active again, it validates its cached membership against the server collection
generation so sessions created while hidden appear without a project/search
detour. Returning a connected tab from the background performs the same
validation. Chronology tracking itself adds no server demand.

## Design decisions

- **User activity owns chronology** (vs. active-first partitioning or general
  update recency): even a stable order within an active block jumps when a turn
  finishes. Activity is a badge, not a ranking signal.
- **Submissions only, never visits**: opening a session initially recorded a
  visit and moved the row to the top. The user found a tap indistinguishable
  from activity confusing, so only writing into a session moves it. The
  browser-local record keeps a send's effect immediate; the server's last
  human turn lets every device agree afterwards.
- **Fresh membership wins during interaction**: explicit changes should move
  rows immediately, rather than preserving their former section while hovered.

## Verification

The summary-store Sidebar regression reproduces a row jumping when one active
session finishes while another produces output. It now preserves order and
updates the title. Component and hook coverage checks immediate membership changes,
arrivals, duplicate protection, persistence, source isolation, malformed
storage, and bounded retention. The browser test drives actual navigation and
composer submission, injects activity through the WebSocket boundary, checks
that navigation leaves the target's position and stored history unchanged
while a send moves it, and captures desktop and phone layouts.

## Historical active-first ordering (superseded)

Before commit `7fc9d17c` ("Client: hide duplicate-title sessions behind
(N hidden) expanders"), the sidebar rendered `recentDaySessions.map(...)`
directly and inherited the hook's stable order, so active sessions did not
shuffle. That commit introduced `groupDuplicateSessions`, whose
`visible.sort((a,b) => updatedAt desc)` re-sorted the *entire* recent list —
including active rows — on every refetch, defeating the hook's preservation and
reintroducing the every-few-seconds shuffle for concurrently-active sessions.
The `(N hidden)` feature is the regression vector the user suspected; splitting
active rows out of that path is the fix.

After the session collection migration, Starred briefly regressed the same
contract by sorting all starred rows by `updatedAt`. Active starred rows could
therefore trade places during a turn. The selector now uses the same active-
first stable ordering as Last 24 Hours.

The next refinement closed a more subtle jump: sorting active rows by
`activeStartedAt` descending made every idle-to-active transition become the top
row in its section. The stable contract is active-first partitioning, not
"newest active wins", so active rows now sort by `activeStartedAt` ascending.


The user subsequently clarified that only their activity should move rows.
The current user-chronology contract above replaces these active-first rules;
the historical fixes explain why sorting on provider updates was repeatedly
insufficient.

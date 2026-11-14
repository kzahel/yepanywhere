# All-Session Content Search

> All Sessions incrementally searches catalog titles and optional visible turn
> text, grouping matches by session while preserving explicit selection.

Topic: all-session-content-search

## Search surface

The sidebar's All Sessions view owns these controls; in-session search keeps
its existing bindings and behavior. Title is enabled by default. Ass. and User
are opt-in, independent checkboxes whose matches form a union. Title searches
the displayed title and the original opening prompt retained in hot metadata.
A rename does not replace that retained prompt.

Matching is against the session's whole opening text, never a display-length
form of it. Truncation is a rendering decision made last, at the width the
reader actually has, so every row a client matches in the browser must carry
the untruncated text: a row reduced to its display title silently makes a
needle past that title unfindable, and the reader cannot tell a search that
found nothing from a search that could not look. This binds the retained
collection as much as the unretained one — see `SESSION_CATALOG_TITLE_MAX_LENGTH`
for the one bound the stored text does obey. Unchecking the last enabled
User/Ass. role selects Title when no other field remains enabled.

Fresh visits select the non-archived filter, narrowing both title results and
Ctrl+R/Ctrl+S turn acquisition. Explicit URL status filters remain authoritative;
an empty `status=` preserves a deliberately cleared filter across navigation.

CSV AND is checked on fresh visits. Comma-separated needles intersect within
one matching turn, title, or opening prompt; different turns cannot satisfy
different needles. Quoted commas and doubled quotes are literal characters.
Blank terms are ignored while editing. Unchecking searches the complete input
literally. Acquisition and highlights use the first needle; remaining needles
filter retained whole text in interruptible slices, without new disk reads or
discarding the first-term cache. Editing/removing a later needle reuses that
stream; changing the first follows ordinary refinement/rescan rules. Title and
opening-prompt candidates are checked independently against all needles.
Missing full text, including after a cache cap or on older servers, is explicit
incomplete intersection coverage; an excerpt cannot establish a nonmatch.
Browser Back restores the checkbox with the other search controls.

The Projects filter lists every project the server currently lists, sorted by
name, under an explicit first row, All projects, that clears the project
filter; it is highlighted while no project is selected, so returning to every
project is a visible choice rather than a second click on the current one.
Removed projects are not listed: removal hides a project and its sessions from
the server's lists. The list stays current because adding, removing, or
renaming a project advances the session collection generation
([project names](project-names.md)); before that, a removed project could
linger and a new one go missing until an unrelated session event.

User and Ass. currently search visible prose. Command strings and tool inputs,
edit additions, removed/context lines, baseline/read file contents, tool output,
reasoning and image/media payloads are excluded. This matches ordinary C-s's
prose scope, not its separate full-session mode. The proposed shared extension
for assistant-authored commands and additions is tracked in
[assistant-authored search inputs](../gaps/assistant-authored-search-inputs.md).

Typing is acknowledged locally, independently of router navigation and result
work: no keystrokes may be dropped, and each must appear within 100 ms.
Title-only search reads catalog metadata and makes no content-search request.
The result DOM grows in batches as the reader scrolls; filtering and selection
still cover all matching sessions, including those not mounted yet.

Turn search keeps one latest pending needle and at most two scan generations.
A stricter needle first refines retained whole searchable turn text, yielding
between short slices so typing can interrupt it. Excerpts are display
projections, never sufficient evidence that a complete turn does not match.
Uncapped sessions reuse acquired prefixes and continue from their saved cursor;
completed sessions require no new disk read until their source changes.
When a third generation starts, it displaces the second unless that second
has enough matching rows for the measured viewport, or is already complete;
then the first is retired. Retired work cannot publish into the current source.
Rows keep a stable order across updates: a result holds the rank it took when
it first appeared under the current needle, so arriving matches, later catalog
pages and live sessions append rather than reshuffle what is being read. That
ranking belongs to one needle. Changing the needle starts it again from catalog
order, so no session carries a position earned under an earlier search.
Changing fields, filters or time criteria keeps the current ranking.
Initial streaming uses a shared
reservation within the preview limit; actual arrivals can grow the row. Once
search completes, 500 ms without pointer, keyboard or scroll activity permits
expansion to the requested preview count. Later live updates do not collapse
the already expanded rows back to the initial streaming shape.
Changing fields or time criteria filters cached results without a new blank
reservation. Enabling turn search for the first time or changing the needle
starts the initial layout.

The reserved space to the right of the needle always says "in N sessions".
N is the eligible catalog scope after Only selected and session filters,
before needle matching. With Title enabled it includes title-only providers;
with only turn roles it excludes providers lacking bounded turn search; with
no field enabled it is zero. Turn-time bounds filter content inside that scope,
so they cannot exclude a session from traversal using hot metadata alone.
An optional trailing ellipsis occupies a fixed slot while newly eligible
sessions are scanned or the initial catalog is loading. Cached refinement and
ordinary live-tail appends stay quiet. Progress and coverage explanations are
available on hover/tap; they never replace the caption with loading prose.
Starting and stopping work does not move results. Incomplete coverage lists
quoted, emphasized session titles and reasons
after the matching results, and remains visible during revalidation. A disclosure
summary names the incomplete-session count; details start collapsed and retain
the user's disclosure choice as diagnostics arrive. Diagnostics
link to the nearest preceding readable turn and identify the source byte offset.
Opening zoom takes a page-owned snapshot;
reordering or revalidation does not dismiss it.

Ctrl+S selects assistant search and Ctrl+R selects user search, focusing the
search box. On a server without turn-search support they only focus title
search. Whether the server supports turn search is a fetched answer, so a press
arriving before it is held rather than dropped: it applies when support is
confirmed, and is discarded once the answer says unsupported. A reader who opens
the page and immediately presses Ctrl+R gets user search, not silence. Desktop typing outside an actual text entry returns to the search's end
and applies the typed character. A focused control keeps the keys it acts on:
Space presses the focused button or toggles the focused checkbox instead of
reaching the needle, while characters that control ignores still reach it, so
clicking a filter and continuing to type loses nothing. Clicking, selecting,
right-clicking and copying do not steal focus; other text inputs and dialogs
retain their interaction. Mobile never autofocuses search. The header has no
redundant All Sessions caption. Search in appears only when the field
checkboxes occupy their own row.

## Time and result limits

A single Turns / Last activity / Created selector chooses what an age range
constrains. Last activity is the fresh-visit default. The minimum and maximum
fields accept d, h and m, with days implied
when the unit is omitted. Bounds are inclusive. Blank means 0d / infinity;
the upper field also accepts the infinity symbol. Negative, malformed and
reversed bounds produce a visible error rather than silently changing meaning.
The lower value is right-aligned and the upper value left-aligned toward the
separator. Small initial fields grow while typing and retain reserved width
during editing to avoid repeated expansion and contraction.

Turns uses original message timestamps. Last activity and Created constrain
sessions. A renamed title has no turn timestamp; the original prompt uses the
session creation timestamp. Multiple simultaneous ranges remain a possible
future extension, not an assertion that their combinations are invalid.
Each basis and age input has a tooltip explaining that distinction and the
units. The 1d / 7d / 30d shortcuts select Last activity and sessions active
within that age; Any age clears both bounds without changing the basis.

Turns/session is empty by default, meaning every matching preview. A positive
integer limits displayed previews independently for User and Ass.; one shows
one of each when both exist. It never stops acquisition. Minus/plus above a
session's first preview adjust this global budget, with minimum one, and
compensate scrolling to preserve that session's position. They occupy a short
strip below the checkbox, above the first role chip and left of the provider
badge. The remainder of the column stays selectable. Each button is absent
when its next global value would not change that session's displayed matches;
the other button keeps its own fixed slot.

### Exact preview counts and live arrivals

Budgets are per role, not shared. For both User and Ass. enabled:

| Turns/session | Initial scan and completion before idle | Settled or later live updates |
| --- | --- | --- |
| 1 | Up to 1 User + 1 Ass. | Up to 1 User + 1 Ass. |
| 2 | Up to 1 User + 1 Ass. | Up to 2 User + 2 Ass. |
| Positive N | Up to 1 User + 1 Ass. | Up to N User + N Ass. |
| Blank | Up to 1 User + 1 Ass. | All retained User + Ass. matches |

An unchecked role contributes zero. Actual counts cannot exceed the retained
matches satisfying the current needle and turn-time bounds; unused capacity
from one role is not transferred to the other. Title hits consume no turn
budget and never produce a separate match row. Zero is invalid, not a way to
disable turn previews.

Initial streaming reserves 44px times the smaller of the enabled-role count
and Turns/session (blank reserves one). Each reserved slot holds a preview and
possible continuation line. This is a minimum height, not a clipping budget:
with N=1 and both roles matching, both previews appear as they arrive.
Completion alone does not immediately reflow: 500ms without pointer movement,
keyboard input or wheel activity permits the settled column above. A completed
scan includes sessions stopped by a cap or error, so this layout transition
does not certify complete coverage. Clicking a visible −/+ explicitly opts
into its requested count immediately, including during acquisition. With a
blank budget, that click starts from the greater of the clicked session's
currently displayed User and Ass. counts. The minimum is one.

Acquisition traverses from the beginning and preserves discovery order.
Limited previews therefore keep the earliest retained matches of each role.
Live append hits fill unused slots or remain retained behind the display
limit; they do **not** evict earlier hits merely because they are newer.
For example, with N=1 and User hits U1, U2, then newly arriving U3, the row
still shows U1; the expanded view exposes U1, U2 and U3. A revised or removed
message can update or remove its hit, and source replacement can invalidate
the retained set. Those are content corrections, not a newest-first policy.
Settled rows do not revert to one-per-role reservations during live catch-up.
Changing the needle starts a fresh reservation. Role and time switches reuse
the settled layout; switching to both roles after a completed scan is immediate.

### Acquisition limits

Acquisition has separate named policy constants, with no settings UI:
`MIN_TURN_SEARCH_QUERY_LENGTH = 1`, `MAX_CACHED_MATCHES_PER_SESSION = 1024`,
`MAX_CACHED_SEARCH_TEXT_BYTES_PER_SESSION = 2 MiB`, and
`MAX_CACHED_SEARCH_TEXT_BYTES_PER_SCAN = 32 MiB`. Byte accounting charges two
bytes per JavaScript string code unit, separate from object overhead. At a
match or text budget limit the session stops, discards whole text, and retains
bounded excerpts/IDs. It restarts for the next needle. A reserved header notice
reports capped sessions; this is distinct from malformed-record coverage.
Backspace or another non-prefix edit starts fresh acquisition. Uncapped sessions
retain both roles and all timestamps, so role/time filtering does not reread
transcripts. Title-only search never initiates turn acquisition.

The 1024-match limit is combined across both roles, including acquired matches
currently excluded by role or time controls. It is not 1024 per role and is
independent of Turns/session. A text-byte cap may stop earlier. On reaching
either cap, this session stops acquisition for this needle and does not join
live tail; fresh matches do not displace retained ones. Refining the needle
rescans that session. An uncapped session reaching the current end remains
eligible for activity-driven tail continuation; reaching the end is a
point-in-time completion, not a claim that no future match can arrive.

## Selection and actions

Let S be explicit selected session IDs and F the current query and filters.
Displayed sessions are the whole catalog intersected with F. Checking a row
adds it to S without hiding any other row, and typing, clearing text, changing
filters, and excluding rows never change S. S therefore can include sessions
the current search hides.

Only selected is an explicit, default-off toggle that restricts displayed
sessions and acquisition to S intersected with F. It restricts nothing while S
is empty and resumes once S is nonempty again. With it on, narrowing is
selected-sessions narrowing, not a same-turn or same-line intersection of old
and new needles: after keeping sessions matching A, B can match anywhere in
those sessions. Clearing the needle preserves S; the red X clears S.
Browser Back restores the needle, filters, field checkboxes, preview limit,
explicit selection and Only selected from the URL and source-scoped history
entry. Leaving the page stops its scans; Back does not keep transcript caches
or subscriptions alive.

The summary displays a checkmark N, a labelled Select all M button, Only
selected, and the red X while S is nonempty. N opens selection management.
Select all M adds the current result session IDs, including matches below the
viewport, to S. It is disabled for zero results and when every result is
already selected.

Selection management appears after results, before the diagnostic log. At wide
desktop widths they occupy adjacent columns and the management list uses page
scrolling; narrower layouts bound its own scroll area. The list is labelled
and identifies each provider. Unselected sessions of providers without bounded
turn search are hidden from this management list for now; this does not clear
their selections or exclude their title hits from ordinary results. A selected
session is always listed, whatever its provider, because this list is the only
place a selection taken from a title-search row can be removed. It explains each excluded session's applicable project,
provider, executor, status, time, or selection restriction. For eligible
sessions without text matches it distinguishes ongoing search, incomplete
coverage, errors, and completed nonmatches. All fields unchecked produces an
explicit field-choice hint. Keeping results during a scan takes a snapshot of
matches found so far; late arrivals do not add to that selection.

Archive/unarchive, star/unstar and read/unread icons filter their statuses and
never choose an action. Opposites are exclusive; different pairs intersect.

While S is nonempty a bar fixed to the bottom of the page shows the selected
count, a clear control, and labelled icon-and-text actions: Archive, Unarchive,
Star, Unstar, Mark read and Mark unread. Each action appears only when at least
one selected session can change under it, so a selection of unarchived sessions
offers no Unarchive. An action updates the complete explicit selection,
including rows the current search hides, and clears S when it succeeds. An
operation keeps its original server transport across all batches, even when
the user switches servers while it runs. The page reserves bottom space while
the bar is shown so the last results and selection management stay reachable.

The checkbox owns a wide, full-height selection column. Role/ordinal chips
visually occupy that column and align against the preview's blue rule.
Clicking the column selects instead of navigating. Titles extend halfway
into it; provider metadata retains its usual indentation. Ordinary row and
links navigate, including while there is a selection. A normal click or tap on
a turn preview opens Zoom; its Open turn in session link navigates to that
position. Modified clicks and middle clicks on the preview retain direct
new-tab behavior.

## Previews and navigation

All Sessions and the in-session rail share excerpt generation and highlighted
text rendering: 24 characters before and 118 after the first match. A result
uses a stable normalized message ID; opening it loads older bounded pages
when necessary and jumps through the normal transcript navigation owner.

Title matches appear in the session title itself, with no separate Title row.
The title or matching opening prompt is fitted around the needle using the
actual available line width and inherited font, with ellipses on either side
as needed. Resizing recalculates that excerpt. Measurement runs in cancellable
tasks after the keyboard echo, reusing each title's canvas context rather than
blocking the input paint with layout effects.

Full-text tooltips load detail on demand. Clicking or tapping a turn match
opens Zoom preview directly; the match menu offers Zoom and direct navigation
to the turn in its session. Zoom shows:
full matching turn, a separator, and a bounded next assistant preview for a
user match or preceding user preview for an assistant match. Neighbor context
need not satisfy the search filters. Detail loading is abortable; unavailable
turns fail visibly. Retained whole text supplies tooltips immediately; after
cache eviction and on older servers, a tooltip fetches bounded transcript pages
by stable turn ID. Zoom subtly highlights the needle in the full turn and
places its first occurrence at the upper third of the scroll area when it
starts below that point and scrolling permits it. An occurrence already above
that point stays in place. Match menus dismiss on their trigger,
outside press, focus leaving the match, or Escape; Escape closes the menu
before its containing preview. Search match controls and preview text do not
activate the containing session hover card. The concise selection help sits
inline with filters only if it fits without another row; otherwise it follows
results immediately before the diagnostic log. Only diagnostic session titles
and filenames are links; byte offsets and error explanations are plain text.

Open turn in session lives in the detail header, outside the scrolling content,
so positioning a deep match cannot hide navigation. With Appearance's Session
right pane enabled, Zoom and the session-only match view use a right column on
wide screens (1100px+) and a right-edge drawer on narrower screens. They reuse
modal header/content chrome; wide results remain available alongside detail,
and the expanded desktop sidebar temporarily collapses. Closing nested Zoom
restores the match view. With the setting off, both retain their covering modal.
The all-matches arrow leaves the session menu's column clear.

### Session match interstitial

The expand action above a session's previews opens a maximized, session-only
match view. It shows every retained matching User/Ass. record under the current
needle, role and time filters, irrespective of Turns/session or the initial
one-per-role reservation. This is an opt-in display projection of the same
cache: opening it issues no extra scan and creates no subscription. Acquisition
and live-tail arrivals continue to update it. Results mount progressively in
40-row increments as the reader scrolls, with an explicit More control, so
"all" does not require mounting 1024 rich rows in one render.

The count means retained matches satisfying the current controls, not a known
total in the transcript. Capped coverage is explicitly labelled; the view
cannot recover records skipped by acquisition or go beyond its cache cap.
It preserves discovery order and does not jump to fresh arrivals. Full-turn
tooltips and Zoom share the normal match components. Clicking a match opens
Zoom; its Open turn in session link navigates to that position. Modified and
middle clicks on a match retain direct new-tab behavior.

Back to sessions, X, Escape or browser Back dismisses the interstitial. The
underlying page stays mounted, retaining its selection, query, limits and
scroll position. Other sessions remain part of that search; concealing them
does not change the set used by selection or acquisition. A nested Zoom closes
back to the interstitial. Unlike Zoom's immutable opened-turn snapshot, the
interstitial follows the live retained set for its chosen session, including
corrections and removals.

## Initial acquisition and compatibility

The maintainer approved this optional contract on 2026-09-14 after review of
v0.8.0 (2026-08-31) and v0.8.1 (2026-09-05). Permanent capability
`session-content-search`, ID 73, is version-implied from 0.8.2 and explicitly
advertised by source builds. Those two older releases keep title-only search,
disable Ass./User with upgrade guidance, and receive no requests to the new
route. No existing capability changes meaning.

`POST /api/sessions/content-search` takes one catalog session ID, query,
selected user/assistant roles, optional inclusive absolute timestamp bounds
`after`/`before`, and an optional opaque cursor. It returns bounded matches,
continuation, done/partial flags, bytes read and an optional unavailable reason.
Authentication and source access remain those of normal session routes.
The cursor binds the acquisition request, expires after 30 minutes, and becomes
invalid after server restart. Client refinement keeps that original broader
acquisition needle for cursor reads and filters returned whole text against the
current needle; no subscription update is needed. Completed batches return `resumeCursor`,
which resumes append acquisition from the verified native tail.
New batches also report replaced message IDs, so a revised message that no
longer matches removes its old hit. This optional delta is additive for older
clients.
Older servers without `resumeCursor` revalidate only the changed session from
its start.
`includeSearchText` requests whole matching text; `includesSearchText` confirms
complete text coverage even for an empty batch. Older servers ignore the request
field and cannot seed exact local refinement, so those sessions rescan.
`allowRestart` lets a native reader return an authoritative `reset` batch and
valid continuation after replacement, truncation, layout or boundary changes.
Normal appends continue quietly; unfinished final JSON awaits its next append
without a malformed-record warning. Legacy requests retain their original
source-version checks and 409 restart response. Expired cursors restart only the
affected session; acquisition errors do not stop the remaining traversal. A
session whose read failed keeps showing that reason, but it is neither resumed
from its tail nor adopted as cached text by a stricter needle: the next needle
reads it again.

Provider metadata advertises `supportsBoundedTurnSearch`, independently of
installation or authentication. The Providers menu explains which providers
support bounded turns and which remain title-only. Known unsupported providers
are excluded before content traversal and from its progress count, while their
titles and opening prompts remain searchable. Explicit server capability values
take precedence; older servers without this additive metadata field use the
known Claude-family and Codex-family reader support. The global route capability
still gates all turn requests, including on v0.8.0/v0.8.1.

The initial provider reader supports Claude-family and Codex-family transcripts.
It admits up to 128 native records and 8 MiB per batch, skips oversized or
malformed records with explicit partial coverage, and searches visible user
and assistant text rather than tool output or reasoning. Case, escaped display
line breaks, and whitespace runs are normalized using the preview rules;
Markdown-delimiter normalization from the index sketch
is not implemented. Ordinals count normalized visible records.

The native reader's separate 1,048,576-byte record limit (the append source's
`RECORD_BYTES`) applies to one raw JSONL line in bytes before JSON parsing or
text extraction. It is neither a
total-file size limit nor a limit on the cursor's byte offset. A transcript
larger than 1 MiB is traversed normally. A larger single record is skipped
through its newline and scanning continues with partial coverage. One record
can include large plain text, tool output, embedded image data or repeated
provider payload fields, so it need not represent a large searchable turn.
The current reader cannot classify skipped oversized records and conservatively
reports all of them; this may overstate missing searchable content. For
example, inspection of a reported 1,642,439-byte Codex `item_completed` record
found duplicated command output, not User/Ass. text. Improving that distinction
requires bounded record classification/extraction, not an unbounded parse.

The page shares a configurable number of concurrent batch slots across both
generations (Performance → Concurrent session file reads, browser-local 1–64,
default 4). Lowering the limit drains existing reads before admitting more;
raising it admits queued work without restarting the scan. Initial admission
orders eligible sessions by descending last modification/activity time, rotating
eligible sessions after each batch so a long transcript cannot starve later
matches. The server admits at most 64 concurrent requests; identical
in-flight native reads join one computation. There is no
persistent search job or transcript cache between requests. Legacy or manual
requests for unsupported providers return an explicit unavailable result rather
than a complete empty transcript result. The server decides that from the
reader it resolves for the session, so a session whose provider is absent from
the advertised list is still searched when its resolved reader reads bounded
turns; `supportsBoundedTurnSearch` stays the advertised hint clients pre-exclude
with. Resolving the reader needs the session's project, so an unresolvable
project answers 404 as it does for any other request on that session.
A stopped client produces no further batches; a shared in-flight batch is
bounded by its record/byte limits and timeout.

Older servers retain their own lower admission cap and busy/retry response.
The slider uses the existing request protocol and adds no required field,
endpoint or capability. Title-only mode still makes no file reads.

The default remains four after a local diagnostic comparison on 2026-09-30:
128 Claude JSONL files, 32,768 records, 67.3 MiB, three alternating-order passes
through the real bounded native reader on a 16-core Xeon 8559C, Node 24.14.0,
with the live YA/relay present. Four reads completed in 197–210 ms with first
batch latency 3.0–3.3 ms; 64 completed in 222–229 ms with first batch latency
51–57 ms. Warm-cache local storage is not a universal storage/relay optimum;
the slider permits tuning while keeping the measured responsive default.

A hidden document or page-hide event suspends content acquisition and aborts
the client's outstanding requests. Matches, coverage and cursors remain in
memory; summary changes coalesce while hidden. Visibility or page-show resumes
only unfinished and changed eligible sessions. Navigation/unmount permanently
stops that page's search. An already accepted shared server batch may finish
within its existing bounds, but a hidden or closed page requests no successor.

The existing source activity subscription supplies catalog and new-session
changes. Search has one eligible session-ID set, reconciled before scheduling:
project, provider, executor, status, Only selected and session-time filters
exclude sessions from content traversal. Counts use that same eligible set.
Unchanged sessions retain matches and coverage; changed sessions resume their
tail, and newly eligible sessions join the queue. No per-session network
subscription or periodic whole-catalog content rescan is created. New owned
session notices include model, executor and activity alongside title, project
identity/name, creation time, last activity and provider. Existing metadata
updates keep those rows current without a detail fetch for every notice.

## Server needle ownership: requested stopgap, not yet enforced

The target guard is at most one active acquisition needle per interested
viewer on the server. Here a viewer is one All Sessions window/tab, distinct
from its query revision and from a shared client connection. A new revision
supersedes that viewer's previous acquisition; old cached rows may remain as
the display buffer, but must not keep an old scanner alive. Retaining an
original broader acquisition needle for valid continuation cursors is allowed
within the one owned search. One needle may still fan out across sessions in
parallel: this rule does not serialize disk I/O to one request.

Multiple viewers, including two windows of the same client, can be supported
with independent ownership and bounded shared capacity. The maintainer also
accepts a conservative initial global last-writer-wins owner: a newer needle
in one window may interrupt another window's unfinished scan. Interruption
must remain distinguishable from successful completion; the displaced viewer
must not blindly retry and repeatedly steal ownership back. A later explicit
search or renewed foreground interest can reacquire ownership.

Ownership must be tied to observable interest: cancellation/supersession,
hidden or closed views and transport loss retire the owner's queued work;
accepted reads drain only within bounded time/bytes. Any lease-based form needs
bounded expiry when explicit cleanup is lost. Stale completions cannot publish
into a newer revision. Opening the session interstitial does not add an owner.
The ownership identity and protocol gate remain to be designed before changing
the wire contract; no TTL, request field or new capability is promised here.

**Current difference:** the page permits two client scan generations sharing
the configured batch slots (default four); the stateless server limits concurrent requests to 64 and
shares identical in-flight reads, but has no viewer/needle ownership guard.
Independent windows have independent client pools. Client cancellation stops
successor pulls; an accepted shared read may finish within its timeout. Thus
the current batch ceiling is not proof of the requested one-needle invariant.
The [acquisition gap](../gaps/all-sessions-search-index.md) tracks this work.

## Design decisions and remaining work

**Bounded request batches** (versus a new streaming transport): work over both
direct and encrypted relay HTTP without introducing another subscription
protocol. Results still arrive progressively.

**Title-only default** (versus automatic transcript scans): preserve fast hot
metadata search; disk work starts only when a turn field is selected.

An efficient disk-backed substring index for selected sessions and all sessions
is still absent. Word-boundary anchored matching remains an option to evaluate,
not an enabled query restriction. The open
[index and acquisition gap](../gaps/all-sessions-search-index.md) tracks this
and remaining provider/coverage limitations. Candidate indexing, maintenance
and measurement choices remain in the
[sketches](all-session-content-search.sketches.md).

Search and future index state stay in YA app data, never selected projects or
their Git metadata. Provider transcripts remain canonical.

Related contracts: [session catalog](session-catalog-observation.md),
[session detail](session-detail-data-layer.md),
[project storage](project-directory-storage.md), and
[capabilities](server-capabilities.md).

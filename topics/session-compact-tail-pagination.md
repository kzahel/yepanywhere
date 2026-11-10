# Session Compact-Tail Pagination

> `tailCompactions` on the session-detail API names the number of compact
> boundary markers to include at the top of the returned tail window, not the
> number of post-compaction message spans to count.

Topic: session-compact-tail-pagination

## Contract

For `GET /api/projects/:projectId/sessions/:sessionId?tailCompactions=N`,
the returned transcript window should start at the Nth compact boundary from
the end when at least N compact boundaries exist. The boundary message itself
is included so the client has an explicit "Context compacted" divider at the
top of the window.

If fewer than N compact boundaries exist, the endpoint returns the full
transcript. That preserves the intuitive "N compact windows" behavior for
short sessions: with `tailCompactions=2`, a session that has only one compact
boundary has only two windows total, so returning the beginning, the boundary,
and the current tail is acceptable.

For `tailCompactions=2`, the intended shapes are:

| Total compact boundaries | Returned shape |
| ---: | --- |
| 0 | full session |
| 1 | beginning, `C1`, tail |
| 2 | `C1`, middle, `C2`, tail |
| 3 | `C2`, middle, `C3`, tail |
| 100 | `C99`, middle, `C100`, tail |

### Compact scope and turn selectors

An uncursored session-detail read is authorized to inspect only the last two
compaction windows by default. The browser's Performance setting may request
one through twenty recent compact boundaries instead, or use Unlimited to send
`fullHistory=1`. The preference is browser-local: `null` represents Unlimited
in application state and the literal `unlimited` represents it in local
storage. The existing default remains two so upgrading does not broaden an
initial load.

`tailTurns` and `tailFrom` select a smaller suffix inside the compact scope;
they do not authorize reading across its older boundary. This distinction
matters because one provider turn can contain multiple compactions and
thousands of normalized rows, so a turn count is not itself a safe response-
size bound.

The effective start is the later of the compact-boundary start and the
turn-selector start. Consequently, `tailTurns=20` means "up to twenty turns
within the authorized compact scope," not "return twenty turns even if that
crosses older compactions." If `tailFrom` is older than the compact start, or
is absent from a provider-omitted prefix, the selector clamps to the compact
start. It must not return an empty page or clear `hasOlderMessages` while the
reader omitted known-hidden bytes; Load older and older-history reverse search
share that cursor. The browser preserves that twenty-turn narrowing for the
unchanged default of two boundaries. A custom compact-boundary value uses the
requested compact scope without that implicit turn selector, while Unlimited
requests true full history.

`fullHistory=1` is the explicit authorization to remove the default compact
scope. It may be combined with `tailTurns` or `tailFrom` so the server selects
a bounded suffix from the full transcript without sending the full transcript
to the client first. Without `fullHistory=1`, those selectors can only narrow
the default or explicitly requested compact window.

| Query | Effective scope |
| --- | --- |
| no query | last two compaction windows |
| `tailTurns=20` | up to 20 turns within the last two compaction windows |
| `tailFrom=<id>` | from the id only when that is later than the compact start; otherwise clamp to the compact start |
| `tailCompactions=5` | last five compaction windows |
| `fullHistory=1` | full transcript |
| `fullHistory=1&tailTurns=20` | last 20 turns across the full transcript |

The setting applies to initial loads, reconnect catch-up, and bounded recovery
from a stale or missing incremental cursor. `afterMessageId` remains an
incremental cursor rather than an initial history scope. If that cursor cannot
be found, the route keeps the explicitly requested compact bound; with no
explicit bound it uses the server default of two. `beforeMessageId` remains the
explicit older-page cursor. Load older deliberately requests fixed two-boundary
pages independent of the initial-history preference.

An anchorless full-history response is authoritative for the loaded window and
replaces any retained same-tab transcript. Warm reconciliation may merge only
when the request actually carried `afterMessageId`; a cached message id omitted
from an Unlimited request cannot turn its response into catch-up. This keeps an
upgrade that changes durable message ids from retaining old-id and new-id copies
of the same provider rows.

If an `afterMessageId` request fails at transport, relay, decode, or server
handling rather than returning a response, the mounted client performs one
uncursored request with the same compact-tail bounds inside the existing
per-session in-flight coordinator. A successful response atomically replaces
the loaded tail window. If that reconciliation also fails, the attempt stops;
it creates no timer or internal retry loop. Later external activity may start
another coalesced attempt. Diagnostics are available in development or during
explicit remote-log collection, limited to one report per route per 30
seconds, and state how many failures were suppressed.

### Provider-bounded source windows

For a plain Codex rollout with a durable summary of an unchanged or append-only
prefix, watcher dirty state alone must not disable the bounded tail read. The
selected summary is retrieved by its scoped SQL key; serving the detail does
not require loading the project's other summaries. Source replacement, rewind,
and reference-backed history retain their existing validation and fallback
rules.

A provider may omit a known-hidden source prefix before normalization when it
can preserve a source-backed older-history cursor. A compact-boundary start uses
the boundary's stable message id. If a turn selector narrows the visible window
past that boundary, the cursor encodes the first visible row's source position
without replacing that row's durable message identity. In either case
`hasOlderMessages` and `truncatedBeforeMessageId` remain authoritative.
For Codex byte windows, `totalMessageCount` and `totalCompactions` describe
the available source window because skipped bytes were not counted. Indexed
Claude selections retain full-projection totals, as described below. The route rejects a provider-bounded
response whose omitted prefix lacks the older-history boolean or cursor instead
of presenting the suffix as the beginning of the session.

#### Indexed head fields for a session still being written

Omitting that prefix needs head-derived summary fields the window itself does
not contain — title, creation time, originator, provider — which the Codex
reader takes from the session index. A session Codex is actively writing grows
between index passes, so requiring an exactly-current index surrendered the
bounded window at the worst possible moment: opening a long session mid-turn
then read and normalized the whole rollout.

An append-only transcript that has only grown still has an accurate indexed
prefix. The index may therefore supply those head-derived fields while the
window is read from the live file, and the response re-derives what the window
carries: `updatedAt` comes from the live file, and the model and context usage
come from the window whenever it contains them. `messageCount` stays the
indexed count and lags a session still being written; it feeds session-list
ordering and the empty-session check, neither of which needs an exact count. An
older page refreshes nothing, because it is not the session's current state.

A file that shrank, or whose size held while its modification time moved, was
rewritten rather than appended to, so its index describes different bytes and
is refused. A hint claiming to be newer than the file means the rollout was
replaced or rewound, and also falls back to the complete reader.

#### Indexed Claude selections

Claude bounded detail uses a source/compaction index under the existing cache
owner. Compaction positions follow the complete visible forest projection,
including rewound groups and sibling work. Hydration may read noncontiguous row
references; private `indexed-selection` metadata therefore describes logical
pagination, not a contiguous source range. Older selections end at their UUID
cursor, and global queue IDs/turn ordinals and full-selection pagination totals
remain unchanged. Task snapshots include omitted prefix state. Valid cursor
catch-up hydrates the anchor and subsequent selected rows, including late queue
delivery. Complete history and over-budget/unsupported cases retain the complete
reader. Source generation is captured with the summary and validated before
selection; projection generation and append evidence fence hydration.

The first unseen-source index build still streams history, and metadata
reselection can revisit history after branch/provisional changes. Persistence,
restart and full-host qualification remain open. The
[Claude index evidence](../docs/research/190-claude-source-index.md) distinguishes
warm append gains from those remaining costs. No client capability or public
response shape changes.

#### Incremental catch-up

For a large plain Codex rollout with usable indexed head fields, an
`afterMessageId` request first tries the requested compact window (two
boundaries by default). The reader verifies the durable id in that window;
the route then returns only the rows after it. A successful incremental
response does not acquire older-page pagination metadata merely because the
reader omitted a prefix: the client already owns the cursor's earlier rows.
Message ids and the API response shape remain unchanged.

Cursor selection happens after actual provider resolution. A Claude-default
project can contain Codex sessions; both managed and unbound Codex sessions
must retain cursor/window intent. The resolved Claude indexed reader retains forest metadata while hydrating the
requested selection; complete fallback reads retain full forest context before
route slicing. This fixes route suppression without relying on project defaults.

Shared append validation may read fixed head probes of at most 1 KiB, even for
a bounded suffix. Those probes do not parse or hydrate the omitted history.

The reader retains and incrementally extends only that source suffix. An
unchanged file reuses its normalized projection without a reverse scan;
appends parse only new bytes. A new compaction or a changed requested boundary
count selects a new suffix, releasing the prior cache. A complete read and a
bounded read share the existing per-session read owner but cannot reuse each
other's differently scoped entries. Only a complete read may cache the
session's subagent mappings: a suffix describes the spawns inside it alone, so
caching from one would report a session with earlier subagents as having none.
Retained source-byte accounting measures the suffix rather than charging the
entire file.

An id outside the candidate window, an unknown id, or a tool result whose call
precedes the window uses the complete reader. This preserves catch-up across
arbitrarily old cursors and tool-specific result interpretation. Unknown ids
still receive the route's existing bounded recovery response. Missing or
invalid summary hints, compressed rollouts, reference-backed forks, and files
below the compact-tail crossover retain the complete-reader path;
`fullHistory=1` also bypasses this optimization. The next eligible recent
cursor replaces a previously cached complete transcript with its suffix.

**Design decision:** reuse the append cache with an explicit source start
instead of keeping a second full-transcript cursor index or reparsing the tail
on each request. This bounds ordinary catch-up retention while preserving warm
parse/normalization reuse and the established fallback for old cursors.

A diagnostic on a deterministic 20,000-message, ten-compaction, 13.8 MB
rollout compared complete and two-boundary incremental reads in three paired
process runs. Both returned exactly the expected zero-to-three appended rows.
Retained heap fell from 26.1 MB to 5.6 MB; retained entries from 20,014 to 4,005;
source-byte charges from 13.8 MB to 2.8 MB. Warm read/normalize/slice totals
were 3.8–24.0 ms versus 1.2–4.5 ms. Re-parsing the bounded window on each call
was separately measured and rejected because it lost warm-cache performance.
These are diagnostic measurements on a shared 16-CPU EPYC 7R13 Linux host
(Node 24.14.0), not latency ratchets or an attribution of the original live
session's stalls. Host capacity, load, memory, and swap were sampled at both
ends; pressure telemetry was unavailable. The original gap did not establish
a user-visible symptom or repeated full parsing.

## Why This Matters

The previous boundary condition used `totalCompactions <= tailCompactions` as
the full-history case. That made a session with exactly two compact boundaries
return the initial prompt and all pre-compaction history for the default
`tailCompactions=2` request, then abruptly shrink once a third compaction
arrived.

That discontinuity is user-visible on long Codex sessions because provider
JSONL can expand a modest number of user turns into hundreds or thousands of
normalized render rows. A syntactically bounded `tailCompactions=2` request can
still be expensive if the exactly-two-boundary case returns the entire
transcript.

## Older-Page Pagination

`beforeMessageId` uses the same rule on the prefix before the cursor. If that
prefix contains at least N compact boundaries, the older page starts at the
Nth boundary from the end of that prefix and reports `hasOlderMessages: true`.
The next older-page request can then fetch the pre-boundary prefix. This may
require one additional page compared with the former full-prefix behavior, but
it keeps every page shaped like the requested compact tail.

For a large plain Codex rollout with a fresh indexed summary, the cursor carries
an absolute source byte position. The reader scans backward in fixed blocks from
that position and parses only the preceding page. Reaching fewer than N prior
boundaries reads `[0, cursor)` and completes traversal without rereading the
newer suffix. Load older and older-history reverse search issue the same fixed
two-boundary request, so both traverse an incompletely loaded rollout through
this blockwise path. Old, unparseable, compressed, or stale-summary cases retain
the complete-reader and stale-cursor recovery behavior.

The session transcript treats a visible older-page control as demand to reveal
at least one earlier real user turn, or to reach the beginning of history. One
demand may therefore follow several `truncatedBeforeMessageId` cursors through
assistant, tool, compact-summary, and other synthetic-user-only pages. Each
server response remains bounded to the existing compact-tail page contract;
the client performs the continuation and older servers need no new route,
field, or capability.

An empty older-page response while the loaded window still claimed older
history is a stale cursor, not proof that history ended. This can occur when a
server reload changes normalized message identity while a client tab retains
the prior cursor. The client performs one bounded uncursored tail refresh,
replaces the current tail with that fresh truth, and continues the same older-
history demand from the refreshed cursor. It never applies the empty terminal
page or retries cursor recovery internally more than once. A failed recovery
leaves the existing older-history control available for later explicit demand.

The continuation pauses after eight pages or after retaining approximately one
session-detail cache budget of additional transcript data, whichever happens
first. If older history remains and no real user turn was reached, the client
shows that it paused and leaves the button available for an explicit next
batch. This makes arbitrarily deep traversal possible without letting one
scroll gesture monopolize memory or the network.

The control automatically starts one such demand when it enters the transcript
scrollport, while retaining the button as the no-observer and explicit-retry or
continuation fallback. If a request fails without advancing the cursor, leaving
and re-entering the boundary permits one new automatic attempt; a continuously
visible failed cursor does not create a retry loop. Every multi-page prepend is
one scroll-preservation transaction, so the reader's current transcript
position remains stable. After that demand settles, a continuously visible
boundary does not start another demand: it must leave and re-enter the
scrollport, preventing automatic history drainage beyond the user-turn or
safety boundary.

Keyboard navigation at the loaded boundary is explicit demand, independent of
that passive visibility latch. A non-repeated `PageUp` that settles at the top
starts one older-history demand. Previous-turn `Home` starts one demand when no
earlier loaded user turn exists. Key repeat does not start additional demands;
after a batch settles, another distinct key press may request the next bounded
batch. The same prepend anchoring and per-demand user-turn/safety limits apply.

Claude may restore the logical selection from its profile-owned SQL source
index after restart/eviction. Compaction ordinals, cursor ranks, group starts and
late deliveries are indexed; only selected payload is acquired from the native
file. Persisted source evidence, projection revision and rewind context must
match before publication. The same full totals, task/turn overlays and enclosing
rewind groups survive restoration. A changed rewind context reconstructs the
existing selector from compact SQL facts; it does not treat a physical tail
marker as complete branch evidence. Unknown/oversized selections retain the
existing complete catch-up behavior.

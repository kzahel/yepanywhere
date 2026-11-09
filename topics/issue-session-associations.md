# Issues and PRs associated with sessions

Topic: issue-session-associations

Implemented: 2026-09-10. Experimental and default off.


Association, evidence and session-link keys use the YA session id. Background
Claude/Codex indexing resolves the stored native source in its original
transcript project and storage scope; project filtering and session links use
the effective working project. Native catalogue publication is projected at
this consumer boundary without changing physical catalogue keys. A stored
unbound or missing source cannot read an ambient same-string transcript, and
a bound association requested under another project is unavailable.

## User contract

Enable **Settings → Issues & PRs** on a server with ready SQLite. The sidebar
then exposes issue search, and session headers link to their associated issues.
One glyph stands for the feature in the settings list, the sidebar and that
header link; the settings list carries it in every selectable icon style.
Ordinary authenticated session viewing automatically captures references from
persisted user/assistant text already delivered by the session route, including
incremental updates and older pages. Manual linking is not an admission step.
Public shares neither trigger capture nor receive these records.

When enabled, session user prompts and assistant prose link known Jira keys
and GitHub issue/PR references directly to their tracker destinations. Links
use discovered destinations without waiting for fetched titles, bodies, or
authentication. The session owns one shared read for the header and transcript;
its bounded discovery rechecks update already displayed mentions without reload,
including on phones where the header control is in the session menu. The same
latest-reference page (up to 100 items) supplies both surfaces.

Unknown destinations and ambiguous keys remain plain text. GitHub shorthand
(`repo#42` or `#42`) links only when it has one destination in that page.
Existing links, project-file links, and rendered Markdown code/math remain
intact. Links open a separate tab and change presentation only: original prompt,
transcript, and copied source text remain unchanged. Public shares do not gain
private issue destinations, and disabling Issues & PRs removes these links.

The default scope is **Viewed session windows**. **Sessions active recently**
additionally indexes sessions whose catalog activity is within a configurable
1–90 days, default 7. This selects sessions, not individual message dates: an
eligible session's history can contain older messages. Viewed older sessions can
still contribute their viewed windows. Background readers currently support
Claude and Codex; other providers retain viewed-window capture where persisted
normalized text is available. Compressed Codex sources cannot be read by this
background adapter.

Search uses literal, case-insensitive substrings of stored keys, URLs and titles.
Fetched confirmation subjects also participate in substring search, even when
a manual title overrides the displayed subject. Display prefers the manual
title, then the fetched subject, then a descriptive observed link label. This
also searches durably fetched descriptions. Canonical content subjects take
precedence over legacy confirmation subjects. Search itself makes no tracker
requests and list responses never carry complete bodies. Selected tickets show
the cached plain-text description; fetching it does not require downloading
other tickets' bodies. Jira v3 requests explicitly include `summary,description`;
ADF text, paragraph breaks, link destinations and smart-link card URLs become
searchable text. Remote smart-card preview metadata and attachments are not
fetched. GitHub uses the issue endpoint's `body`, including for pull requests.

The refresh and settings controls are compact icons with accessible names and
44-pixel targets. Normal refresh scans all stored canonical ticket URLs,
including old-session references, for missing or expired content. It respects
a shared subject/body TTL, default two weeks, including 404/410 negative results.
Right-click, long-press or Shift+F10 on refresh immediately rechecks all tickets,
ignoring cache age, without opening a menu. This bypasses TTL, including cached
misses, but respects retry cooldowns and provider rate limits. Selecting a ticket
requests the same revalidation for that item; saved content remains visible.
Concurrent requests coalesce, with at most the latest selected item retained
for a follow-up pass.
These actions refresh already discovered references; they do not read previously
unindexed session transcripts.

Settings provides two cache-lifetime sliders: **Subject & body** defaults to
two weeks for both Jira and GitHub; **Status & comments** defaults to five
minutes and currently controls GitHub status checks only. Comments are not
fetched yet. Both sliders have discrete stops from one second through
**Never expire (∞)**. A drag updates its displayed value immediately and saves
when released; keyboard changes save on key release. Expiration only permits
a later refresh/view to fetch again; it never starts a polling timer. Never
expire still permits initial acquisition, explicit content revalidation and
status-cache clearing. Failed requests retain their separate retry cooldown.
The settings response supplies `contentTtlSeconds` and
`statusCommentTtlSeconds`, with `null` meaning never expire. Older servers omit
these fields, so clients hide the controls; older clients omit them on save,
so servers preserve the saved values.

Refresh runs serially, pauses one second between requests, reads at most 50
candidate identities per page, and yields between cached pages. Requests time
out after ten seconds and responses are bounded to 2 MiB. ETag and Last-Modified
validators are used when returned; a 304 advances validation time and retains
the body. A provider without validators receives a normal GET. Transient errors
preserve prior content without marking it fresh and impose a five-minute retry
cooldown. Rate limits stop the pass and persist their retry deadline across
restarts, with no automatic retry timer. Refresh progress and failure counts
appear beneath the toolbar. A stopped/restarted server needs another refresh;
completed per-ticket results survive, so regular refresh skips them.

Content is stored once per canonical tracker identity in `issue_content`, in
app-data SQLite. A 404/410 removes previously saved content for that ticket;
other failures retain the last good text. Deleting an item cascades to its
content. Public HTTPS Jira tickets and github.com items can be fetched without
credentials. Jira credentials are sent only to the exact configured site and
context path; GitHub credentials only to api.github.com. Redirects are refused.
Unsupported hosts/protocols count as failed attempts. Public shares receive no
cached tracker content. Explicit refresh requires Issues & PRs enabled, while
automatic confirmation retains its separate setting and once-per-reference
policy. That first confirmation now retains description text from the same
response when the fetched site's canonical record exists. Existing subject-only
confirmations remain eligible for normal refresh.

The optional `contentRefresh` response field advertises the refresh and cached
content routes. Clients connected to earlier servers retain list-only refresh
and offer no force-refresh action or body read. Disabling the feature or changing
its settings fences in-flight content publication. The fuller first-mention
TTL policy, indexed search/highlighting and comments remain in the
[content-search sketch](issue-session-associations.sketches.md).
Pasting a full URL finds its canonical record. An exact lookup, `GET /api/issues?ref=<url>`,
matches only the item whose canonical identity the URL names, from any URL a
browser shows for it: GitHub subpaths such as `/files`, either the `issues/`
or `pull/` path for the same number, and Jira board or backlog URLs carrying
`selectedIssue`. The response echoes that identity as `ref`. A `ref` that
names no tracker item matches nothing rather than falling back to `q`.
Clients send `q` with `ref` and keep only items whose `id` equals the
identity, so a server that predates `ref` still answers exactly, except for
an item stored under the other GitHub path. Search and evidence pages default
to 50 rows and accept at most 100. Project/session filters apply before the limit.
The browser content scrolls vertically within the app while its page header
remains visible. Long result lists, pagination controls, and association evidence
remain reachable at desktop and phone widths. Controls and evidence cards use the
app theme colors, typography and focus states. Results occupy the available width
until an issue is selected. Desktop shows issues beside their associated
sessions; phone shows the selected issue's sessions, with the close control
returning to the issue list. An active issue-title/link editor remains visible
in the list on phones.

A shared ticket glyph identifies Issues & PRs in the sidebar, settings category
(including emoji icon mode), and the session header. The session shortcut is a
compact icon button carrying that glyph and its count at every width; the
feature name lives in its tooltip and accessible name rather than in a
word-wide chip. At every width it matches the adjacent session Share control's
22-pixel chip height, 14-pixel glyph, padding, and surface treatment; enabling
Issues must not make the mobile header taller. Menu rows retain 44-pixel mobile
touch targets. Discovery settings use the standard searchable settings rows and
toggle, with scope guidance above the control.
Bare Jira keys require a known project prefix by default. Unknown bare keys are
retained as inactive candidates, without creating an issue/session link or
appearing in search or session counts. **Match unknown ticket keys** is an
explicit opt-in that exposes these candidates as references with **Issue link
unknown**. Their issue menu accepts a matching full URL through **Add issue link**. Markdown labels
supply observed titles; a user can override a resolved item's title. A label
that only names the item (`#42`, `repo#42`, `PR #42`, the key) is not a title,
and neither is the label of a link into part of the item, such as a changed
file or a comment anchor. Because the first observed title is kept, titles
saved under the earlier rules are read through the same test; a manual title
is shown as chosen. Discovery
itself makes no tracker request and changes no external issue; the only
outbound requests come from the opt-in confirmation step below.

Coverage distinguishes viewed windows, queued/indexing, indexed, partial,
unsupported, failed and outside-scope jobs. Counts describe acquired sources,
not the whole transcript corpus. Empty search results explicitly refer to indexed
content. The page refreshes while its worker is active; there is no idle global
client poll. Refresh reloads results, rather than forcing a full scan.

The session header button carries the count of that session's undismissed
associations, read from one page of the same search route, so more than a full
page reads as `100+`. That count also says in advance how many rows the button
opens: pressing it opens a menu built from the page already read, so the menu
costs no further request and the session stays on screen. The menu has a
**Pull requests** section first, shown whenever the session has any
association and saying so when none is a PR, then **Issues** for everything
else. Each section lists its latest mention first, unknown times last. At most
twelve references are listed; each section keeps six rows and lends the rest to
the other, so a long ticket list cannot push every PR out of view. A note names
how many more the full list holds, and a final row opens that list filtered to
this session. The header first asks without a sort; a server advertising
**Recently mentioned** is asked in that order from then on, immediately when
the key-ordered page was full, so the page it reads holds the latest mentions.
Each row links at its tracker URL when one is known and at the same filtered
list otherwise, so a left click follows the reference and a middle or
modifier click opens it in a new tab. Only the navigating click closes the
menu, so several references can be opened into tabs in turn. Hovering or focusing a row describes it
before the click: full title, key, provider, kind, how many sessions mention
it, whether its tracker context is still unresolved, and where the click
leads. Because indexing this session's own text starts when the
session is opened, the first answer usually predates it: the header asks again
a bounded number of times, sooner while the server reports active indexing, and
restarts that sequence when the transcript grows. It then stops rather than
polling. A count the server does not currently confirm shows no badge at all,
so the number on screen is one the client actually read, and a later
association can go unnoticed until the session is reopened or extended.

## Learned Jira projects and matching rules

A supported absolute Jira browse URL in persisted user/assistant message text
teaches its ticket prefix and canonical site/context path automatically, without
an external request. For example, `https://tomfit.atlassian.net/browse/TF-3996`
teaches `TF → https://tomfit.atlassian.net`. Query strings, fragments and URL
credentials never enter a mapping. Tool-call commands/arguments, tool output,
reasoning, and setup remain excluded. Command-only tool evidence is deferred.

Mappings persist in `jira_project_sites`, independently of the originating
session or issue. Settings lists the learned prefix/site pairs. One known site
for a prefix applies across this server's code projects and sessions. Multiple
sites stay distinct: exactly one learned site in the current code project can
resolve a bare key; otherwise it remains ambiguous. Explicit URLs always retain
their own site. No personal Jira site is hardcoded.

The existing editable prefix blocklist excludes bare-key matches, including old
ones and learned prefixes, but never explicit URLs. Confirmed manual association
decisions remain authoritative. Aggressive matching defaults off for both new
and existing installations lacking an explicit setting; the feature itself
remains experimental/default-off. Turning aggressive matching off hides unknown
candidates immediately. Changing exclusions or learning a mapping reconciles
stored candidates in bounded batches, preserving titles, occurrences and explicit
dismissals. Restoring an association explicitly clears occurrence suppression.

Migration 7 adds the mapping table and a durable `issue_registry_work` cursor.
It schedules work only: the existing worker first learns from stored URL/manual
evidence, then resolves candidates, in transactions of at most 25 evidence rows
with a yield between turns. Restart resumes the cursor. No provider reads or
large backfill occur in migration initialization. Rule changes coalesce into
that worker; unchanged sources and idle clients introduce no recurring work.

## Associated-session browser

The issue list defaults to **Recent session activity**: the latest retained
catalog activity among sessions with visible evidence for that issue.
**Recently mentioned** instead uses the latest source-message timestamp, so
indexing an old conversation today does not make it a recent mention.
**Issue number ↑** groups by tracker and project/repository key, then orders
numbers numerically (9, 10, 100). Reference key and canonical identity break
ties; missing or invalid activity/mention timestamps sort last. Search,
project/session scope and dismissed filtering apply before aggregation and
pagination. Refresh reads the current catalog; sorting adds no idle polling,
transcript reads, durable activity copies or migrations.

Each row keeps its key in the identity line, next to a colored Jira, GitHub
issue, or GitHub PR badge; unknown GitHub types say GitHub reference. Type icons
and labels carry the distinction without relying on color. Type colors never
claim open, closed or merged state; only a [tracker status](#tracker-status)
badge does, and only when the server reported one. A title, when available and distinct from the
key, occupies its own line. Session count and the chosen recency basis sit
below it; number order shows session activity. Unknown times are explicit.

`GET /api/issues` advertises `supportedSorts` and echoes `sort`, with additive
`lastSessionActivityAt` and `lastMentionAt` on items. Clients learn support from
the first ordinary search response before sending a sort parameter. Earlier
experimental servers without this advertisement retain **Reference key A–Z**
and get no sorting parameter; omitted sort preserves the legacy wire order.
Each issue's overflow
menu owns display-title editing, adding a missing issue URL, and deleting the
saved item. A cleared display override falls back to its observed title, then key.
Coverage counts and the dismissed-association filter live in a collapsed discovery
disclosure. Ordinary browsing does not require confirming or dismissing items.

The right pane renders one row per distinct canonical YA session, reusing the
sidebar's compact `SessionListItem` and shared themed hover detail. Navigation
and Native tooltip preferences retain the shared row behavior. Association
corrections live in a per-session overflow menu; a correction affects the whole
issue/session relationship, not one displayed mention. Per-occurrence correction
and tool evidence remain deferred.

**Last activity ↓** is the default, using the retained session catalog's activity
timestamp (including agent activity), not indexing or mention insertion time.
**Last activity ↑** reverses the known timestamps. Unknown activity sorts last in
both directions; canonical session ID breaks ties. Rows display the activity age,
or explicitly say the activity time is unavailable. This differs deliberately
from the sidebar's browser-local visits/submissions chronology. Refresh reloads
the ordering; background agent output does not continuously reorder this pane.

`GET /api/issues/sessions` groups and sorts before pagination (50 sessions by
default, maximum 100). It loads source summaries only for the returned page and
returns one initial mention per session. Mentions sort by source-message time,
then occurrence ID; unknown source times follow dated mentions in occurrence
order. Expand loads further mentions through session-filtered
`GET /api/issues/evidence`, in bounded pages. Collapsing preserves loaded mentions,
and so does a refresh: a confirm, dismiss, title save, or the Refresh button
reloads the rows in place, leaving every row expanded over the mentions it has
already loaded, with the initial mention replaced by the reloaded one. Each
reloaded answer, including one for a changed dismissed filter, re-fetches as
many further mentions as the row had loaded, under that answer's filter and
ordering, so loaded pages never mix two lists; a page requested before the
reload is discarded, and an expanded row still waiting for its first page asks
again. Only choosing a different issue empties the pane back to
its loading state.
Dismissed evidence stays hidden unless the filter includes it. Unavailable source
sessions keep historical excerpts but have no navigation or preview request.
Selections, expansions and asynchronous responses belong to the selected source;
switching servers or issues cannot append an earlier source's evidence.

## Tracker confirmation

Shape alone cannot separate a bare Jira key from ordinary prose: `UTF-8`,
`ISO-8601`, `COVID-19`, `RFC-2119` and `SHA-256` all match the pattern. Two
defences need no network. A Jira project key is at least two characters, which
excludes `H-1` structurally. `jiraKeyBlocklist` names project parts to ignore,
prefilled with the common offenders and editable to any list, including none.
Blocking applies only to keys seen without a URL, so a tracker whose real
project key is on the list keeps working through browse links.

**Settings → Issues & PRs** then offers opt-in confirmation, off by default:
turning it on is what authorizes an outbound request carrying a credential.
With it on, a reference seen for the first time gets exactly one lookup, GitHub
by repository and number and Jira by key against the configured site and
account email. A confirmed reference gains the tracker's own summary, the first
title that does not depend on someone having written a Markdown link. A missing
item is recorded as rejected, and a failed or unauthorized lookup as
unreachable. A rejected reference is hidden from search, the session header's
count and menu, and the Issues page, as a dismissed association is; the
dismissed filter shows it, and an exact `ref` lookup still finds it. A
confirmation from any project outranks a rejection.

One question per reference is the whole retry policy, and it lives in the
schema rather than in a scheduler. `issue_confirmations` takes a pending row
when a reference is first captured, and only while confirmation is on, so
enabling the feature never sets a backlog loose. The insert ignores conflicts,
so a reference holding any verdict, unreachable included, is never asked about
again by itself. Nothing polls. `POST /api/issues/confirm` is the only second
question and belongs to an explicit user action. It also asks the first
question for a reference that has no row, because it was captured while
confirmation was off: the automatic path leaves that backlog alone, and the
explicit request is what authorizes the one lookup. It asks only about a
reference YA captured: when no evidence in that project holds that provider and
key, it answers 404, writes no row and sends nothing to a tracker, so a typo or
a stale client cannot spend the user's credentials on a key YA never saw.
Overlapping drains coalesce:
a recheck arriving while a capture-triggered lookup is still out joins that
work instead of starting a second pass over the same pending references, so
one reference costs one request however many drains overlap, and the recheck
answers only once a pass has settled its own row. Verdicts are per project, and
the most decisive one wins across projects: one project confirming a key
settles it even if another recorded only an outage.

GitHub status checks have their own **Check GitHub issue and PR status**
control, independent of reference confirmation. When the new setting is absent,
status checks retain the historical confirmation-enabled policy. Explicit false
is preserved; changing confirmation in a current client preserves the separate
status choice. Credential inventory is requested only while confirmation or
supported GitHub status checks are enabled.

**Allow GitHub CLI credentials** defaults on for enabled lookups. Turning it off
prevents this integration from invoking `gh`, including account/presence probes.
**GitHub CLI account for YA** can use the active CLI account or a named signed-in
account. A named account takes priority over stored/environment tokens and uses
`gh auth token --hostname github.com --user <account>` with token environment
overrides removed. An unavailable named account fails without credential
fallback. YA never switches the global CLI account. Settings names the active
source and CLI account when known, and never returns a token. The account list
comes from bounded `gh auth status` execution, keeping only non-secret identity
fields. No token enters the status database.

Without a named CLI account, credentials resolve from a key stored in Settings, then environment variables
(`YEP_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`; `YEP_JIRA_API_TOKEN`,
`JIRA_API_TOKEN`, `ATLASSIAN_API_TOKEN`), then, for GitHub, the signed-in `gh`
CLI. The settings pane names every source and says whether it is present; no
route returns a key to a client. The pane requests inventory only while a tracker feature is opted in, so a
reader who never opts in never causes CLI sources to be probed. Stored keys are written to
`{dataDir}/issue-credentials.json` with owner-only permissions rather than into
server settings, which the settings route hands to any authenticated client.
Both credential routes stay reachable while discovery is off, so an
installation can be configured before it is turned on.

Both credential override inputs start empty and clear after a successful save,
regardless of the active credential source. They mask newly entered keys and
request no existing-password autofill or password-manager save/fill handling;
browser-native password-saving prompts remain under browser control. The
source inventory, rather than password dots, indicates configured credentials.

## Tracker status

While GitHub status checks and discovery are enabled, viewed GitHub issues
and PRs on `github.com` acquire the state GitHub last reported: Open, Draft,
Merged or Closed for PRs; Open or Closed for issues. Badges appear in the session
header, Issues page and extension session panel. Absent/unknown states show no
badge. Jira status and Enterprise hosts remain deferred. These operations only
read GitHub metadata, even when the underlying token has broader permissions.

A `GET /api/issues` read returns cached facts and queues returned items whose
state is missing or older than the status/comment TTL (default five minutes).
Merged facts never automatically
expire or refresh. A failed lookup retains the last successful state/check time
and persists a five-minute retry delay. Readers share one server-wide pass,
with up to 50 items per GraphQL query and at most 200 queued/in-flight items.
There are no server polling timers or startup GitHub requests.

`issue_tracker_status` in `{dataDir}/discovery.sqlite` holds one row per canonical
item, shared by every mentioning session: state, successful check time, last
attempt time, GitHub node id, actual merge date and merge commit SHA. Reads load
only the requested page; memory retains at most 2,000 entries. The existing
`IssueStore` owns SQL and batches each response into one transaction. Deleting
an item removes its status by foreign key. Cache writes cannot recreate deleted
items or replace a terminal merged fact with an older/nonmerged answer.

Disabling checks stops lookups but keeps cached facts visible. **Clear cached
status** (`DELETE /api/issues/status`) deletes only tracker facts/retry times,
including merged facts, and fences in-flight answers so they cannot undo the
clear. Enabled checks can acquire facts again on a subsequent view. This action
is available even with discovery disabled. Changing credential/lookup policy
while a response is in flight prevents that response from being published.

A response carries `statusRefreshing: true` while relevant items are queued or
in flight. The session header and Issues page keep their bounded follow-ups.
The extension session panel follows up after 1.5 seconds at most three times,
coalesces interval/manual requests, and tears down follow-ups on navigation or
close. Its ordinary visible refresh remains 30 seconds.

The extension groups known merged PRs under **Merged PRs (N)**. Open, draft,
closed-without-merge and unknown-status items stay in the ordinary list.
**Browser extension → Collapse merged PRs** is browser-local and defaults off;
when enabled, each session's merged section starts collapsed. Manual expansion
survives refreshes and new facts; changing session or the preference resets the
initial expansion. Expanded rows show merge date and abbreviated commit SHA;
status tooltips expose the full SHA and check/merge times. Counts describe the
items returned in the session's existing bounded list.

## Identity and evidence

Which message text the index may see is not the feature's decision: the visible
user/assistant projection (`sessions/message-text.ts`) and the Codex source id
(the normalizer's `getCodexMessageSourceId`) are owned by the shared transcript
path, and the issue index consumes both. Nothing under `sessions/` imports
`services/issues`, so a change to this feature cannot alter a session read.

`services/issues/extract.ts` recognizes Jira browse URLs and uppercase Jira keys,
GitHub issue/PR URLs, and repository-qualified `owner/repo#123` references.
A bare `#123` needs explicit issue/PR wording and exactly one GitHub repository
URL in the same bounded text window. Arbitrary bare numbers are ignored.
Nothing inside a fenced code block (``` or ~~~, to its closing line or the end
of the message) is a reference, and a repository URL there gives no context
to a bare number: such blocks hold sample output, fixtures and logs. Fences
are found over the whole message, so a chunk read from inside a long block
knows it is in one. Inline code and indented blocks are still read. Generic
Jira deployments may have context paths. GitHub Enterprise issue paths are
recognized on `github.*` hosts; `/pull/N` URLs also identify PRs on other hosts.

Canonical identities include the host and Jira context path or GitHub repository.
GitHub issue and PR URLs for the same repository/number share identity; discovering
a PR cannot subsequently downgrade its kind. Credentials are rejected. URL
tracking/query/fragment payloads are removed from saved URLs and excerpts.

Unknown candidates are grouped by current observed project plus key, not globally.
Jira prefix/site learning follows the rules above. Repository-qualified GitHub
references retain the existing exact-reference resolution within a code project.
A second matching GitHub identity restores ambiguity for inferred, unconfirmed
observations. Confirmed decisions remain authoritative. Contextual bare-number
observations record their repository-based provenance separately from a seen
issue URL. This is evidence of mention, never proof that work was completed.

Three domain tables in `{dataDir}/discovery.sqlite` own durable state:

- `external_issues`: canonical identity, URL, provider/kind, observed and manual
  titles. An observed title comes from a descriptive Markdown link label;
  `manual_title` is an independently retained override.
- `session_issue_links`: unique issue/canonical-YA-session association with
  discovered, confirmed or dismissed state and decision time.
- `session_issue_evidence`: source/project, stable occurrence, reference, source
  locator, bounded excerpt, observed/source times and extractor version. Its
  link may be null until identity resolves. Evidence kinds distinguish URL,
  ticket key, contextual number and manual correction. The extractor version
  names the extraction rules that produced the row's reference and excerpt, so
  rows written before a rules change stay distinguishable; redelivering the
  same occurrence updates identity and project, not the text or its version.

Distinct repeated mentions survive. Redelivering the same persisted occurrence
does not duplicate it. Codex source locators use rollout ordinal/byte provenance
through normalization rather than response-array indices. Dismissed associations
remain dismissed on new observations; unresolved suppression also survives
resolution. Restore is explicit. Remaps union evidence and preserve the latest
explicit decision, with dismissal winning equal-time ties. Current working-project
metadata updates evidence navigation independently of transcript storage location.
Missing source sessions keep their historical evidence and display unavailable.
Navigation opens the source session; exact-message deep links are not exposed.

Deletion removes the selected saved item and its links/evidence. It aborts buffered
work, and source-version receipts prevent the same background snapshot from
immediately recreating it. A later changed source or a new viewed-window observation
may rediscover it, as the deletion UI explains. Disabling or aging out of a recent
window preserves all existing metadata. No automatic retention expiry or local
browser fallback exists. No project files, Git metadata or YA refs are written.

## Acquisition and lifecycle

`IssueIndexer` owns one fair recent worker and a durable SQLite queue. It admits
catalog rows from the existing retained catalog, yielding after each 100 rows;
metadata enumeration is replayable/idempotent after restart, and every admitted
candidate is durable. It does not retain a separate unbounded candidate array or
reparse unchanged cold transcripts on a timer. At most 16 jobs are fetched into a
worker batch. Settings, catalog and completed-session signals drive admission.
An unchanged failed source is not retried by an endless loop; a changed source
version permits another attempt.

A republished catalog that has not changed costs nothing. Admission is keyed
to the publication's epoch and generation, so the sweep that already covered
that pair returns immediately rather than re-walking an identical corpus, which
matters because an active server republishes every few seconds. A caller with
its own reason to sweep — a settings change, a session-id remap — is not keyed
and always runs, and only a sweep that ran to completion retires its mark, so
an aborted one is repeated rather than assumed.

A catalog sweep writes only for sessions that actually changed, in every
scope. The observable requirement is that admitting an unchanged catalog of
any size performs no writes at all: SQLite takes a file lock per write, and an
idle server was previously taking roughly one lock per known session per
catalog publication, which is fatal on the network filesystems
[required SQLite](required-sqlite.md) now refuses. Recent scope is the case
that makes this visible, because it re-admits every session inside the window
on every publication, and an active server republishes every few seconds.

Two reads before the sweep replace all of those writes. Ownership can change
only for a session that already has a job or evidence row, so one read names
those sessions and the project each of their rows currently holds; a candidate
with no row, or whose rows all hold its current project, is skipped without
opening a transaction. The other read names what each queued job already
holds, so a candidate whose project, priority and serialized catalog row all
match the stored job is admitted without a write — the upsert would otherwise
rewrite the row with its own bytes. A paused job is the exception and is
always written, because returning it to the queue is exactly what the upsert
does when a widened recent window or a reopened session admits it again.

Provider-owned acquisition uses 64 KiB reads, an 8 MiB/2,000-record batch budget,
a 30-second acquisition deadline and a 1 MiB individual JSONL record limit.
Oversized/malformed records leave partial coverage. Codex lineage traversal is
limited to 32 segments. Cursor state tracks source position, lineage layout,
file identity, modification and a boundary hash. Appends resume; detected rewrites
reset acquisition without erasing historical evidence. Batch limits yield and
requeue automatically. Provider readers never fall back to full-transcript reads.

Both text acquisition and the associated-session availability probe read a
session with the reader belonging to the provider that recorded it. When that
provider has no reader in the project, the session yields no text and reports
unavailable; neither read substitutes another provider's reader, whose answer
would be an empty or unsupported result with the real reason hidden.

Viewed windows add no file read. Their retained text budget is 8 MiB across up to
16 pending windows, inspecting at most 16,000 normalized records per admission;
overflow reports partial coverage. Both viewed windows and background batches
extract through the same loop: it yields between 32 KiB text windows read with
4 KiB of overlap on either side, and each window records only the references
starting inside its own range, so a reference crossing a window boundary is read
whole and recorded once. Transactions handle at most 25 observations or resolution rows
per batch; large project-key resolution runs through a durable continuation queue.
Settings changes, deletion, remaps and shutdown abort stale generations, and the
same fence returns a session interrupted mid-acquisition to the queue, so no
session is left indexing by a generation that no longer exists. Closing
the final view releases the existing session-view demand; this feature adds no
independent tail watcher or recurring per-session task.

Operational tables `issue_index_jobs`, `issue_resolution_jobs`,
`issue_deleted_snapshots` and `issue_confirmations` retain checkpoints,
resolution continuations, deletion fences and tracker verdicts. `issue_registry_work`
owns the bounded mapping/candidate reconciliation pass. SQL statements finalize; startup migrations do no provider acquisition.
Storage errors do not acknowledge unsaved writes or become successful empty lists.
The server owns disposal and awaits indexing before closing its database.

`IssueStore` owns every statement against those tables. It answers its callers
through methods named for the decision being recorded — admit this candidate,
move this job to this state, record this acquisition batch against the source
version it read, store this tracker verdict — and exposes no general-purpose
SQL entry point, so no column name, state string or upsert rule is spelled in
a route, the index worker or the confirmation worker. The workers keep the
policy: which state a job earns, and the wording of the reason stored with it.

A hand-attached reference is one such decision and costs one write. The HTTP
route supplies the session and the URL the user chose; the store mints the
message identity, records the reference as `manual` evidence and stores the
user's note as its excerpt in the same insert an extracted reference pays for.
Manual evidence is authoritative for namespace learning and identity
resolution even where the extractor would have read the same URL as an
ordinary mention.

## Compatibility and migrations

The approved optional-feature review covered v0.8.0 (2026-08-31) and v0.8.1
(2026-09-05), the latest two stable releases and all stable releases in the
preceding 14 days on 2026-09-10. Sparse optional capability
`issue-session-associations-v1` (permanent ID 68) covers:

- `GET /api/issues`, `GET /api/issues/evidence`, `GET /api/issues/sessions`;
- `GET /api/issues/settings`, `PUT /api/issues/settings`;
- `GET /api/issues/credentials`, `PUT /api/issues/credentials`;
- `POST /api/issues/decision`, `POST /api/issues/resolve`;
- `POST /api/issues/confirm`;
- `PATCH /api/issues/item`, `DELETE /api/issues/item`.

`IssueItem.trackerStatus` and `IssueSearchResult.statusRefreshing` are
additive, self-gated response fields outside the bit: older servers omit them
and the client shows no state badge and makes no extra request; older clients
ignore them. The bit's meaning is unchanged.

Optional capability `github-status-controls` (permanent ID 128) owns the
independent `githubStatusEnabled` and `githubCli: { enabled, account }` settings,
non-secret CLI account inventory, durable status cache and cache-clear action.
The approved October 16 optional corpus is v0.9.1 and v0.9.2 (latest two local
stable tags; neither has the controls, and no local stable tags fall in the
preceding 14 days). Without it new clients hide new server-backed controls and
send no new settings or cache-clear requests. Existing status fields remain
self-gated and extension grouping works with whatever status a server supplies.
The original ID 68 is unchanged. Older-client saves preserve omitted new
settings. No protocol floor or remote compatibility-level change is needed.

The shared settings service persists `issueAssociations: { enabled, scope,
recentDays, githubStatusEnabled?, githubCli? }`. The bit requires ready SQLite and the installed indexing owner,
independently of opt-in; data routes also require enablement and ordinary app
authorization. Without it clients hide all controls and make no issue requests.
The Issues & PRs sidebar and direct page links open `/issues` locally and in
direct remote mode, or `/-/relay/:relayUsername/issues` in relay mode (beneath
the hosted client base when configured). Refresh preserves the issue browser
and its session/project scope; these routes must not fall back to Projects.
Selections and requests belong to the current source runtime; switching servers
remounts the browser before another server can receive the previous selection.
No existing capability meaning or protocol floor changes. This unpublished v1
contract can evolve before release; released peers require normal compatibility
review for subsequent changes.

[SQLite storage](required-sqlite.md) owns migration policy. Frozen historical
v2/v3 SQL moved out of the mutable vocabulary schema. Migration 4 adds the domain
and indexing tables; migration 5 adds resolution/deletion continuations;
migration 6 adds the one-verdict-per-reference confirmation table; migration 7
adds durable Jira project mappings and resumable reconciliation. Migration 11 adds
tracker status with a foreign key to the canonical issue; it starts empty and
performs no network calls or backfill. Prefix
fixtures test fresh installation, each historical upgrade, repeat initialization,
rollback and old-reader refusal. No down migrations, resets, WAL switch or longer
lock timeout were added. An older binary refusing the newer discovery schema
also loses its discovery-gated speech capabilities; separate speech files remain
untouched. Use a newer binary or explicitly restore a consistent older backup.

## Boundaries and references

Deferred: branch/worktree inference (including YA Workstreams), Git/commit
attribution, tracker synchronization, remote snapshots, semantic matching,
tool-output mining and multi-server aggregation. Credentials are now used, but
to ask whether a reference exists and, for GitHub items someone is looking at,
what state it is in: YA writes nothing to a tracker, retains status facts durably,
and asks about a reference again only under the
[tracker status](#tracker-status) refresh rule. This feature does not
close the [cold-storage startup gap](../gaps/sqlite-backed-cold-storage-startup.md),
[commit attribution gap](../gaps/sketches/committed-change-session-attribution.md) or
[worktree identity gap](../gaps/session-worktree-file-links.md).

T3 reference: `~/github/t3code` at `d29c56a5c`, inspected 2026-09-10.
`ThreadPullRequestReactor` correlates saved branch/worktree context with remote PRs;
`linkCreatedPullRequest` and the PR MCP handler supply explicit producers.
`ProjectionThreadPullRequests` retains association source and cached snapshot/stack
JSON. T3's numbered migrations and durable dismissal inspired this implementation;
YA's initial producer is visible session text and needs no YA Workstream or remote
credentials. The retired tactical 125 plan and independent Opus review are retained
in Git history under this topic's commit series.

Validation owners:
`test/storage/{issues,issue-indexing,issue-routes,issue-credentials,issue-confirmation}.test.ts`,
`client/src/pages/settings/__tests__/IssueSettings.test.tsx`,
`client/src/components/__tests__/SessionIssuesLink.test.tsx` and
`client/e2e/{issue-associations,issues-scroll,remote-issues}.spec.ts`, plus
packaged SQLite runtime checks. Remote navigation coverage uses the production
client bundle. The GitHub confirmation path was also exercised against the live
API with a real credential; the Jira path is covered against a stub.

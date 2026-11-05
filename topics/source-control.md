# Source Control

> Source Control is YA's repository-navigation workbench for moving among
> working-tree changes, commits, tracked files, blame, diffs, and relevant
> agent sessions, with page-wide layout and navigation kept separate from the
> detailed line-review workflow.

Topic: source-control

The original implementation grew out of
[Source Review → New Session](source-review-to-session.md). That topic remains
the contract for line-comment anchors, persistent review drafts, relocation,
submission, and review-session handoff. This topic is the current landing site
for behavior that belongs to Source Control generally: its modes, repository
navigation, master-detail layout, changed-file rows, diff controls, search,
update guidance, and links to relevant sessions. The old topic retains its
combined implementation record for historical context; where its page-wide UI
statements conflict with this topic, this topic governs.

## Current compatibility baseline

Since the 2026-10-28 retirement, enhanced status, Check remote, Pull, Push and
integration options are baseline v0.8.0 server contracts. Their former fixed
client gates and old enhanced-status upgrade screen are removed. Operation
serialization, project/repository eligibility and failure feedback remain.
The 2026-10-29 follow-up makes the remaining ten fixed contracts baseline:
browse/review, working-tree inventory, both diff-projection families, inclusive
To HEAD, file revisions, last-editor attribution, incoming commits, review
submissions and the live-monitoring setting. The page and file-projection
readers start from valid project/source inputs without waiting for version
metadata. There is no per-feature update screen or unsupported-setting payload.
Older hosts should update or use their bundled client. Registry identities and
server advertisements stay available for maintained older clients.

Optional live sections and complete scans retain their capability checks and
static inventory alternative. Actual project/Git eligibility, permissions,
source identity, cancellation, settings and response-field presence still govern
use. Review visibility follows the stored server value (true for fresh installs,
false when absent); stored false remains authoritative. Monitoring follows its
existing platform default and explicit setting.

## Product boundary

Source Control is primarily an inspection and agent-direction surface, not a
full git client. Check refreshes remote-tracking observation; fast-forward-only
Pull and explicit Push are the narrow established repository mutations.
Staging, committing, amending, discarding, branch surgery, stash mutation,
integration, conflict resolution, and recovery remain agent work unless a
separate proposal justifies one operation's preconditions, feedback, and
recovery.

Every Git subprocess launched through Source Control disables Git's optional
locks. Passive status, diff, history, and file observation must not
opportunistically refresh the index or briefly create `.git/index.lock` while
an agent or the user is doing concurrent Git work. Explicit Pull, Push, and
review-object mutations still take every lock Git requires for correctness.

Failed Check remote, Pull, and Push actions keep a visible result below the
header. When the existing optional `detail` response is present, recognizable
HTTPS/SSH authentication, SSH file-permission, timeout, and non-fast-forward
errors receive a specific summary and recovery guidance. An HTTPS URL alone
never establishes authentication failure. Unknown errors keep the ordinary
action summary and expose the supplied output in expandable **Git error
details** with a copy control. URL credentials, token query parameters, and
Authorization values are redacted before display or copying. Details remain
until another action starts or the selected project changes. Responses without
`detail` retain their existing feedback; no new capability, route, or response
field is required, and the client never changes Git credentials or remotes.
When a remote Git subprocess reaches its execution timeout, its existing error
detail identifies the elapsed limit (30 seconds for Check remote, 60 seconds
for Pull/Push). Output-buffer failures are not reported as timeouts.

The navigation surface has these modes:

- **Changes** is the default quick check and owns both the current
  HEAD-to-filesystem state and commit history. **Working tree status** is its
  normal landing at every repository state. A browser-local preference may
  instead select the newest commit when the repository is clean; Working tree
  remains available as a pinned revision.
- **Working Tree** keeps the stable `?tab=files` URL while browsing current
  filesystem contents. Its complete surface can find every project file except
  `.git` administrative state. Current content is primary; blame is an optional
  tracked-file projection.
- **Pending Comments** is the unsubmitted accumulator owned by
  [Source Review → New Session](source-review-to-session.md). Its stable URL
  key remains `comments`, preserving existing `?tab=comments` links.
- **Reviews** is the submission and comment-site browser owned by that topic.
  Its URL key is `reviews`; it shows frozen reviewer entries, captured source,
  target sessions, outcomes, and open/addressed/resolved state as those
  contracts become available. The added fourth mode means the wrapping rule
  in *Header hierarchy* below must be re-verified at phone width rather than
  assumed to still fit.

Normal Source Control navigation opens Changes with Working tree selected. A
clean repository renders its quiet clean-state confirmation at desktop and
phone widths; a dirty repository renders its changed files. The browser-local
**When the working tree is clean** preference may choose **Latest commit**
instead of the default **Working tree status** landing. If the repository has
no commits, the clean Working tree confirmation remains the fallback.

A user-selected mode pushes a browser-history entry. Back from Pending Comments
or Reviews therefore restores the preceding Source Control mode; a direct entry
at `?tab=comments` still backs out of Source Control rather than inventing an
internal predecessor. Phone commit-detail history remains a separate nested
interaction.

The preference applies only when navigation did not already identify an
explicit source target. A bare `?rev=<sha>` is a focused commit: files and diff
without the revision sidebar. `?history=1&rev=<sha>` opens history with that
commit selected; `?history=1` opens history with Working tree selected. The
detail-level **‹ Commit history** parent link and legacy `?tab=commits` URL open
history inside Changes. A working-tree file link adds
`?worktreeFile=<path>`; a committed-file link combines `?rev=<sha>` with
`?commitFile=<path>`. Both select the named file's diff as soon as its corpus is
available, including the phone drill-in flow.

The pinned Working tree row remains available in history and reflects its
actual state: clean uses calm success/neutral treatment and explicit clean
copy, while dirty uses warning treatment with its changed-file count. Selected
commit detail identifies only the commit; repository cleanliness remains in
the Source Control identity header and is not repeated as commit metadata.

Desktop uses master-detail panes once history is open; phone layouts drill
from revisions to files to a full-screen diff and restore the prior list
position on Back or back-swipe. The pinned Working tree behaves like any other
revision: desktop keeps it selected beside the history list, while phone opens
its detail with **‹ Commit history** returning to that list. The top-level
Changes tab reapplies the status-sensitive landing; the Dirty badge restores
the standalone Working tree landing.

## Header hierarchy

Project selection, branch, upstream, ahead/behind state, and the Clean/Dirty
badge form the Source Control identity cluster. Changes/Files/Pending
Comments/Reviews is the trailing mode selector. Pull, Push, Check remote, and
Pause form one repository-action group in that fixed order. Pending Comments
is only that mode tab; there is no second Comments action that opens the same
pane.

On a wide layout, repository actions occupy the title row between identity and
the trailing modes only when the rendered intrinsic widths of all three groups
fit. A `ResizeObserver`-backed measurement responds to identity, capability,
count, and viewport changes; a viewport breakpoint does not infer that fit.
When they do not fit, identity and modes retain the upper row and repository
actions take a full-width fallback row below it. Constrained layouts give the
mode selector and repository actions full-width rows. The same control
instances move between placements rather than being duplicated.

The branch name in the identity cluster is navigation to the commit that branch
points at — `recentCommits[0]`, the current `HEAD` tip. It is a real anchor with
a standalone `?rev=<sha>` URL, so middle-click, modifier-click, and “open in new
tab” work, while plain left-click stays in the current tab. A detached `HEAD`
keeps its detached label and still opens and copies that tip SHA. The copy
control stays beside the name: the name click navigates, the icon copies.

The upstream name opens the
commits reachable from the configured tracking ref but not local `HEAD`. The
server resolves both range endpoints before reading the log, and opening the
preview never fetches: it shows only what the last **Check remote** observed.
A preview request starts only when the user opens it and a project and upstream
exist; failures keep the ordinary request-error feedback.

The Pending Comments tab opens that accumulator, including when drafts exist;
submission remains on that pane. In the full-width fallback, repository
actions stay left-anchored. Branch names,
upstream names, count badges, action progress, and action outcomes must not move
the Pull/Push/Check group. Their visible labels stay constant while a leading
action glyph changes in place to present progress and brief success/warning
state. Full action feedback remains visible below the header. The project
selector retains its intrinsic width, up to its desktop cap, before branch and
upstream text yield space; ordinary short project names must not truncate while
unused header space remains.

A successful fast-forward Pull reports the number of commits by which the
local branch advanced, or **Already up to date** when `HEAD` did not move. A
successful Push to an existing upstream reports the pre-push ahead count that
the action advanced; publishing a new branch remains **Branch published**.
Commit counts are optional additive response data under the existing Pull and
Push contracts. Clients receiving an older response without the count retain
the generic **Pull complete** or **Pushed commits** feedback and make no
different request.

## Workbench geometry

Source Control is a workbench, not prose or a transcript. It must use the
available page width after ordinary page padding and must not inherit the
Appearance **Max Content Width** measure globally or on its detail panes. The
revision, changed-files, diff, and blame tracks may use all available width.

On wide layouts, the browser region fills the page space remaining after the
actual Source Control header, notices, and action feedback. Lists and
diff/blame panes own their internal scrolling. Fixed viewport deductions such
as `100vh - 220px` are not the product contract, and the blank space they
currently create is not reserved for later content. Phone layout may continue
using normal page and full-screen-modal scrolling.

### Pane splitters

Changes exposes revision/files and files/diff boundaries while history is
open, and exposes its direct files/detail boundary for the default Working
tree. Working Tree exposes its files/detail boundary. Matching top and bottom
handles resize the same boundary, remain keyboard-operable, and stay absent
from phone layout. Clicking either revision splitter handle alternates between
zero width and the exact last nonzero revision width; the hidden selector leaves
no minimum-width strip.

The changed-files pane has no arbitrary fixed maximum such as 500 px. It may
grow until the inter-pane gap and splitter handles would cease to remain fully
visible and operable; do not reserve an unrelated minimum width for the detail
pane. The user naturally stops after exposing as much path text as desired,
and the still-visible splitter is the recovery path from an extreme choice.
Pointer drag reflows the panes live but coalesces high-frequency movement to at
most one width update per animation frame; releasing the pointer commits the
final width.

A content-derived natural maximum is optional, not required. If added, compute
it from the widest untruncated row in the **complete file corpus**, including
status, count, and menu affordances—not only rows currently mounted in the
vertical-scroll window. Recompute it when the corpus or relevant font, size,
or spacing metrics change.

### Changed-file state and path recovery

Changed-file rows use the compact git status code as the primary kind:
`M` = Modified, `A` = Added, `D` = Deleted, `R` = Renamed, and `?` =
Untracked. Less common codes retain the same treatment: `C` = Copied, `T` =
Type changed, and `U` = Unmerged. Tooltips and accessible labels expand every
code.

Do not repeat the long, visually similar **unstaged** or **untracked** words on
ordinary rows: the status code already carries the useful distinction, with
unstaged as the ordinary dirty state and `?` identifying untracked files. A
compact check may identify a fully staged file. When a file has staged changes
plus additional unstaged changes, use the explicit short label **partial**
rather than the opaque `±`; its tooltip says “Partially staged: staged changes
plus additional unstaged changes.”

Compact untracked directories are backed by the
server's persistent non-ignored path cache. A group with more than ten
descendants starts collapsed and loads its children only on expansion; a
smaller group may load and expand immediately. Expanded child labels omit the
shared parent while row tooltips and action identity retain the canonical full
path. A debounced query searches cached paths that the client has not realized,
shows matching paths without overwriting disclosure state, and removes
search-only rows when cleared. Loading, truncation, and cache failures remain
visible.

Working-tree changes, commit revisions, and Files use one shared file-row/path
treatment and one path-compression outline. Filtering and semantic sectioning
happen first; grouping is independent inside each resulting section. The
outline factors slash-delimited directory prefixes into headings, including a
directory with only one surviving file. Expanded rows omit the heading prefix
while their tooltip, copy target, menu actions, accessibility name, and
`data-source-path` retain the complete canonical path. This deterministic
elision does not depend on measuring row width and does not attempt generalized
non-path prefix factoring. A collapsed group renders every distinct Git status
represented by its children rather than choosing one status for a mixed group.

Initial disclosure uses the list's available row budget: groups expand in order
while their immediate children fit. A later explicit expand or collapse choice
wins through corpus refreshes and resizes. Search renders the filtered complete
paths directly, so grouping never hides a match.

A case-insensitive search match is highlighted and held visible: the leading
prefix yields from its start and the suffix consumes the remaining live row
width. A truncated path exposes its full value from the actual row hover/focus
target in both Native and Themed tooltip modes; a nested `title` that happens to
work in only one mode is not sufficient. Desktop row menus overlay the trailing
edge instead of reserving permanent path width. Touch layouts keep the menu
target in flow and preserve more path identity in the row itself rather than
depending on hover.

### Current-content inventory and untracked cache

Working Tree exposes a route-local row of **Tracked**, **Untracked**, and
**Locally excluded** visibility toggles, all three on by default. Tracked means
every present tracked path. Changes retains its diff-oriented changed-tracked
and non-ignored untracked list; composing it from the same section-control
surface remains an optional unification, not a requirement.

Locally excluded is the final divider-separated section, and the two kinds of
ignored content are split by where the rule lives. A `.gitignore` (or global
excludes) rule is shared project truth about build output and dependencies:
that content is never enumerated, never sent, and has no toggle. A
`.git/info/exclude` rule is this clone's own decision to keep authored material
— private notes, review files, task state — out of commits, so that material
stays browsable and is shown without asking. Making a directory browsable is
therefore an ordinary Git operation: move its rule from `.gitignore` to
`.git/info/exclude`. `git check-ignore -v` decides each path by the rule Git
actually applied, so a path named in both files follows `.gitignore` and stays
hidden. `.git` itself and every descendant are categorically absent: YA does
not list, traverse for content, or attach a filesystem watch within that
administrative subtree. No config-file exception is implied.

The Working Tree browser uses the live project subscription described below
when `git-working-tree-sections` is present. A server with only
`git-working-tree-files` retains the released explicit-entry or refresh request
to `GET /api/projects/:projectId/git/working-tree-files`; neither path runs on a
five-second poll. The complete corpus combines present indexed paths with
non-ignored untracked paths and subtracts tracked deletions. Tracked changes
come first, **Untracked** separates live-only files, and **Tracked, unchanged**
separates the remaining tracked paths. The Working tree revision in Changes
uses the first two sections only: tracked rows open HEAD-to-filesystem diffs,
while untracked rows open live contents through `FileViewer`. Every section
uses the shared outline described above. Search spans the enabled section
corpus without changing group disclosure state, and any server safety bound is
an explicit truncation state rather than a claim of completeness.

Selecting a path renders its live contents through the shared `FileViewer`,
including clean and untracked files. Tracked files may switch to Blame; an
untracked file stays in Contents and never receives invented provenance. The stable `?tab=files` URL remains the Working Tree entry. Servers missing
the working-tree inventory contract receive update guidance rather than a
tracked-only browser.

When no Git repository exists, a server with `git-working-tree-sections` still
shows Working Tree current contents. Ordinary filesystem files are untracked
rows, `HEAD` and base endpoints are absent, and `.git` remains categorically
excluded. The repository action and history surfaces stay absent. YA neither
initializes Git nor offers an initialization control. A server without the live
capability retains the released **Not a git repository** fallback and receives
no worktree subscription.

A current client begins such a project with only the filesystem root open. The
snapshot contains direct root files and one pending row for each direct
subdirectory; a pending row claims no file count. Opening a row leases that
canonical project-relative prefix and its ancestors, enumerates all of its
direct files and subdirectories, and watches that directory non-recursively.
Unopened descendants are neither traversed nor watched.

The server retains every enumerated direct file as opened-directory truth. An
ordinary subscriber receives at most 5,000 files from each open directory, with
an exact total for every successfully enumerated directory. A truncated browser
ends with an ellipsis row and **Show all N**, where `N` is the total file count
across its open-directory corpus. That action acquires an explicit complete
filesystem lease; it removes only the subscriber projection bound, so a wide
flat directory deliberately publishes every row. Other subscribers remain
bounded. If an open directory cannot return rows, it remains explicitly
incomplete. A separate count-only enumeration may still publish its exact total
with an empty row response; if that also fails, the total is omitted rather than
reported as a lower bound.

Directory disclosure is subscription state, not a selectable pseudo-file.
Collapsing a directory releases it and every descendant prefix from that client
lease. Search covers already enumerated files and hides pending directory rows;
it never implies that unopened descendants were searched. Subscriber prefixes
are unioned by the project owner, but each subscriber receives only files below
its own open prefixes and sees a directory opened only by another subscriber as
pending. The filesystem root and the union of currently open prefixes are the
only content directories watched; narrowing the union closes obsolete watches.
A missing directory disappears, while an unreadable open directory remains
explicitly incomplete.

`expandedPrefixes` is optional at the protocol boundary because capability 41
was expanded before its first stable release. Omission retains the earlier
bounded breadth-first filesystem inventory for a cached source client. A current
filesystem client sends an empty array for root-only mode and accepts a snapshot
without directory rows from an older source server; that safely displays the
server's bounded file corpus without offering unsupported lazy disclosure.
When omitted-prefix and expanded-prefix subscribers coexist, the shared file
scan retains the compatibility corpus while a separate scan of the expanded
prefix union preserves current clients' directory rows, files, totals, and
watchers. Compatibility subscribers receive no directory fields;
expanded-prefix subscribers receive their own narrow file and directory
projection.

Permanent capability 42, `git-working-tree-complete-scan`, owns the optional
`coverage.filesystemScan: "complete"` request, snapshot and delta totals, and
the visible **Show all N** action. Without it, the client keeps the bounded
inventory and truncation notice, sends no complete request, and never exposes a
button whose server cannot honor. Capability 41 keeps its existing lazy
opened-directory meaning.

The same capability owns
`GET /api/projects/:projectId/git/untracked-files` and cache-backed status via
`GET /api/projects/:projectId/git?untracked=cache`. Cache-backed polling asks Git
for tracked/staged state with untracked enumeration disabled, then merges the
retained untracked snapshot. One root request is shared in flight, so a polling
tick cannot overlap it. The tracked/staged response mounts the workbench
immediately; until the first untracked snapshot arrives, an inline loading or
error state replaces any premature clean-tree or empty-corpus claim. When live
monitoring defers its first snapshot until the document receives attention, the
available static status still mounts this workbench instead of a page-level
loader. Untracked rows then enrich the mounted corpus in place. Retention expiry,
eviction, a file update, and every background check keep the last successful
mounted corpus, selected row, detail, scroll/view state, and explicit
folder/outline disclosures visible until replacement data is ready. A changed
compact-folder corpus adds or removes available groups without resetting choices
for groups that remain.

The route-mounted status owner refreshes early when a managed process in the
selected project reaches idle or waiting-for-input, coalescing completion events
for 750 ms. Git actions also refresh explicitly. External editors, human Git
commands, and other unobserved writers produce no YA activity event, so a
30-second safety refresh remains while the Source Control document is both
`visible` and focused. Leaving the route tears down that timer, its activity
subscriptions, and any queued event refresh. A hidden tab, commonly including a
minimized window, and an unfocused browser window do no periodic Git work; the
next focus/visibility restoration refreshes immediately.

Browser attention signals are deliberately coarser than pixels. The Page
Visibility API does not report whether a visible window is covered or whether
Source Control is scrolled outside the viewport, while focus may pause a visible
side-by-side window that the user is passively reading. The immediate refresh on
focus accepts that stale passive view in exchange for stopping repository work
from an open but unattended window. Multiple tabs own independent route
lifecycles; hidden or unfocused tabs do not multiply the safety cadence.

The project-keyed cache lives below the configured YA data directory under
`indexes/git-untracked/`; browsing does not create `.yep`, edit Git excludes, or
otherwise write selected-project state. Git remains authoritative for
`.gitignore`, `.git/info/exclude`, and the user's global excludes. Cached HEAD
and index sets remove newly committed or staged paths immediately and force
reconciliation when those sets change. Full filesystem reconciliation defaults
to hourly; a stale selected path is checked at most hourly, and a root query
does not stat every nested child. Persisted paths must remain canonical
repository-relative paths, bounds and truncation are explicit, and concurrent
refresh callers share one refresh.

### Browsing a path outside the project

A file-path link or file viewer naming an absolute path outside the selected
project offers **Open in Source Control** in its context menu when the server
advertises `local-source-browse`. It opens a new tab at
`/projects/:projectId/browse?path=<absolute path>` showing the Working Tree
file browser for that path. The browsed directory is not a project, and the
view never pretends otherwise:

- **Root.** The enclosing Git checkout when the file-access allow-set covers
  its top level, else the directory holding the named file (or the named
  directory). The requested file opens selected. An allowed prefix itself
  may be browsed.
- **Snapshot.** One inventory request (`GET
  /api/projects/:projectId/git/working-tree-files?root=`), with no live lease,
  watcher, untracked cache, or app-data state. Reloading the tab refreshes it.
- **Inventory.** In a checkout, tracked plus non-ignored untracked files under
  the root, classified by Git. Outside Git, a bounded breadth-first walk lists
  every regular file as one plain list: `.git` and symlinked directories are
  not entered, and more than 50,000 files or 20,000 directories truncates.
- **Contents only.** Files open through the ordinary authenticated absolute
  file read, so the allow-set is enforced again per file. There is no blame,
  review-comment surface, Changes tab, or project history.
- **Authority.** `:projectId` must be a project the caller may view; it
  authorizes the request and is otherwise unused. The path must resolve
  inside the allow-set (403 otherwise), and only the superuser may name one,
  as for every host absolute-path read (403 for a limited principal).

Git runs in that directory with its own configuration, exactly as for a
project checkout. A full Source Control view (history, Changes) for a
checkout root outside any project remains possible future work.

### Optional live project worktree ownership

Live monitoring is an experimental server-wide Source Control option with a
platform-dependent default: when no explicit stored choice exists it is On
only on Linux, whose bounded native-watcher profile has been measured. macOS
stays Off after the 2026-08-21 FSEvents watcher-exhaustion incident. Windows
also stays Off pending native platform measurement. Explicit opt-in on either
platform runs poll-only. An explicit stored choice always wins over the
platform default. Off advertises no `git-working-tree-sections` or
complete-scan availability, accepts no worktree subscription, and owns no
content watcher, Git-metadata watcher, reconciliation timer, or retry timer.
ID 38's static inventory, cache-backed status, explicit refresh, and legacy
file projections remain the core behavior wherever monitoring is off.

Native filesystem watchers exist only on Linux. It is the sole platform where
complete watch sets are treated as truth, and its bounded per-directory
inotify cost is the one that has been measured. Every other platform runs
enabled monitoring poll-only: the bounded 30-second full reconciliation that
was already the correctness truth source there, with zero native watcher
allocation. The incident mechanism — one native FSEvents client per
directory — can therefore no longer allocate on macOS at all.

When enabled, one project-keyed server owner replaces the static file corpus as
the current Source Control truth while a visible and focused Source Control
view holds a lease. Identical subscribers across direct and relay transports
share one snapshot, watcher set, and reconciliation computation. Subscriber
coverage is unioned: Tracked, Untracked, and locally excluded paths are present
by default, and the `ignored` coverage dimension carries only this clone's
`.git/info/exclude` content, so `.gitignore` paths are never enumerated at all.
For filesystem-only projects, explicitly opened directory prefixes are unioned
as well, then projected back to each subscriber's own lease. Leaving Source
Control, hiding or unfocusing the document, pressing Pause, or releasing the
final prefix closes the lease and every watcher and timer. Inactive snapshots
may then remain only as bounded least-recently-used state.

The first subscriber receives one complete snapshot with project-root
`{ epoch, sequence }` generation, resolved `HEAD` / `HEAD^1` endpoints, present
tracked and untracked rows, tracked deletions marked `present: false`, and the
exact dirty and cumulative projection facts each row needs. A lazy filesystem
snapshot also carries the visible directory rows and their pending or bounded
state. That payload ends Loading immediately. Fresh query metadata without a
retained payload never stands in for it, and no query identity serializes the
file corpus. File-level diff links first reuse a non-polling status query with
untracked enumeration omitted to establish that the project is a Git
repository. File-level diff links and standalone file viewers do not retain
live coverage: their passive availability affordance uses the released
non-polling status and static projection paths. A transcript or file view must
not activate whole-project native observation.

Filesystem changes publish create, modify, and delete deltas. If subscriber
coverage widens while a narrower scan is active, the owner scans again before
the new subscriber becomes ready; its initial snapshot therefore covers the
complete requested union. The generation sequence advances globally even when
a subscriber's coverage filters the delta to an empty change list. The client
applies only contiguous deltas, preserves untouched row object identity,
ignores stale events, and requests one full snapshot after a generation gap or
reconnect. Selection, detail mode, scroll, and explicit outline disclosure
remain component state and therefore survive ordinary corpus replacement.

YA enforces one process-level live-worktree watcher ceiling before native
acquisition. Directory discovery stops when the desired set cannot fit. A
limit, `EMFILE`, `ENFILE`, `ENOSPC`, or native allocation failure opens one
circuit, closes the manager's native watchers, and permits no further watcher
allocation attempt until restart or an explicit monitoring-mode reset. The
owner remains usable through bounded reconciliation and manual refresh; failure
never retries construction of the same oversized set.

The shipped process ceiling is 256 native watches total across content and Git
metadata, with at most four projects holding native watches concurrently. These
are safety bounds, not completeness promises: reaching either opens the same
process-generation circuit before YA partially constructs the over-budget set.
Diagnostics report the effective mode, circuit state and reason, subscriber and
project counts, native-watch count, cumulative registrations, and both
ceilings without exposing paths.

The active-watcher ceiling alone cannot see repeated replacement: close-and-
reopen cycles keep the active count below the cap while cumulative native
allocation grows without bound — the shape of the macOS incident's 8,301
registrations. A rolling registration-churn window (default 60 seconds, four
times the watcher ceiling) therefore also opens the circuit when native
registrations are churning faster than any healthy watch set requires.
Sustained heavy directory churn deliberately degrades to bounded polling
rather than re-allocating; an explicit Off-to-On reset or restart re-arms
native watching with a fresh window.

2026-08-21 Linux validation on a 16-core x86_64 host (Node 24): a
12,000-directory Git tree opened the watcher-limit circuit after three
registrations, held RSS flat (+0.4 MB) across two 30-second polling ticks
with cumulative registrations frozen, and released cleanly. A 200-directory
watched tree held 205–246 active watchers under 800 real create/delete churn
cycles, never exceeded the ceiling, grew RSS by 2.3 MB, tripped the
registration-churn circuit under runaway-rate churn, and released to zero
watchers and subscribers. That measurement is the basis for the Linux
default-on decision. macOS and Windows remain default-off and allocate no
native watchers even when explicitly enabled.

The validation harness treats every scenario's subscription, manager, timers,
native watchers, and temporary tree as one cleanup scope. Setup, Git, scan,
watch, churn, and assertion failures all release the subscription, dispose the
manager, and remove the temporary tree before the process exits; successful
samples use the same final owner rather than a separate happy-path teardown.

On Linux, YA watches content directories non-recursively. Git repositories and
the omitted-prefix compatibility walk cover each enumerated content directory;
lazy filesystem inventory covers only the root and the union of open prefixes.
Directory creation and removal update only the affected watch set. For the full
walk, the initial root watcher is installed before background watcher expansion,
so expansion cannot delay the first snapshot or starve a notification-triggered
Git scan. Lazy filesystem watches synchronize to the scanned open-prefix set
before a widened subscriber becomes ready. `.git` and every descendant are
absent from content traversal and watching.

A Git repository adds a separate metadata watch set. YA resolves both the
per-worktree administrative directory and the common Git directory rather than
assuming `.git` is a directory or that linked worktrees share one metadata
root. It watches each root non-recursively and watches existing refs, reftable,
and rebase/am state directories recursively. The containing directories are the
watch targets because Git atomically replaces `HEAD`, the index, and refs;
lockfiles and watchman cookies are ignored. A relevant event starts the same
coalesced worktree reconciliation used for content events. Reconciliations are
serialized, and an event during a scan queues one follow-up rather than
launching an overlapping Git scan.

Once Linux content and metadata watches are complete, the 30-second safety tick
fingerprints a bounded set of Git sentinels, including `HEAD`, the index, packed
refs, the current symbolic ref, operation markers, config, and excludes. An
unchanged tick runs no Git subprocess. Changed metadata triggers a full scan,
and fingerprints before and after that scan force a follow-up if Git moved
during observation. A missing or failed watch restores full 30-second
reconciliation, and so does a failed scan: the published snapshot is then
behind the worktree with no pending event of its own, so the clock reconciles
until a scan succeeds. macOS, Windows, and other platforms run that full
reconciliation as their only mechanism: they allocate no native watchers at
all. Explicit YA Git actions and watch events may refresh more frequently.

A filesystem-only walk survives its directories changing under it. A directory
removed mid-walk is skipped and leaves the inventory complete; one that cannot
be read is skipped and reported as an incomplete inventory. The compatibility
breadth-first walk alone ends early at its file limit. Opened-directory scans
enumerate each direct file before applying subscriber-specific delivery bounds.

A 150 ms quiet timer coalesces an ordinary burst. A separate five-second
maximum deadline is pinned to the first unprocessed filesystem event; later
events never move it forward. Five seconds is not a polling cadence or an
initial-load delay. The Source Control Pause control freezes visible client
application and releases the live lease; Play reacquires it and applies the
next current snapshot. Pause and Play use the same reserved
leading glyph slot as Pull, Push, and Check: a pair of vertical bars or a
right-pointing triangle, drawn as a 16×16 SVG and optically centered in that
slot. They are not text or numeral glyphs. Pointer motion over the Working
Tree list may wait for 200 ms of quiet before applying row movement, but a
pending client delta has its own five-second hard deadline.

### Diff gutter

Added/deleted line backgrounds remain subdued while the `+` / `−` strip carries
the stronger semantic color. The authored gutter is about 16 px wide with a
roughly 6 px inline inset and separate breathing room between the color divide
and source text.

Source Control and session Edit-tool diffs use the same gutter-alignment class;
neither surface may keep a separately tuned approximation. The same shared
boundary owns the diff-specific Shiki palette. Each shipped theme uses fixed,
uniform added and removed line fills, and every syntax token has at least 3.5:1
contrast against both fills. This deliberately softer threshold keeps syntax
roles distinct from ordinary body text while preventing illegible combinations
such as a dim comment on a tinted line. Contrast is audited from the theme
palette offline, never inferred from the current file's content. Highlighted
and fallback renderers retain the contract in unified and side-by-side modes.
The stronger `+` / `−` gutter tints have separately audited foregrounds at the
same minimum, including the session fixed-font rendered form.

Source text is source text regardless of entry point. Source Control diffs,
session Edit-tool diffs, Files content, and blame use the same fixed-font
family, size, and line-spacing tokens derived from Appearance settings.
Individual source surfaces may add local density offsets, but may not substitute
a separately sized or spaced monospace style.

## Navigation and diff controls

Highlighted unified and side-by-side diffs share horizontal scroll groups.
A hunk whose source rows and header fit the visible vertical scrollport has
one slider beside its hunk range; both sides move by the same pixel offset.
For a taller hunk, each isolated overflowing row or contiguous run of
overflowing rows has its own inline slider in a narrow right-hand rail.
Short rows remain fixed, and separate runs retain independent positions.
Native horizontal scrolling and keyboard slider input move the same group.
There are no per-line scrollbar tracks or nested vertical scrollports.

Hunk headers stay visible while their hunk passes through the pane, and a
long run's control stays available while scrolling through that run. Pane
resizing and source typography changes recompute the grouping from rendered
line widths and the available height. Regrouping can reset an affected run's
horizontal position. Comment insertion retains the original line anchors
and splits source above and below the editor; each visible segment owns its
scroll groups. Plain text and after-side file projections keep their existing
scroll behavior.

One selected row drives the adjacent detail. Identity and state stay visible
in list rows; primary quick actions belong in the selected detail banner; one
shared ellipsis/context menu discloses the full action set. Right-click,
long-press, the visible ellipsis, and Shift+F10/Menu open the same accessible
menu with focus return and keyboard traversal.

When the selected commit has a body, its message card begins with the complete,
wrapping subject even though the detail banner retains its compact ellipsized
copy. The subject is preserved verbatim; only likely manual prose wrapping in
the commit body is folded to the pane width. Its text is selectable; mouse
activation opens the verbatim message only when the release did not complete a
selection, while Enter and Space remain keyboard activation. Phone detail keeps
the full subject above its compact full-message action. **‹ Commit history** is
styled as an actionable parent link rather than a full-width section label.
On desktop, a long message card scrolls within a bounded part of the files pane
before file selection and while the full-message view is open, so the file
outline remains visible throughout review entry. Moving keyboard focus to a
file reveals it only within that outline's scrollport; it must not scroll the
outer Source Control page or move the selected revision and diff workbench
offscreen.

Source lists support Up/Down selection, Escape return, and `/` to focus search
when focus is outside an editor. Once desktop commit history has loaded, its
selected commit or Working tree row owns initial keyboard focus instead of the
application sidebar. Enter on that revision row enters its file outline at the
first selectable file once the detail is available. That Enter intent is tied
to the current revision visit: moving to another revision by any other action
cancels it, and later returning does not enter the file outline. In a commit
file outline, Enter expands every structural path group when any is collapsed;
otherwise it collapses every group except the selected file's ancestors, which
keeps the focused file mounted. It does not activate the file row's pointer
action.

In a file outline, Up/Down traverse the visible rows; Right expands a collapsed
group or enters its first child, while Left collapses an expanded group or
returns to its parent. Left/Right on a leaf is still consumed rather than
scrolling a neighboring pane. These keys apply only while an outline row owns
focus, so a focused source scroller keeps native arrow-key scrolling.
Unmodified `[` and `]` select, reveal, and visibly focus the previous or next
file diff in the same depth-first order shown by the path outline. Either key
from commit-message view enters at the first file; the outline expands the
target's ancestors, so collapsed path groups and unmounted rows cannot block
either transition.
The files pane shows the selected file's complete display path in a sticky
tooltip-style box even when its grouped row is collapsed. At desktop width its
right edge stays inside the files pane while the box may grow left over the
revision pane; it never covers the diff. It prefers wrapping after path
separators and may break an individually overlong segment rather than truncate
the identity.

Unmodified Page Up/Page Down scrolls the adjacent commit diff by one viewport
without moving focus, whether invoked from its changed-file list or source
scroller. Commit-file bracket/page navigation dismisses any visible tooltip;
fresh pointer movement may reveal hover detail again. Other source-list row
navigation and Enter likewise dismiss the current tooltip and suppress a
destination focus reveal. Diff navigation supports previous/next hunk and a
visible current-hunk indicator. Browser shortcuts must not copy native GitHub
Desktop accelerators that collide with browser tabs, Find, or the address bar.

Unified/Split and full-context controls stay in the diff pane. **Hide removed
lines** loads that same full-context projection, suppresses every old-side
deletion, hunk header, and diff-prefix character while keeping additions
highlighted in the complete after-side text. Turning full context off also
leaves this after-side mode. Ignore whitespace is an independent projection of
the active working-tree, commit, or revision-range diff. **To HEAD** is
inclusive: an ordinary selected commit uses
its first parent as the fixed base, a selected root uses Git's empty tree, and
the server pins current HEAD as the tip. The returned list therefore contains
the net squash-style change from the selected commit through HEAD, including
paths first added by the selected commit. Every per-file request stays on those
returned endpoints so a later HEAD move cannot mix comparisons. Switching the
range on or off retains the selected file whenever that path, or its rename
counterpart, exists in the new corpus; loading the replacement corpus never
clears the selection merely because its rows have not arrived yet.

Direct selected-tree-to-HEAD remains a different, clearly labelled per-file
context-menu action. It retains the established direct-comparison route and
capability semantics rather than overloading **To HEAD**.

Projection routes are baseline v0.8.0 contracts. When a projection request
fails, the client returns to ordinary Source Control and shows the request's
retryable error. It never recasts an execution failure as an outdated-server
notice or leaves the projection selected over ordinary content.

A comparison comment cites the endpoint that contains the clicked projection:
an old-side line anchors to the fixed base SHA (or has no old lines for the
empty tree) and a new-side line anchors to the pinned tip SHA. An ordinary
one-commit diff uses that commit SHA for both sides; a working-tree diff remains
uncommitted. Rendered diff lines are
interactive on their first visible frame—first-click commenting and hunk keys
do not depend on a later passive effect. Pending-comment tint uses revision,
side, and line identity so similarly numbered lines in another projection do
not inherit it.

Full context is a view of the current diff, not a file-path cache entry. If a
live working-tree refresh changes the diff while full context is open, YA
invalidates and reloads that projection. An older request resolving later
cannot overwrite the newer projection.

A diff-only/full-context switch preserves the first changed row's current
viewport offset rather than centering that row. Source Control and session Edit
details share both this scroll-anchor primitive and the unified diff renderer,
so the hunk remains visually stationary while surrounding source and the
scrollbar appear.

A live working-tree refresh preserves the user's selected Diff/Markdown
Preview mode and maintains the viewed position on a best-effort basis. A
projection change may remount the rendered detail while its replacement loads;
the remount starts from the latest explicit per-file view choice, not the
retention snapshot from before the click. Until the aligned source-marker
projection exists, preserving the relative scrollbar position is sufficient.
If one refreshed response cannot supply Markdown preview content, YA
temporarily shows the source diff without clearing the user's preview choice;
preview resumes when a later response can render it.

Source Control presents a text diff only when the exact Git projection is not
classified as binary and both file versions are safe UTF-8 text. Git attributes
that mark a tracked path binary are authoritative; a filename extension alone
is never authoritative in either direction. Binary working-tree, staged,
commit, and selected-revision comparison files show a bounded skipped-preview
state with the path and size when known, and their bytes never enter syntax
highlighting. Untracked files receive the same treatment from their content.
A current client also suppresses binary-looking structured patch text returned
by an older server.

Large text diffs have a bounded plain projection rather than inheriting the
syntax-highlighted projection's expansion limit. Up to 16,777,216 hunk
characters, 20,000 hunk lines, and 20,000 characters on any one line, the server
ships the complete structured patch. Above 640 KiB of hunk text—or whenever
highlighted HTML expands past 20,000,000 characters—it omits highlighting and
the client renders one low-node-count unified text block. The plain view says
that syntax color, split view, and line comments are unavailable; copy, full
context, and hunk navigation remain. Source versions stop at 32 MiB combined
before diff computation. Binary and malformed-text guards remain independent.
Markdown Preview has a separate 256 KiB whole-document rendering budget; it is
not unlimited and does not decide whether the source diff uses rich or plain
mode.

## Design decisions

- **Watch Git's administrative directories and retain a bounded sentinel
  fingerprint** (vs. watching replaceable file inodes or running Git on every
  safety tick): directory events survive Git's atomic replacements, while the
  cheap fingerprint catches a missed event without an unchanged Git subprocess.
- **Show filesystem-only current contents without repository mutations** (vs.
  adding a Git initialization action): projects remain inspectable outside Git
  while Source Control keeps its established inspection-first product boundary.
- **Use a complete bounded plain projection beyond the generous rich-diff
  budget** (vs. omitting the preview or leaving rich rendering unbounded): this
  keeps useful source available while still bounding server expansion and
  browser nodes. The rich budget is twenty times its original 32 KiB / one-
  million-HTML-character thresholds. On a
  quiet 16-core host, three cold-cache repetitions of a real 568,301-character,
  19,803-line evidence file took 166–188 ms to produce 3.6 million highlighted
  HTML characters; its plain browser layout took 53–61 ms at 1000×600. A
  representative one-million-character plain block took 62–64 ms, while two
  million characters took 111–136 ms. One million characters split into about
  350,000 tiny lines took 597–653 ms, which is why both the character and line
  bounds are required. These are diagnostic same-host measurements, not a
  cross-host performance ratchet.
- **Keep one plain-projection budget for every connection** (vs. a smaller
  budget when the viewer arrives through the relay): the server would have to
  learn the viewer's transport at the diff route to vary it, and a remote viewer
  asking for a large diff usually wants the same content a local one gets. The
  accepted cost is that the largest allowed diffs are near the relay's delivery
  ceiling. A relay response travels as 256 KiB transport chunks, but the relay
  closes a circuit whose queued bytes pass 2 MiB, or whose socket passes 8 MiB,
  rather than slowing the sender — so a multi-megabyte diff sent to a viewer
  that cannot drain it that fast drops the remote connection instead of the
  request. A direct (Tailscale/LAN) connection has no such ceiling. Lower
  `GIT_DIFF_PREVIEW_MAX_DIFF_CHARS` if remote viewers start losing connections
  on large diffs; raise the relay's per-circuit queue only with its own
  memory-per-connection evidence.

Markdown Preview follows the explicit diff/full-context scope. Diff-only uses
the same approximate diff-aware rich-text projection as session Edit details,
including added/removed/context lanes. Full context renders the complete
post-change document and may sacrifice changed-block emphasis for a faithful
whole-file render. Copy content follows that same scope. Exact source-line
identities, aligned blocks, and the cross-representation scroll contract live in
[aligned Markdown diffs](aligned-markdown-diffs.md).

The wide diff pane keeps filename, path, view controls, hunk navigation, and
file actions in one toolbar row when they fit. In a narrow pane, controls take
the first row and may wrap to additional control rows; file identity follows on
its own full-width row. The filename wraps without a line cap. The filename is
the primary identity: it uses compact source type and retains its full text
before the directory path spends remaining width. The smaller directory prefix
precedes it and, when clipped, keeps its rightmost segment next to the filename.
Toolbar actions use compact glyphs with complete hover and accessible names;
hunk position uses the language-neutral `current/total` form.

Ignore whitespace uses the compact `_+` glyph. Its tooltip reads **Ignore
whitespace changes** when off and **Ignoring whitespace — click to include it**
when pressed; the selected state must not depend on a subtle tint.

Each commit and working-tree changed-file pane exposes one compact file-filter
disclosure. Opening its magnifier expands a case-insensitive path search across
the pane's current corpus, including both sides of a rename. On a capable
server, the Working tree query also searches cached untracked children not yet
loaded into an expanded group; legacy servers retain returned-child-only
coverage. New arrivals pass through the active query. On wide layouts, the first
visible file becomes the detail when the prior selection no longer matches; no
match leaves an explicit empty result.

### File-viewer projections

Every project file viewer may expose two exact Git projections in its header.
**Δ** (HEAD to working tree) compares the current `HEAD` tree to the live
filesystem. **Δ1** is cumulative: it compares the first parent of `HEAD` to the
live filesystem, so it includes both the current commit and any staged, unstaged,
or untracked work. Tooltips and accessible names spell out each comparison.
It is not the commit-only `HEAD^1`-to-`HEAD` diff. A worktree edit that exactly
cancels the current commit's change therefore
removes that path from the cumulative corpus.

A selector exists only when the current Git projection contains the path. With
the live worktree capability, availability comes from the resident project row;
older capable servers use the static project manifest. A clean path has no **Δ**
selector; a root commit has no **Δ1** selector; a path with neither
net diff has no selector at all. Selecting one projection sends only its current
path and, for a rename, its original path; the server performs an exact
literal-path comparison rather than rebuilding the project-wide manifest.
Renames match either path and render as one file projection.

The shared project-file link is the access point in prose and structured
Read/Edit turns. Hovering the filename reveals the available projections
beside it; keyboard focus reveals the same links. Touch relies on the viewer
header. Each target is a real anchor with a standalone URL, so middle-click,
modifier-click, and browser context-menu opening work normally.
Ordinary clicks open the selected projection in the session's managed viewer
(overlay or right pane), or a modal when there is no session host; they do not
navigate away from the conversation. Recall after closing or reloading retains
the selected comparison. A Read row's separate line-range link does not repeat
the filename's whole-file diff actions. Region-specific diffs are not offered.

Selecting a projection replaces the source body in the existing file viewer.
While a diff is active, source line and line-range requests are inapplicable:
the diff URL omits `line`, `lineEnd`, and `view=range`, and the viewer neither
loads nor highlights that source window. The **Raw source** (`</>`) button
returns from a diff; the projection selector has no separate **Source** segment.
Returning through that button restores the original source range as fixed-font
source, even when Markdown would ordinarily
open rendered. An already loaded source stays resident while a projection is
shown, so returning to it does not fetch or enter Loading again. Diff rendering
retains full-context, unified/split, Markdown-preview, hunk-navigation, and
review-projection behavior from the shared Source Control renderer.

A working-tree refresh keeps the last completed file projection mounted until
the projection for the new status snapshot is ready, then replaces it in one
render. A late response for an older snapshot cannot displace the current one.
If the new projection no longer contains the path, the viewer returns to its
resident source without first blanking the document.

The permanent `git-file-diff-projections` capability owns
`GET /api/projects/:projectId/git/file-projections` and
`POST /api/projects/:projectId/git/file-projection-diff`. Current clients use
this baseline contract directly; path validity, project identity and actual
projection data determine the available selectors. Existing Source Control
capability meanings do not expand.

### File revision provenance

Every authenticated project file view shows the last commit that changed the
displayed file as a short hash followed by a compact parenthesized age. This
shared chrome covers ordinary and modal file viewers, expanded Edit details,
Source Control current-content, commit, comparison, and diff panes, and blame.
An immutable view resolves history from its selected revision; a live view
resolves from `HEAD`. A not-yet-committed rename follows its original path.

Source Control diff banners also display the author between the hash and age,
without requiring hover. Narrow banners wrap the metadata and long author
names instead of overflowing; other file surfaces keep their compact chrome.

Live content adds **dirty** only when its bytes differ from the committed blob;
a rename with identical content is not dirty. Immutable revision views are
never dirty. An untracked file says **uncommitted** and receives no invented
hash or link. A non-Git project omits the chrome. Only Git's explicit
not-a-repository, unborn-HEAD, missing-working-file, and missing-blob outcomes
map to those ordinary absence states; process launch, permission, and other Git
execution failures surface as request errors rather than fabricated absence or
dirty content.

Public shares acquire neither authenticated Git projections nor revision
provenance, including in shared tool output. This is an explicit share-context
boundary independent of version metadata.

Revision requests are scoped by source as well as project, path, and revision.
Switching between local and remote sources starts a request against the new
source even when those other fields match, and a late response from the prior
source cannot replace the new source's provenance.

The hash is a regular anchor to Changes with the resolved commit and file
selected in the default diff view; blame and full context remain opt-in from
that pane. It preserves modifier-click and middle-click without paying the
blame-history cost on entry. Right-click opens the shared file resource menu
for the displayed commit and its historical file path. Its native tooltip
contains the author, absolute author time, and at most 50
commit-message lines; when more lines exist it ends with `...`.

The permanent `git-file-revision` capability owns
`GET /api/projects/:projectId/git/file-revision`. Current clients acquire it
without a version wait; non-Git, uncommitted and missing-data states retain the
absence behavior above.

### Copy GitHub link from a file menu

Authenticated file resource menus append **Copy GitHub link** after the other
actions when the file has a committed revision and a `github.com` remote.
The copied HTTPS URL pins the full commit hash and encodes the file path.
It refers to the last commit changing this file, so unrelated unpushed commits
do not make its link unavailable. A GitHub remote with a remote-tracking branch
containing that commit wins, in Git config file order. The first GitHub remote
supplies the unavailable target when none contains the revision. Git's
alphabetical `remote` listing and branch upstream/push settings do not choose
this permalink target. Reordering remote sections in Git config is sufficient;
there is no separate preference setting. HTTPS, Git, SSH, and scp-style
GitHub remotes are recognized. Other repository hosts are not yet supported.

In the file viewer, right-click the filename, the **Copy viewer link** control,
or the revision hash to open this menu. The hash targets the displayed commit;
the filename and copy control resolve the current file revision. Left-clicking
the copy control still copies the YA viewer URL.

Clean, pushed files use normal menu color. Dirty files remain copyable in
warning color with **Local edits won’t be included**. An unpushed revision is
red and disabled with **Revision not pushed to GitHub**; this takes precedence
over dirty. Files with no committed blob, directories, and projects without a
GitHub remote omit the item. Existing copy actions keep their behavior.

Push status reflects local remote-tracking refs, including the last fetch or
push observation; opening a menu performs no fetch or network Git command.
Remote history rewritten since that observation can make the saved status stale.
Reopening the menu refreshes local revision and dirty state. Absolute paths
use the existing file-owner lookup and its authorization boundary. Public
shares do not perform these authenticated lookups.

The optional `GitFileRevision.githubLink` response field carries `url` and
`pushed`; absence on older servers simply omits the action. The existing
file-revision endpoint is baseline, and absolute paths still require
`file-owner-project`. No new endpoint or request
parameter is introduced. v0.9.0–v0.9.2 omit this metadata; this field-presence
compatibility plan was approved by the maintainer on 2026-09-30.

## Search and compatibility

Every Source Control filter activates on the first non-whitespace character.
The Working Tree filter acknowledges every sequential keystroke within 100 ms,
including with a large inventory and file details loading concurrently. Result
filtering and rendering may catch up without blocking input; they still cover
the entire returned corpus. Slash focus and Escape clearing remain immediate.
Filename filters, commit-message and metadata search, and indexed changed-path
or changed-text search share one case-insensitive match projection. It preserves
source casing, keeps the matched substring highlighted, and independently
shrinks leading and trailing context with ellipses so narrow rows do not hide
the match. The complete original value or changed line remains available from
the result's tooltip.

Commit search preserves why each result matched: subject, author, short or full
hash, date, changed path, or changed line. The row renders that exact field or
line instead of returning an unexplained matching commit. On phone layouts, an
active query keeps the revision list visible until the user explicitly opens a
result; clean-tree default selection cannot replace it with Working tree
detail.

Working Tree search owns the complete returned current-content corpus; rendering
or path-prefix collapse must not become a search-coverage limit. Commit-delta
search builds an on-demand client corpus from lightweight history plus bounded
changed-path/line batches. Once a commit corpus is present, typing performs no
network request and starts no Git process. Browser-lifetime reuse is
implemented; IndexedDB reuse across browser restarts and focused completions
remain optional future work.

Working Tree starts the ordinary project-file request independently of optional
blame. Readable content renders as soon as the file request returns and never
waits for `git blame`. Blame then fills commit-hash links in place and may add
highlighting without resetting the file selection or scroll context. Failure to
load blame leaves readable content visible with a provenance warning.

In a commit detail, **Blame** is an in-place gutter mode rather than navigation
to Working Tree. It keeps the selected commit and file panes mounted and blames
the exact immutable revision being viewed; an inclusive or direct comparison
uses its pinned tip. The active gutter control returns to the diff in place.
Right-clicking a commit file reaches the same mode. Working Tree retains its
Contents/Blame projection and may use live-file provenance.

A committed hash opens that exact revision in Commits, including a revision
outside the recent page. Its tooltip shows the full SHA, author/date when
known, and commit summary. Right-click, long-press, and the shared keyboard menu
offer **Open commit** and **Copy commit hash**; copying uses the full SHA.
Uncommitted lines remain visibly non-link provenance. Pending blame-comment
tint matches both the line and its committed/uncommitted revision identity.

The blame grid has three real columns: a five-character displayed commit hash,
a content-sized line number, and selectable code. Clicking the line number or
clicking code without selecting it starts a review comment; completing a text
selection does not turn the release click into a review action. Consecutive
lines with the same populated blame provenance share one horizontal overflow
region. Different commits never share that scrollbar, and code cells do not
grow independent per-line scrollbars.

The path-copy icon sits beside the pathname. The detail banner's trailing
document-copy icon instead copies the exact raw text returned by the file
endpoint and remains disabled until readable text is available. Their icons,
tooltips, and accessible names distinguish path from content.

One-author files retain the ordinary gray hash. With multiple authors, hashes
receive distinct hues chosen by maximum minimum distance over the visible
author set. The server gives each author a durable project-wide hue preference
and refreshes the palette in the background when a project is opened or added;
new HEAD commits only scan the newly reachable range. A palette read, update,
or write error discards persisted detail and permits exactly one full-history
regeneration attempt, then omits server palette detail rather than retrying in
a loop. Shutting the app down waits for a refresh already running, so none
writes after the server has stopped. The client re-spaces the visible file's author set from those
preferences. When palette generation fails or an older server omits the
optional preference, a stable author-name hash supplies the preference without
an unsupported request.

Current source persists that palette at `.yep/git-author-palette.json` and
warms it merely when a project is opened or added. That post-`0.7.0` behavior
is audited but not the target contract: under
[Project Directory Storage](project-directory-storage.md), default project
browsing performs no project or Git-metadata write. The palette belongs in
memory or a central project-keyed cache unless project-local storage was
explicitly enabled.

Files caches the selected file's maximum intrinsic rendered code-line width by
project, path, content fingerprint, and the typography metrics that affect
measurement. On a wide layout, selection or a relevant viewport/typography
change targets the content pane at the blame gutter, line-number gutter,
scrollbar/border allowance, and that maximum line width—just enough to show the
file without gratuitous empty space—and leaves the remainder to the file list.

The allocator clamps to available space and existing pane minima. It may shrink
an oversized file list toward its ordinary default when that lets the content
fit, but uses a list the user manually narrowed below that default as its
automatic lower bound. A manual split remains in effect until file selection or
the measured viewport/typography changes. Phone layouts keep their full-screen
drill-in and do not run this two-pane allocation. Tests cover cache reuse and
invalidation, tabs/wide characters and empty files, wide-space allocation, and
constrained minimum-width fallback.

**Persist project-wide author preferences, then re-space the visible file**
(vs storing a final color per author): the durable preference keeps identity
stable while file-local maximum-distance assignment preserves useful
distinction for the usually small visible author set. Regenerating only after
an error keeps corrupt state recoverable without turning palette maintenance
into a background retry loop.

## Foreground diff latency

A working-tree file selection depends on its exact Git projection and renderer,
not on fresh provider-session aggregates. Once the project id has resolved in
the server's project snapshot, every Source Control path-only route may reuse
that known identity even after the aggregate snapshot's five-second freshness
window expires. A cold server may discover projects once; clicking a file after
the Changes list is visible must not synchronously rescan Claude, Codex, or
Gemini histories. Session/project inventory refresh remains owned by the
surfaces that consume that mutable inventory.

The working-tree diff endpoint reports `Server-Timing` phases named `project`,
`preflight`, `versions`, `render`, `projections`, and `total`, and emits the same
numbers in its debug event. This keeps future regressions attributable: a
simple file should spend only ordinary subprocess time in Git preflight/version
reads, while syntax highlighting or Markdown rendering is visible separately
as `render`. The file-diff request does not compute or fetch blame.

The comment-anchor projections only read `HEAD`, so they depend on nothing
else the request computes and run concurrently with it. Their phase is
therefore an overlapping wall-clock window, and the number is the time that
read was awaited rather than its exclusive share.

The binary classification stays strictly *before* the version reads, and a
later latency change must not parallelize the two. That ordering is what keeps
a binary file's bytes from being read into memory at all: the size-based
preview skip only covers untracked paths, so for a tracked binary the
classification is the sole guard, and speculating on the version reads
alongside it would trade a bounded skip for an unbounded read. The cost of
holding the order is one subprocess latency. Note that a response-level test
cannot catch a regression here — the classification still wins the race and
still returns the skip — so the guard is the ordering itself.

Syntax highlighting dominates the remaining cost — roughly 90µs per tokenized
line, and a whole file is tokenized per version. A version's content determines
its highlighting exactly, so the server retains highlighted output keyed by
content and language, bounded by total retained bytes. This is a pure function
of content and needs no invalidation window; do not add a time-based expiry
that would reintroduce the cost.

**No request pays whole-file tokenization.** Highlighting a whole file gives
the tokenizer exact context, but a request that has to compute it scales with
the file rather than with the change — for a ~2000-line source file that was
413ms of tokenizing. A diff therefore takes whichever it can have now: the
retained whole-file result when that is already paid for, otherwise an excerpt
of just the hunk lines, while scheduling the whole-file tokenization to land
after the response. The next read of that same version — the status-poll
refetch, a reselection, a whitespace or full-context toggle — is exact and
tokenizes nothing. Measured on that file: 413ms → 89ms first look → 9ms
thereafter.

Scheduled whole-file tokenizations are capped, because each one blocks the
loop while it runs and walking quickly through a changeset would otherwise
queue a long stall. Dropping one is safe — the request still has its excerpt,
and the next read of that version schedules it again.

The excerpt is what makes this a trade rather than a free win: tokenizing only
the hunk lines starts outside any string or comment that opened above them, so
a prose word inside a docstring can render keyword-coloured. That error is
therefore deliberately **transient** — it belongs only to the first look at a
version and must not become the steady state. A change here that removes the
background warm, or that serves the excerpt when the whole-file result is
cached, breaks the contract even though every response still parses.

Do not "fix" the first-look approximation by making the request wait for
whole-file tokenization; that is the 1.2s this replaced. Worker threads do not
substitute either: they would let the two versions tokenize in parallel, but
the common case has one cold version, so they buy no latency there — their
value is keeping a long tokenize off the loop that also serves live sessions.

Do not add speculative file-diff prewarming as the first remedy for a slow
selection. Eliminate unrelated project/session scans and measure the remaining
phases first. Prewarming the likely next file remains an optional latency
courtesy only if those measurements show a meaningful irreducible renderer
cost; it cannot become a correctness dependency or retain unbounded file
content.

### Selection cost is independent of corpus size

Entering Changes and selecting a file must cost what that one file's diff
costs. Two client-side rules keep it there, both of which a large working tree
otherwise breaks:

**Background enrichment yields to the foreground.** A capable server answers
compact directory expansion and search from its retained untracked cache rather
than launching one Git status per directory. A legacy server keeps the bounded
`git status --untracked-files=all` folder path; that sweep stays below the
browser's per-host connection budget and coalesces arrivals into periodic list
updates. Neither path may queue status or the selected file's diff behind
background enrichment.

**A changed-file row's object identity changes only when its state changes.**
The diff pane reloads when its `file` prop changes identity — that is how a
live working-tree refresh reaches an open diff, including when the summary
fields did not move. Rebuilding every row on each untracked-folder arrival
therefore recomputed the selected file's diff once per arrival. The merge that
produces rows reuses the previous object for any path whose state is unchanged,
and deliberately does not reuse across a new status snapshot, which is the
live-refresh signal itself.

The fixed `git-source-review`, `git-working-tree-files`,
`git-source-review-projections` and `git-inclusive-to-head` identities retain
their existing route meanings. Current clients assume the complete v0.8.0
contracts and have no update-only gate, projection support props or reduced
inventory browser. Inclusive To HEAD uses its `range-to-head` list/diff routes;
the direct per-file comparison remains its separate action. The static
current-content inventory remains available when optional live sections are off.
`git-working-tree-sections` (permanent ID 41, optional from `0.7.2`) owns
the expanded live snapshot and delta contract described above. Its absence
keeps ID 38's static behavior and sends no worktree subscription. The Maintainer
approved changing unpublished ID 41 to opt-in availability after the watcher
exhaustion incident rather than publishing its unsafe version-implied default.
With the platform-dependent monitoring default, Linux servers advertise IDs
41/42 out of the box while the effective setting is On; the optional-bit
mechanism and the server-side rejection while Off are unchanged.
`git-working-tree-complete-scan` (permanent ID 42, optional from `0.7.2`)
separately owns exact filesystem totals and complete projection requests; its
absence preserves ID 41's bounded inventory without a Show-all action. The
permanent live-worktree-setting capability owns the additive, platform-
dependent server setting, now baseline in current clients. Active ID 41 and the
server-side setting still determine whether monitoring can be acquired.
`git-incoming-commits` (permanent ID 39,
version-implied from `0.7.1`) owns the local tracking-ref preview, now baseline
in current clients. None broadens a published Source Control capability. See
[server capabilities](server-capabilities.md) and
[`063-source-control-hosted-compatibility.md`](../docs/tactical/063-source-control-hosted-compatibility.md).

### Status freshness

Git status outside Source Control may be up to about three seconds old.
`GET /:projectId/git` shares one status read per project and untracked
mode across sidebars, file views, other tabs and activity refreshes for that
window. The Source Control view sends `?fresh` and always reads current
status. A finished check-remote, pull or push drops the shared read, so the
status after an operation is current. Only the request that performed a read
reconciles dirty-file editors authoritatively (§ Dirty-file last editor): an
older shared read must not clear an editor recorded after it began.

Checks that only prove a cache current read HEAD from the repository's ref
files rather than starting `git`: blame's per-file validator (file mtime and
size plus HEAD), the author palette, and the file-projection manifest's HEAD.
An unchanged file and an unchanged HEAD therefore cost no git process. The
manifest's `HEAD^1` is memoized per HEAD commit.

## Dirty-file last editor

The selected dirty file links to the **last YA session observed editing
it**. This reverses the existing bridge from a session Edit block into the exact
dirty file without pretending YA can reconstruct complete authorship. In
Changes, the selected file banner and shared file context menu expose one
compact session action when attribution exists; it navigates through the
canonical YA session id. The context-menu action includes the session's known
display title, falling back to its short id when the title is unavailable.
Selecting a file starts no attribution or session query.

Opening that file's menu triggers one targeted read of the existing session
metadata route when the source-keyed client catalog has not yet observed any of
the session's title fields. Concurrent openings join the same source/project/
session request. A successful response merges only project and title facts into
the catalog at request-start freshness, preserving richer summary fields and
feeding the still-open menu, selected-file header, and later consumers. An
explicit null title is an observation and therefore does not cause repeated
reads. Failure keeps the short-id fallback and permits the next explicit menu
opening to retry. This adds no dirty-editor payload field, server route, or
capability; older servers already support the stable session metadata route.

The live Working Tree projection carries `lastEditor` forward from the latest
status metadata for the same path when its resident change row has no newer
attribution of its own. Replacing status rows with live snapshot rows must not
silently remove an already-observed editor action.

Git records no dirty-file session authorship. The deliberately bounded
contract is **the last session with a recorded edit**: a successful structured
file mutation YA observed in a canonical session—Edit, Write, `apply_patch`, or a
provider equivalent—whose normalized project-relative target is this path.
Do not infer an editor from active sessions, project membership, or file
mtime.

The server observes every owned provider process at the normalized
`tool_use`/`tool_result` boundary. It remembers a mutation proposal by tool id,
then records paths only when the paired result is not an error. `apply_patch`
parsing covers every Add, Update, Delete, Move, and unified-diff path in a
multi-file patch. Repeated completion-phase tool-use events do not replace the
earlier proposal. Provider adapters must mark declined or failed mutations as
error results; a proposed or failed edit never earns attribution.

One private server-owned JSON store retains a logical row per canonical project
path and normalized repository-relative file. A row carries only the canonical
YA session id and successful-result observation time. A later observed edit
replaces it, while a late completion with an older observation time cannot
overwrite newer attribution. There is no editor set, event history, tool id,
content hash, transcript backfill, or before/after lineage. The observer already
has project and session context, so Source Control must not run provider
discovery, session inventory, or `agent-mapping` work to construct the link.
This is YA application metadata for a still-dirty path, not a Git note, commit
header, hidden commit field, or commit-message trailer. YA currently records no
session attribution for committed changes; cleaning or committing the path
removes this last-editor row once status reconciliation observes it clean.

Scripted commands are a deliberately best-effort supplement. For a bounded set
of recognizable write-shaped shell commands—redirection, common file mutation
primitives, patch/apply operations, and formatter/package-manager write
modes—the observer compares Git's dirty paths and filesystem fingerprints just
before and after a successful command. Only dirty paths whose fingerprint
changed are attributed. Arbitrary scripts, generators with unrecognized command
shapes, human edits, external processes, provider activity YA did not observe,
and fast writes racing the initial snapshot may remain unattributed. Concurrent
external writes during a recognized command can be misattributed. These gaps
are preferable to scanning Git around every read-only shell command or guessing
from active sessions.

A successful complete Git-status refresh is the clearing authority. Any stored
path absent from dirty status is deleted; a commit that leaves another staged or
unstaged change does not clear it. A failed or unavailable status read is not a
clean listing and never prunes attribution; it may decorate whatever rows are
available, but stored rows survive until an authoritative refresh. Compact
untracked-directory rows preserve stored child attribution until Git expands or
cleans that directory. The compact folder itself does not expose a child-session
link; its existing expansion response includes attribution for the individual
files. Reconciliation may wait until Source Control enters or refreshes the
project; restart does not walk all repositories. An unobserved writer can
therefore replace or revert the recorded session's contribution while leaving
the path dirty, so the action is worded as the last editing session and never
claims exact-byte authorship.

The permanent `git-dirty-file-editor` capability adds optional
`files[].lastEditor = { sessionId, observedAt }` data to the existing
status response. Current clients use that baseline contract and show the
session action only when actual attribution data exists. Missing attribution
never creates a session link or metadata request.
Existing `git-status-enhanced` and `git-source-review` meanings do not grow.

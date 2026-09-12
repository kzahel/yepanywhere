# Source Review → New Session

> Source Review → New Session is the Source Control workflow that accumulates
> line-anchored drafts, freezes each submitted reviewer entry with the exact
> source projection it describes, and carries site history and agent outcomes
> across submissions to new or existing sessions.

Topic: source-review-to-session

Parent topic: [Source Control](source-control.md).

Status: **stages 1–7 implemented** (2026-08-01). The original stages 1–3
landed 2026-07-26, including the P8 diff view mode. The pending set is
browsable as a **Comments mode tab** (list, delete, jump-to-blame, submit)
beside changes/commits/files. The first GitHub
Desktop-inspired review-navigation slice is implemented (2026-07-27): Commits
includes a shared dirty Working tree revision, source lists support keyboard
traversal/search, and diff hunk navigation is symmetric. The follow-up
refinement (2026-07-28) adds one accessible action-menu contract across
revisions, files, and diff lines; a compact shortcut card; and edge-only,
keyboard-accessible desktop pane splitters. The same refinement now includes
independent Ignore whitespace and selected-revision-to-HEAD diff projections.
Design owner: graehl.

Live use of that flow (2026-08-01) exposed gaps now closed by the submission
and comment-site implementation: the archive lacked a reader, pending comments
could not be edited, destinations and comment composition were too constrained,
and seeded turns pointed agents at the whole mutable draft store.
**[Submissions and comment sites](#submissions-and-comment-sites--contract-2026-08-01)
is the governing contract for the implemented replacement** and supersedes the
older lifecycle and draft-location prose below.

## Storage Policy Amendment — 2026-08-03

The historical design below chose project-local `.yep` files and the Git ref
`refs/yep/source-review/captures`. That location decision is superseded by
[Project Directory Storage](project-directory-storage.md).

In the default **App data only** mode, review drafts, submissions, response
state, and exact-source captures live in central project-keyed storage. Source
review must not create or modify `.yep`, `.git/info/exclude`, Git objects, or
YA-owned refs. If a file-by-reference agent workflow truly requires a
project-local artifact, it requires the global project-local storage opt-in;
the source-review feature setting alone is not storage consent.

Existing `.yep` state and `refs/yep/source-review/captures` may remain readable
for compatibility but are not migrated, refreshed, or deleted during upgrade.
The current post-`0.7.0` implementation is recorded in the parent topic's audit
and awaits correction. Wherever later historical prose says the project-local
home "stands" or is the established convention, this amendment wins.

Related topics: [selection-comment-ui](selection-comment-ui.md) (the
quote-comment ancestor — but see the gesture difference below),
[source-review-followups](source-review-followups.md) (dormant agent-authored
annotations for later review sweeps),
[floating-new-session-composer](floating-new-session-composer.md) (the
first-turn launch path), [local-file-source-highlighting](local-file-source-highlighting.md)
(highlighted read-only file previews),
[forged-transcript-handoff](forged-transcript-handoff.md) and
[session-context-actions](session-context-actions.md) (seeding a session with
prepared context), [provider-context-economics](provider-context-economics.md)
(cost of quoted code), [compose-time-context-anchors](compose-time-context-anchors.md)
(staleness/provenance framing for composed turns).

## Origin

Prompted by [kzahel/yepanywhere#95](https://github.com/kzahel/yepanywhere/issues/95):
a contributor shipped a polished file browser plus full git management (branch
switch, log, changes, stash, history, fetch/commit/push). kzahel deliberately
kept YA's git surface minimal — pull/push/refresh only — because he lets agents
do committing and conflict resolution and rarely takes manual git actions. The
contributor then named the part that actually earns its keep: the viewer is a
**bridge for directing agents**, not a repo-management console. Their two live
use cases were (1) grab exact file names / relative paths to feed an agent, and
(2) read the git log to grab a branch name or commit hash so they can tell the
agent "look at what changed in *this* commit and adapt."

This proposal takes that bridge framing as the whole point and adds the piece a
detailed reviewer wants: **comment on diff lines, then hand the whole review to
a fresh agent** — the review-tool interaction (Gerrit/GitHub line comments)
minus any obligation to perform the git actions yourself.

![3-column recent-changes browser (kzahel/yepanywhere#95)](https://raw.githubusercontent.com/chenxiccc/yepanywhere/assets/screenshots/source-manager/git-management-04.webp)

*Reference layout (kzahel/yepanywhere#95, the contributor's Source Manager): a
3-column recent-changes browser — commit list · changed files · unified diff. A
side-by-side diff option would make it 4 columns. Linked to the upstream asset
rather than committed, to avoid polluting the repo.*

**Reference implementation, not a template.** The issue #95 submitter's
archived
[`source-file-manager-v3` branch](https://github.com/chenxiccc/yepanywhere/tree/archive/source-file-manager-v3)
is useful for interaction and layout inspiration only. Do not copy it wholesale:
it is deliberately more feature-rich than YA's goals here, especially around
file and git management. Any borrowed idea must first pass this topic's
review-first, agent-directing scope.

## Design stance

- **Review-first; Pull/Push are narrow exceptions.** Inspection, copying, and
  composing an agent turn are the surface's center. The established remote
  controls are Check, Pull, and Push: Check refreshes remote-tracking
  observation; fast-forward-only Pull and explicit Push are the only manual
  operations presented as repository state changes. Commit, stage, branch,
  stash, integration, conflict, and destructive/recovery work stays with
  agents. This is a deliberate safety and workflow decision, not an
  implementation limitation: even when a button would be trivial to wire, an
  attentive agent can inspect preconditions, preserve unrelated work, explain
  the exact operation, and adapt or recover when the repository is not in the
  expected state.
- **Compose, don't act.** The output of a review is never a git operation; it is
  a **review session turn** — a new session, or a follow-up to a recent review
  session — carrying the reviewer's comments and the code they were about. The
  reviewer directs; the agent acts.
- **One surface, two modes — both accumulate.** "Source control" is a single
  surface with two navigation modes that feed the **same** comment accumulator:
  (1) the working-tree (uncommitted) diff and recent commits / diffs (the
  primary review flow — reviewing an agent's dirty worktree *before* it commits
  is the hottest supervision moment), and (2) an **all-files
  git-blame browser** — open any project file, not just recently-changed ones,
  with blame giving each line its originating commit. Clicking a blamed line
  opens the same comment window. The all-files browser is a subsection/mode of
  source control, **not a standalone feature**.
- **Line comments, implied context — no precise selection.** You click a diff
  line to open a comment window; you do **not** drag-select an exact span to
  limit context. It is implied that the nearby context is what the comment is
  about, and the tool includes it. This is deliberate: hand-delimiting spans is
  friction, and "the code around this line" is almost always the intent. The
  payload carries a small immediate snippet inline plus references for larger
  context (see the seeded-turn contract below), never a reviewer-chosen span.
- **Large-screen, multipane — with a first-class mobile path.** The design
  target is a smooth, large-screen multipane layout (like the #95 branch
  screenshots): navigate recent commit(s) in one pane, read a diff in another,
  comment on various diff lines as you go. Mobile is not an afterthought: a
  back-swipe-navigable version, with a small selector to jump between commits,
  stays usable for reading diffs and leaving comments on the go.
- **Build on existing surfaces, don't rebuild.**
  - [selection-comment-ui](selection-comment-ui.md) — select text → `>`
    blockquote into the composer with a green comment-anchor tint. It is the
    quote-comment *ancestor*, but the gesture here differs: **click a diff line →
    comment window**, not drag-select, and the destination is a persistent
    pending review, not the live draft. The comment-anchor tint (marking a line
    that already has a draft comment) still applies.
  - `GitStatusPage` / `GitStatusDiffPreview` / `routes/git-status.ts` — the
    existing read-only status + diff viewer to grow the multipane commit/diff
    browsing from.
  - [local-file-source-highlighting](local-file-source-highlighting.md) —
    Shiki-highlighted previews via the authenticated local-file route, for the
    file-viewer half and the highlighted diff.
  - Path/link affordances graehl noted: any path mentioned in a session is
    already viewable and any file link is already copyable — the viewer makes
    those first-class rather than incidental.
  - [floating-new-session-composer](floating-new-session-composer.md) — prior
    art for composing a first turn from a non-session page; the submit
    endpoint owns the actual launch (see the implementation sketch).

## Core feature: the accumulating review (the vision)

This is the actual proposal, not the one-off below. It is a Gerrit-style set of
**draft comments that persist and accumulate** — across files, across diff lines
within a commit, and across the tree as it keeps changing under them — until a
single "submit review" drains *every not-yet-consumed comment at once* into one
review session. The value is that a reviewer works over a change at their own
pace, leaving line comments as they go, and only later hands the whole
considered review to an agent in one shot.

There is deliberately **no Gerrit-style patch-set or change-identity concept**:
plain git has no stable identity for "the same change" across amends and
successive commits (no Change-Id machinery here), and everything patch-sets
would buy is already covered by per-comment anchoring revisions plus
submit-time relocation below.

- **Comment on a line.** Clicking a diff line — on either the `-` (removed) or
  `+` (added) side — or a blamed line in all-files mode opens a comment window
  anchored to that line; its provenance follows the rules below. No exact-span
  selection; the tool carries a small immediate snippet and references for the
  rest (see the seeded-turn contract).
- **Anchors and drift.** Each comment anchors to `{ repo-relative path,
  anchoring revision, line, nearby-context snippet }`. The anchoring revision
  is one of: the reviewed commit's SHA, the blame line's origin SHA, the HEAD
  SHA at comment time (the all-files "as of HEAD" case), or **uncommitted** —
  a working-tree change with no SHA, labeled `uncommitted` and timestamped.
  Drafts live for hours or days while agents keep committing, so anchors
  drift: lines move, change, or vanish. At **submit time, per comment**, the
  anchor is relocated against the current tree — exact line match first, then
  a fuzzy context-snippet match (patch-hunk style). An `uncommitted` anchor
  whose change has since been committed acquires that commit's SHA and
  relocates the same way.
- **Provenance, and when the generated message cites a SHA.** The generated
  message states the SHA **only when relocation fails** — the commented line no
  longer exists in the current tree, so the agent needs the commit to locate
  the historical line. When relocation succeeds, the message omits the SHA and
  gives path + current line + snippet; the agent can run `git blame` itself if
  it wants provenance. This keeps the seeded turn lean and only cites commits
  the agent actually needs. A comment on the `-` (removed) side of a diff is by
  definition about code no longer in the tree, so its SHA is **implied and
  always cited** (a concrete case of the relocation rule). For diff comments
  the message can also frame the change as *from X to Y*, where X and Y are the
  clicked line plus a few surrounding lines in the old and new versions
  respectively — so the agent sees the before/after region, not just the single
  side that was clicked.
- **Submit preview; stale comments default to discard.** "Submit review" first
  shows a preview of every pending comment. Comments whose context no longer
  exists (relocation failed) are listed **first**, pre-selected **discard** —
  it is usually too late to act on them — but the reviewer can override and
  include any of them (each then carries its SHA citation), since discussion
  of history can still inform present state.
- **Pending → consumed (archived) lifecycle.** A comment is *pending*
  (unconsumed) from creation until a review is submitted. Submit gathers the
  pending comments that survived the preview, composes one review turn,
  delivers it, and **archives** those comments as consumed: they stay visible
  on their anchors and in an archive list, linked to the session they went to —
  so "did I already comment on this?" has an answer — and the next submit will
  not resend them. Comments added afterward form the next pending review. A
  visible pending count (like unsent Gerrit drafts) is the reviewer's cue to
  what a submit would carry. — Superseded 2026-08-01: a consumed comment does
  not merely archive, it becomes a **site** carrying open/addressed/resolved
  state and accumulated history.
- **Submit target: recent review session by default.** When a review session
  was recently started from this surface, submit defaults to delivering the
  new batch to it as a **follow-up turn** — that agent already holds the
  earlier review context. The submit flow lets the user override: pick any
  existing session manually, or opt for a fresh one. Existing choices identify
  their provider/model; a fresh session exposes provider and model choices
  explicitly. "Recent" is a default, not a gate; absent a prior review session,
  the most recently updated project session is a reasonable follow-up default.
  Each consumed batch records which session it went to.
- **The seeded turn: short prompt + review file, small snippets inline.** The
  delivered turn is a short prompt — naming what this is (a source review),
  instructing the agent to address each comment and report per-comment
  dispositions, and explicitly instructing it to read current file state
  rather than trusting quoted snippets — referencing a **project-local `.yep`
  review-comments file** that carries the structured comments (a follow-up
  turn references the same file updated with the new batch). Each comment
  gives path + line + anchoring revision plus a **small immediate snippet
  inline**: inline context lets a human reading the transcript comprehend the
  review, and makes the agent less likely to miss the immediate context — at
  the known risk that the agent settles for the snippet instead of reading the
  larger context, which the read-current-state instruction counters. Larger
  context stays by reference; for a non-current revision the agent views it
  with git commands. — Superseded 2026-08-01: the turn references a frozen
  per-submission directory, never the mutable draft store, and leads with the
  submission name or first-comment excerpt.
- **Where drafts live: server-owned, in the project's `.yep/` dir.**
  Relocation, blame, and submit composition all need server git access, so
  the server owns the drafts and is the single authority for
  pending/archived state — a review started on the desktop continues on the
  phone with the same pending set and archive. Storage is a git-ignored
  project-local `.yep/review-comments.json` per the agreed `.yep/`
  YA-managed-state home ([interactives](interactives.md)): the project path
  is the keying (two repos' drafts can never mix), the drafts follow the
  checkout they annotate, and the file sits exactly where the seeded
  prompt's review file must live, so submit composes largely by reference.
  The client holds only UI state (the open comment window's in-progress text
  may keep a localStorage backup, like message drafts). — Amended 2026-08-01:
  server ownership and the `.yep/` home stand, but `review-comments.json` is
  private draft state that no seeded prompt may reference; submissions get
  their own frozen `.yep/source-review/<id>/` directories.

## Submissions and comment sites — contract (2026-08-01)

This section governs wherever it differs from the vision prose above and the
historical records below, which are retained as the origin account. It was
written from live use of the shipped flow, and each item below names a
behavior that use found missing or wrong.

### A submission freezes its request, not its whole directory

A **submission** is one accepted submit attempt. YA creates
`.yep/source-review/<submissionId>/request.json` before it can enqueue or
deliver the turn. That versioned, server-authored file is immutable and
contains the submission id, optional name, submit time, requested target, and
one frozen entry per included comment: site and entry ids, reviewer text,
anchor and relocation result, immediate snippet, and capture identity.

The seeded turn references **only** that submission directory.
`.yep/review-comments.json` remains private draft state and is never named to
an agent. Resolved delivery state, the eventual canonical YA session id, unread
watermarks, and cross-submission indexes are mutable server state outside
`request.json`; a queued new-session request cannot truthfully freeze a session
id that does not exist yet.

The agent may create or replace `response.json` in the same directory. Thus the
directory is intentionally mutable while the request snapshot is not. Two
sessions cannot interfere because every submission has its own directory and
response file, not because the directory is read-only.

### A capture identifies the exact rendered source projection

Every submitted reviewer entry records a `captureBlobId` for the exact file
projection and side the reviewer saw. This is distinct from the anchor's
provenance or relocation revision: a blame line's origin SHA is not necessarily
the revision whose file content was rendered, and an old-side commit line may
come from the comparison base or parent rather than the clicked commit.

With project-local storage enabled, a committed projection resolves the
already-existing git blob and a worktree or otherwise dirty projection writes
the rendered bytes as a real git blob at **comment creation** (`git hash-object
-w`). In the default app-data mode, the same exact bytes are stored centrally
under their SHA-256 content id without writing Git objects or refs. Publication
uses a fully written and fsynced temporary file followed by atomic rename;
existing content is accepted only when its bytes match, and reads reject a
SHA-256-named file whose content does not match. YA never waits for submit and
never substitutes current bytes for a historical or removed side. The capture
descriptor also records enough projection identity to reconstruct which side
was shown without treating `captureBlobId` as provenance.

All anchor and capture paths must be validated as repository-relative before
any file read or git invocation. Absolute paths, `..` traversal, and symlink
escapes outside the project root are rejected; a syntactically short string is
not sufficient validation.

**Captures must be pinned or git deletes them.** Verified 2026-08-01:
`git gc --prune=now` prunes an unreferenced capture blob and retains a
referenced one. YA retains every capture from the object database's single
`refs/yep/source-review/captures` ref, whose target is a tree with entries named
by blob id. Linked worktrees share the object database and therefore share this
ref; it is not one independently writable ref per project directory.

Adding a pin is an append-only compare-and-swap update: build the union of the
current tree and the new blob ids, run `git update-ref` against the exact old
object id, and retry if another writer won. Identical blobs intentionally share
one entry. Resolution does **not** unpin anything: resolved sites and old
submissions remain browsable. A future deletion feature must remove a blob only
after proving that no surviving site or submission in the shared object
database references it; until that reference accounting exists, the pin tree
is append-only.

The agent can read a capture with `git cat-file blob <id>` and YA can compare a
captured file with current worktree state. A path-bearing diff invocation must
still use an explicit path boundary; the blob id alone does not make an
untrusted path safe.

### Sites hold immutable submitted entries

A **site** is the stable discussion location. It owns an ordered history of
reviewer entries and agent outcomes:

- A pending, unsubmitted entry may be edited in place. Its capture continues
  to describe the source it was written against; changing its anchor creates a
  fresh capture.
- Once submitted, a reviewer entry is immutable history.
- A reviewer follow-up creates a new entry at the same site with a fresh
  comment-time capture. It does not reopen the old entry.
- The site is **open** while its latest submitted reviewer entry has neither a
  recorded outcome nor a non-whitespace change in the captured neighborhood.
- It is **addressed** when either of those conditions becomes true.
- It is **resolved** only by the reviewer. Resolution removes it from active
  work surfaces but does not delete its history or captures.

This per-entry rule matters: a code edit that addressed the first entry cannot
automatically address a later follow-up, because the follow-up compares against
its own fresh capture. A resend carries only the site's latest open reviewer
entry.

**Addressed and unchanged are different axes.** YA compares each entry's
captured neighborhood with current state, ignoring whitespace-only changes. An
entry can be addressed by a **No change** or **Question** outcome while its code
is unchanged. The version-1 response schema stores No change under its legacy
machine token, `wont_fix`; prompts and UI do not present that issue-tracker
wording as the human disposition. Reviews and changed-file rows show both the
open/addressed state and an independent unchanged indicator, so "the agent
answered without editing" does not become the contradictory claim that the
comment is unaddressed.

### The persisted site model precedes submission persistence

The existing version-1 store freezes comments as `pending` or `archived` and
lets batches merely reference comment ids. That is not the site model and must
not become the input to new immutable manifests. Introduce the versioned site,
entry, submission-summary, and draft schemas first; all later submission and
outcome work builds on those canonical entities.

Migration preserves every version-1 draft, archived comment, and batch. Since
the old format did not capture the exact rendered projection, migrated entries
are marked `legacy-missing`, and the UI says that captured source is
unavailable. Migration must never fabricate a comment-time capture from the
current file. The existing lifetime cap also stops counting archived history:
it bounds active drafts only, while submission summaries are paged and full
history stays in per-site/per-submission records. Otherwise 2,000 lifetime
comments permanently wedge comment creation even though the UI cannot delete
archived comments.

### Submission acceptance is idempotent

The client supplies a stable submission id as the idempotency key. Submit
reserves the included pending entries, writes and fsyncs the frozen
`request.json`, and only then asks the session launcher to enqueue or deliver a
turn carrying that same key. Acceptance archives the reserved entries even
when a queued new session has no session id yet. Mutable server state later
associates the submission with the canonical YA session id, including provider
session-id remapping.

Retrying the same submission id returns the same accepted result and cannot
send a second turn. The launcher/input queue must enforce that invariant across
the crash window between delivery and the server recording completion; a
check-then-send route handler alone cannot. A failure before queue acceptance
releases the reservation and leaves the comments pending. Startup recovery
finishes or rolls back durable `prepared` submissions rather than silently
resending them.

Manifest publication is atomic and no-clobber: YA writes and fsyncs a unique
temporary file, links the completed inode into the final `request.json` name,
then syncs the submission directory where supported, using the shared
[Windows directory-sync fallback](server-runtime.md#cross-platform-file-persistence).
The same fallback applies to review state and app-data capture publication.
A crash before publication may leave only
an ignored temporary file, never a truncated final manifest. If an older crash
left an invalid manifest for an unaccepted `prepared` submission, retry removes
that invalid reservation and rebuilds it from the still-pending entries. An
invalid manifest already associated with accepted history remains an explicit
conflict and is never overwritten.

### The response file is a versioned atomic snapshot

`response.json` contains `{ version, submissionId, outcomes,
suggestedTitle? }`. Every outcome names an exact `{ siteId, entryId }`, one of
the machine values `done`, `wont_fix`, or `question`, and bounded free text.
The persisted `wont_fix` value is presented as **No change** and covers both
"no source change was requested" and "a source change was considered but is
not needed." Keeping the version-1 token preserves existing response files;
its narrower name does not define the user-facing semantics.
One valid response revision covers every entry in `request.json` exactly once.
Unknown, missing, or duplicate ids; an incorrect submission id or version; an
oversized file; or invalid/truncated JSON rejects the entire revision without
changing previously ingested state.

Ingestion is atomic and idempotent by content hash. Re-reading an identical
file adds nothing. A later valid complete revision appends history only for
outcomes whose disposition or text changed; omission never erases a prior
outcome. A "why no change yet" explanation is the outcome text linked to the
authoring session, not a reviewer comment and not another pending entry.

Optional clarification, discussion, source-comment, and gap annotations are
not part of this response contract. The dormant proposal in
[Source review follow-ups](source-review-followups.md) keeps them orthogonal to
the per-comment disposition and forbids adding them to review prompts until YA
has a workflow that intends to receive and act on them.

### Response observation is per delivery, bounded, and explicit

YA does not watch the filesystem, poll response files, or scrape reply text.
For each `(canonical YA session id, submission id)` association, it re-reads
that submission's `response.json` after each of the first completed assistant
turns following delivery. The server setting `sourceReviewResponseTurns`
controls the bound from 1 through 32 and defaults to **eight**. A completed
turn is the provider-neutral idle boundary after assistant activity advanced,
not every streamed message. The counter and association survive restart, and
provisional-to-canonical session id remapping moves them together. A later
submission delivered to the same session gets its own observation window.
After the window, an explicit Refresh in Reviews can ingest a late response
without restoring background work.

Unread state is a server-side outcome revision paired with an acknowledged
revision. Listing or prefetching submissions never marks anything read; YA
acknowledges only when the reviewer actually opens the outcome-bearing
submission. A capability-gated `GET /api/review/inbox` supplies unread review
outcomes to Inbox before Source Control opens, and acknowledging the visible
submission uses
`POST /api/projects/:projectId/review/submissions/:submissionId/acknowledge`.
After a changed complete snapshot is durably ingested, the server emits
`review-response-changed` on the activity stream so an already-open Inbox can
refresh the optional feed only after ingestion finishes.

The unread review Inbox is a retained compact projection, not an all-project
read. Response ingestion, acknowledgment, deletion/migration, and project
metadata changes update the exact submission row and publish a versioned
delta. Reading or filtering Inbox performs no project listing, full
`ReviewStoreFile` loading, Git work, response-file probing, provider work, or
transcript work. The durable projection and any project manifest live under YA
app data and must share the central-storage owner described by
[project-directory-storage](project-directory-storage.md). The implementation
handoff is
[`docs/tactical/099-retained-source-review-inbox.md`](../docs/tactical/099-retained-source-review-inbox.md).

### Turn composition

Lead with the submission's name. An unnamed submission takes the excerpt YA
derives from the first comment — the same text the name field shows
grey-prefilled — so named and unnamed submissions yield the same kind of
title. Then one or two lines: what this is, the pointer to the submission
directory, and read-current-state. Then the comments grouped by file, each
with location, snippet, and capture id. Then the instruction to record
outcomes. The multi-paragraph preamble the first implementation shipped costs
more attention than it buys and goes.

### Naming a submission

An optional short field beside the submit button — never a second click, a
confirmation step, or a modal of its own. It shows the derived excerpt
grey-prefilled; typing replaces it, and leaving it alone accepts the prefill.

### The comment editor never covers its subject

**The requested design is a vertical split into two views.** The upper view
ends with the anchored visual row, the composer follows it, and the lower view
starts with the next row. The anchored line therefore remains readable. This
is a split of the client render model, not an insertion into generated DOM and
not a second server render: unified mode slices the existing
`parseDiffLineFragments` result, and side-by-side slices the existing
`buildSideBySideRows` result. The outer render/controller changes; server-side
highlight generation and generated DOM do not.

**A column is an accepted initial fallback**, not the target. The composer
takes a column beside the source, which then requires side-swipe scrolling on
mobile. For unified diff this is the composer with a connector to a horizontal
rule marking the spot in the diff.

Either way the line under discussion stays readable in its real surroundings,
and the popover's quoted snippet stops being the only way to know what is
being commented on. Blame commenting shares this surface and gets the same
treatment, not a second approximation.

### Immediate-submit destination is chosen in the comment editor

The comment editor's immediate-submit action always offers a destination,
preferring the session with recorded edits to this file when provenance is
known, else the project's recently active sessions in a dropdown, else a new
session. **Add to review remains targetless**: the accumulator's destination
is selected when the batch is submitted, so comments accumulated at different
times never silently create a mixed-destination batch. Today the
submit-to-session action renders only when Source Control was opened from a
session Edit-block link. The recently-active dropdown satisfies this contract
before dirty-file provenance lands.

### Pending Comments and Reviews are separate Source Control modes

**Pending Comments** is the accumulator: unsubmitted comments, editable in
place. **Reviews** browses submissions — a submissions list column (phone: a
selector), and the selected submission's comments shown against the source
captured at comment time, each with its outcome and a link to its target
session. Both navigate alike. Source Control therefore has four top-level
modes: Changes, Files, Pending Comments, and Reviews. The existing
`?tab=comments` URL continues to select Pending Comments; `?tab=reviews`
selects Reviews. The selector's wrapping contract in
[Source Control](source-control.md) must be re-verified at phone width rather
than assumed to still fit.

### Hosted compatibility is additive and separately gated

The stable compatibility corpus for this optional feature is v0.7.0 and
v0.6.2; neither advertises the existing `git-source-review` capability. The
new server contract is owned by a permanent
`git-source-review-submissions` capability, not by broadening
`git-source-review` after it has shipped.

The new capability covers:

- paged `GET /api/projects/:projectId/review/submissions` and detail
  `GET /api/projects/:projectId/review/submissions/:submissionId`;
- `POST /api/projects/:projectId/review/submissions/:submissionId/acknowledge`
  and
  `POST /api/projects/:projectId/review/submissions/:submissionId/refresh-response`;
- `POST /api/projects/:projectId/review/sites/:siteId/follow-ups` and
  `POST /api/projects/:projectId/review/sites/:siteId/resolve`;
- `GET /api/review/inbox`; and
- `reviewComment.anchor.projection` on comment creation,
  `reviewSubmit.submissionId` and `reviewSubmit.name`, and the server settings
  `sourceReviewSubmissionsEnabled` and `sourceReviewResponseTurns`.

Without `git-source-review`, the client keeps the established basic Source
Control compatibility shell. With `git-source-review` but without the new
capability, it keeps the shipped version-1 comment/submit behavior and may show
the client-only editor split and destination picker, but it shows no Reviews
mode and sends no capture, site, submission, acknowledgement, refresh, or
outcome request. A new server preserves all old request shapes and response
fields for old clients. This compatibility plan requires maintainer approval
before any client/server contract edit.

### Review visibility is on by default for new installs

Submission directories, site/outcome history, the Reviews mode, and review
outcome Inbox cards remain behind the server-persisted
`sourceReviewSubmissionsEnabled` setting. The default is true for new installs
so a user who submits a review can discover its history and eventual response.
An explicit stored false remains authoritative. Existing installs whose
persisted default is already false are not silently migrated because the file
does not distinguish an untouched old default from an intentional choice.
Missing setting data from an older server still means false in the client. The
capability says the server can support the workflow; the setting controls its
visibility, capture history, and outcome tracking. Fixing the existing editor
overlay and offering a destination for an already-invoked immediate submit do
not depend on this option.

Enabling the option activates the new submit transaction and its associated UI
as one contract. With no submitted review, enabling it starts no observation
work. The default-on decision is recorded under
[Vanilla Defaults](vanilla-defaults.md).

### Relocation — deferred, but its contract is stated

No relocation defect has been observed in use, so improving it is not
scheduled. The contract it must meet when touched: relocation answers "does
this text still appear, non-exactly, in the worktree — HEAD plus dirty
state". Today it answers only the exact-line form, choosing the occurrence
nearest the recorded line with no context scoring and no ambiguity signal.

### Proposal, not contract: agent-authored title

Leading the turn with comment content exists to make the session title
meaningful. An alternative would remove that constraint: instruct the agent to
emit a short recap-like title as the first thing in its reply, and have YA
parse it from that session's next response when present. The turn could then
open with the brief instructions and carry no content-first ordering at all.
This is worth building only if compliance and extraction both prove reliable
in practice; until they are measured, leading with content stays the contract.

The response file's optional title field is the cheap variant of the same
idea — a declared field beats parsing prose — but it arrives after the session
already has a name, so it can only rename, not title at launch. graehl treats
recap-style title suggestion as advanced/future either way; nothing here
blocks on it.

### Proposal, not contract: deleting old submissions

A small `×` per entry in the Reviews list would delete that submission's
record outright. It may remove capture pins only through the shared-object-
database reference accounting required above; deleting or resolving one site
does not prove that another site or worktree no longer needs an identical
blob. graehl's condition for treating deletion as unimportant is that captures
are not routinely pushed to a public remote by default.

Verified 2026-08-01: they are not. `git push`, `git push --all`, and
`git push --tags` carry no `refs/yep/*` ref, and a capture blob whose content
appears in no commit stays local. `git push --mirror` does carry them, but
that is a deliberate act rather than a default. Capture retention is
therefore a local-disk concern only, which is what makes deletion a
convenience rather than a requirement — and what keeps a growing capture set
from becoming a repository-hygiene problem for anyone else.

## One-off diff-line comment → session (a fast path, not the vision)

A direct "click a line, comment, start a session with just that now" shortcut
is worth having for a quick single question. It is **defined as the accumulator
containing one comment, drained immediately** — same store, same submit
machinery and never a parallel code path. Submitting either way consumes only
that one comment, leaving the rest of the pending review untouched. Do not
mistake shipping this shortcut for delivering the accumulating review — the
vision is the multi-comment, drain-all-unconsumed flow.

**Edit block → dirty file.** Each session Edit tool block with a usable project
file offers **Review**. The link opens that project's Source Control
in Changes at the exact edited Working tree file. The session containing the
link becomes the **default session** for that Source Control browser-history
entry. Back/forward and navigation among Source Control modes preserve it; a
deliberate project switch clears it. This default is tab-local navigation
history, not server or project recency: activity in another tab, browser,
device, or session cannot retarget it.

**Two distinct immediate-submit actions.** The comment window always offers
**Submit to new session**. When the page has an Edit-link default session, it
also offers **Submit to current session**. Hovering that action shows the
standard session hovercard for the exact destination (opening request, recent
reply when available, provider/model, project, age, and status), with the
Edit-link-captured session identity as its fallback when live summary data is
not yet available.

- **Submit to current session** sends the composed review turn directly to
  that exact existing session. It does not consult recent sessions or prior
  review batches.
- **Submit to new session** starts a separate session using the default
  session's provider, model, thinking mode, and effort. When Source Control was
  not opened from a session Edit link, the default-session action is absent and
  the new session uses the normal launch defaults.

**A background refresh never owns the editor.** Once the reviewer opens a
line-comment editor, status polling and diff refreshes must not dismiss it,
clear its text, replace its captured anchor, or move focus away. This includes
an actually changed diff and a refresh in which the selected file or the whole
dirty Working tree disappears. While the target remains addressable, the live
diff continues refreshing behind the mounted editor; this contract is not
implemented by suppressing equivalent polls. If the target disappears, the
last selected file/diff stays pinned until the reviewer cancels or successfully
submits. Queueing or submit failure leaves the editor and text intact.

**The delivered turn quotes captured context.** A dirty-line draft captures
the clicked line plus nearby context when the editor opens because the file can
shift before submit. Submit relocates that anchor against current state and the
user turn always includes a fenced context quote: current relocated context
when found, or the original captured snippet when gone, plus the path/current
line or historical citation as applicable. The turn also explicitly tells the
agent to read current file state rather than treating the quote as
authoritative.

## Historical combined Source Control scope

The current page-wide navigation and layout contract lives in
[Source Control](source-control.md). This section is retained as the original
combined implementation record; Source Control governs if its current contract
differs.

The polished viewer graehl wanted, kept read-only except for the established
Pull/Push actions:

- **Repo/branch status bar.** At tablet/desktop widths, one small persistent
  top row carries project identity, current branch, sync/dirty state, source
  modes, and the Review entry point. A **yellow warning when the worktree is
  dirty or the branch is out of sync** (ahead/behind its upstream) stays
  visible without spending a second toolbar row. On phone widths only the
  small project header persists; repo state, modes, and review controls may
  wrap into scrolling rows and must scroll away with content. The surface
  exposes status and the established Check/Pull/Push actions, not the deferred
  manual operations in Non-goals.
- **Changes-first with deliberate history.** Source Control lands on
  **Changes** at every viewport, preserving Kyle's accustomed-to quick-check
  experience. Changes owns one revision-detail model whose permanent default
  is **Working tree**: one row per changed path,
  staged/unstaged/both/untracked state, and the same diff/comment stack with
  `uncommitted` anchors. A clean Working tree stays selected with no file or
  recent-commit list. Its **‹ Commit history** parent link explicitly opens
  commit history without introducing a second top-level mode.
- Multipane commit/diff navigation: browse recent commit(s), history/log, and a
  commit's diff **without switching branches**.
  The reference layout above is a **3-column** browser (commits · files ·
  diff); the diff pane renders **unified or side-by-side** per the
  diff-view-mode decision below, side-by-side reading as a 4-column layout.
  From a commit's diff you can switch to an **"as of HEAD" content view
  centered on the diff region, with a blame gutter** — bridging the
  commit-review mode into the all-files/blame provenance.
- Rudimentary search across recent commit **delta (diff) text and/or filenames**
  — enough to find the commit or file you want to comment on. This is a generic
  browser facility, captured here as part of this surface by design intent.
- All-files mode: file tree + search + highlighted file viewing (reuse Shiki per
  local-file-source-highlighting), with **git blame** so any line can be clicked
  to comment into the same review — a mode of this surface, not a standalone
  browser.
- Copy affordances: file name, absolute path, relative path, branch name, commit
  hash — the non-mutating subset of the #95 context menu.
- Mobile: Changes shows its Working tree file list and opens a selected diff
  full-screen. Explicitly opened history is master/detail navigation: commit
  list → selected commit files → full-screen diff, with explicit and
  back-swipe navigation restoring the previous level and list position.
  Selected files never render after the complete history list. The small
  commit-jump selector remains available in commit detail (the #95 branch
  showed mobile matters).

## Non-goals

- No manual git-state-changing actions beyond Pull/Push. In particular, no
  staging, commit/amend, restore/discard/reset, branch switch or creation,
  stash mutation, merge/rebase/cherry-pick/revert, conflict workflow, tag, or
  rename/delete operation is currently planned. When one of those changes is
  wanted, the user asks an agent to perform it with repository-specific
  attention.
- No precise span selection to limit context — anchoring is per-line with implied
  nearby context, by design.
- Not a replacement for agent-driven git; not a full IDE or a second VS Code;
  not a general file manager (the #95 rename/delete items are intentionally
  unimplemented).

## Inbox projection and store lifetime

The unread-outcome Inbox is a derived projection, not a per-request scan of
canonical state. One server-side owner builds it; concurrent mounts, manual
refreshes, and repeated response events join that build rather than each
starting an all-project store load. A project filter narrows the retained
projection and never builds a separate one from canonical stores.

The projection's source version is a monotonic review state revision that every
accepted mutation bumps, because canonical state changes in memory before its
save reaches disk. A project appearing with review state already on disk
publishes no review event today, so a coarse time bucket bounds that staleness
until exact per-row deltas exist. A projection build is accepted only while its
observed revision and project-set bucket remain current. If they move during the
build, neither a success nor a failure from that obsolete read is returned; the
caller follows the newest build instead. A failure from the still-current source
is returned, and bounded retargeting fails explicitly if the source never
stabilizes.

Retained project stores are a byte- and age-bounded cache, not process-lifetime
state. A clean, inactive store may be released after its canonical state is
durable and reloaded on exact project demand. Every mutation of one project is
one serialized operation on one pinned store owner, from any source capture or
manifest read through state mutation, durable save, and revision publication.
A store with such a mutation, a save, or a load in flight is pinned: releasing
it would strand the only copy of state the writer has not yet written. A rejected
save poisons that in-memory owner because the filesystem outcome may be
indeterminate after an atomic rename; queued mutations fail without running,
and the owner is released when its active pins drain. The next operation reloads
filesystem truth and applies the ordinary prepared-submission recovery rules.
Budgets are enforced on access, so the newest store may briefly exceed them.

## Design decisions

- **Uncommitted provenance class** (vs. commit-only anchors): the hottest
  supervision moment is reviewing an agent's dirty worktree before it commits,
  and the existing GitStatusDiffPreview foundation is exactly that view; an
  anchor class with no SHA (labeled `uncommitted`, timestamped) covers it.
- **Changes-to-Commits convergence is approval-gated** (vs. either permanent
  duplicate investment or an immediate default flip): keep Changes as Kyle's
  accustomed-to quick-check surface while Commits grows a dirty Working tree
  landing that can make it redundant. Do not change the default until the
  candidate is approved as useful on mobile and desktop and Kyle gives the
  go-ahead.
- **Submit-time relocation, SHA cited only on failure** (vs. citing every
  comment's commit): lean seeded turns; the agent needs a SHA only when the
  line is gone from the current tree.
- **No patch-set/change-identity concept** (vs. Gerrit-style revisions): plain
  git has no stable change identity across amends and successive commits;
  anchoring revisions plus relocation cover draft survival.
- **Stale comments default to discard at submit preview** (vs. silently
  including or dropping them): usually too late to act on, so pre-selected
  discard and listed first — but overridable, since discussion of history can
  inform present state.
- **Server-owned drafts from v1** (vs. a client-only `localStorage`
  accumulator graduating to the server later): every git-state operation the
  feature needs already passes through the server, so putting drafts there is
  the simpler build, not the harder one — and device-switching during a long
  review makes server authority the right semantics anyway. One owner for
  consumed/archived state; no schema graduation step.
- **Drafts stored in project-local `.yep/`** (vs. a data-dir store keyed by a
  project mapping): follows the established `.yep/` YA-managed-state
  convention, gets per-project keying from the path itself, keeps drafts
  with the worktree they annotate, and co-locates them with the review file
  the seeded prompt references.
- **Diff view mode: one three-valued preference, `auto | unified |
  side-by-side`, defaulting to `auto`** (vs. a bare side-by-side boolean, or
  side-by-side always): graehl mildly prefers side-by-side, but the default
  is whatever the width allows — `auto` picks side-by-side exactly when the
  diff pane measures wide enough for two readable code columns, else
  unified. "Wide enough" is a content measurement of the pane against a
  minimum readable code column, not a viewport breakpoint
  ([responsive-layout-gaps](responsive-layout-gaps.md)). The manual toggle
  lives **in the diff pane itself** (beside the existing full-context
  toggle) so the mode is switchable on the spot, and it persists as a
  **device-local browser preference** — screen sizes vary per device, so
  this is typically set once per device and does not travel between them.
  One mode value, not coupled booleans.
- **Default submit target = recent review session** (vs. always a new
  session): round-2 comments continue the round-1 conversation; the submit
  flow still lets the user pick any existing session or a fresh one.
- **Archive consumed comments** (vs. delete): answers "did I already comment
  on this?", keeps history, and links each batch to the session it went to.
- **Short prompt + project-local `.yep` review file, small snippets inline**
  (vs. pasting full context into the turn): the structured comments travel in
  a file the prompt references, keeping the transcript readable; small inline
  snippets serve human comprehension and immediate-context safety, and the
  prompt instructs the agent to read current file state rather than trust
  them.
- **Blame cache keyed by (commit SHA, path)** (vs. mtime keying, vs. a
  cumulative all-history blame index): blame is a pure function of (commit,
  path); mtime false-invalidates on touch and can miss same-second edits; a
  cumulative index is probably too large. Dirty files have no SHA for current
  content, so they key on a content hash — or mtime as the cheap freshness
  check — or skip caching.

## Historical combined Source Control UI record

The current page-wide UI contract and pending general refinements live in
[Source Control](source-control.md). The detailed record below explains the
implemented review-led evolution but is not the landing site for new general
Source Control behavior.

The multipane source browser's presentation contracts, refined from live
review. Each is a spec a reviewer can verify; the status marker cites the
landing commit, or "pending" for a spec built out here but not yet
implemented.

### Rows identify; detail banners act; ellipses disclose

List rows reserve their main area for always-visible identity and state
(subject/path, comment-count badge, read/unread weight). Primary quick actions
route through the selected item's detail-pane banner. A compact trailing
ellipsis may reveal the full shared action menu on row hover/focus and remains
visible on touch layouts; it does not reserve a wide action gutter or duplicate
the banner's quick-action treatment.
Selecting a row is the click already made to see its diff/detail, so actions
cost no extra affordance. — Done (6ecdd938).

- **Commit banner** (files-column header): selected commit's short sha
  (copyable), "mark read to here", "mark unread since here", newer/older jump.
- **File banner** (diff-pane header, via `GitDiffPreview`/`GitDiffModal`
  `headerActions`): copy path, blame-at-HEAD.
- **Blame view header**: copy path.

### Comment-count badges

Every commit row and file row with pending review comments shows a small
always-visible count badge — keyed per commit sha (commit list) and per file
path (file lists). Comments are the priority badge; other counts may join
later "if there is room". — Done (6ecdd938).

### Commit read watermark

A per-project **read watermark** (device-local, `useCommitReadWatermark`)
splits the commit list into unread (bold, newer than the mark) and read
(dimmed, at/older) — the mail convention. "Mark read to here" sets the
boundary to the selected commit's author time; "mark unread since here" drops
it just below, so that commit and everything newer read as unread. Date-based,
not list-position, so it survives paging and search. Nothing is read until a
boundary is set. — Done (6ecdd938).

### Tooltips on truncated text; date in blame

- Truncated commit subjects and file paths carry a `title` tooltip until any
  fuller in-layout treatment lands. — Done (8c9be031).
- Files renders readable content immediately and fills blame asynchronously.
  The populated hash is a commit link; its tooltip is
  `full sha · author · date · summary`, and its shared action menu opens the
  commit or copies the full SHA. Blame failure leaves content visible. —
  Revised 2026-07-28.

### Per-column content width

Each source-browser column caps at `var(--content-max-width)` (the Appearance
> Max Content Width preference), applied **per column** — not one global cap
that would crush a multi-column layout. The diff/blame column is the one that
otherwise grows unbounded; leftover width stays as gutter
(`justify-content: start`), never stretched tracks. — Done (8c9be031).

### Identity header, mode tabs, and stable action row

Project identity, repo/branch state, and Clean/Dirty status form the Source
Control identity header. Changes/Files/Comments use the top-right space
on wide layouts and a separate full-width row when constrained. Pull, Push, and
Check occupy a second, left-anchored action row in fixed order; Review anchors
independently at its trailing edge. Dynamic branch/status content and Review
state never displace the three repository actions.

Source Control lands on Changes with the synthetic Working tree revision
selected even when its diff is empty. A clean tree stays visually empty and
never auto-selects HEAD. Commit history opens only through the
**‹ Commit history** parent link, a commit deep link, or the legacy
`?tab=commits` compatibility URL. Pull, Push, and Check retain constant
visible labels and a reserved state-indicator slot, whose idle action glyph
changes in place, so progress and brief results remain visible on the
initiating button without changing its width. Full feedback appears below the
action row.
Review with no pending comments opens Comments and its "click a line" guidance;
with drafts it opens submit preview directly, so a first-time explorer can
discover the complete comment → review-session path from the header.

Phone widths retain project/branch status in the identity header while tabs
and actions use ordinary scrolling rows in the page body. Both tab placements
drive the same `?tab=` URL state (`useSourceTab`). History uses simultaneous
desktop panes and focused mobile navigation without changing the meaning of
Working tree or a selected commit. — Revised 2026-07-31; see
[`docs/tactical/064-source-control-responsive-navigation.md`](../docs/tactical/064-source-control-responsive-navigation.md).

### GitHub Desktop review grammar; operations stay options

GitHub Desktop is useful here as learned **review-navigation grammar**, not as
the scope of a native git client. Its Changes and History views consistently
make one selection drive the adjacent file list and diff, keep state and
identity in dense rows, and provide keyboard navigation and contextual
actions. Its manual operations are useful expectation research, but are
intentionally unimplemented options rather than part of the planned redesign.
This is the modest boundary requested in the two closing comments on
[`kzahel/yepanywhere#76`](https://github.com/kzahel/yepanywhere/pull/76#issuecomment-5096340400):
use the familiar interface as inspiration while leaving git operations to
agents
([follow-up](https://github.com/kzahel/yepanywhere/pull/76#issuecomment-5096351210)).

**Expected operations, intentionally absent.** A GitHub Desktop user may
reasonably look for:

- stage/unstage, commit, amend, and undo-last-commit;
- restore/discard changes and reset;
- create/apply/pop/drop stash;
- create/switch/rename/delete branch;
- merge, rebase, cherry-pick, revert, commit checkout, and conflict
  resolution; and
- compound Fetch/Sync/Publish workflows beyond YA's explicit Check, Pull, and
  Push controls.

These are options YA is in theory open to adding one at a time, not a backlog.
Their implementation is often trivial; that is intentionally not sufficient
reason to expose them. The preferred workflow is to ask an agent to perform a
meaningful state change with full attention to repository state, unrelated
work, remote movement, the intended scope, and recovery. A single-screen
visual summary—however good—does not replace that judgment. Reopen an option
only after real, repeated workflow demand shows that agent delegation is
materially worse; then specify that operation's preconditions, failure
feedback, and recovery before approval. Do not import a completeness bundle
merely because users of a full git client may expect it.

The converged revision-detail model now has one Changes entry point:

- **Working tree is the permanent default revision.** It opens its file/diff
  detail immediately when dirty and a reassuring empty state when clean.
  Empty never substitutes the newest commit.
- **History is deliberate.** The **‹ Commit history** parent link discloses
  the searchable revision list. A pinned Working tree row remains available
  with a zero-file count when clean and behaves like every other revision once
  history is open.
- **Desktop keeps the master-detail progression:** revisions · files · diff
  while history is open, and the compact files · diff form for the default
  Working tree.
- **Phone drills in rather than appending detail below history:** revisions →
  selected revision's files → selected file's diff. Working tree and commit
  detail use the same **‹ Commit history** parent link, while file detail
  retains its normal Back behavior. The default Working tree remains outside
  that history stack, so browser Back from Source Control does not
  unexpectedly open commits.
- **Old entry points remain meaningful.** `?tab=commits` opens history inside
  Changes, while `?rev=<sha>` selects that explicit commit. Neither restores a
  separate Commits tab.

The first review accelerators are small and read-only. Implemented items remain
shared where their owning surface is shared; the rest stay proposals:

1. **List and drill-in keys:** Up/Down moves the active revision or file
   selection, Enter opens its detail on a focused layout, and Escape returns
   one level or clears the active filter. `/` focuses search when focus is not
   in an editor or input. — Implemented 2026-07-27. Enter remains native button
   activation, and the visible `/` keycap teaches the browser-safe shortcut.
2. **Symmetric hunk keys:** keep `n` for next hunk and add `p` for previous.
   The visible previous/current/next toolbar remains the touch path; keyboard
   use is never required. — Implemented 2026-07-27.
3. **One accessible context menu:** right-click, long-press, the visible
   ellipsis, and Shift+F10/Menu all open the same read-only menu specified
   below. — Implemented 2026-07-28 across revisions, working-tree/commit/blame
   file rows, and diff lines. Menu focus starts on the first action; arrow,
   Home/End, and Escape navigation work uniformly.
4. **Diff review controls:** retain Unified/Split and full context. **Ignore
   whitespace** is an independent projection of whichever diff is active:
   ordinary commit, selected revision to HEAD, or working tree. It removes
   whitespace-only changes while preserving the original source text on lines
   that still carry a semantic change. — Implemented 2026-07-28. Incremental
   context expansion remains unbuilt. GitHub Desktop exposes these same review
   projections in its
   [change-review guide](https://docs.github.com/en/desktop/making-changes-in-a-branch/committing-and-reviewing-changes-to-your-project-in-github-desktop).
5. **Edge-only pane splitters:** desktop revision/file boundaries expose small
   resize handles only at the top and bottom, keeping pane interiors free of a
   full-height hit target. Pointer drag reflows the grid live and reveals the
   full-height guide; Left/Right and Home/End resize the same boundary from
   either handle. Splitters are absent below the desktop layout threshold. —
   Implemented 2026-07-28. A separate focused-pane maximize action remains
   unbuilt.

Do **not** copy GitHub Desktop's accelerators literally. Its native application
uses Command/Control+1 and +2 for Changes/History, Command/Control+L for the
Changes filter, Command/Control+F for Find, and Command/Control+8/+9 for pane
sizing
([shortcut reference](https://docs.github.com/en/desktop/overview/github-desktop-keyboard-shortcuts);
[pinned source](https://github.com/desktop/desktop/blob/57d0f8129656978e2b064f4c8d3d9fec7e2e21ee/app/src/main-process/menu/build-default-menu.ts)).
Those combinations collide with ordinary browser tab selection, the address
bar, and browser Find. YA uses the scope-aware keys above. A compact `?`
inside commit search reveals the shortcut card on hover, focus, or click/tap
without adding a toolbar row; both the trigger and card are absent at phone
width, where every action has a touch path. — Implemented 2026-07-28.

Inclusive **To HEAD** is a toggleable mode, not arbitrary range selection: the
selected commit is included by fixing its first parent as the base (or Git's
empty tree for a root commit) and current HEAD as the tip. The server resolves
and returns the selected SHA plus both endpoints with the file list; every file
diff then uses those pinned endpoints, so a later HEAD move cannot mix two
comparisons. Merge commits use their first parent as the squash-style base.
Comments cite the endpoint containing the clicked line: old-side anchors use
the fixed base SHA and new-side anchors use the pinned HEAD SHA. Direct
selected-tree-to-HEAD remains a separately labelled per-file action. — Revised
2026-08-18.

— First slice implemented 2026-07-27; remaining options researched against
GitHub Desktop
[`57d0f812`](https://github.com/desktop/desktop/tree/57d0f8129656978e2b064f4c8d3d9fec7e2e21ee)
and live YA desktop/phone captures (2026-07-27).

### Released-server fallback and action feedback

The complete Changes/Files/Comments browser, including commit history inside
Changes, and source-review workflow requires the permanent
`git-source-review` capability. That capability owns
the commit browse, search, blame, commit-diff, review-comment, preview, and
submit routes plus the extended HEAD-to-filesystem diff fields;
`git-status-enhanced` retains only its previously released status,
untracked-folder, and basic working-tree-diff meaning.

When `git-status-enhanced` exists without `git-source-review`, Source Control
renders a basic compatibility shell instead of an upgrade-only dead end:
repository/branch/upstream/ahead-behind/clean state plus Check, Pull, Push, and
integration analysis according to their existing independent capability
advertisements. It explains that commit history, file browsing, and source
review require a server update. It does not mount a new browse/review component
or call one of its routes.

Ignore whitespace and direct selected-tree-to-HEAD per-file comparison require
the transitional `git-source-review-projections` capability. Inclusive **To
HEAD** separately requires permanent `git-inclusive-to-head`; without it, the
inclusive control is hidden and makes no range request. Without the older
projection capability, direct/whitespace controls make no projection request,
remain off, and show a dismissible update-or-restart-server notice; ordinary
Source Control continues to work. If a server advertises the applicable
capability but a projection request fails, the client returns to the ordinary
diff and shows the same notice. It never leaves a projection control active
over ordinary or stale content. On phone layouts,
the notice is portaled above the full-screen diff as a dismissible bottom
banner rather than being hidden behind it.

Git action outcomes render twice by design: a brief mark on the initiating
button for immediate attribution and a persistent full-text panel beside the
page content. The panel survives until the next action or project change;
warnings are alerts and successes are status messages. Touch users never need
hover to learn why Pull or Push left the branch unchanged.

The core compatibility corpus initially covers released `v0.6.0`, `v0.6.1`,
`v0.6.2`, and `v0.7.0`. See
[`docs/tactical/063-source-control-hosted-compatibility.md`](../docs/tactical/063-source-control-hosted-compatibility.md).

— Done (2026-07-27).

### Stash triage in history — proposal only

If stashes become common enough to justify a management exception, show an
alert-colored alias for **every existing stash** in a triage group pinned above
the commit history, regardless of stash age or ordinary commit paging/search
horizons. Clicking the alias reveals, scrolls to, and selects that stash at its
actual chronological position in history rather than creating a second
logical entry. A preference may disable the pinned triage aliases and leave
stashes only in chronology, accepting that old stashes will usually go
unnoticed.

The selected chronological entry opens its files and original diff through
the same review browser. Its primary review delta is the stash's saved
working-tree snapshot against its first parent (the `HEAD` commit at stash
creation), and the UI shows and copies that base SHA. The stash's index parent
and optional untracked-files parent remain visible as provenance/facets rather
than silently disappearing or replacing that primary ancestor-to-stash diff.

Dropping a stash would be a new manual-mutation exception beyond Pull/Push and
is an **intentionally unimplemented option**, not approved by this proposal.
If real demand eventually justifies it, "drop" must be recoverable: retain the
stash tip under a YA-owned Git ref before removing it from `refs/stash`, and
append one record to a single `.yep/dropped-stashes.jsonl` audit/recovery log.
The log records the original stash identity, retained ref, tip SHA, message,
and drop time; it cannot itself hold the stash object graph or keep
unreferenced objects alive. The UI must expose recovery and eventual permanent
cleanup, and the exception must be reconciled explicitly with the Non-goals
rather than quietly weakening them.

### Context menus

Right-click (desktop) and long-press (touch) on a commit, file, or
diff/context line opens a menu of *all* logical actions for that target; the
same menu is reachable from a small hamburger/ellipsis affordance (revealed on
mouseover on desktop, always shown on mobile) in the style of the
recent-sessions sidebar item menu. The detail-pane banner stays the
quick-action surface; the context menu is the fuller superset — the
"right-click action" the select-shows-detail design left open. Logical actions
by target:

- **Commit**: copy sha, copy subject, mark read to here, mark unread since
  here, jump newer/older.
- **File** (within a commit): copy path, blame-at-HEAD.
- **Diff / context line**: comment on line (the existing click), copy line
  text, copy `path:line`.

The tracked-files browser uses the same file-row menu with Open file and Copy
path because blame-at-HEAD is already its selected detail.

`SourceContextMenu` owns portal positioning, dismissal, focus return, menu
arrow/Home/End traversal, Shift+F10/Menu, right-click, and the shared 500 ms
touch/pen long-press. Each target supplies only its action list. Diff lines
are keyboard-focusable: Enter opens the existing comment path and Up/Down
moves between rendered lines. Their one ellipsis follows the hovered/focused
line rather than reserving a button on every code row. — Done (2026-07-28).

### Dirty-file editor sessions — proposal

Kyle suggested a button to **"navigate to session(s) that made edits to this
dirty file"**; graehl agrees (2026-07-28). This reverses the useful bridge that
already exists from a session Edit block into the exact dirty file in Source
Control. In Changes, the selected-file banner and shared file context menu
would expose a compact `Sessions (N)` action. It opens a newest-evidence-first
chooser using the normal session identity, hovercard, and canonical YA-session
navigation; it does not invent a second session-row treatment.

Git itself records no dirty-file session authorship. Do not infer it from
currently active sessions, project membership, or file mtime. Defensible
evidence is a successful structured file mutation observed in a canonical YA
session — Edit, Write, `apply_patch`, or a provider-equivalent operation —
whose normalized project-relative target is this path. Shell commands,
generators, human edits, external processes, and provider activity YA did not
observe may remain unattributed. An unobserved writer can also replace or
revert an observed session's contribution while leaving the path dirty, so a
recorded session can remain as a stale candidate until the path next becomes
clean. This limitation is accepted to bound implementation effort. UI wording
must therefore say **sessions with recorded edits**, not claim to identify
everyone who contributed to the file's current contents or present the set as
exhaustive.

Implementation plan:

1. Characterize each supported provider's structured file-mutation events and
   success boundary. Ignore failed or merely proposed mutations.
2. Persist a set whose logical rows are
   `(source, project, normalized file, canonical YA session, latest edit time)`.
   A later successful structured mutation by the same session to the same file
   only replaces that row's time; do not retain an event history, tool/message
   ids, content hashes, or before/after lineage. Private server-owned state
   survives restart and has no time-based or bounded-retention expiry.
3. Clear rows only when a successful complete Git-status refresh authoritatively
   observes the path clean. Restart and reconnect reconcile reachable projects;
   temporary disconnect retains rows, while explicit project/source removal
   clears the removed scope. A commit that leaves additional staged or unstaged
   changes does not clear anything.
4. Add a capability-gated query for the remaining candidate session summaries,
   ordered by each session's latest recorded edit, then reuse the existing
   session hovercard/navigation and source file banner/menu surfaces. More than
   one candidate opens the chooser; one candidate may navigate directly.
5. Test one and several sessions, repeated edits deduplicating to the latest
   time, failed edits being ignored, clean-state clearing, restart and
   disconnect/reconnect reconciliation, explicit removal, a commit that leaves
   the file dirty, and accepted missing/stale attribution after unobserved
   shell or human changes.

**Difficulty:** the button and chooser are low difficulty. Provider mutation
hooks, clean-state observation, the small tuple set, and its query are
low-to-medium difficulty. Content hashes, transcript backfill, exact lineage,
and exhaustive attribution are deliberately out of scope; writers that bypass
observable structured mutations are an accepted accuracy limit, not a reason
to enlarge the first implementation.

### Desktop pane splitters

At the desktop three-pane threshold, Changes history exposes revision/files
and files/diff boundaries; the default Working tree and Files expose their one
files/detail boundary. Each boundary has matching top and bottom separators
with the same current value. Dragging either handle dynamically reflows the
owning CSS grid and shows one vertical guide for the duration; keyboard
Left/Right adjusts in small steps and Home/End reaches the allowed extrema. No
splitter markup participates in phone layout. Width changes last for the
mounted browser; they are not a new persisted preference. — Revised
2026-07-31.

The current file-pane implementation's fixed 500 px maximum is an arbitrary
implementation bound, not a product contract. A future full-width correction
should let the user widen the complete changed-files column until the
inter-pane gap and splitter handles remain fully visible and operable; do not
reserve an arbitrary minimum detail-pane width. The user will naturally stop
after exposing as much of the paths as they need, and the still-visible
splitter is the recovery path from an extreme choice. A smaller
content-derived maximum is optional, not required: if added, compute it from
the widest untruncated row in the **complete file corpus**, including its
status/count/menu affordances, rather than only the currently mounted
vertical-scroll window. Recompute when the corpus or font, size, or spacing
metrics change.

### Hunk navigation + single diff toolbar row

- **Re-click advances hunks.** Clicking the already-selected file entry jumps
  the diff to the next hunk (wrapping at the end), in both "diff only" and
  "full context" modes.
- **"k of N" hunk indicator** in the diff toolbar beside the filename,
  tappable to advance to the next hunk.
- **One toolbar row.** The diff currently spends a second row inside the
  content on the full path + view-mode toggles; fold that content — filename,
  path, view toggles, hunk indicator, file actions — into the single
  pane-header toolbar row **when it fits** (responsive; the body sub-row is the
  fallback when it does not), so the diff content keeps that row.
- **`n` key** jumps to the next hunk when focus is not in a text input.

— Done (2026-07-26). The wide diff pane uses the single-row form; a narrow
mobile modal keeps the compact controls-row fallback beneath its path title.

### Dark-theme diff emphasis

Dark and Very Dark keep added/deleted whole-line backgrounds as subdued
semantic washes rather than saturated panels. The narrow `+` / `−` gutter
carries the stronger green/red emphasis, so change type stays scannable
without competing with syntax text. Auto follows the Dark treatment when the
system is dark; Light keeps its established whole-line intensity. In the
source browser, the sign is an authored gutter rather than the first ordinary
monospace character: its strong-color strip has a fixed width, separate inset
before the glyph and breathing room after the color divide, and a small
optical glyph shift that does not narrow the strip. The shared diff palette
still applies to source-browser and session-tool diffs. — Done (2026-07-26;
source-gutter refinement 2026-07-28).

### Master-detail use and touch-readable row identities

- **Wide Files opens useful detail.** Once the tracked-file list loads, Files
  selects the first visible file whenever there is no still-visible selection.
  Changing the filter therefore replaces a filtered-out selection instead of
  leaving a narrow list beside an unused detail canvas. Mobile stays
  deliberately list-first.
- **Touch rows preserve identity in layout.** At phone width, commit subjects
  and file paths may use a second line before clipping, with practical
  touch-target height and row separation. Desktop still carries title
  tooltips for incidental truncation, but touch does not depend on hover as
  its only recovery path.

— Done (2026-07-26).

### Commit message display

- Clicking the compact commit body opens the **verbatim original message**
  (subject + body, hard breaks preserved) with the exact author date/time in
  the detail pane, until a file is picked (`CommitMessageView`; mobile modal).
  The banner hash tooltips `sha + date/time`; newer/older jump is glyph-only
  (↑/↓), adjacent, at the banner's left edge nearest the list. — Done
  (a977f1f9).
- **Soft-reflow of the compact body.** The compact commit body reflows
  width-wrapped prose to its column while preserving *intentional* breaks,
  mirroring the AGENTS.md
  commit-wrap rule: "Wrap body prose manually at 71 columns — a visual rule,
  not greedy fill: preserve bullets, hanging indents, aligned continuations,
  short tables, and ASCII diagrams even when that leaves a short line." A break
  before a line is intentional (kept) when the line is blank, a
  `[spaces]* `/`-`/`•`/`N.` bullet, indented (hanging/ASCII), or short while its
  predecessor is also short (two consecutive lines of at most 50 characters,
  for compact tables and ASCII). Otherwise the line is a wrapped continuation
  and folds into the previous with a space. Render the result with
  `white-space: pre-wrap`. `reflowCommitMessage` owns that tested display
  projection; the verbatim view above remains the escape hatch. — Done
  (2026-07-27).

### Search completions + match tooltips — pending

- Focused commit/file search shows a **completions/hints dropdown** to the
  right of the input.
- While focused with matches, **float per-match tooltips** — `…context…` with
  the matched **substring bolded** — reusing the session incremental-search
  (Ctrl-R / Ctrl-S) hit presentation. Find and reuse that presentation, don't
  re-derive it.

— Pending.

### Fast client-side search index

Typing in either source-browser search must update at interactive speed. The
previous two paths failed in different ways:

- **Files lost coverage.** `/git/files` ran `git ls-files` and returned at
  most 2,000 paths; `BlameBrowser` then filters that client-side corpus and
  renders at most 500 matches. A path outside the first server slice cannot be
  found at all. Repositories in scope will have at most 10,000 committed files,
  so the client can own the complete filename-search corpus.
- **Commit delta search repeated expensive work.** After a 300 ms debounce,
  every changed query started a new server-side `git log -G` history scan. Live
  use has shown these scans taking more than a second, so typing feels like a
  sequence of cold searches rather than incremental search.

Contract:

1. **One complete client corpus, no per-keystroke git process.** Files mode
   fetches all tracked paths once and builds normalized search entries in the
   browser. Commit-delta search builds its client corpus/index on demand. Once
   a corpus is available, changing the query performs no network request and
   starts no git command.
2. **Incremental query evaluation.** Extending a query narrows the previous
   candidate set; edits and backspaces query an in-memory substring index
   (for example, a small trigram-to-entry map). Lowercasing/tokenization and
   match-context extraction happen when records enter the index, not again for
   every query.
3. **Persistent on the same device, incremental across repo updates.** Store
   the on-demand index in IndexedDB, versioned by project/source identity,
   index format, and the indexed git horizon. New commits append until the
   previous indexed ancestor; a rewritten history that no longer reaches that
   ancestor invalidates the affected commit segment. A changed tracked-file
   corpus replaces the small file index.
4. **Coverage and rendering are separate.** Windowing or paging may keep the
   DOM small, but every match in the indexed corpus remains addressable.
   A 500-row render window must never become a 500-file search ceiling. While
   a commit index is still building, the UI states the indexed horizon and
   progress rather than silently presenting partial results as complete.
5. **Client ownership is the requested boundary.** A future server-side cache
   could accelerate first use or share an index across devices, but that is
   explicitly not part of this proposal. The server may stream source records
   needed to build the index; it does not become the typing-time search engine
   or the persistent index owner.

Items 1, 2, 4, and 5 are implemented (2026-07-26): Files receives the complete
tracked-path corpus up to the stated 10,000-file product bound and normalizes
it once; Commit search requests the complete lightweight history plus bounded
changed-path/changed-line batches on demand. Prefix-query candidate sets update
as batches arrive, typing launches no `git log -G`, ordinary Commit paging is
not a search ceiling, and progress is explicit while history is indexing. The
commit index survives source-tab remounts for the browser lifetime.

Item 3 remains a proposal: persist the in-browser indexes in IndexedDB and
append/invalidate them from the prior git horizon. A cross-device server cache
remains a possible later first-use accelerator, not part of the requested
ownership boundary.

## Historical questions (superseded)

This section is retained only as the decision trail from the first
implementation. It is not a second contract or a list of current unknowns;
the 2026-08-01 submissions-and-sites section above owns every question it
resolves. The remaining genuinely open items are labeled as such.

- **Provenance rendering.** Reuse the compose-time-context-anchors framing so
  each quote's SHA/age is legible to both the reader and the agent.
- **Dirty (uncommitted) comments may not be sufficiently contextualized.**
  A committed `sha:path:line` can be reopened exactly; a dirty-file anchor
  cannot. The saved timestamp, line number, and small snippet describe what the
  reviewer saw, but the file can drift between comment, submit, and the agent's
  eventual read. Submit-time relocation does not by itself preserve that
  original state.

  The implementation is currently weaker than this topic's earlier "fuzzy
  context-snippet match" wording: it exact-matches only the clicked line
  (ignoring trailing whitespace), chooses the occurrence nearest the recorded
  line, and refreshes the snippet from there. It neither scores the surrounding
  context nor reports an ambiguous repeated-line match. The composed turn then
  shows only the refreshed current snippet and a generic read-current-state
  instruction; it does not say that an uncommitted anchor moved, carry an
  identity for the dirty file version, or preserve original-versus-current
  context.

  Treat this as a stale-read discipline, analogous to the exact-preimage,
  context-anchor, and reject-on-staleness choices in
  [provider-read-edit-disciplines](provider-read-edit-disciplines.md). Before
  calling the concern closed, decide which stronger contract applies:
  preserve a content fingerprint plus the original context snapshot at comment
  time; relocate by scoring the full context and surface ambiguous/no-match
  outcomes instead of silently choosing nearest; and tell the submitted
  session when the anchor moved, with original and current context when they
  differ. A project-local snapshot/blob keyed by content hash is the strongest
  recoverable option, but is not yet chosen. — **Decided 2026-08-01**: the
  capture is a real git blob written at comment time and pinned by
  `refs/yep/source-review/captures`. The relocation half of this question is
  deliberately *not* decided; no defect has been observed, and the contract it
  must meet when touched is stated in the 2026-08-01 section.
- **Review-file/draft-file split.** Whether the seeded prompt references
  `.yep/review-comments.json` directly or a per-submit snapshot beside it,
  and how a follow-up turn's update composes with the archive. How archived
  comments are pruned. — **Decided 2026-08-01**: a frozen per-submission
  `request.json` in a per-submission directory; the draft store is never
  referenced by a prompt. The agent's `response.json` sibling remains mutable.
  Resolving a site does not unpin captures.
- **Relationship to forged-transcript-handoff.** A submitted review is a
  narrower, reviewer-authored cousin of that experiment — worth deciding whether
  they share the seeding path.
- **Disposition round-trip (aspirational, no mechanism decided).** Submitting
  a batch archives its comments — "handled" from the reviewer's side — but
  the agent's actual outcomes never flow back. The seeded prompt already
  instructs the agent to report a per-comment disposition
  (done / no change / question; version 1 stores No change as `wont_fix`) in
  its reply; nothing captures that onto the archived comments. The aspiration:
  each archived comment shows a one-line
  disposition in the comments view, beside its batch/session link, so
  "submitted" and "actually resolved" stop being conflated. Feasible shape:
  the bundled review message additionally instructs the agent to emit an
  explicitly parseable per-comment-id disposition line (or call a small
  server endpoint/tool), and the server attaches what it sees to the archived
  comment. Nothing is committed — the prompt-side instruction, the capture
  channel, and the rendering are all open. — **Decided 2026-08-01**: the agent
  writes an atomic outcome snapshot into `response.json`; YA reads it after
  each of a configurable number of completed assistant turns for that exact
  session/submission delivery. There is no transcript fallback. The governing
  section defines the default bound, per-entry state, and Inbox acknowledgement
  surface.

## Staged plan (historical)

Written before implementation; retained as the record of how the work
was cut. Stages 1-3 and P8 are landed — see Status at top.

1. **One-off line comment → new session.** Add click-a-diff-line → comment on
   the git-status/diff viewer — which is the working-tree diff, so this slice
   already exercises the `uncommitted` anchor class. Built as the single-entry
   accumulator drained immediately (per the fast-path definition above), it
   proves the line-anchor + provenance payload with no parallel code path.
2. **Accumulating review — the vision.** Persist pending comments in the
   server-owned `.yep/review-comments.json` across files and commits with a
   visible count; "submit review" runs the preview (stale comments
   pre-selected discard), drains the survivors into the target session
   (recent review session by default, override to any or new), and archives
   them consumed.
3. **Fuller multipane viewer + all-files blame + search + mobile.** Wrap the flow
   in the large-screen multipane commit/diff/file viewer with the copy
   affordances, the all-files git-blame browsing mode, rudimentary
   commit-delta/filename search, the unified/side-by-side diff view mode
   (orderable independently — it touches only the existing diff viewer),
   and the mobile back-swipe + commit-jump path.

## Implementation sketch (historical implementer guide)

Verified against the tree at a682f7c3, before the implementation
landed; it describes the pre-implementation tree, not current code.

Verified against the tree at a682f7c3 (2026-07-26); file references are real,
nothing below is built. This is the concrete shape for stages 1–2.

### What exists to build on

- Route `/git-status` → `packages/client/src/pages/GitStatusPage.tsx`
  (~1450 lines — already large; every new pane below is a new file composed
  into it, never inline growth).
- `pages/GitStatusDiffPreview.tsx` fetches
  `api.getGitDiff(projectId, { path, staged, status, fullContext? })` →
  `GitDiffResult` and renders `diffResult.diffHtml` — server-generated Shiki
  HTML — via `dangerouslySetInnerHTML` (`HighlightedDiff`), with a per-line
  `DiffLines` fallback when highlighting was skipped.
- The diff HTML's lines already carry classes
  `line line-deleted|line-inserted|line-context|line-hunk`, added at
  generation time by `addDiffLineClasses`
  (`packages/server/src/augments/edit-augments.ts`).
- `GitDiffResult.structuredPatch: PatchHunk[]`
  (`packages/shared/src/types.ts:736`): `oldStart`/`newStart` plus
  `' '|'-'|'+'`-prefixed `lines` — per-side line numbers are computable by
  walking hunks; no DOM needed.
- Server JSON-persistence idiom: `PushService`
  (`packages/server/src/push/PushService.ts`) — typed state, load once,
  debounced save — is the template for the drafts service.
- Session plumbing: two-phase `api.createSession(projectId, opts)` +
  `POST /sessions/{id}/messages`; server-side, the supervisor and
  project-queue already create sessions and deliver first turns.

### Consequential decisions

1. **Anchors derive from `structuredPatch`, never from the DOM.** A click
   identifies (hunk index, line index); a pure shared helper computes side,
   old/new line numbers, and the context snippet from `PatchHunk` data. The
   Shiki HTML stays presentation-only, so anchor logic is testable without a
   browser and cannot drift from what is displayed.
2. **Line clicks: server-emitted indices + one delegated listener; no DOM
   patching.** Extend `addDiffLineClasses` to also emit
   `data-diff-line="<flat line index>"` at generation time; the diff pane
   attaches a single click handler on the `.highlighted-diff` container that
   walks to the nearest `[data-diff-line]`. Per-line React components would
   abandon server highlighting; attaching handlers by post-processing the
   injected HTML would patch generated DOM (the
   [ui-architecture](ui-architecture.md) rule). Give the `DiffLines` fallback
   the same attribute so one handler serves both renderers. The
   comment-anchor tint ([selection-comment-ui](selection-comment-ui.md)) is a
   class toggled on nodes addressed by that same server-emitted attribute —
   idempotent decoration of stably-addressed nodes, not restructuring.
3. **Wire types in `packages/shared` with a defensive parser.**
   `shared/src/review-comments.ts`: `ReviewCommentAnchor` (path; anchoring
   revision `sha | { uncommitted: true, savedAt }`; side; old/new line;
   snippet), `ReviewComment` (id, anchor, text, `pending | archived`, batch +
   target-session link). Parse persisted data defensively (the
   `parseClaudeAdditionalModelSelections` idiom): `.yep/review-comments.json`
   outlives bundle versions and is user-visible on disk, so the shape is a
   contract from day 1.
4. **One review service owns the file.**
   `packages/server/src/review/ReviewCommentService.ts` (PushService shape)
   reads/writes `{projectPath}/.yep/review-comments.json`: comment CRUD,
   pending→archived transitions, batch records. Routes in a new
   `packages/server/src/routes/review-comments.ts` — `routes/git-status.ts`
   is 1200 lines and must not absorb this feature.
5. **Submit is one server endpoint; preview is its dry run.**
   `POST /api/projects/:projectId/review/preview` relocates every pending
   anchor (exact line match against HEAD/worktree, then fuzzy snippet match,
   git plumbing) and returns per-comment `{ relocated | gone }` for the
   discard-default preview.
   `POST …/review/submit { include, target: "new" | sessionId }` re-runs
   relocation, composes the short prompt referencing the review file, creates
   the session (supervisor) or posts the follow-up turn, archives the batch
   with its target, and returns the session id for the client to navigate to.
   The client stays dumb: render preview, confirm, navigate. Relocation and
   turn composition are pure modules (`review/relocateAnchors.ts`,
   `review/composeReviewTurn.ts`) with the endpoint as thin glue.
6. **Stage 1 cuts scope by count, not by shape.** The one-off fast path is
   the same service, file, and submit endpoint with a single pending comment
   and no preview UI — relocation is trivially exact because the anchor is
   seconds old. No client-side storage variant exists at any stage.
7. **Side-by-side is a client arrangement of once-highlighted lines.** Today
   `diffHtml` is one Shiki block; side-by-side must not become a second
   server render that can drift from the first. When the diff pane grows the
   view mode, the render unit becomes per-line highlighted fragments (the
   line elements `addDiffLineClasses` already produces), and the client
   arranges them — unified as a stack, side-by-side as a two-column pairing
   whose `-`/`+` run alignment is computed from `structuredPatch` (pure
   data, same source as anchors). The `data-diff-line` click/tint contract
   addresses lines, not the container, so it survives both layouts
   unchanged; a left-column click is a `-`-side anchor, a right-column click
   `+`-side. The `auto` default measures the pane per the diff-view-mode
   decision; the in-pane toggle persists device-locally. This piece touches
   only the existing diff viewer, so it can land independently of stages
   1–2.

### Tests that pin the contract

- Anchor-from-patch helper: hunk walking yields correct old/new line numbers
  at boundaries (first/last line of a hunk, context vs `-`/`+` lines).
- Parser: round-trip of persisted comments; garbage and truncated files
  reject to empty rather than throwing.
- Relocation, against a fixture repo: unchanged line → relocated; moved line
  → fuzzy-relocated; deleted line → gone (SHA cited); an `uncommitted`
  anchor whose change has since been committed acquires that commit's SHA.
- Service: per-project isolation (two projects never mix), pending→archived
  lifecycle, a batch records its target session, archive survives service
  restart.
- Compose: SHA appears only for gone/minus-side comments; from-X-to-Y
  framing carries both sides; comments group by file; the
  read-current-state instruction is present in every prompt.
- Client (RTL): clicking a `.line-inserted` node in rendered `diffHtml`
  opens the comment window with the correct anchor; a commented line shows
  the tint; the preview lists gone-context comments first, pre-selected
  discard (mocked preview API).
- View mode (with stage 3): `auto` resolves unified when the pane measures
  below two readable columns and side-by-side above; a manual pick wins over
  `auto` and survives reload; in side-by-side, a left-column click anchors
  `-`-side and a right-column click `+`-side.

### Subtask phases (each lands green)

Stages 1–2 decompose into subtask-sized phases, each verifiable by its own
tests before the next begins. Every phase before P6 is user-invisible, so no
half-built UI ever ships; P6 is the first visible milestone (= stage 1).

- **P1 — anchor model (shared).** Types + defensive parser +
  anchor-from-patch helper. Verified by unit tests alone (hunk-boundary line
  numbers, round-trip, garbage rejection). Land paired with P2 or P3 so the
  contract module does not sit consumerless.
- **P2 — line addressing (server).** `addDiffLineClasses` emits
  `data-diff-line` matching the flat `structuredPatch` index. Verified by
  augment unit tests asserting index↔line agreement; invisible in the UI,
  safe alone.
- **P3 — drafts service + CRUD routes (server).** `ReviewCommentService`
  over `.yep/review-comments.json` plus `routes/review-comments.ts` CRUD.
  Verified by route tests (per-project isolation, lifecycle, restart
  survival) and by curl against a dev-profile instance.
- **P4 — compose + relocation (server, pure).** `composeReviewTurn` and
  `relocateAnchors` as pure modules with fixture-repo tests
  (SHA-only-when-gone, moved/gone/committed-uncommitted cases). No routes
  yet.
- **P5 — preview + submit endpoints.** Thin glue over P3 + P4 plus the
  supervisor launch. Route tests with a stubbed supervisor; one real
  single-comment submit against a dev-profile instance closes the stage-1
  backend.
- **P6 — click → comment window → submit-now (client).** Delegated
  listener, `CommentWindow`, tint, submit-now button. RTL tests; the
  stage-1 user-visible milestone.
- **P7 — pending tray + submit preview + target picker (client).** RTL
  tests for discard-default ordering and the recent-review-session default;
  the stage-2 milestone.
- **P8 — diff view mode.** Independent of all of the above (decision 7);
  orderable any time.

Dependencies: P1 → {P2, P3, P4}; P5 needs P3 + P4; P6 needs P2 + P5; P7
needs P5 (and P6's window for editing). P2/P3/P4 parallelize after P1.

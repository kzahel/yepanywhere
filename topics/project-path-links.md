# File path links in viewed content

> A bare path appearing in authenticated viewed content becomes a file-viewer
> link only after the server proves that exact file exists within the applicable
> file-access boundary.

Topic: project-path-links

Status: **implemented (2026-08-02); demand-driven cache and turn-text
annotation landed 2026-08-05; authenticated absolute-path probes landed
2026-08-10; command, tool-result, and user-turn annotations landed
2026-08-16; viewed-file-relative and external-file-relative links landed
2026-08-25; prefix-causal basename aliases landed 2026-08-30.**
Highlighted file content, assistant turn text, completed command text, and
completed tool-result bodies link exact project files through a demand-driven,
watcher-backed directory cache — the same cache that now also decides the
inline-code file references turn text already linked. Tracked, untracked, and
gitignored files share the same membership test. The breadth-first warm, the
per-use directory-mtime validation, and the `.yepignore` crawl exclusions this
feature originally shipped with are gone.

## Why membership, not shape

An agent hands over a JSON manifest of run outputs and the reader wants to open
one. Detecting "path-like" strings by shape — a `/`, a known extension, a key
named `*path*` or `*file*` — needs a rule per false positive: `application/json`
is not a file, `1.2.3` is not a file, and a `"path"` key can hold something that
was deleted an hour ago.

The test is instead membership in the project's own path set. A string links
because it *is* a file in this project. That has no false positives to tune,
needs no key-name convention, and cannot link something that is not there. It
also means the mechanism is safe to run over arbitrary content rather than only
over JSON.

**Absolute paths use a separate exact oracle.** A whitespace-delimited POSIX
token beginning with one `/`, a home-relative token beginning with `~/`, or a
Windows token beginning with a drive letter and separator, is eligible for one
direct file probe when it contains at least four characters. A `~/` token is
expanded against the connected server's home directory, never the browser's;
the probe and link target use the expanded path while the visible text keeps
the `~/` spelling. It is never tried as a project-relative path. The whole token is queried, including legal punctuation, so
an existing prefix is never linked out of a longer filename. The one exception
is a cited position: when the whole token is not a file and it ends in `:N`,
`:N-M`, or `:N:C`, the path before that suffix is probed too, from the same
64-candidate budget. A hit is confirmed under the whole visible token, suffix
included, so clients that match confirmed links by token text need no change.
It is never added to the project index or discovered by a filesystem crawl.

**A visible cited position is its own link.** Wherever a confirmed file link
shows `path:N`, `path:N-M`, or `path:N:C`, the client renders two adjacent
links: the path opens the file at the top, and the `:N…` suffix opens it at
that position. Both carry the same file target and resource attributes, so
they share one context menu; only viewing is position-specific. The rule
covers every surface: server-rendered Markdown (inline code, prose, and local
file links), user prompts, and command and tool output. A project-relative
token stops at the colon, so its suffix is the citation text right after the
link; an absolute token carries its suffix unless the whole token is itself
the file. The split happens in the client, so transcripts rendered and stored
before it gain the split without re-rendering. Inline code stays one pill
holding both links. A link whose label does not end in its cited position,
such as a Markdown link with its own text, stays one link.
`readLeadingCitedPosition` and `splitTrailingCitedPosition` in
`packages/shared/src/project-path-links.ts` are the one citation grammar that
the server resolver and every client surface share.
The probe uses the same realpath-resolved allow-set and regular-file check as
the authenticated file endpoint, and click-time fetching repeats that check.
At most 64 distinct direct-filesystem candidates are probed for one completed
body, shared between explicit absolute paths and paths resolved relative to an
external viewed file. Short absolute tokens such as `/x`, network-style
`//...` tokens, missing files, and files outside the configured allow-set
remain plain text.

This absolute-path resolver is absent from both live and frozen public-share
rendering. Generated absolute links also carry the private-project-link marker
as defense in depth, so captured or reused authenticated HTML is unwrapped
rather than granting a share a path or file-existence capability.

## The index

Composer `@` completion has a separate, explicitly requested inventory; see
[Composer path completion](#composer-path-completion). The `/v` command
([view-command](view-command.md)) searches that same inventory, which records
whether Git tracks each path, and opens its result through the same viewer
registration a file link uses. Its ignore-filtered
corpus does not change exact file-link membership or start a linkifier crawl.

`packages/server/src/projects/projectPathIndex.ts` holds one demand-driven
cache per project. The filesystem is authoritative; Git is never consulted, so
ignored files need no special case. The cache is rebuildable app state: it
lives in memory, and no lookup, cache, watch, or diagnostic ever writes inside
the selected project or its Git metadata.

**Nothing is read until something is asked.** Creating an index performs no I/O
at all, not even a project-root listing, and starts no warm, timer, or retry
loop. Only the directory components a candidate actually names are hydrated. A
project holding 50,000 unrelated run artifacts costs nothing because one
displayed turn mentions `src/server.ts`, and that lookup performs no I/O under
`runs/`, `.git/`, or `node_modules/`. Those directories need no exclusion list
because nothing enumerates them.

**Each retained component edge records only what was proven** — `directory`,
`file`, or `absent` — and each directory node separately records whether its
listing is *complete*. The two facts have different strength. Only a complete
directory answers arbitrary child absence without I/O. An exact failed probe
caches that one edge as absent and claims nothing about its siblings; a present
edge likewise implies nothing about unobserved siblings.

**A live watcher is what makes a cached fact trustworthy.** Each hydrated
directory carries a non-recursive shared watch lease (off-thread on macOS when
no synchronous or recursive lease shares that directory, where probes and
listings await native attachment with a short bounded timeout and degrade to
direct uncached reads if the watch worker is busy closing handles; a mixed
synchronous/recursive co-lease on the same directory still owns and closes its
synchronous native handle on the caller's thread, and worker-to-synchronous
transitions may open the synchronous handle before the retiring worker handle
confirms close), and facts under a directory with
no attached, unstalled watcher are never read from cache (while the macOS watch
worker is stalled inside a close, cached facts degrade to direct reads and
`sourceRevision()` advances so rendered output is not reused stale). So a cache hit costs zero `stat`, and
losing — or never obtaining — a watch makes an answer re-probe rather than go
wrong: a directory that cannot be watched still answers correctly, just from
the filesystem every time. Re-listing an already-watched directory reconciles
its direct children in place, keeping unchanged child directories whose inode
identity still matches and their hydrated descendant watchers intact rather than
tearing down the whole subtree. A named event invalidates and removes an already-
retained edge; if the parent was complete, it also invalidates completeness.
Previously absent names likewise invalidate completeness without materializing
an `unknown` edge. Every named-event branch then closes the parent watcher when
no observation or cacheable fact remains. Event churn therefore retains no name
nobody queried, and a later answer is exact-probed. An event that names no entry,
a watch error, or overflow
instead makes the whole generation uncertain: the directory's cached facts are
discarded rather than trusted, and one bounded re-listing re-establishes them.
Invalidated names retain no edge; once no proven edge, complete listing, or wide-
listing fact remains, releasing the last current observation also releases the
watcher. Claims are exact watcher-identity and generation
tokens: an in-flight claim from a failed older watcher or generation cannot pin
its factless replacement. Every trie node also carries an attachment generation:
its object reference is usable only while root traversal still reaches that exact
node at its canonical path with the same generation. One subtree-invalidation
operation advances that identity and releases the node's own watcher and
reconciliation timer plus every descendant. A parent event naming a directory
uses that operation before removing the named edge, so a replacement inode
cannot inherit the old directory's watcher or timer. Removing an edge also marks
the old node detached. A deferred reconciliation is
therefore cancelled when its node is replaced or removed with an evicted
subtree, and can neither retain nor mutate an unreachable cache node.
Reconciliation that does publish on a still-reachable node performs the ordinary
byte-budget enforcement before settling. Watch ambiguity therefore cannot leave
a negative answer trusted indefinitely.

An exact probe attaches or claims the parent-directory watcher and captures its
live generation before `lstat`. The lookup also captures the registry activity
generation belonging to its owning project claim. It publishes the result only
if the project is still in that same activity and the same watcher generation
remains live and unchanged after the read. A watcher-generation change earns
one retry under the new observation; a last release or later reclaim instead
turns the completed read into an uncached answer and never attaches a watcher
for the obsolete activity. If two watcher generations change, one final direct
`lstat` answers the caller without caching. The probe never loops. Each attempt
releases its temporary watcher claim on every exit,
including permission-denied and thrown reads; a successful positive cache entry
or exact negative cache entry then retains the watcher as the fact's owner, while
an uncached answer leaves no otherwise-empty watcher behind. An unwatchable
parent returns the direct answer without caching, and a missing directory
component terminates the walk after observing only its nearest existing parent.
Before every retry, the probe reacquires the currently attached parent by
canonical path from the root. If ancestor invalidation detached the node, the
retry returns a direct uncached answer; it never reattaches or publishes through
the stale object.

A directory listing uses the same ownership, attachment, and generation fence.
It reacquires the canonical directory node, claims its watcher before `readdir`,
holds that exact watcher alive through the read, and publishes a complete or
wide-directory fact only while root reachability, attachment generation,
watcher, watcher generation, and registry activity generation all remain
current. A coalesced waiter rechecks that observation before using or retaining
the listing. If any identity changed, the requested names are exact-probed under
the lookup's original activity; an obsolete activity therefore gets correct
direct answers but cannot publish the stale listing or its fallback probes into
a replacement claim. Reconciliation timers carry the same canonical path,
attachment generation, and activity generation and recheck all three before
they read or publish.

**Probe or list, whichever is cheaper for the batch.** One lookup batch groups
candidates by parent directory. A sparse set is probed exactly with `lstat` —
`lstat`, not `stat`, so a symlink is a leaf and a link cannot walk the
traversal out of the project. Four or more unknown names in one not-yet-complete
directory are worth a single `readdir` instead, which then answers every later
name in that directory. **The four are counted cumulatively, not per batch.**
Each directory remembers how many distinct names it has probed since its
generation began, and a batch that pushes that running total over the threshold
earns the listing. One wide batch is not the only way to deserve one: turn-text
annotation asks about two or three names per rendered body, so on a per-batch
test alone a directory the reader keeps referring to would pay an `lstat` per
name forever. Discarding the generation resets the count with the facts it
proved. A listing wider than 20,000 entries is not retained
whole — one directory would otherwise claim a large share of the project's
entire budget — but the names that batch asked about are kept as ordinary
proven edges, since the watch was already attached when the read covered them.
The width itself is remembered, so later batches in that directory probe
exactly instead of re-reading it every time; the cap therefore bounds what may
be *claimed complete*, not what may be known. Discarding the directory's
generation forgets the width too, so a directory that has since shrunk is
listed again rather than probed forever.

**Retention is bounded at both owners.** Within a project, least-recently-used
hydrated directories are dropped once retained bytes exceed 4 MiB. One index
also has a hard ceiling of 1,024 watchers even while actively claimed. Before a
new attachment at that ceiling, it evicts least-recently-used directory
subtrees that own neither the current traversal nor any in-flight observation;
if all candidates are protected, the new read stays uncached rather than
closing a claimed watcher or crossing the ceiling.

Across the process, `getProjectPathIndex()` hands each caller a refcounted claim.
Inactive projects are dropped least-recently-used when the registry exceeds 128
projects, 1,024 live watchers, or 32 MiB; a triggered bound evicts toward its 75%
low-water mark. Bytes remain a separate bound rather than a proxy for tiny
watched indexes. Every self-consistent retained-byte or watcher mutation notifies
the registry, so growth in an active project immediately evicts eligible
inactive victims rather than waiting for a later claim or release. Active
claims themselves stay pinned under process pressure, and releasing the claim
makes the complete index — including every watcher — evictable.

The active-to-inactive transition advances one activity generation and cancels
pending reconciliation timers. Exact probes, ordinary listings, their watcher
observations, and reconciliation already awaiting I/O all carry that generation,
so neither a last release nor a release-and-reclaim lets prior work publish or
regrow facts and watchers into the inactive or replacement activity. A later
claim rebuilds state on demand. Ten thousand dormant projects therefore cannot
mean ten thousand live tries or watchers, and a discarded project still answers
by rebuilding only the components it needs. Byte eviction runs only between
batches, so a probe in flight keeps its ancestors; watcher-slot eviction applies
during attachment but protects that traversal and all current observations.

`projectPathCacheDiagnostics()` reports project count, retained bytes, live
watchers, and evicted projects; per-index counters cover cached answers, exact probes,
directory listings, oversized listings, watcher invalidations, uncertain
generations, and evicted directories. Reading either scans no tree.

`sourceRevision()` exposes one process-monotonic identity for rendered-output
fencing. A new or replacement index starts with a fresh identity. Named watcher
invalidation, uncertain watcher state, a probe that changes an already-observed
membership fact, disposal, and loss of a watcher that owned retained facts all
advance it. Render work observes the identity before filesystem-dependent work
and verifies it again before retaining output. A direct answer from an
unwatchable directory or synchronous `stat` fallback is deliberately marked
unversioned: callers may use and coalesce that answer, but must not retain
rendered output derived from it.

**Completion is an explicit request, not a side effect.** The replacement plan
sketched an optional `listDirectory()` on the interface; it is deliberately
unbuilt, because no product surface asks for a complete inventory. A surface
that later needs one must request and budget that operation, never restore it
to index construction. The same rule retired the `.yepignore` crawl-exclusion
file with the warm it configured.

## Rendering

Path discovery is advisory and must never gate the first readable source or
preview. A file response renders highlighted and Markdown text from already
known path facts; cold project-root, viewed-file-relative, and authenticated
absolute-path probes continue outside that display-critical response. The
current view may therefore stay plain and a later refresh may gain anchors.
This is the viewed-file form of the established session-text contract: live or
optimistic text appears before its settled, server-confirmed path annotation.

Foreground linkification runs server-side over already-highlighted HTML using
only cached membership facts, so the client needs no project path corpus and a
cold scanner cannot extend response latency. After constructing the response,
one deferred pass collects distinct candidates. The project index resolves
relative candidates in bounded directory batches, while the authenticated
allow-set resolver directly probes bounded absolute candidates. That pass
warms the authoritative caches; it does not mutate the response already being
returned. A later request rewrites only confirmed files. Project-relative
matches retain the existing local-file markup; absolute matches use private
project-file markup so both open in the FileViewer belonging to the active
session project.

### New Session from a host path

Viewing stays in the active project, but starting a session about a file
belongs to the project that owns it. When the server advertises
`file-owner-project`, the file menu's New Session sends an absolute or `~/`
path to `GET /api/projects/:projectId/file-owner`; the URL project only
authorizes the request. Like every host-path read this is superuser-only and
applies the file endpoint's allow-set check, so a missing or disallowed file is
an error rather than a guessed owner. The server expands `~/` against its home,
then matches each registered root against both the written path and its
realpath, so a symlinked root (`~/ya` for a checkout elsewhere) claims files
under either spelling. The deepest matching root wins, so a nested project
claims its own files; on equal depth the requesting project wins, then the
lexically first path. The session opens in the owner with the project-relative
path prefilled, whatever the link label says.

A file inside no registered project, a failed lookup, or an older server keeps
the previous behavior: the linking project with the path exactly as written,
so the prefill never names a project the file was not proven to be in.

Highlighted file content also resolves relative tokens from the viewed file's
containing directory when the same token is not an existing project-root path.
Project-root precedence preserves every established link when both coordinates
exist. A leading `$ROOT/` is treated as an explicit relative-root marker: the
marker is removed, then the same project-root-first, viewed-directory-second
resolution applies. This covers configuration values such as
`$ROOT/input/example.txt` without teaching the viewer a project-specific file
format. Turn text and tool annotations have no viewed-file coordinate, so their
project-root-relative contract is unchanged.

When the viewed file itself is an allowed absolute file outside the selected
project, relative tokens resolve from that file's directory through the same
authenticated allow-set and regular-file oracle as explicit absolute paths.
The unrelated selected-project index is not queried. If every distinct token
fits the body's remaining 64-probe budget, all are checked once; repeated
occurrences share that answer. For a larger body, only tokens with a path
separator, a leading dot, or a plausible extension are eligible, and the same
cap still applies. Confirmed targets use private project-file viewer links;
public shares receive no external resolver and cannot discover these files.

All possible targets for one body enter the same `findExisting()` batch. The
index therefore answers cached negative prefixes immediately and groups dense
root or sibling-directory candidates into its existing bounded directory
listing; file-relative support adds no per-token `stat` loop and no project
crawl. Self-link suppression applies to the resolved target rather than only
to the visible spelling.

Constraints that keep it safe over arbitrary markup:

- Only text between tags is rewritten. Markup is never matched, so a real
  project path appearing inside a tag attribute cannot corrupt the HTML.
- Text already inside an `<a>` is left alone. Highlighted source contains no
  anchors, but rendered turn text does — from Markdown links and from the
  inline-code file linker — and an anchor nested inside an anchor is not markup
  a browser can be asked to render.
- A match must fall inside one text run. Highlighted output nests spans per
  token, and a path split across two spans stays unlinked rather than risking a
  rewrite across a tag boundary.
- Token boundaries exclude quotes, brackets, commas and colons, so a JSON
  string value yields the path without swallowing its punctuation.
- `&` is excluded, because the surrounding HTML is escaped and a decoded entity
  would not round-trip. Paths containing `&` are not linked.
- The file being viewed does not link to itself.

An empty or unavailable index returns the content unchanged, so the feature
degrades to plain content rather than failing the view.

## Design decisions

- **Project-root paths win collisions** (vs. nearest-file precedence): adding a
  sibling with the same name cannot retarget an existing project-relative link.
- **Expand bounded target aliases into the existing index batch** (vs. client
  path corpora or a second filesystem oracle): the watcher-backed index keeps
  membership, invalidation, and I/O batching authoritative in one place.
- **Replay basename aliases from earlier confirmed links** (vs. server-side
  transcript state): the browser already sees the ordered, authorized links and
  can derive the small contextual table without a protocol change or path
  corpus. Replay is strictly prefix-causal; a later link never changes an
  earlier basename.

## Turn text

Assistant prose runs the same seam, wired at `renderMarkdownToHtml`
(`packages/server/src/augments/markdown-augments.ts`) — the one funnel both
render paths share, the streaming coordinator's completed-block render and the
settled/replayed `augmentTextBlocks`. Per completed body, never per streamed
delta: the coordinator's per-delta path goes through the synchronous
`renderSafeMarkdown`, which reaches no filesystem. Callers claim the index for
the right lifetime — one claim for a session subscription's augmenter, per
request in `routes/sessions.ts` — and a claim that fails yields plain text
rather than an error.

**One oracle, not two.** Turn text already linked a subset of paths before
this: `resolveProjectFileCodeReference` links assistant *inline-code* filename
references, and decided membership with a blocking `statSync` plus an
unbounded, never-invalidated module map. Two oracles for one question can
disagree, and that one had no way to learn a file was deleted. The trie is now
the authority; `statSync` remains only as the backstop for what the trie cannot
prove, which is the same degradation the index already uses when a watch is
unavailable. The module map memoizes only that backstop — layering it over the
trie would let an answer outlive the fact behind it.

Rendering asks synchronously, so one batched asynchronous pass over the raw
source runs first (`resolveShapedPaths`) and turns the mid-render questions
into cache hits. Batching is also what lets a directory be listed once instead
of probed per name. `PATH_TOKEN` excludes `:`, so an inline `src/server.ts:42`
already tokenizes to the `src/server.ts` key the inline-code path needs.

**Gate relative-path I/O, not linking.** In prose most words are words, so a token earns a
filesystem call only by shape: it contains `/`, starts with `.`, or ends in a
short alphanumeric extension containing a letter — which keeps `1.2.3` a
version. A token failing that test is still *answered* from what the cache
already holds, so `Makefile` and `LICENSE` link wherever their directory is
already listed and only an unlisted one goes unlinked. A token starting with
`/` never enters this project-index path; eligible absolute tokens go through
the separate bounded allow-set resolver described above. The file viewer leaves
the relative-path shape gate off — every token there came out of a file the
reader is already looking at, and one batch groups them by directory anyway.

The gate is a shape test, not a character-level automaton over the trie. The
early-fail property is already present at component granularity: a token whose
first component is a cached `absent` costs one cache hit regardless of its
length. Scanning character by character would save regex and allocation work,
not the filesystem I/O that is the actual cost.

## Tool commands and result bodies

Completed authenticated tool-use command strings and string tool-result bodies
carry a small optional `_projectPathLinks` annotation containing only exact
tokens the server confirmed. The annotation is per body, not a project path
corpus. Bash/Ran command headers, collapsed previews, expanded output, and the
detail modal all consume the same annotation. A missing target remains ordinary
text even when a glossary term inside that text is independently annotated.

A confirmed full path is one anchor. Glossary annotation does not enter an
existing anchor, so it cannot split or replace the file link. Source/raw mode
may show the original plain text; rendered mode owns the link. The command row
uses a delegated keyboard/click target instead of wrapping its contents in a
native button, allowing file anchors and the row's expand action to coexist.
Activating an anchor does not expand the row or open the Bash detail modal.

The field is optional and field-presence-gated. Servers without it preserve the
previous plain rendering and receive no new request. The compatibility review
covered stable releases `v0.7.0` and `v0.6.2`; neither supplies the annotation.
Public-share routes produce it too, restricted as
[Public shares](#public-shares) describes; a share client that receives one
targets the share's own file route rather than the authenticated project route.

## User turns

Completed authenticated user messages carry the same bounded, optional
`_projectPathLinks` annotation at message level. String prompts and text blocks
are resolved as one visible body; attachments and other structured blocks do
not become path text. The transcript projection passes only the confirmed
literal token/target pairs to the user-turn renderer. An optimistic prompt can
therefore begin as plain text and gain its file anchors when the server's
durable message arrives.

User-turn decoration has an explicit nesting order: a confirmed complete path
is one file-viewer anchor, a URL is one ordinary URL anchor, and glossary terms
are annotated only in the remaining plain-text segments. Neither glossary
matching nor URL matching enters or splits a file anchor. Missing annotations
and older servers retain plain text and make no follow-up file request.

## Public shares

A public share viewer sees the same project-file links the session owner does,
pointing at the share's own file route. Nothing new is exposed by this: a share
already serves the project files its session mentions, through
`/public-api/shares/:secret/files`, authorized by that mention. The links make
the reader's transcript match that existing capability instead of naming files
they cannot open.

What a share does *not* get is any path oracle beyond its own transcript:

- No absolute-path resolver and no `knownAbsoluteFilePaths` is supplied to
  share rendering, so only paths inside the share's project root — resolved
  through the project path index or a `statSync` backstop — can become links.
  A `/etc/...` or `~/...` mention stays plain text, as does a project-relative
  path that resolves outside the root.
- The share client refuses to mint a link it cannot serve. When
  `buildPublicShareFileHref()` returns null for a target, the text stays plain
  rather than falling back to the authenticated `/projects/:id/file` route.
- `data-ya-private-project-file-link` keeps its meaning: a link minted for the
  authenticated owner. Share rendering omits it (`publicShare` in
  `ProjectFileLinkOptions`), and the share page still unwraps any anchor
  carrying it back into plain code, so authenticated HTML reused in a share
  degrades rather than leaking.

Rendering runs per share response in `augmentPublicShareMessages()`, which
claims the project path index for the share's project. The Markdown HTML cache
key includes the share flag, so an authenticated render and a share render of
the same body cannot be served for each other.

The **Link Recent File Basenames** convenience remains owner-only; a share
links only what the server confirmed for that body.

## File-link preferences and mentioned directories

Appearance groups three browser preferences: **Link Project Paths** (on),
**Use Mentioned Directories** (on), and **Link Recent File Basenames** (off).
The master switch gates both conveniences and automatic content links in
authenticated sessions. Public-share rendering retains its server-confirmed
links. The directory option is enabled by default at the maintainer's request.

For completed Markdown prose, the server scans occurrences in source order.
A verified project-relative directory mention becomes the context for later
bare filenames throughout that prose body, including later paragraphs. A new
verified directory replaces it; an unverified mention does not. Context resets
at the next prose body and never carries between turns. Directory spellings
must contain a slash or appear in inline code; filename candidates must have a
path-like extension or appear in inline code. Explicit paths, Markdown links,
fenced code, and math do not acquire this context.

The joined file must exist. When it does, the client displays and links the
joined path even if the same basename exists at project root or has a recent
basename alias. Otherwise ordinary exact-file and recent-alias behavior
remains. For example, `Use ar/raghda/ ... intake (onboard.py) and scoring
(score.sh)` displays links for `ar/raghda/onboard.py` and
`ar/raghda/score.sh` when those files exist.

The server extracts rendered HTML path occurrences once. Exact links and
directory context consume that same ordered list, then one rewrite emits the
links and `data-ya-directory-file` annotations. Two identical basenames can
therefore name different files in one body without a second HTML scan. The
existing raw-Markdown pre-population remains: it warms the index before the
synchronous inline-code renderer asks about files. Verification reuses the
sparse path index, including its revision and retention rules,
with bounded directory and file probes. Streaming known-only renders do not
start directory discovery; settled full-body augmentation supplies it. No
filesystem inventory reaches the client. Old clients ignore the annotation;
new clients talking to old servers keep ordinary links without making a new
request. Public shares do not receive these annotations. Completed output stays
in the existing source-versioned HTML cache, and the client makes no separate
path-discovery requests. Client decoration applies directory matches first;
recent full-name aliases only process unresolved occurrences.

Right-clicking or long-pressing the composer formula control opens its existing
toolbar menu with these three session-view overrides above **Hide**. Each offers
**Default**, **On**, and **Off**; Default follows the current browser preference.
Overrides live only in that mounted session view, reset on unmount/reload,
and do not change browser defaults or another session view. Turning off the
master disables the two dependent controls without discarding their choices.

## Recent basename aliases

This YA-specific convenience is configurable in Appearance and defaults off.
When **Link Recent File Basenames** is enabled, the authenticated web client
remembers the target of each linked full path in the loaded transcript under
its basename. A later bare occurrence of that basename links to the most
recently preceding target. A later full-path link with the same basename
changes only subsequent occurrences; recompiling after new transcript rows
arrive must not retarget an earlier occurrence.

Only confirmed project-file links seed the table. A basename-expanded link does
not feed itself back into the table, and a bare project-root link likewise does
not replace the remembered full-path target. The browser derives this during
ordered replay, so stable servers need no new field or capability. Public
shares remain excluded from authenticated project-file links.

The table covers only the currently loaded semantic transcript window. An
unloaded full-path link immediately above the older-page seam cannot seed a
basename below it; `gaps/project-path-basename-alias-pagination-seam.md` records
that low-priority edge. Only the basename is retained today. Matching longer
path suffixes is separately deferred in `gaps/sketches/project-path-suffix-aliases.md`
until its replay and memory cost is measured. The initial browser
implementation uses a simple basename map plus an additional token scan over
loaded bodies; `gaps/sketches/project-path-basename-replay-scan.md` keeps the possible
versioned-index/trie replacement contingent on measured cost.

Extensionless basenames deliberately remain eligible. This can link an
ordinary word when it happens to equal a recently established filename even
though the assistant did not mean the file. That accepted provisional cost is
tracked in `gaps/sketches/project-path-basename-common-word-false-positives.md`; a common
filename denylist needs user-frustration evidence before it narrows linking.

## Version-control affordances

An authenticated project-file link may append two compact version-control
affordances after its path. The dirty affordance appears only when the current
Git status names that project-relative path and opens its working-tree diff.
The committed affordance appears only when the current HEAD commit names the
path and opens that commit's diff against its first parent with the file
selected. A file can show both. Ordinary activation stays in the current tab;
native modifier-click and context-menu behavior can open either link elsewhere.

These are capability-gated enrichments of an existing path link. An older
server receives no unsupported Git request, a non-repository or unmatched path
stays unchanged, and public-share file links never expose Source Control. The
status and HEAD-detail reads share retained request state across the many links
that can be mounted in one transcript and do not create one polling interval per
link. Edit-tool summaries use this same affordance instead of a separate review
link.

## Not yet covered

Assistant and user turn text, tool commands and results, and the file viewer's
highlighted source run this. Other viewers showing project content, such as
diff panes, would use the same server-confirmed annotation seam.

Completed Markdown HTML is retained behind a 32 MiB source-versioned
single-flight cache. Its exact key includes Markdown text, local-file scope,
inline-image mode, project identity/path, and custom membership-callback
identity. Only immutable HTML is retained; response messages are detached
before route-specific augmentation. Inline local images stay outside retained
HTML because their file bytes have no content revision fence. A project-path
revision change discards late work and forces a render under the new identity.

**Server annotation, not a client corpus.** Turn text raised the option of
shipping the path set to the client and matching there, the way glossary
tooltips ship a compiled automaton
([glossary-tooltips](glossary-tooltips.md) § Compiled matcher contract). That
was considered and rejected in 2026-08-05 design discussion. The path set is
three to five orders of magnitude larger than a glossary's — 131,956 files here
and 594,511 in a research repository — so the artifact is a different weight
class on a mobile-first client, and it is open rather than closed: any write
anywhere changes it, whereas glossary terms change only on an edit the
subscription already streams. Against that, a path link is decided once per body
the server is already rendering, so nothing needs re-deriving client-side.

Tool content follows the same decision without requiring server-side ownership
of its presentation: the server ships only the confirmed literal token/target
pairs for that one body, and the client inserts anchors while rendering the
existing command/output surface.

The general rule the two surfaces settle: ship the matcher client-side when the
pattern set is small, closed, and slow-changing; annotate server-side when it is
large, open, and filesystem-derived.

Server annotation also keeps the demand-driven cache sufficient. A shipped
corpus would require enumeration — the `git ls-files` set this feature's own
history rules out on correctness, since it omits the ignored run outputs that
motivated the feature — while the server only ever answers about text it is
currently rendering. So the mandate against a project-wide crawl stands
unamended.

## Shared directory observation

YA's path index, glossary monitor, live-worktree monitor, focused-session
monitor, provider transcript watcher, and development source watcher acquire
independent leases from `SharedDirectoryWatcher`. One `fs.watch` registration
serves each canonical watched directory, including symlink aliases. Closing one
lease does not close another consumer's observation; the final release closes
the native watcher. The native watch keeps the event loop alive only while a
remaining lease requests that behavior.

Recursive and non-recursive requests for the same directory share one native
registration. Changing required coverage invalidates the old leases' observation
gap; synchronous transitions close the previous native registration before
opening its replacement, whereas on macOS an off-thread worker-to-synchronous
transition opens the synchronous handle immediately while the retiring worker
handle completes its close off-thread and retains its budget slot until
acknowledged.
Non-recursive consumers receive only direct-child events, using the host's
native path separator. A backslash in a POSIX basename is a filename character
and must not cause its event to be dropped. Acquiring a path whose
directory inode changed also replaces the old native registration. Native
failure invalidates every lease so each consumer can use its existing fallback.
The registry admits at most 1,024 native registrations; existing consumers'
stricter admission rules and platform restrictions still apply. Recursive roots
may cover descendants internally according to the platform's native backend.

## Composer path completion

Typing `@` followed by at least two nonspace characters in a focused session
or new-session composer requests project path discovery. Merely opening a
composer, typing ordinary text, `@`, or a one-character query does not request
an inventory. Accepting a completion remembers enablement for that server and
project in browser storage; subsequent `@` tokens can query immediately. Even
enabled projects acquire no inventory on composer mount and retain no periodic
scan or watcher.

Matching is case-insensitive substring matching over project-relative paths,
including parent directories. The menu floats above the composer in the same
sheet the [`/v` command](view-command.md) uses, distinguishes `dir` and
`file`, shows the basename and parent with the matched substring marked, and
ranks eligible candidates by most recent mention
first, then deterministic path order. Recency uses confirmed links and causal
basename aliases from the loaded transcript, independently of the basename-link
appearance preference. It preserves distinct paths with the same basename;
there is no hidden history fetch. At most 100 recent paths, within a 4-KiB
encoded request budget, affect ranking.

Tab or a row click inserts the whole project-relative path and ends completion,
including for directories. Paths needing quotes are double-quoted. Arrows only
move the highlight. Space and Enter never accept a candidate. Acceptance adds
a provisional trailing space: an immediately following Space consumes it before
inserting one typed space; an immediately following Enter consumes it before
the composer's normal submit/newline handling. Other input makes the separator
ordinary text. No file contents are injected, and the provider's skill/plugin
invocation vocabulary is unchanged.

Tracked and untracked files are eligible; ignored paths are not, even if
recently mentioned. Git owns ignore semantics, including nested `.gitignore`,
negation, repository excludes, and configured global excludes. Non-Git projects
also honor nested `.gitignore`: the enumerator uses an empty Git directory under
YA app data with the project as its read-only working tree. Git must therefore
be installed for completion in either project type. `.git` is excluded,
symlinks are not traversed, and paths containing control characters are omitted.
Directories come from eligible descendant files, or from the initial collapsed
directory probe. Empty directories are not inventoried. The retired `.yepignore`
facility is not restored.

The first Git response uses the tracked index, without a full filesystem stat
pass. A non-Git project first receives a collapsed directory probe. A shared
untracked enumeration fills the requested inventory afterward; an open menu
polls only while that request remains pending. Subsequent queries search the
retained inventory. Candidate ignore rules and existence are checked again
before each response, so cached or recently mentioned paths cannot bypass an
ignore change. Cached candidates remain available while an on-demand refresh
builds a replacement; switching among projects does not discard their inventories.

Freshness is independent of cache retention or persistence. Existing path-index
and worktree filesystem observers invalidate an affected completion inventory
without allocating another watcher or starting a crawl. Completion also consumes
the existing end-of-turn activity hint used by Git status. Each warm request
checks project-root and root-ignore metadata plus the shared Git metadata
fingerprint, including HEAD, index, refs, and repository excludes. A checkout
therefore requests a refresh even when no filesystem observer is active.
Unobserved nested changes have a 60-second freshness backstop, checked on the
next completion request. An open, settled menu does not poll for new changes.
An invalidation or fingerprint change during enumeration prevents the result
from being marked fresh; the next request reconciles again. Failed scans have
a 60-second retry cooldown rather than an immediate retry loop.

Each project retains at most 1,000,000 file/directory candidates and 128 MiB of
accounted path storage. Published inventories across all projects share a
256 MiB accounted budget; past it, the least recently used settled inventories
are released and rescan on their next request. There is no project-count
limit, so 100 recently used small or medium project inventories can coexist.
Inventories unused for more than a week are removed on the next completion
request or by the process-wide idle sweep, with no per-project timer. Cache state need not survive
a server restart. Optional disk persistence is deferred in
`gaps/sketches/project-file-completion-persistence.md`.

At most two scans and eight distinct queries run simultaneously; identical
in-flight queries share one computation. Git enumeration is streamed as NUL
records, with at most 16 KiB of partial-record storage and bounded diagnostics.
Reaching either inventory budget kills the read-only Git child immediately and
waits for it to close before releasing the scan slot. A truncated initial phase
starts no subsequent enumeration. Full command output, split-path arrays, and
an unbounded ignored-path set are never accumulated. Git commands time out after
10 seconds; query-time ignore checks retain their 32-MiB output ceiling.
Candidate selection keeps only bounded recent and lexical matches instead of
sorting a copy of the full inventory on each keystroke. Responses contain at
most 30 items, selected from at most 100 matches for current eligibility checks.
A visible truncation notice reports when a budget cuts the result; narrowing
the query filters the retained corpus, without expanding its enumeration budget.
Scan or Git failures make the menu unavailable rather than returning ignored
fallback paths. All inventory state and auxiliary Git metadata stay outside
selected projects. Closing or dismissing the menu cancels client polling;
already requested server scans remain bounded. Server disposal aborts and reaps
enumeration children and releases completion's passive event subscriptions.

`GET /api/projects/:projectId/file-completion` is gated by permanent capability
`project-file-completion` (ID 56, version-implied from 0.8.2, advertised explicitly
by earlier source builds). Stable 0.8.0 and 0.8.1 lack it. Older servers retain
literal `@` text and receive no completion requests: their transcript-only paths
cannot establish the required ignore eligibility. Existing capability meanings
and file-link behavior are unchanged.

## Replacement evidence

The original flat index used `git ls-files` plus porcelain-v2 untracked paths.
It missed ignored run outputs, while enumerating ignored files up front measured
2.5s for 131,956 files here and 3.5s for 594,511 in a research repository. Its
global freshness sweep also measured 135ms for 10,845 directories against 220ms
to rebuild. Those results ruled out repairing the flat set with another Git
enumeration or a wider sweep.

The replacement test suite covers ignored membership, sparse component-chain
I/O, listing-vs-probe batch choice, cumulative promotion across small batches,
absolute and parent-traversal rejection before I/O, concurrent-probe coalescing,
watcher invalidation, a forced watcher-uncertain generation and its
reconciliation, release/reclaim fencing around pending exact probes and ordinary
listings, unwatchable directories, oversized listings, per-project byte and
watcher ceilings, publication-triggered process eviction, process-wide
count/watcher/byte eviction, HTML safety, anchor nesting, the shape gate's lookup
budget, the extensionless name a listed directory still links, the inline-code
reference decided by the trie and the one that falls back to the filesystem,
self-link suppression, and batch I/O cost.

The warm the demand-driven cache replaced was itself the second design. It
started a breadth-first crawl of up to 50,000 path-component nodes and 12
directory levels for every touched project, validated each traversed directory
by mtime `stat` on every use, and left the process-wide project map with no
eviction. Auditing the real consumers — `linkifyProjectPaths`, `GlossaryIndexService`
governing/include resolution, and Markdown rendering in `routes/files.ts` —
found that none asks for an inventory: each asks `findExisting()`/`has()` about
a handful of paths already displayed on screen. The crawl was therefore paying
for an answer nothing requested, which is why the cache now hydrates only the
components a candidate names and why a future completion surface must budget
its own listing rather than reinstate a crawl.

A 2026-08-02 end-to-end measurement of the warm-based index used the motivating
ignored file under `trtllm-speculative/draft`: 10,000 highlighted tokens, 191
distinct candidates in one parent directory, and 500 occurrences of the
existing file.

| state | elapsed | `stat` | `readdir` | links |
|---|---:|---:|---:|---:|
| cold trie | 22.3ms | 8 | 4 | 500 |
| cached parent, median of 5 | 9.4ms | 1 | 0 | 500 |

The five cached-parent timings ranged from 7.0–11.2ms. This is a local
regression measurement, not a cross-machine latency guarantee; the structural
result is the stable part, and the demand-driven cache holds it while removing
the crawl behind it. The same 191-candidate shape is asserted in the test
suite: cold, one exact probe for the parent component plus one listing that
answers all 191 names; warm, no filesystem call at all, where the warm model
still paid one validation `stat`.

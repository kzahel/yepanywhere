# Nested Harness Launch

> A nested harness launch is one agent session starting a second harness
> process from a shell tool call, which YA links to the session that process
> writes by reading the launching command rather than provider subagent
> records.

Topic: nested-harness-launch

Related topics: [provider-child-sessions](provider-child-sessions.md),
[bash-result-contract](bash-result-contract.md),
[vanilla-defaults](vanilla-defaults.md)

## What this is, and what it is not

An agent can start a whole second harness process with a shell tool call —
`claude --resume <uuid> --print < task.md`, usually backgrounded — instead of
using the provider's own subagent feature. YA records both sides correctly and
independently: the launcher writes an ordinary Bash tool call, and the child
writes an ordinary top-level session transcript in the same project. Nothing in
either record says they are related.

This is not a [provider child session](provider-child-sessions.md) and not a
subagent. Subagent detection keys on `agentId` plus `isSidechain`, and these
transcripts contain no sidechain entries at all, because no subagent was ever
created. The child is a real YA session with its own canonical YA session id,
listed and openable like any other. The live scoped producer below records that edge; reverse presentation is still pending.

The Bash result's `backgroundTaskId` does not supply that edge. It names a
harness-local output file under the harness temp directory, not a session, and
it is unresolvable once that directory is gone.

## Discovery contract

`detectNestedHarnessLaunch` in `packages/shared/src/nested-harness-launch.ts`
is the single owner of reading a launch out of command text. It returns the
harness name, the session the launched process will write when the command
names one, and the directory an earlier `cd` moved to.

It recognizes a launch only when the harness is the command word of a simple
command and the invocation either names a session — `--resume`, `-r`, or
`--session-id` with a UUID-shaped value, attached or separate — or runs
non-interactively via `-p`/`--print`. `claude --version`, `command -v claude`,
and a `claude` substring inside an argument or a path are all not launches.

Two properties matter more than breadth of syntax coverage:

- **A quoted command is not an invocation.** The splitter tracks quoting and
  skips heredoc bodies, so a commit message or a written file that quotes a
  launch command does not produce a phantom edge. It deliberately does not
  descend into a quoted `sh -c '...'` argument, which therefore reads as no
  launch rather than as a guess.
- **Only a named session becomes a link.** A fresh launch reports the harness
  with no session id: the new id exists only in the harness's own task output
  file, which is temporary and process-scoped. Recovering it would need a new
  reader for that file and is not implemented.

Against every shell command in the local transcript corpus (25,457 commands,
2,061 of which mention `claude`), the detector reported 19 launches, all
genuine backgrounded harness runs, 9 of them carrying a resumable session id,
with no false positives.

## Presentation contract

`NestedHarnessLaunchLink` renders under the command in all three Bash views —
the tool-use view, the expanded result, and the detail modal — and renders
nothing at all when there is no session to link. `nestedHarnessLaunchTarget` in
`packages/client/src/lib/nestedHarnessLaunch.ts` decides that, and withholds a
link in three cases:

- the command names no session;
- the named session is the one being read, which is not an edge;
- the command first `cd`s outside the session's own project directory, because
  the child then belongs to another project and a filesystem path is not a YA
  project id.

The link carries the launched session's first eight characters and resolves
through the relay base path, so it works from the hosted remote client.

This is not YA-novel behavior under [vanilla-defaults](vanilla-defaults.md), on
the same footing as [provider child sessions](provider-child-sessions.md): it
restores visibility for work the user explicitly caused, adds no action and no
provider state mutation, and reuses YA's existing session navigation. It ships
always-on and adds no setting.

## Durable live command evidence

`NestedHarnessRelationshipService` observes main-session Bash calls from managed
Claude-family processes. It uses the same lexer with a stricter scoped selector:
one explicit `cd` into the process project followed by a named foreground Claude invocation,
optionally clearing `CLAUDECODE`. Branches, pipelines, shell expansion, alternate
homes/configuration, worktrees, forks, background jobs, informational invocations
and unnamed launches are withheld. Other
parent storage families are not qualified by this producer.

The existing identity binding selects the exact native store. A successful foreground tool
result and a bounded, complete target header matching the named id and project
support a `launched_harness` fact with `command-observed` trust. This does not
prove creation, command intent, or provider subagent membership. A resume
only names an existing same-project session; no fresh creation is inferred. Full commands,
prompts and tool outputs are never persisted in this index.

Pending tool ids, target ids and exact scope live in the existing SQL extraction
checkpoints. Accepted facts, duplicate suppression and pending removal commit
atomically. Startup walks indexed partial checkpoints in finite pages; existing
native file events can retry a missing target in the watched Claude root;
alternate roots rely on process completion or startup. There are two workers, 128 retained
sources and 32 pending calls per source, with no per-session timers or new
watchers. Capacity and unqualified syntax remain unknown, not known empty.
A real process end abandons unreturned calls as unknown. Unproved targets
receive at most three probes; pending hints older than 24 hours are abandoned
on the next acquisition/startup, without a timer. These terminal unknowns free
capacity and leave the partial startup index. Reload detachment is nonterminal,
including a direct wrapper SIGHUP; it preserves pending correlation.
Observed facts survive target deletion. Acquisition never reads parent bodies or
reruns a provider command. A frame lost before its pending SQL commit is not
recoverable from this live-only producer.

The opt-in native-app fixture runs actual parent/child Claude executables against
a scripted model endpoint, replaces the API via both the admin route and direct
wrapper SIGHUP while the child is running, verifies
SQL edges after completion and target loss, and checks that copied fork history
creates no extra launch edge. No inference is used by that fixture.

## Historical acquisition from an authorized read

Ordinary authenticated detail reads also offer the already acquired Claude rows
to the same bounded coordinator. The request stores only a weak reference and
compact source context, and waits for no historical discovery. It starts no
parent-file read, summary-cache invalidation or corpus walk. Public-share
capture does not request this acquisition.

Only a server-admitted, non-copy source with its exact native binding and an
explicit persisted sandbox level of `none` plus known never-confined admission
provenance qualifies. A private monotonic `sandboxEverConfined` marker starts at
admission and becomes true on any `project-write` selection; switching back to
`none` cannot clear it. Missing legacy provenance remains unknown and is
withheld, so a downgrade cannot re-qualify confined-era rows.
The admission owner supplies its birth time without loading the saved prompt or
context. Rows must belong to that native source and follow its admitted birth;
sidechains, replay and synthetic rows are withheld. Copied/legacy histories lack
a reliable source cutoff and remain unknown. Live observations still cover new
commands in those sessions. A successful paired foreground Bash result and the
existing destination proof support command evidence, never creation authority.

Each CPU turn examines at most 256 records/blocks and 256K command characters.
At most 32 pending IDs/pairs with 48 KiB of compact data survive in a private SQL
extraction cursor. No command, prompt or tool output enters that cursor. The
reader supplies its newline-committed count, excluding provisional tails.
Native file identity, size/mtime and a bounded stable UUID anchor qualify append
continuation; replacement or a changed prefix resets extraction, preserving
accepted history. Pending pairs survive observer replacement and expire as
unknown after 24 hours since extraction, rather than since an old command ran.
An unchanged high-water mark causes no extraction write. An older same-file
view cannot rewind newer progress, and an invalid derived cursor resets without
erasing accepted facts.

Facts and pending proof use the existing atomic relationship owner. The SQL
scan cursor advances only after durable handoff under the current generation;
ready but unhanded pairs remain in that cursor. Capacity and transient handoff
failures stop the view without dropping those pairs. Transient handoff failures
use a one-second persisted retry deadline, checked only by later reads; no
timer or closed-view loop is created. A replay before the handoff
is idempotent. A terminal live unknown can gain
historical support later. Already accepted live evidence is not duplicated, and a historical read cannot
change an active live hint's timestamp, completion key or retry budget. Transient
proof errors use the bounded retry ladder. Notifications coalesce once per
coordinator turn.
Native command time is stored separately from the new observation time.

The native fixture models a pre-index session by deleting only its derived
launch index inside the owned temporary profile, then opening the ordinary
detail route. Actual native command/result rows restore the edge; neither the
rejected reused id nor copied fork commands add one. Model dispatch counts stay
unchanged. Automatic install-wide backfill and copied-history birth proof remain
separate work.

## Not covered

The reverse edge — a child session showing which session launched it — is not
implemented. It cannot be derived from the child's own transcript, so it needs
a server contract to carry the indexed facts, which is a client/server compatibility decision
([server-capabilities](server-capabilities.md)) rather than a rendering
concern. Until then a launched session still looks unattached when opened
directly, which
[`gaps/nested-harness-session-not-linked-to-launcher.md`](../gaps/nested-harness-session-not-linked-to-launcher.md)
tracks.

Only `claude` is recognized. Other harnesses' resume spellings are addable as
data in `HARNESS_NAMES` and the flag sets, but none has been verified against a
real transcript corpus here, and guessing a spelling would produce links that
silently point nowhere.

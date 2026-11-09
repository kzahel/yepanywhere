# Zed DeltaDB and Delta

> **2026-09-30 update:** Delta entered [public beta on September 16](https://zed.dev/blog/delta-public-beta)
> with desktop and web access. The body below preserves the September 15
> research snapshot, including then-current waitlist status and unverified
> implementation inferences. Use the [multiplayer analysis](multiplayer-ai.md)
> for the newer collaboration and availability comparison; this is not a fresh
> audit of DeltaDB internals.

- **Vendor:** Zed Industries (the Zed editor company)
- **Products:** *DeltaDB*, an operation-based version control store for
  agent-driven work; *Delta*, a multiplayer application built on it in which
  humans and agents share threads. Announced on the Zed blog
  ([DeltaDB, June 2026][deltadb-blog]; [Delta, 2026-08-12][delta-blog]);
  early access by waitlist at [zed.dev/deltadb][deltadb-page].
- **Type:** Hosted collaboration product plus a version-control data model;
  not an agent supervisor in YA's sense, but it overlaps YA on shared
  sessions, code↔conversation traceability, and cheap branching.
- **License / source:** Closed. The [Zed editor repository][zed-repo] is
  open (GPL/AGPL/Apache per crate) and contains no DeltaDB implementation.
  Local checkout `~/.cache/checkouts/github.com/zed-industries/zed`, analyzed
  at [`01c555b`][zed-pin] (2026-09-15).
- **Evidence limits:** The Zed team published no technical documentation,
  schema, protocol, or pricing as of 2026-09-15. Everything below about
  internals is either a verbatim marketing claim, an inference from the open
  Zed crates the same team wrote, or explicitly marked as unverified.
  The Hacker News launch thread contains no Zed staff explanation of
  internals.

## Assessment

**Competitive relevance: high for the direction, low for the current
product.** DeltaDB targets exactly the two things YA has been circling from
the Git side: recording what happened *between* commits with the conversation
attached, and letting more than one person be inside a live agent thread. It
is a hosted early-access product with no self-host or open-source path, so it
is not a substitute for a private supervisor today. Its value to YA is as a
design pressure and as prior art for choices YA has so far made
conservatively.

The claims, verbatim from the announcement and product page:

> DeltaDB breaks your work into a stream of fine-grained *deltas*. Where Git
> captures a snapshot at each commit, DeltaDB captures every operation in
> between and gives each one a stable identity.

> Every change is linked to the agent conversation that produced it. From any
> line of code, find the conversation. From any message, jump to the code it
> touched.

> DeltaDB virtualizes the worktree, so spinning up a new agent branch is
> effectively free. Any point in history is a valid branch point, including
> mid-run.

> A teammate can join while the work is still happening, talk to the agent
> that did the work, and annotate as they go, without waiting for you to
> commit and push first.

## What the data model most likely is

The open Zed source is the best available evidence, because the team has
shipped this CRDT for years and the `path` crate's header comment already
reads "Relative path types for deltadb" (`crates/path/src/path.rs`), which
shows DeltaDB shares crates with the editor.

- **Text CRDT with stable operation identity.** `crates/text` stores a
  buffer as a `SumTree` of insertion fragments. Every edit is an
  `Operation::Edit(EditOperation { timestamp: Lamport, version: Global,
  ranges, new_text })`, where `Lamport { value: u32, replica_id: u16 }` is the
  stable identity of the operation and `Global` is a version vector. Undo is a
  separate operation kind, so history is append-only.
- **Anchors survive edits.** `text::Anchor` is `(insertion timestamp, byte
  offset into that insertion, bias)`, not a line number. This is the exact
  mechanism behind "every reference is anchored to a delta instead of a line
  number, [so] it survives as the code moves underneath it"
  ([blog][deltadb-blog]). YA's source-review anchors are `(path, revision,
  line, context snippet)` with relocation at submit time; DeltaDB anchors
  never need relocation because the identity is the insertion itself.
- **Replicas are first-class.** `ReplicaId` is a `u16` and the version vector
  is sized for "all the important non-collab replica ids" plus collaborators,
  so a worktree replicated across several machines is native to the model,
  not a deployment afterthought. The Delta post says teammates get "their own
  local code copies synchronized in real time".
- **Conversation as a document.** The Delta post: "the conversation is a
  document, and your cursor works everywhere in it" and "A message and the
  edit it produced are recorded side by side, so neither drifts away from the
  other." The plausible reading is that the thread is itself a CRDT document
  whose entries reference edit operation ids, and edits carry the thread
  entry that produced them. Unverified.
- **Git is a peripheral, not the store.** "DeltaDB works with the git
  repository you already have. Every edit and conversation is captured
  between your commits." Git remains "for running checks and connecting you
  to the rest of the world, rather than being the place collaboration is
  forced to happen."

**Centralized in practice.** Zed's existing collaboration (shared projects,
channels, following) runs through Zed's hosted `collab` server, and Delta is
offered only as a hosted early-access product. The replica-capable data model
is a conceptual property; the shipped topology is one vendor-operated
coordination service. There is no evidence of peer-to-peer or self-hosted
replication.

## The agent-facing worktree: what is actually claimed

The user's working model going in was that agents see a non-materialized
worktree through bespoke tools until a build or other step requests files on
disk. The published text is narrower:

> They're real worktrees: agents work in them through a terminal, and you can
> mount the whole worktree to disk whenever you want your own tools on it.

So the *agent* is given an ordinary terminal against the worktree, and it is
the *human's* local tools that require an explicit mount. The materialization
mechanism (hosted sandbox, FUSE-style mount, or a synced local directory) is
undisclosed. The commitment that does follow from the claims is that every
byte change in that worktree must pass through DeltaDB's operation log to be
recorded; edits that bypass it (an unmounted local editor, a build artifact)
either need a reconciliation path or are invisible to the conversation link.

The assessment of that commitment stands regardless of mechanism: frontier
agents are trained on POSIX files, `git`, and a shell. Any layer that changes
what those primitives do, or asks the model to use replacement tools, pays
either in instruction tokens, in provider-specific tuning, or in the class of
bugs where the model's expectation and the virtual worktree disagree.
Terminal-first is the least committal version of that choice, and it is the
one they appear to have made. Semantic merge of independent branches remains
unsolved by the data model; CRDT convergence guarantees that concurrent edits
to one file produce *a* result, not a correct one.

**Forced representation versus observed provenance.** The vision is to force
every interaction, edits and messages alike, through one traceable
representation: the worktree and the thread exist only as operations in the
store, the terminal and the mount are views onto it, and "every change is
linked" holds because no unrecorded path exists. That is forcing by
construction rather than by rule, and it pays in exactly the team-plus-agent
cases where one unexplained hunk breaks trust in the whole trail: several
people and agents on one thread, review of work in progress rather than of a
pull request, audit, onboarding, and hands-off delegation read afterwards.
What happens to edits that bypass the log is undisclosed. YA makes the
opposite bet deliberately: observe at the tool boundary, record what was
seen, leave honest gaps for human and external edits, and never gate how
anyone edits. The forced model wins on completeness; the observed model wins
on not owning the user's files or workflow.

## Feature comparison with Yep Anywhere

| Concern | DeltaDB / Delta (claimed) | YA today | YA design already on file |
| --- | --- | --- | --- |
| Session/transcript storage | Proprietary operation log; thread and edits in one store | Provider-native JSONL (Claude `parentUuid` DAG, Codex linear rollouts) as truth; SQLite for catalog/search; YA writes no shadow transcript | [session ownership](../../topics/session-ownership.md), [required SQLite](../../topics/required-sqlite.md); a YA-written git mirror of session state was [rejected](../../topics/agent-session-access.md#rejected-ya-written-filesystemgit-mirror) |
| Edit provenance while dirty | Every operation carries its producing message | Last editing session per dirty path from observed Edit/Write/`apply_patch` tool results; Review link from each Edit block | [Source Control](../../topics/source-control.md) `lastEditor` contract |
| Edit provenance after commit | Same log; commits are markers | None recorded | [git-notes attribution sketch](../../gaps/sketches/committed-change-session-attribution.md) (default-off, notes only) |
| Code → conversation | Any line → conversation | Dirty line → last session; committed line → commit only | Turn-level index: [turn-anchored edit provenance](../../gaps/sketches/turn-anchored-edit-provenance.md) |
| Conversation → code | Any message → the code it touched, at that moment | Edit blocks show before/after text; Review opens the current diff | same sketch |
| Anchoring comments | Delta-anchored, never relocates | `(path, revision, line, snippet)` with exact-line relocation at submit; captures pin the exact projection | [review sites](../../topics/source-review-to-session.md#submissions-and-comment-sites--contract-2026-08-01) |
| Branch at any moment | Free virtual worktree fork, including mid-run | Fork/Clone copies the transcript at a completed user turn; the working tree is shared | [fork-from-turn](../../topics/fork-from-turn.md), [workstreams](../../topics/workstreams.md) lanes; [fork with worktree checkpoint](../../gaps/sketches/fork-with-worktree-checkpoint.md) |
| Multiplayer thread | Teammates join live, talk to the agent, annotate | Read-only frozen/live public shares; driver/guest composer is a sketch | [participatory live share](../../topics/relay-origin-and-share-gating.sketches.md#participatory-live-share), [multi-machine map](../../topics/multi-machine-architecture.md#multiplayer-and-participatory-sharing); [named participant seats](../../gaps/sketches/named-participant-seats.md) |
| Agent introspection of history | Presumably native (thread is data the agent reads) | `ya-agent self` for the owning session; cross-session catalog/transcript/search proposed | [agent-self](../../topics/agent-self.md), [agent session access](../../topics/agent-session-access.md) |
| Replication across servers | Replica-capable model; hosted-only deployment | One server owns a session; federation is a single-writer migration proposal | [federated super sessions](../../topics/federated-super-sessions.md) |
| Deployment | Vendor-hosted early access | Self-hosted, private, relay-encrypted | — |

## Where YA is ahead, and where it is not

YA is ahead on everything that depends on not owning the store: provider-native
history discovery, private self-hosting, working with whatever the provider
CLI writes, and the review-to-session workflow that already freezes exact
source projections. The dirty-path `lastEditor` link plus the Edit-block Review
link is a working, if coarse, "trace code to conversation" for the hottest
supervision moment.

YA is behind on three things DeltaDB makes structural rather than bolted on:

1. **Granularity of provenance.** YA remembers *a session* per dirty path.
   DeltaDB remembers *the message* per operation, in both directions, and
   keeps it after commit. YA already observes every successful mutation tool
   call with its path and content at the `tool_use`/`tool_result` boundary, so
   the missing piece is retention and indexing, not observation.
2. **Branching the worktree with the conversation.** Fork copies the
   transcript and leaves both forks editing one checkout. Workstream lanes
   give separate checkouts but are not tied to a fork point.
3. **Participant identity.** Live share knows one driver and anonymous
   viewers. Nothing in a YA transcript records which person sent a turn,
   approved a tool, or left a review comment, because YA has one operator.
   Every multiplayer idea, including Delta-style annotation, needs at least a
   display-level seat identity before it needs security principals.

The multiplayer UI itself is not where the novelty lies. Delta's thread is an
editor buffer: "your cursor works everywhere in it", and placing it on any
text (a diff line, a plan step, a thinking block) and typing attaches a
comment there. Shared cursor presence is plausible from Zed's collaboration
features but not stated. YA's live share already streams the driver's draft
to viewers. The differentiator is the data underneath: annotations and
edits that keep pointing at the right thing while an agent keeps working.

## Implications for YA

This analysis does not reprioritize the [roadmap](../roadmap/README.md).
The existing plans and gaps named above were checked before deriving these.

1. **Keep provider-native storage; add a YA-owned provenance index beside
   it.** Do not adopt an operation-log store or shadow transcript; the
   rejection of a git mirror stands. A turn-keyed edit index over already
   observed mutations delivers most of "trace code to conversation" without
   changing where truth lives. Sketch:
   [turn-anchored edit provenance](../../gaps/sketches/turn-anchored-edit-provenance.md).
2. **Pair fork with a checkout.** Make "fork from this turn" optionally
   create a workstream lane whose working tree matches the checkout at that
   turn, using the dirty diff YA can already compute. Sketch:
   [fork with worktree checkpoint](../../gaps/sketches/fork-with-worktree-checkpoint.md).
3. **Give participants names before giving them rights.** A single-server,
   trusted-household multiplayer needs per-client seat names attached to
   sends, drafts, approvals, and comments so a shared transcript reads
   correctly. The maintainer direction is already fixed for the provider-
   visible half: share joiners enter a username and their driver-bypassing
   sends carry it as a prefix, while the driver stays unprefixed. Sketch:
   [named participant seats](../../gaps/sketches/named-participant-seats.md).
   Security principals remain the separate open design in the
   [multi-machine map](../../topics/multi-machine-architecture.md#authority-and-failure-questions-to-resolve).
4. **Treat the wide-screen workspace as a layout concern, not a feature
   list.** Delta's conversation-as-editor-buffer reads as an IDE-shaped
   surface. YA's
   wide-viewport answer is the side-by-side viewer panel sketched in
   [parked file viewer sketches](../../topics/parked-file-viewer.sketches.md),
   which keeps the session primary and the transcript's content width intact.
5. **Do not compete on CRDT anchoring.** YA's anchors relocate against real
   files because real files are the contract with every provider. Improve
   relocation (context-scored, ambiguity-signalled) when a defect is observed,
   as [source review](../../topics/source-review-to-session.md#relocation--deferred-but-its-contract-is-stated)
   already states, rather than adopting a store that owns the bytes.

Revisit this analysis when Zed publishes DeltaDB technical documentation, a
self-hosted or open-source component, a Git bridge specification, pricing, or
evidence of which agent providers Delta supports and how their tool calls are
captured. Any of those would change the comparison more than the current
marketing claims do.

## Sources

Public pages were checked on 2026-09-15. Zed source references are pinned to
the analyzed commit.

[deltadb-blog]: https://zed.dev/blog/introducing-deltadb
[delta-blog]: https://zed.dev/blog/introducing-delta
[deltadb-page]: https://zed.dev/deltadb
[zed-repo]: https://github.com/zed-industries/zed
[zed-pin]: https://github.com/zed-industries/zed/tree/01c555b43519833bdce2089425d2634d82253a59
[zed-text]: https://github.com/zed-industries/zed/blob/01c555b43519833bdce2089425d2634d82253a59/crates/text/src/text.rs
[zed-anchor]: https://github.com/zed-industries/zed/blob/01c555b43519833bdce2089425d2634d82253a59/crates/text/src/anchor.rs
[zed-clock]: https://github.com/zed-industries/zed/blob/01c555b43519833bdce2089425d2634d82253a59/crates/clock/src/clock.rs
[zed-path]: https://github.com/zed-industries/zed/blob/01c555b43519833bdce2089425d2634d82253a59/crates/path/src/path.rs
[zed-collab-docs]: https://github.com/zed-industries/zed/blob/01c555b43519833bdce2089425d2634d82253a59/docs/src/collaboration/overview.md
[hn]: https://news.ycombinator.com/item?id=49187256

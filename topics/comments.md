# Code comments

Topic: comments

Direction agreed 2026-11-14: comment cleanup is worthwhile. On 2026-11-15 the
maintainer selected a repository-wide block checklist, suspecting roughly 90%
of comments may be removable. The [review inventory](../docs/research/comment-review/README.md)
records the committed snapshot, per-block decisions and extraction limits.
The estimate is a hypothesis to test through review, not a deletion quota.
No automated gate or blanket comment ban is adopted.

## What earns a comment

Keep information a reader cannot readily recover from names, types and nearby
code: units, public API semantics, external platform/protocol constraints,
non-obvious invariants, and resource ownership or lifetime. Legal notices and
necessary tool directives also have a purpose.

Remove narration of obvious operations, redundant function/field descriptions,
orphaned documentation, commented-out code, and implementation chronology that
belongs in Git. A long explanation is a reason to inspect the claim, not proof
that the comment is wrong. A comment does not make a workaround correct.

Prefer clearer names, data structures and APIs when our own code needs an
explanation to make its behavior understandable. When a constraint can be
enforced by a type, runtime check or meaningful regression test, prose alone
is insufficient enforcement.

## Existing requirements still apply

- [Bounded retention](server-performance-observability.md#bounded-retention)
  requires plain `Map`/`Set` fields on long-lived services to name their
  retention policy. Preserve the semantic distinction between a cache and
  state whose eviction changes behavior. Accepted growth until restart is a
  documented exception, not a hard memory cap; a comment is not evidence that
  cleanup works.
- [Warning justifications](../docs/development/code-quality.md#zero-warning-commits)
  remain required for warnings that must stand. Review the underlying rule and
  behavior before changing a suppression; deleting a directive is not a fix
  for the bug it suppresses.

## Cleanup workflow

Start with a bounded diff or module and inspect each comment against its code.
Separate obvious comment-only deletions from behavior changes. When a comment
is wrong, establish whether the code or the explanation needs repair; preserve
unverified external constraints until checked. Leave unresolved behavior in its
owning gap rather than declaring it fixed by deleting the explanation.

The audit found misleading explanations around
[artifact input ownership](../gaps/artifact-capture-input-ownership.md) and
[early composer typing](../gaps/session-early-typing-waits-for-transcript.md),
alongside redundant narration. These defects retain their existing owners.
Comment counts and keyword matches identify candidates, not a quality score.

Review the inventory in bounded module sweeps, recording remove, keep or
rewrite/move decisions with brief reasons. Check off a block after its decision
has been applied and verified. Verify the current source against the snapshot
before editing, and resolve the inventory's extraction-completeness checks
before claiming every block has been found. Keep useful constraints under the
criteria above; measure the resulting removal rate rather than forcing it.

An automated gate remains undecided. Mechanical checks should enforce only
rules they can reliably establish without creating noisy CI.

## What pstack contributes

As inspected 2026-11-14, upstream
[poteto-mode](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md)
calls [no-comments](https://github.com/cursor/plugins/blob/main/pstack/skills/no-comments/SKILL.md)
before review. It invokes a dedicated
[comment reviewer](https://github.com/cursor/plugins/blob/main/pstack/agents/comment-sicko.md),
then validates findings, fixes accepted root causes, and offers executable
encodings for constraints. These are agent instructions, not a deterministic
comment-quality checker. Its aggressive deletion default needs adaptation to
YA's requirements above; the workflow is reference material, not adopted policy.

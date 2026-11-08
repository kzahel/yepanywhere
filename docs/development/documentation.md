# Documentation and plans

[Contributor guide](../../DEVELOPMENT.md) · [Development docs](README.md)

Commands and code paths below are relative to the repository root unless stated
otherwise.

## Document Ownership

- `DEVELOPMENT.md` owns common contributor rules and required-reading triggers.
- `docs/development/` owns contributor procedures and operational runbooks.
- `topics/` owns observable product behavior and durable technical contracts.
  Existing topics may also own their specialist development procedures; link to
  them rather than splitting an established owner just to match the directory
  taxonomy.
- `docs/tactical/` holds implementation plans; `docs/roadmap/README.md` owns
  product priority; `gaps/` holds open adjacent defects under
  [its lifecycle](../../gaps/README.md).

Every intentional observable behavior change needs an owning topic contract,
including deliberate failure and fallback behavior. Tests and commit messages
are evidence and history, not substitutes for that contract.

Keep current requirements distinct from proposals and historical evidence. When
moving documentation, preserve requirements, approval gates, exceptions, and
verification obligations; update incoming links and named-section references.
The root guide should name the trigger and owner, while detailed procedures and
examples have one home. Add a root trigger when a new requirement must be read
before a particular action, including when the affected work is outside the
owner's directory.

## Naming Steps In Tactical Plans

Name every step in a `docs/tactical/*.md` plan for the product surface or the
work it covers — "source-control chrome", "delete the dead git-status rules",
"teach the unused-CSS report about modules". Number them in recommended order
if a handle is useful, matching the house form `### 4 — map source-control CSS
ownership`.

Do not invent a private code scheme. Lettered lanes with numbered slices
(`A1`, `C1.5`, `F0`) force every reader — including the maintainer who asked
for the plan — to hold a lookup table in their head before they can discuss the
work, and the letters convey nothing on their own. Group related steps under a
plain heading instead. If a step's name is hard to write, that usually means
its boundary is not yet decided.

Reusing a scheme that already exists in a document you are editing is fine;
extending it into a new document is not. When you rename, leave one compact
mapping table so older commit messages stay traceable.

## Retiring Completed Tacticals And Gaps

A `docs/tactical/*.md` whose work is landed, validated, and working has no
remaining job as a plan. Retire it by first migrating its durable content —
the contracts, invariants, and design reasoning a later reader still needs —
into the owning `topics/*.md`, then deleting the file in that same commit.
What does not survive the migration is a finished todo list and its recon
notes, which the tree and git history already record. Migration first is the
whole procedure: a deletion that skips it loses knowledge nothing else holds.

Retiring is periodic or at-will, never obligatory — a completed plan may be
kept, and some carry enough durable design to serve as a topic doc would.
Retire only plans you authored; leave another author's completed plans alone
unless they ask.

`gaps/*.md` is stricter: the entry is deleted in the commit that fixes it
(`gaps/README.md`).

A `topics/*.md` or a code comment that names a retired file needs no scrub.
The path stays a searchable handle:
`git log --diff-filter=D -- docs/tactical/<name>.md` finds the removal, and
`git show <sha>^:docs/tactical/<name>.md` prints the file back.

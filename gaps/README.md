# gaps/ — captured adjacent defects

See [triage](triage.md) for impact, scope, evidence and closure judgments.
Concrete unresolved defects stay here even when they need diagnosis.
[sketches/](sketches/) holds aspirational or insufficiently bounded work;
moving an entry preserves its prior direction and constraints. Close an entry
when current evidence shows its complaint is fixed, retaining any unresolved
remainder as a narrower gap. Triage is a dated review, not a replacement for
the product roadmap or verification against current code.

A gap is a code-quality defect noticed *next to* other work but deliberately
not fixed then — a failing or flaky test, lint debt, a small structural wart,
a UI glitch — captured here so it doesn't evaporate into a chat message that
dies with the session.

## Entry format

One file per gap, `gaps/<slug>.md`:

- Title line stating the defect.
- Body: what is wrong, where (paths/lines), why it was not fixed in place,
  and the cheap fix if known.
- Footer: `Found <date> while <context>.`

## Lifecycle

- Create the entry in (or alongside) the commit doing the adjacent work.
- **Delete the entry in the commit that fixes the gap** — the directory only
  ever lists open gaps; git history keeps the record.
- Fix in place instead of filing only when the fix is cheap *and* in scope
  (the seam is already open), and then as its own commit.

## What does not belong here

- Cross-cutting contracts and durable design knowledge → `topics/`.
- Queued feature work → the Project Queue / `on-deck/` when present.

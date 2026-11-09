# Client CSS Architecture

> Component-owned client styles use co-located CSS Modules. Existing global
> stylesheets are frozen at ratcheting line-count ceilings while feature work
> gradually extracts their rules.

Topic: css-architecture

## Status: contained steady state; opportunistic paydown

YA's authored client CSS grew into four globally loaded stylesheets totaling
more than 31,000 lines. The two largest files mixed unrelated ownership:
`index.css` held most application pages and controls, while `renderers.css`
held generated content, tool renderers, file viewing, source review, and source
control.

The dedicated migration campaigns are complete. The existing cascade remains
in place while new work stops increasing it and touched features pay down their
local part. Zero global CSS is not the goal: generated markup, document-level
state, themes, tokens, and reviewed shared primitives remain global by design.

"Good enough" means the direction is enforced without requiring a continuous
cleanup campaign: new component CSS is modular, the legacy files cannot grow,
and a feature change extracts its clearly owned legacy CSS when that work is a
bounded part of the same verification surface.

## Migration tracking

[`docs/tactical/070-css-modules-migration.md`](../docs/tactical/070-css-modules-migration.md)
is the closed campaign record. It no longer carries a priority queue. This
topic is the binding architecture, candidate-selection protocol, and reusable
runbook.

[`docs/tactical/072-source-css-ownership-map.md`](../docs/tactical/072-source-css-ownership-map.md)
records the ownership evidence for the file viewer, source review, source
control, and blame regions: which classes are generated and stay global, which
component owns each rule, every cross-owner reach-in a slice must convert, and
the rules verified dead. It is reference data, not policy.

[`docs/tactical/074-mixed-model-css-paydown.md`](../docs/tactical/074-mixed-model-css-paydown.md)
is the stopped bounded-campaign ledger. It records the final campaign counts,
verification evidence, and the known ownership-sink false positive left for
tooling follow-up.

[Tactical 076](../docs/tactical/076-css-module-contracts-and-tooling.md) is the
closed tooling-hardening record for the Biome upgrade, module lint and usage
contracts, touched-component guidance, and on-demand health summary. It does
not carry a migration queue.

## Contract

- A React component's new styles belong in a co-located `*.module.css`, imported
  as `styles` by the owning component.
- `packages/client/src/styles/index.css`, `renderers.css`, `tool-rows.css`, and
  `emulator.css` are legacy global stylesheets. Each is frozen at the line limit
  in `scripts/css-architecture-baseline.json`.
- Feature work must not raise those limits. If a global rule is genuinely
  necessary, offset it by extracting at least as many legacy lines from the
  same file; prefer a reviewed, narrowly owned global exception when offsetting
  would obscure ownership.
- A new authored non-module stylesheet under `packages/client/src` fails
  `pnpm css:check` unless it is explicitly added to the reviewed allowlist with
  a reason. This prevents replacing one global monolith with several unowned
  global files.
- When extraction takes a legacy file below its ceiling, run
  `pnpm css:check --record` in the same change. Recording only lowers limits;
  it never accepts growth.
- A `var(--name)` read of a custom property that no production client source
  defines fails `pnpm css:check`. Such a read silently takes its fallback, or
  drops its declaration when it has none. The undefined-token pass of
  2026-11-09 emptied `undefinedCustomProperties` in
  `scripts/css-architecture-baseline.json` (62 names and 291 reads when first
  recorded on 2026-11-08), so every undefined read now fails. A definition is
  a CSS declaration or `@property`, or a TypeScript style key, `setProperty`
  call (with the name inline or in a `const` in the same file) or `--name:`
  string; the scan covers CSS and TypeScript under `packages/client/src`,
  excluding tests. Read a theme token, define the property, or set it where
  its owner renders. The
  [design playground](ui-design.md#shared-controls-and-the-design-playground)
  token page lists each name with its sites.
- CSS refactors preserve rendered appearance, responsive behavior, interaction
  states, and theme behavior unless an owning product topic explicitly changes
  them. Hashed module class names are implementation details; tests and browser
  automation should prefer roles, labels, and stable data attributes.
- A task that changes a React owner still using legacy global classes performs a
  bounded ownership check. It extracts a clear, locally verifiable slice when
  that work stays inside the task's product surface; it reports why extraction
  was deferred when generated vocabulary, dynamic construction, composition,
  or verification would materially expand the task.
- `pnpm css:touched` is the diff-aware trigger for that check. By default it
  compares `HEAD` with the working tree, including untracked files;
  `--base <ref>` compares the ref's merge base with `HEAD` through the current
  working tree. It reports only changed React owners with current legacy
  ownership evidence and separately calls out changed legacy stylesheets.
- The touched report labels an owner `OPPORTUNITY` only when its owned rules are
  concentrated in at most two stylesheets and have no coupled, unresolved, or
  dynamic evidence. All other owners are labeled `DEFER` with concrete reasons.
  Either result, and a clean/module-only diff, exits successfully because the
  command is advisory. Invalid arguments or a failed git comparison exit 2.
- `pnpm lint` runs `pnpm css:modules:check` before Biome. The module check is a
  blocking, parser-backed contract: every module needs production reach; every
  declared selector needs a statically known production use; every
  `styles.foo`/`styles["foo"]` access must name a local selector; and computed
  or side-effect access fails instead of making the whole module silently live.
- Test and package-script imports are tracked separately. A selector reached
  only by a test is reported as test-only and fails the production contract;
  tests may pin behavior, but they do not prove shipped code uses a selector.
- Each `:global(...)` or `composes ... from global` use in a module must name a
  class present in an authored global stylesheet and carry a module-local class
  anchor in the same selector-list branch. An anchor in a sibling comma branch
  does not scope the global use. The shared-shell form
  `:global(.modal):has(.localContent)` is valid because `.localContent` makes
  ownership and scope explicit.
- CSS analysis compares selector-parser-decoded class values with complete
  whitespace-delimited class tokens from source. Selector-shaped strings are
  parser-decoded, and generated-markup class attributes are tokenized as class
  lists. Escaped punctuation, Unicode, leading digits, and single-character
  classes retain one canonical identity; source tokenization must not split one
  runtime class into ASCII word fragments.
- `pnpm lint` runs `pnpm buttons:check`, the button family's ban
  ([UI design](ui-design.md#shared-controls-and-the-design-playground)). It
  rejects a banned legacy button class (rule-less in `design/census/mapping.ts`
  or recorded as banned), a raw `<button>` outside `ui/Button.tsx` and the
  later families (menus, tabs, option pickers, switches, the composer), a new
  `role="button"` element, and a CSS rule, in a module or a global
  stylesheet, whose selector reaches a bare `button` element (`.panel
  button`, `button:hover`) and sets look or size properties. Such a rule
  outranks `ButtonBase`'s zero-specificity reset and ties with `Button`'s
  variants. Exceptions sit in
  `packages/client/design/census/button-allowlist.json` with a count and a
  reason; counts only fall, and `--record` lowers them.
- `pnpm css:unused` remains the investigative global-and-module report. Its
  known legacy findings may make that command exit nonzero without breaking
  ordinary lint. `--remove` remains limited to global rules; module rules are
  deleted deliberately with their owner.

## Command roles and exit behavior

| Command | Role | Exit/write contract |
|---|---|---|
| `pnpm css:check` | Hard containment gate | Exits 1 for global growth, an unreviewed global file, a stale/invalid baseline entry, a newly undefined custom property, or more reads of a recorded one. `--record` is the only write mode and only lowers current ceilings. |
| `pnpm buttons:check` | Hard button-family ban | Exits 1 for a banned legacy button class, a raw `<button>`, a `role="button"` element or a `button` look rule beyond the allowlist, or an allowlist count above the scan. `--record` only lowers allowlist counts, drops entries at zero and adds newly rule-less classes to the banned list. |
| `pnpm css:modules:check` | Hard module usage/global-interop gate | Exits 1 for any module contract issue or an unusable scan; otherwise 0. It never edits CSS. |
| `pnpm css:lint` | Hard authored-CSS lint gate | ESLint with `eslint-cssicorn` over `packages/client/src` and `site/src` CSS; exits 1 on any error or warning. It never edits CSS unless run by hand with `--fix`. |
| `pnpm lint` | Combined repository gate | Runs containment, module contracts, the button ban, CSS lint, and Biome; any child failure fails lint. |
| `pnpm css:touched` | Advisory feature-diff prompt | Exits 0 for opportunity, deferral, or no matching owner; exits 2 for invalid arguments or a failed git comparison. It never edits files. |
| `pnpm css:inventory` | Advisory ownership drill-down | A valid report exits 0 and never edits files; invalid arguments exit 2. |
| `pnpm css:unused` | Advisory dead-code investigation | Exits 1 while potential global dead code or a module contract issue remains. `--dry-run` previews; explicit `--remove` may delete only reviewed global rules, never module selectors. |
| `pnpm css:health` | Observational cross-signal summary | A successful scan exits 0 regardless of reported debt; invalid arguments or unreadable/unparseable input exit 2. It never builds or writes. |

## CSS lint rules

ESLint runs only on CSS here; Biome keeps TypeScript/JavaScript lint and all
formatting. `eslint.config.js` enables every `eslint-cssicorn` rule for
authored client and site CSS, minus these decisions:

- **Rejected as churn without a defect class:** `lowercase` (mostly
  `currentColor` spelling), `prefer-short-hex-color`, and
  `prefer-modern-syntax` (`rgba(…)` to `rgb(… / 50%)`).
- **Out of scope:** `packages/desktop` (also outside Biome) and
  `packages/client/mockups` (throwaway mockups).

Rules that shape new CSS:

- Full-viewport sizes name their viewport: use `100dvh`/`100dvw`, matching
  the app shell, not bare `100vh`/`100vw`. No `vh` fallback line is needed;
  the client already requires `color-mix()`, which postdates dynamic
  viewport units.
- Media queries use range syntax (`width < 1100px` paired with
  `width >= 1100px`), so adjacent breakpoints leave no fractional-width gap.
  The production build lowers range syntax for older targets.
- Wrap long words with `overflow-wrap: anywhere`, not the deprecated
  `word-break: break-word`. Visually hidden elements use
  `clip-path: inset(50%)`, not `clip: rect(…)`.
- A base rule comes before every contextual override of the same property
  (`no-descending-specificity`), in the legacy stylesheets too. When adding
  an override, place it after its base; when moving rules to satisfy this,
  check that no rule whose order flips has equal specificity, an
  overlapping property, and a subject that can be the same element.
- A selector appears once per file and media context. The diff palette in
  `index.css` is the one deliberate exception: it is grouped separately from
  the theme blocks under a scoped disable comment.
- `no-unknown-animations` checks `animation` names against keyframes in the
  same file. That is the CSS Modules contract too: a module's keyframe names
  are renamed per module, so it cannot use a global keyframe by bare name.

## Ownership boundaries

CSS Modules are the default for:

- component layout and appearance;
- component-local states and variants;
- component-local media queries and keyframes; and
- selectors whose complete DOM subtree is owned by one React component.

Global CSS remains appropriate for:

- design tokens, themes, font faces, reset/base element rules, and shared
  document-level state;
- third-party CSS such as KaTeX;
- HTML produced outside the owning React component, including server-rendered
  markdown, Shiki markup, ANSI/fixed-font transforms, or stable provider
  renderer vocabularies; and
- narrowly documented composition primitives shared across unrelated owners.

Generated markup does not justify placing an entire surrounding feature in a
global file. Keep the generated vocabulary global and move the React-owned
shell, controls, and layout into modules.

Use `:global(...)` inside a module only for a narrow interop boundary that the
module cannot own. The global selector should be evident beside the local
selector it affects. `HostOfflineModal.module.css`, for example, uses the
shared global `.modal` shell only to size the modal containing its local
content.

The module contract reports the count of reviewed global references as
context, but does not impose a numeric ceiling. A new interop reference is
acceptable when it is local, existent, and intentional; an unanchored or
missing reference is not.

## Component composition

- The component that creates an element owns its class.
- A parent that needs to place a child should prefer a wrapper or an explicit
  `className`/variant prop over reaching into the child's generated class name.
- Reusable visual primitives may expose a deliberate shared global class, but
  accidental global selectors are not a component API.
- Keep design values in existing custom properties. Moving a selector into a
  module does not require copying theme values or introducing JavaScript style
  objects.
- Runtime CSS-in-JS libraries are not part of this migration. Vite's native CSS
  Modules provide scoping and co-location while retaining static CSS and adding
  no client runtime dependency.

## Data-driven slice selection

Choose migration work from current repository evidence, not a standing list of
features that looked attractive during an earlier inspection.

Start with:

```bash
pnpm css:touched
pnpm css:inventory
pnpm css:inventory -- --owner <component-or-path>
```

The inventory parses legacy CSS with a CSS parser and authored package source,
Playwright, and script roots with the TypeScript parser, including JS module
and CommonJS harnesses. It distinguishes exact string-literal and
regex-selector callsites, dynamic template prefixes, test references,
non-client/generated producers, and React owners. For each likely owner it
reports:

- **owned lines** — complete CSS rule spans attributed to that owner;
- **span and coverage** — how concentrated those rules are between the first
  and last owned rule in each stylesheet;
- **stylesheets** — whether the component is split across legacy files;
- **edges** — coupled or unresolved rules that need explicit review; a coupled
  rule is shown under every React owner it touches even when none of its
  classes provides a single-owner anchor;
- **dynamic classes** — template-built families that require a finite/open
  construction decision; and
- **tests** — files that mention the selector vocabulary and may rely on it.

The default approachable list is deliberately conservative. Prefer a component
or cohesive surface with substantial owned lines, high span coverage, one or
two stylesheets, few edges, no generated vocabulary, and a deterministic way to
exercise its important states. A 150–350 line local slice is often a better
paydown than a larger owner scattered through shared primitives, but the report
is evidence rather than a numeric mandate.

Before naming a slice:

1. drill into the owner and inspect every reported edge;
2. search the complete repository for the involved selectors and dynamic
   constructors;
3. identify the focused tests and desktop/phone states that will verify it;
4. define one bounded product surface, not a stylesheet range; and
5. leave the candidate in the inventory rather than adding speculative future
   steps to a tactical document.

Do not normalize every `className` before selection. Literal classes can move
with their owner. Finite switches or template unions become local module
lookups during that slice. Open-ended construction and generated HTML remain a
review boundary and may justify keeping the vocabulary global.

Automation may rewrite an already reviewed, unambiguous slice, but it must not
choose ownership, silently resolve composition, or delete coupled/generated
rules. Add a conversion tool only after repeated completed slices demonstrate
a stable mechanical transformation.

## Opportunistic extraction during feature work

Run the ownership check when either of these is true:

- a changed React component still emits classes defined in a legacy global
  stylesheet; or
- the change edits a legacy global stylesheet.

Begin with `pnpm css:touched`, then drill into a reported owner with
`pnpm css:inventory -- --owner <component>` and search the complete repository
for the involved selectors. Extract in the same change when the owner is clear,
the selectors describe the same product surface, important states can be
verified with the task's existing test or browser setup, and the move does not
require a substantial new cross-component styling API.

Small touched slices are worthwhile even when they would not rank highly for a
standalone paydown campaign. Locality and verification overlap matter more than
raw line count. Conversely, a large inferred owner is not an invitation to
expand a feature task across scattered rules.

Defer the extraction when it crosses generated markup, an open-ended dynamic
class family, unresolved ownership, broad caller/child composition, or a visual
state the current task cannot exercise reliably. State the concrete reason in
the handoff, for example:

```text
CSS ownership: deferred — the changed control participates in 14 coupled rules
across MessageInputToolbar and ModeSelector.
```

Do not create a future-candidate queue from these deferrals. Fresh inventory is
the source of truth when the component is touched again. An unrelated deletion
that merely makes the global line ceiling pass does not establish that newly
added component CSS belongs in the global file.

## Health interpretation

The legacy line ratchet measures containment of the global monoliths. It does
not measure total CSS reduction or, by itself, module quality. CSS health should
be inspected on demand across separate dimensions rather than collapsed into a
single score or maintained as a standing dashboard:

- **containment** — legacy lines per file and reviewed global exceptions;
- **ownership** — owned, coupled, generated, unresolved, and low-confidence
  rules or lines;
- **module contracts** — unused or undeclared selectors, test-only usage,
  missing production importers, and analysis made unknown by computed access or
  side-effect imports;
- **escape hatches and complexity** — `:global(...)`, `!important`, duplicate
  declarations, descending specificity, and excessive selector depth;
- **dead code** — potentially unused legacy classes and safely removable rules;
  and
- **shipping context** — total authored CSS and built CSS bytes, so moving
  ownership is not mistaken for reducing delivered code.

Treat new global files or growth, broken module contracts, and strict module
lint failures as hard gates. Ratchet reviewed escape hatches and known unknown
modules without accepting regressions. Keep ownership mix, coupled rules,
candidate counts, total authored CSS, and bundle size observational: correct
classification or ordinary feature work may move them in either direction.

The intended consumer is the agent or reviewer already changing CSS and the
occasional architecture audit. A command-line summary is sufficient; do not
build a product dashboard or duplicate changing measurements in prose.

`pnpm css:health` is that on-demand summary. It composes the containment
baseline, ownership inventory, module contract, global-interop analysis, and
unused-global report into human-readable or `--json` output. It includes total
authored CSS and the global/module line split but does not build the client to
obtain shipping bytes. Its escape-hatch row covers reviewed module-to-global
references; strict module complexity rules such as `!important`, duplicate
declarations, and excessive selector depth remain visible through the blocking
Biome lint policy.

The health command is observational and exits 0 after a successful scan even
when it reports ratchet problems, module issues, or potential dead code; the
owning checks retain their documented blocking behavior. Invalid arguments or
an unreadable/unparseable input exits 2. Do not use a saved health JSON file as
a baseline or add a composite threshold—the current analyzers are the source of
truth.

## Migration runbook

### 1. Establish ownership before moving rules

Choose a feature whose selectors and DOM owner can be identified together.
Begin with `pnpm css:inventory -- --owner <name>`, then search the entire
repository before editing:

- every class selector and state suffix;
- CSS selectors elsewhere in the legacy cascade;
- `className` strings, template literals, and helper-built names;
- raw/generated HTML producers;
- tests, Playwright locators, and DOM-query code; and
- caller selectors that reach into the component.

Classify each rule as component-owned, caller layout, shared primitive,
document-level state, generated vocabulary, third-party override, or stale.
Ambiguous ownership is a reason to pause, not a reason to use broad
`:global(...)`.

A feature's rules are not necessarily in one stylesheet, and a stylesheet's
section headings describe where rules were written rather than what owns them.
Source control keeps its Stage-3 browser shells in `renderers.css` and its older
Git Status Page vocabulary in `index.css`, with six components owning rules in
both. Slice by component and take every rule that component owns from every
legacy file in the same change; a slice defined as a line range leaves its
components half-owned.

A class with no literal producer is not necessarily stale. Resolve dynamic
construction by reading the expression that builds it —
`` `git-status-${status.toLowerCase()}` `` and
`` `source-pane-splitter-${boundary}` `` have no literal occurrence anywhere.
Search outside `packages/client/src` as well: generated vocabulary is often
produced in `packages/shared` or `packages/server`, which is precisely why it
must stay global.

### 2. Move behavior before cleaning it up

Create `Owner.module.css` beside the component and import it as `styles`.
Preserve declarations, media queries, pseudo states, keyframes, variables, and
selector ordering before attempting visual cleanup. Semantic local names no
longer need globally unique feature prefixes.

Basic usage:

```tsx
import styles from "./StatusChip.module.css";

export function StatusChip({ active }: { active: boolean }) {
  return (
    <span className={`${styles.root} ${active ? styles.active : ""}`}>
      …
    </span>
  );
}
```

Do not add a runtime class-name dependency for ordinary composition. When
several optional classes make interpolation unreadable, use a tiny local
function or an array filtered and joined in the component.

### 3. Make composition explicit

For caller-owned placement, prefer a wrapper or an explicit `className` or
variant prop:

```tsx
export function StatusChip({ className }: { className?: string }) {
  return (
    <span className={[styles.root, className].filter(Boolean).join(" ")}>
      …
    </span>
  );
}
```

A caller may supply its own module class through that prop. It must not guess or
reach into the child's generated class name. Prefer named variants when several
callers need the same meaningful presentation; prefer a wrapper for one-off
layout.

Migrating a component that callers already reach into inverts this: once its
classes are hashed, `.caller .child-class` cannot be written at all, so each
existing override must become part of the component's API before the move.
`FilterDropdown` classifies its overrides three ways — a named boolean for a
recurring need (`fullWidth`), a named variant for a meaningful presentation
(`triggerVariant`, `panelVariant`), and a pass-through class for caller-specific
sizing (`triggerClassName`). A pass-through targets one documented element; it
is not a licence to restyle the subtree.

When the reach-in runs the other way — several ancestors styling a control they
do not render, as four row lists did to the source row-menu trigger — the child
module exports an opt-in class for the ancestor to apply to itself, and owns the
relationship locally (`.rowSurface:hover > .trigger`). The ancestor declares that
it is the interaction surface; it does not decide what the reveal looks like.

Check what a moved declaration was actually defending against before calling it
redundant. `.repo-status-bar .copy-button` restated `.copy-button`'s own values
and looked like dead weight, but a second, unrelated `.copy-button` later in
`index.css` was winning against it — `renderers.css` is `@import`ed at the top of
`index.css`, so its rules are the earliest in the cascade, not the latest. A
module class that replaces a descendant selector needs the same specificity the
selector had, or the outcome silently becomes stylesheet order.

When a caller rule that survives in a legacy stylesheet used to win through
descendant specificity, keep it at that specificity — scope it under the
caller's own wrapper. Otherwise it silently starts depending on stylesheet
order relative to the module.

Portals do not require global CSS. A module import emits static CSS, and the
portal element can use the generated class anywhere in the document. Keep
overlay, sheet, responsive, and keyframe rules in the owning module.

### 4. Contain unavoidable global vocabulary

Use a narrow global selector only where the module cannot own the other side:

```css
.root :global(.markdown-rendered) {
  color: var(--text-primary);
}

:global(.modal):has(.content) {
  max-width: 30rem;
}
```

The first form scopes generated markup beneath a local root. The second is
appropriate only when a shared global shell must respond to local content.
Never translate a whole legacy section into unscoped `:global(...)`; that
changes its file without changing its architecture.

Keep shared theme values in custom properties. Runtime-dependent dimensions or
positions may stay in `style` as CSS variables while all static declarations
move to the module.

### 5. Re-scan and test the boundary

After editing:

1. Search again for stale selectors and old literal class names. `pnpm
   css:unused` reports global classes by name and module selectors per owning
   file; it treats a computed key, a side-effect-only import, and an unimported
   module as undetermined rather than unused, and never rewrites module rules.
   Its CSS and TypeScript parsers scan every authored `packages/*/src`,
   `packages/*/e2e`, and `packages/*/scripts` producer, including `.mjs` and
   `.cjs` harnesses. They keep whitespace-delimited string tokens whole,
   parser-decode dot-led selector strings, read generated-markup class
   attributes as class lists, and record class selectors a regular-expression
   literal spells out after an escaped dot. A stylesheet-contract test that
   asserts on CSS text is therefore a visible producer.
   Bare words, other regex punctuation, and pattern flags are not vocabulary.
   Dynamic prefixes remain conservative, and a test-only reference can still be
   an intentional DOM contract, so confirm a verdict against the reported
   producer before deleting.
2. Confirm callers no longer depend on removed child selectors.
3. Run focused component and consumer tests.
4. Prefer roles, labels, and stable data attributes in tests; module hashes and
   local class names are not public selectors.
5. Run `pnpm css:check`, `pnpm lint`, `pnpm typecheck`, and
   `pnpm console:scan`.
6. Capture and inspect final browser screenshots at 1000×600 and 375×812 when
   the migration affects rendered UI. Read and inspect one image at a time.
7. Run `pnpm css:check --record` and verify that only the intended legacy
   ceilings moved downward.

Prefer extraction while a feature is already being changed. Standalone
mechanical extractions are also welcome when they have a clear owner and can be
verified without mixing in visual redesign.

## Established examples and baseline

The containment pass established native Vite CSS Modules with three different
ownership examples:

- `Toast.module.css`: an ordinary shared React component with a local animation;
- `HostOfflineModal.module.css`: a component with a narrow global-shell
  interop selector; and
- `KillShellRenderer.module.css`: a React-owned tool renderer extracted from
  `renderers.css`.

`FilterDropdown.module.css` followed as the shared-component case: a portaled
mobile sheet, a desktop panel, and five caller sites whose overrides became
props. It is the reference for the composition rules above.

The authoritative current legacy ceilings live in
`scripts/css-architecture-baseline.json`; `pnpm css:check` prints them. Do not
copy the changing numbers into this topic: every successful extraction records
a smaller ceiling, so a duplicate table becomes misleading quickly. The
baseline values are ceilings, not targets.

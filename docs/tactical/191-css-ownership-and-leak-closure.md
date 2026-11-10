# CSS ownership and leak closure

Topic: css-architecture

Status: plan selected 2026-11-10; no step has landed. The maintainer
replaced the "contained steady state" stance of
[CSS architecture](../../topics/css-architecture.md) with a target of little
global CSS and shared controls whose look callers cannot override. Steps run
in order, each implemented, reviewed and committed before the next.

## Why

[Plan 182](182-design-playground-and-shared-controls.md) put every control
family except the composer on shared controls, and the app looks more
consistent for it. The styling around those controls still leaks, and the
tooling under-reports it. Measured on 2026-11-10 with ad hoc scripts
(approximate; each step re-measures with its own check):

| Leak | Measurement |
| --- | --- |
| Shared buttons restyled by their caller | 156 of 568 `Button`/`IconButton` uses pass a class that sets color, font size, padding, background, radius or height (76 files) |
| `ButtonBase` drawn by hand | 25 to 30 of 127 uses are really buttons, links or cards |
| Literal type and radius values in modules | 231 literal font sizes against 305 tokenised; 182 literal radii against 119 tokenised |
| Global classes used from components | 2,227 string `className` sites in 242 files against 2,773 `styles.x` sites |
| Modules reaching into globals | 207 `:global(...)` references in 42 files |
| Dead global CSS | `css:unused` reports 12; 225 of 1,502 global classes have no literal use in production source |

`css:unused` treats any class that starts with a detected "dynamic prefix"
as used. The detected list holds about 400 prefixes, including `-`,
`session-`, `settings-`, `tool-`, `file-` and `is-`, so most classes can
never be reported. Of the 225, about 140 are plausibly built at runtime,
about 37 are generated markup (ANSI, KaTeX) and 24 are named only by tests.

Global CSS is 17,224 lines (43% of client CSS): `index.css` 11,390,
`renderers.css` 5,070, `tool-rows.css` 709, `provider-colors.css` 38,
`emulator.css` 17. About 700 lines are tokens, themes and font faces. The
line ceilings freeze the rest in place; they do not shrink it.

## Decisions

- **Little global CSS is the goal.** Three purposes stay global: tokens and
  themes, the base reset, and styles for markup the client does not author
  (markdown, syntax highlighting, ANSI, KaTeX, diff output). Everything
  else belongs to a component's module.
- **A shared control owns its look.** A class a caller passes to a shared
  control may set layout only: margin, flex and grid placement, alignment,
  width limits, position and order. A look a caller needs is a variant or
  size of the control, or the element is not that control.
- **Type sizes and radii come from tokens.** Module CSS reads
  `--font-size-*` and `--radius-*`. `inherit`, `0`, `50%` and em values
  relative to surrounding text remain allowed.
- **Every exception is counted.** Each new check ships with an allowlist of
  the violations it finds, with a reason per entry. Counts only fall, as in
  `buttons:check`.
- **Dead-class detection is exact.** A global class is used when production
  source names it as a whole token, or when it belongs to a declared
  runtime-built or generated family. Prefix guessing is removed.
- **Link-style actions get a `link` variant** of `Button`: link color, no
  chrome, underline on hover. About 12 sites already draw it by hand, and
  folding them into `ghost` would recolor them.
- **Design changes are accepted**, as in plan 182: a swap adopts the shared
  look even where the old one differed, and fallout is fixed as noticed.
- **The composer stays excluded** from control swaps until plan 182's
  composer pass. Its global rules are drained last and only by moving them
  unchanged.

## Verification for every step

- `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and `pnpm test` pass,
  warning-free.
- A step that changes rendered CSS captures `pnpm -s design:tour` before
  and after, and inspects the pairs. Moves must render identically; swaps
  may differ only where the step says so.
- Touched browser cases run under [E2E testing](../../topics/e2e-testing.md).
- [CSS architecture](../../topics/css-architecture.md) and
  [UI design](../../topics/ui-design.md) are updated in the commit that
  changes their contract, and this plan's status line with them.

## Steps

### 1 — make dead-class detection exact and delete dead rules

Replace the dynamic-prefix heuristic in `scripts/find-unused-css.ts` with a
reviewed list of runtime-built and generated class families (file, pattern,
reason), kept beside the other CSS baselines. A global class outside those
families needs a whole-token use in production source. Classes named only
by tests count as unused; the tests that pin them are rewritten to roles,
labels or data attributes, or removed under
[test value and CI cost](../development/testing.md#test-value-and-ci-cost).

Delete every rule the exact scan finds dead, lower the line ceilings with
`pnpm css:check --record`, and make an unused global class fail `pnpm lint`.

Done when `pnpm css:unused` exits 0, lint runs it, and the declared
families are the only way a class without a literal use survives.

### 2 — make shared controls own their look

Add a check (in `buttons:check` or beside it) that resolves each class
passed to `Button`, `IconButton`, `Switch`, `SegmentedControl`, `Field`
controls, `Checkbox`, `Badge`, `Banner`, `Tabs`, `Menu` items and `Dialog`
and rejects look or size declarations in its rules: color, background,
border, radius, shadow, font, padding, height and min-height. Record the
current violations in an allowlist.

Then drain the allowlist for buttons, by area:

- a class that restates the variant's look is deleted;
- a class that needs another existing variant or size changes the prop;
- a look several sites share and no variant covers becomes a variant or
  size, shown on Controls/Button. Expected: `link`; possibly an attention
  tone. Each addition is justified by its sites in the commit message;
- what remains is allowlisted with its reason.

Done when the check runs in lint and the button allowlist holds only
reviewed, reasoned entries.

### 3 — put hand-drawn `ButtonBase` buttons on shared controls

Review all `ButtonBase` uses against the 2026-11-10 grouping: about 10
small bordered buttons (`.user-prompt-action`, `.local-media-inline-toggle`,
`.file-link-button`, the 22 px triggers) become `Button`/`IconButton`;
about 12 link-style actions become the `link` variant; rows, disclosures,
thumbnails and wrappers stay. Selectable cards (`.login-mode-option`,
`.host-picker-item`, `.session-share-action`, the async-question option,
side panel rows) get one shared card style if they can agree on one;
otherwise they are listed as a follow-up here.

Extend `buttons:check` so a `ButtonBase` whose class draws both a
background and a border fails unless allowlisted, which keeps new
hand-drawn buttons out.

### 4 — require tokens for type sizes and radii

Add a CSS check that rejects literal `font-size` and `border-radius`
values in modules, with the exemptions under Decisions and an allowlist.
Map existing literals to the nearest token where the difference is at most
1 px; add a token only when several sites need a step the scale lacks
(candidates: 11 px, 16 px), shown on the Tokens page. Global stylesheets
are converted as their rules move in steps 6 and 7.

### 5 — reduce the census pages to open work

Delete census rows and pages for swept families, moving their class names
into the allowlist's `bannedClasses` first so the bans hold. Census/Buttons
keeps the composer rows and the element scan; the playground gains a page
for each new allowlist (control overrides, `ButtonBase` exceptions, literal
type and radius), so remaining exceptions are visible in one place.

### 6 — split the global stylesheets by purpose

Create `styles/tokens.css` (custom properties, themes, font faces),
`styles/base.css` (reset, document and root layout) and
`styles/generated.css` (markup the client does not author). Move matching
rules out of `index.css` and `renderers.css` unchanged, preserving cascade
order. `css:check` treats those three as the permitted globals and the
remaining files as legacy with a target of zero. `provider-colors.css`
folds into tokens; `emulator.css` into its component's module.

### 7 — drain the legacy stylesheets by owner

Using `pnpm css:inventory`, move each owner's rules into its module, one
area per commit, following the existing
[migration runbook](../../topics/css-architecture.md#migration-runbook).
Order: single-owner pages first (`MultiHostMonitorPage`, `PublicSharePage`),
then settings, source control and file viewing, session list and sidebar,
transcript blocks and tool renderers, session page chrome, and the composer
last. Coupled rules are resolved by giving the shared piece one owner
(a component, or a shared module composed by its users), not by leaving it
global.

Each area's commit records the new ceilings. An area that cannot move
safely is recorded here with its reason instead of being forced.

### 8 — ban string class names in drained owners

Once an owner has no legacy rules, lint rejects string-literal and
template `className` values in that file, apart from declared generated or
runtime-built families. When the legacy files are empty the ban covers all
of `packages/client/src`, the legacy files are deleted, and the line
ceilings give way to the three permitted globals.

## Not in scope

- Composer control swaps and redesign (plan 182, composer pass).
- Visual-regression tests in CI; captures stay on demand.
- `packages/desktop`, `site/` and mockup CSS.

## Sources consulted

- [CSS architecture](../../topics/css-architecture.md) and plans 070, 072,
  074, 076 (the closed migration campaigns and tooling).
- [UI design](../../topics/ui-design.md) and
  [plan 182](182-design-playground-and-shared-controls.md).
- `pnpm css:health`, `css:unused`, `css:inventory` and `buttons:check`
  output on 2026-11-10.

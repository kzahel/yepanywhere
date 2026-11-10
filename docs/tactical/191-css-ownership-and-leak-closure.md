# CSS ownership and leak closure

Topic: css-architecture

Status: steps 1–6 landed 2026-11-10; step 7 areas 1–2 landed.
Steps 7–8 remain open. The maintainer
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

Before step 1, `css:unused` treated any class starting with a detected
"dynamic prefix" as used. That list held about 400 prefixes, including `-`,
`session-`, `settings-`, `tool-`, `file-` and `is-`, so most classes can
never be reported. Of the 225, about 140 were plausibly built at runtime,
about 37 were generated markup (ANSI, KaTeX) and 24 were named only by tests.

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

Landed 2026-11-10. `scripts/css-runtime-families.json` declares 46
reviewed runtime/generated families with anchored patterns, source paths and
reasons. Missing emitters and patterns matching no global class fail the check.
Production client whole tokens and production-reachable module interop count;
tests and server/shared literals do not. Prefixes are no longer liveness
exemptions, and interpolation fragments are not whole tokens.

Repository-wide searches (including server, shared, site and E2E) verified the
48 unused class names before deletion. Removed 96 selector-list branches,
keeping live siblings; the dead branches also held the only `.archived`
selector, so the global vocabulary dropped from 1,502 to 1,453 (49 names).
Deleted 572 lines: `index.css` 11,390 → 10,871, `renderers.css` 5,070 → 5,051,
`tool-rows.css` 709 → 675. Global CSS is now 16,652 lines. Removed eight
custom-property reads whose only definitions were in dead rules, preserving
their existing fallbacks. `pnpm css:check --record` lowered all three ceilings.

Lint runs `css:unused`, covering both exact global usage and module contracts.
The CSS health dead-code row uses the same exact analysis. Parser-based
`--remove`/`--dry-run` prune all global occurrences and only dead selector-list
branches; writes recheck remaining debt, JSON honors both modes, and nested
selector logic is left for deliberate review. No uncertain deletions were made.

Removed two redundant negative `.source-control-action-row` assertions;
surviving role/tab and data-placement assertions cover that header behavior.
Tooling regression coverage checks test-only and non-client evidence, declared
families and stale entries, interpolation boundaries, and mixed-selector pruning.

Verification: `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and the
final `pnpm test` all exit 0 (7,333 client and 7,256 server cases pass;
94 server cases skip). The 91 focused CSS-tooling/Git Status cases pass without
warnings. `css:unused` reports 0/1,453 unused globals and 0 module issues;
`css:health`, `css:touched`, `css:check --record`, `buttons:check --record`
and `console:scan` were also run. A disposable CLI integration check verified
JSON dry-run immutability, duplicate-class removal across files and the final
rescan exit code.

Warning-free full-suite acceptance remains unmet: five unowned jsdom navigation
diagnostics recur ([existing gap](../../gaps/client-unit-navigation-diagnostics.md)),
as do the negative-fixture server warnings tracked in
[full-suite diagnostics](../../gaps/full-suite-timing-and-diagnostics.md).
Lint has zero warnings and one existing informational regex-escape diagnostic
in `design-buttons-check.ts:492`. One intermediate full run exposed an unchanged
[Commit Browser fixture race](../../gaps/commit-browser-reclick-hunk-navigation-intermittent.md);
the isolated file and final full rerun pass. These independent fixture repairs
were deferred, with no log suppression or unrelated implementation edits.

Both final screen tours pass 34 screens / 196 captures apiece. Pixel comparison
finds 160 identical pairs; inspected differences are fixture paths, ports,
timestamps, browser registration and About's dirty-checkout metadata. No
CSS-caused visual change was found. Originals are under
`.artifacts/design-tour/{before,after}/`; the artifact-capture facility presents
`.artifacts/design-tour/191-comparison/index.html` with the complete comparison.

### 2 — make shared controls own their look

Landed 2026-11-10. `controls:check` runs in lint; parser-backed class,
helper/prop, ancestor, custom-property and inline-style findings fail closed.
Final census: 21/600 button sites in 12 files; 29 other sites in 24 files.
Census/Control overrides shows counts/reasons; `--record` only lowers them.
Shared inline `link`, copy `success-outline`, newer-content/Force-start
`attention-outline`, 36/44 px `large`, pressed cues and elevation own repeated looks.
Copy hover/Tab/post-copy works; activation no longer toggles the tool row.
Deferred: gallery/device shape, quote/overlay placement, countdown/watch states,
multiline bulk actions, queued raw-copy feedback, disabled-account cues; Badge branding,
field adornments/touch rows, tabs and choice content need their later passes.
Composer unchanged (`composer pass`). Server sign-in accepts 44→32 px mouse
minimum; coarse pointers keep 44. Global CSS now 16,629 lines (23 removed).

### 3 — put hand-drawn `ButtonBase` buttons on shared controls

Landed with review corrections 2026-11-10. All 132 original
sites reviewed; 65 moved, including 15 on shared SelectableCard surfaces.
Navigation uses distinct aria-current cues; hover is fine-pointer-only.
Shared text flow, mono/inline sizes, opaque elevation and explicit touch sizing
preserve truncation, prose density, reveal and 26/36 px prompt packing.
The strengthened gate catches filled chips, shadow rings and inherited-color
links; transparent borders are unpainted. Initial expanded census: 28 exceptions
in 23 files among 67 remaining sites; recording only lowers counts.
Caller overrides: 18 button sites/9 files; 28 other sites/23 files.
Global CSS: 16,355 lines. Server-generated media retains its original styling.
Deferred: measured rich transcript/image/tree rows, countdown/controller states
and composer handle, with specific playground reasons.

### 4 — require tokens for type sizes and radii

Landed 2026-11-10. `tokens:check` runs in lint, parses CSS
shorthands/corners and TSX literal style values; counted reasons only ratchet down.
Before: modules 231 type / 180 radius; inline 22 type / 15 radius findings.
After: 57 type / 28 radius exceptions in 33 files (85 total; 448 → 85).
Type scale at 100%: xs 10, caption 11, sm 12, base 13, lg 14, xl 16, 2xl 18px;
all follow the font preference (default 115%, measured root 18.4px).
Radius scale: xs 3, sm 4, md 6, lg 8, full 999px; Tokens shows every step.
Exact/near values adopt tokens; defined-token fallbacks lose unreachable literals.
Deferred: stylesheet-independent boot/crash fallbacks, composer (`composer pass`),
configured output/source/tooltip sizes,
optically sized glyphs, uncommon headings/sheet corners and the 17.25px plan
heading; no suitable token within 1px. Global literals wait for steps 6–7.

### 5 — reduce the census pages to open work

Landed 2026-11-10. Census shrank from 457 rows / 8 pages
to 319 rows / 6 pages (each state counted once, without theme copies).
Swept-family samples, the 1,747-line mapping and the directory inventory are
removed; the enforcement scanner now reports only raw buttons and button roles.
All 150 permanent class bans survive independently of census rows; focused
regressions cover removed-row bans and shared-link classification.
Composer has 112 class/element rows. Exceptions share element, location/count,
reason and closure fields: 32 control-override, 23 ButtonBase, 73 element/rule,
33 token-literal and 46 runtime-family rows, directly from the owning lists.
Controls/Patterns are the standard; Census is the remaining exceptions.
Deferred: composer swaps (plan 182), global ownership (steps 6–8), and intentional
generated-markup/specialized exceptions, whose closure conditions remain visible.

### 6 — split the global stylesheets by purpose

Landed 2026-11-10; move-only, with all declarations preserved.
`tokens.css` 886 lines, `base.css` 92, `generated.css` 803; provider colors fold
into tokens and EmulatorStream's video moves to its 8-line module.
Legacy ceilings: index 10,708 → 9,829; renderers 4,922 → 4,063; tool rows 670.
Global lines: 16,355 → 16,343. Purpose checks run in lint: zero token exceptions,
18 base references / 6 entries, 135 generated contexts / 18 entries; recording
only lowers counts. Inventory/touched exclude purpose globals; health and all
style scanners include them. The playground reads tokens from their new owner.
Cascade audit: 8,395 declarations, 274,340 cross-file specificity ties; three
candidate reversals are DOM-disjoint. All 24 computed-style snapshots match.
Deferred to step 7: coupled React/generated typography groups and shared React
media/fallback-diff vocabulary, to preserve their cascade and ownership.

### 7 — drain the legacy stylesheets by owner

Landing by area, composer unchanged and last (2026-11-10).
- Area 1 landed: monitor/share/relay setup, five login pages and logo; shared
  login/list/pulse owners. Remaining index/renderers/tool rows: 8,929/4,063/670.
- Area 2 landed: settings rows/search, categories, page content, toolbar previews,
  device/command reuse and onboarding. Remaining: 7,058/4,062/670 (11,790).
  Tokens: 97 exceptions / 41 files; runtime families: 40; unused globals: zero.
- Deferred: shared page shell to navigation; Model's 17 inline-modifier lines to
  ThinkingControls/RecapAfterSecondsControl in the composer pass; transcript
  samples/share interop and the tool-row global pulse to their transcript owner.
  The login recovery-hint [defect](../../gaps/login-recovery-hint-unstyled.md) stays unchanged.
- Next: source viewing/review, collections/navigation, shared shell/modals,
  transcript, session chrome, composer; one commit per area.

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

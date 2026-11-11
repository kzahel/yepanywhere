# CSS ownership and leak closure

Topic: css-architecture

Status: landed 2026-11-10–11. Steps 1–7 and their review repairs landed;
step 8 closes the campaign. This plan is retained as the implementation record.
[CSS architecture](../../topics/css-architecture.md) owns the ongoing contract.

## Outcome

React-authored markup uses co-located CSS Modules. Exactly three authored
purpose globals remain: tokens/themes/fonts, document defaults/state, and
emitted HTML. Shared controls own their look; caller classes supply layout.
Type sizes and radii use tokens, with specific counted reasons for exceptions.

Before this campaign, globals were 17,224 lines, prefix guessing hid dead
classes, and shared controls accepted unreviewed appearance overrides. The
composer's ownership move preserves its controls; plan 182 owns their swaps.
Moves preserve appearance, specificity, responsive behavior and interaction;
shared-control swaps deliberately adopt the shared look. Every new check runs
in lint with a reasoned allowlist whose counts only fall; `--record` never raises.

## Final summary

Counts describe each step's landed result; the last row is the current census.

| Step | What landed | Counts |
| --- | --- | --- |
| 1 | Exact whole-token/family liveness and parser-based dead-branch removal. Tests/server/shared literals and guessed prefixes no longer keep globals alive. | 49 global class names / 572 lines removed; 1,453 global names and 16,652 lines remained. |
| 2 | Shared-control caller look/size gate; shared link, feedback/attention, elevation and large variants. | Initial exceptions: 21 button sites / 12 files and 29 other sites / 24 files. |
| 3 | ButtonBase surface gate and selectable cards; navigation, reveal and touch geometry qualified. | 132 original sites reviewed; 65 moved, including 15 cards; 28 reasoned exceptions / 23 files remained. |
| 4 | Module/inline type and radius token checks and complete shared scales. | 448 initial findings → 85 exceptions / 33 files before the remaining global rules moved. |
| 5 | Census shows open composer work and counted exceptions; retired-class bans survive independently. | 457 rows / 8 pages → 319 rows / 6 pages; 150 permanent class bans retained. |
| 6 | Ordered purpose globals; provider tokens and emulator ownership; parser-backed purpose gate. | Tokens/base/generated: 886/92/803 lines; 153 initial counted purpose references; no token exceptions. |
| 7 | Pages, settings, source browsers, collections/navigation, modal/session shells, transcript/tools and composer drained by owner; review repairs restore hooks, copy behavior, typography and explicit cascade winners. | Legacy index/renderers/tool rows: 0/0/0. Before final review: 192 token exceptions / 85 files and 13 generated families. |
| 8 | Legacy files, ceilings and migration-only tooling removed; production class-string/selector ban, purpose re-audit and final contracts. Review repair adds the emitted-attribute gate and accurate composer census. | Globals 888/98/1,106 lines (2,092 total); 85 global names / 13 families; purpose 0 token, 0 base, 145 generated; class-string exceptions 6 / 3 files; hook exceptions/families 0/0; control overrides 18 button + 28 other; ButtonBase 28; tokens 149 type + 32 radius = 181 / 83 files. |

### Step 7 review closure

Landed: Follow placement, plain-line highlight specificity, chevron/slash/effort
markers and placeholder ownership, Settings row margins and explicit flex winner.
`css:hooks` checks data/custom-ARIA selectors against production emitters and
values; zero exceptions or attribute families remain. Existing browser cases
cover delayed new-session bootstrap and session-title access; focused real-browser
checks qualify the repaired computed styles at desktop and phone widths.
Vacuous moved-class assertions and stale performance selectors are repaired.
Composer census now lists raw controls and counted overrides/literals; 9 token
findings clear through exact token/circle substitutions, leaving 183 exceptions.
Specific reasons replace “composer pass,” including native summary semantics and
root-font-dependent 0.5rem corners. Composer control swaps remain with plan 182.

### Step 8 record

Landed: lint follows class values through helpers/maps, JSX, HTML builders and
DOM operations/selectors; six exceptions recognize external KaTeX/Pandoc markup.
React media groups and fallback diff prefixes are modular; document state uses
data attributes. All 13 retained generated families still match global rules.
Purpose findings fall 158 → 145; token/control/ButtonBase counts are in the table.
Removed legacy files/imports/fixtures/baselines, ceilings, ownership inventory,
touched-owner logic and obsolete health rows; health retains useful current facts.
Pre-plan `a5e7eb7ab` passes the header case; width probes bisect 50.46875px at
`25a4ac709` → 49.375px at `e888b3ee9`. Fixed effort sizing restores the budget.
Architecture/design/development/roadmap contracts describe the end state.
Deferred: the bounded follow-ups below; no composer control swap was folded in.

## Verification

Every step requires root lint, non-writing formatting, typechecking and unit
tests, focused browser interaction checks, and inspected desktop/phone tours.
Final qualification also includes production client and extension builds,
changed playground pages, and sequential input acknowledgement under 100 ms.
Captures remain on demand; visual regression CI is outside this campaign.
Existing suite diagnostics remain tracked in
[client navigation diagnostics](../../gaps/client-unit-navigation-diagnostics.md)
and [full-suite diagnostics](../../gaps/full-suite-timing-and-diagnostics.md).

## Follow-ups

- Plan 182's composer control swaps: raw controls, specialized action geometry,
  and composer look overrides; CSS ownership itself is complete.
- The 28 non-button control overrides, 18 button overrides and 28 specialized
  ButtonBase surfaces retain per-entry reasons and closure conditions in Census.
- The 181 semantic typography, optical/geometry and fallback exceptions need
  appropriate shared tokens/APIs or stronger alias recognition, not blind scaling.
- The 145 generated-purpose exceptions are references to React/document data
  contexts that scope emitted Markdown/ANSI/math and Shiki/diff descendants,
  including prose rhythm, source typography, gutters and inline-paint resets.
  Close them by giving those producers scoped generated surfaces and local
  mode boundaries that preserve the same appearance without React/document
  ancestor hooks; external KaTeX/Pandoc recognition separately keeps six
  class-string exceptions.
- Existing native select popup/prose-font, [transcript-follow flake](../../gaps/session-header-responsive-follow-flake.md)
  and browser/fixture diagnostics remain separate work; native-device instrumentation and
  Linux/Windows execution were not performed by this CSS campaign.

## Scope and references

`packages/desktop`, `site/` and throwaway mockup CSS remain outside the drain.
The historical ownership/tooling evidence lives in plans 070, 072, 074 and 076.
[Plan 182](182-design-playground-and-shared-controls.md) and
[UI design](../../topics/ui-design.md) own shared-control adoption;
[UI testing](../../topics/ui-testing.md) and
[E2E testing](../../topics/e2e-testing.md) own browser qualification.

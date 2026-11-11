# Client CSS Architecture

> Component-owned client styles live in co-located CSS Modules. Global CSS is
> limited to tokens, the base reset and styles for markup the client does not
> author; the three legacy global stylesheets are empty.

Topic: css-architecture

## Status: ownership drained; string-class ban remains

Direction changed by the maintainer on 2026-11-10.
[Plan 191](../docs/tactical/191-css-ownership-and-leak-closure.md) sequences
the work and records what has landed; until a step lands, the contract below
describes the checks that run today.

YA's authored client CSS grew into globally loaded stylesheets of more than
31,000 lines. Earlier campaigns (plans 070, 074, 076) moved component styles
into modules and froze the rest at line ceilings, then stopped at a
"contained steady state". That left 17,224 global lines (43% of client CSS) and
shared controls whose look any caller can override. Step 1 of plan 191
replaced prefix guessing with exact dead-class detection and removed 572
global lines (49 class names). Step 2 adds the caller-control ownership gate
and moves repeated button looks and sizes into the shared family. Step 3
checks hand-drawn ButtonBase surfaces and shares selectable action cards. Step 4
enforces token-owned type sizes and radii in modules and production TSX.
Step 5 removes swept-family census pages: Controls/Patterns show the standard,
and Census shows only remaining composer work and reasoned exceptions.
Retired class bans live independently of the playground's rows in
`design/census/button-allowlist.json`; deleting a row or restoring CSS cannot
lift a ban. Before removing a rule-less row, preserve all its retired class
names in `bannedClasses`. Recording exception counts never removes those bans.

Step 6 separates the three continuing global purposes from the remaining
React-owned legacy rules. Step 7 drains those rules to their owners;
`purposeGlobals.ts` imports the three continuing globals. No rendered styles change.
Step 7 has landed single-owner pages: login layout, session-list layout and
connection pulse reuse have one shared module each; logo sizes are owned
variants. Public-share transcript reach-ins use stable data boundaries beneath local
anchors. Tool rows own their pulse animation and its final keyframe definition
so the ownership change preserves animation behavior.
Settings rows and search visibility share `SettingsRows.module.css`; categories,
previews, device lists, command samples and onboarding have explicit owners.
Cross-owner row/preview selectors use the child’s stable data boundaries
(`data-settings-item`, `data-settings-info`, `data-settings-origin`,
`data-thinking-section`, `data-range-number`, `data-toolbar-control-preview`)
under a local class anchor. These attributes preserve class specificity and
DOM relationships; they do not authorize unscoped global styling.
Source browsers share column, row, search, detail and preview modules; standalone
file pages share their page chrome. Resize/focus/selection queries use stable
`data-source-*` boundaries, and the source header uses `data-project-selector*`
boundaries under its local identity class. Diff context controls have one shared
module for source previews and EditRenderer. Local preview anchors retain the
mixed generated/React `line-hunk` vocabulary through a class-token attribute
selector. FileViewer and shared CodeOutput/DiffOutput modules own React source wrappers,
fallback diff rows and gutters alongside Read/Write/Edit output. Emitted Markdown,
math and Shiki descendants stay in generated.css under counted data boundaries;
review and blame grids retain their existing module owners.
Collections and navigation now share PageLayout, MainContent and
CollectionLayout modules; Sidebar, SidebarNavItem, SessionListItem and the route
linger host own their states and geometry. The /btw badge and title treatment
has one shared module. DOM consumers use data boundaries for scroll containers,
route layers/active state, sidebar collapse and session rows; selector constants
need the same migration audit as inline queries.
Modal owns its frame in `ui/Modal.module.css`, including the custom file viewer.
Consumers use `data-modal-*` frame/header/content boundaries under local anchors;
the modal reach-in check recognizes these aliases and retains its counted debt.
Model option sections have one shared owner across model switch and restart;
share management, schema warnings and recording badges own their own modules.
Transcript items, user/setup/thinking blocks, tool rows and renderer families now
own their layout and states. Shared source typography, output status, paths and
task presentation have one module each; DOM consumers and fixtures use stable
data hooks. Native data markers must survive wrapper components and finite
status maps; removing a styling class never removes an existing DOM contract.
Session and generic page headers share one header module; navigation owns the
viewport frame, while session split/messages and footer chrome own their geometry.
The /btw pane, connection/status indicators, overscroll hint and warning content
have local owners. Cross-owner header, transcript, split and footer relationships
use stable `data-session-*` boundaries with the previous selector specificity.
Conditional split boundaries are present only while their corresponding layout
state is active. Document selection shielding targets those boundaries; its
`session-transcript-selection-active` state remains document-owned.

The composer is now module-owned too: input/toolbar/new-session, speech, thinking,
mode, recall, attachments and context controls retain their existing appearance.
Shared action and option-dot modules own reused looks. Finite state maps reference
module exports explicitly; measurement and tests use stable data boundaries.
No composer control swaps belong to this move (plan 182 owns that pass).

The target:

- **Three global purposes.** Tokens and themes, the base reset, and styles
  for markup the client does not author (markdown, syntax highlighting, ANSI,
  KaTeX, diff output). Everything else belongs to a component's module, and
  the legacy files are deleted when empty.
- **A shared control owns its look.** A class passed to a shared control
  sets layout only; a needed look is a variant or size
  ([UI design](ui-design.md#shared-controls-and-the-design-playground)).
- **Type sizes and radii come from tokens** in module CSS.
- **Dead global classes fail lint**, judged by whole-token use or a declared
  runtime-built or generated family, not by prefix.
- **Every exception is counted** in an allowlist with a reason; counts only
  fall.

The legacy files are empty and their ceilings are zero. Step 8 removes the
files and introduces the string-class ban; new component CSS remains modular.

## Migration tracking

[`docs/tactical/070-css-modules-migration.md`](../docs/tactical/070-css-modules-migration.md)
is the closed first campaign record. [Plan 191](../docs/tactical/191-css-ownership-and-leak-closure.md)
is the open plan and owns the order of work. This topic is the binding
architecture, candidate-selection protocol, and reusable runbook.

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
- The only continuing authored global stylesheets are under
  `packages/client/src/styles/`: `tokens.css`, `base.css` and `generated.css`.
  Their parser-backed purpose check runs in `pnpm css:check` and `pnpm lint`.
  `tokens.css` permits custom-property declarations on root/theme selectors,
  `@font-face` and `@property` descriptors, with media/supports wrappers.
  Theme `color-scheme` belongs in `base.css`, not in the token declarations.
- `base.css` owns resets, element defaults, document layout/state, scrollbars,
  selection/highlights and focus defaults. Component scrollbars/focus treatments
  remain with their component. Its class selectors are limited to the documented
  source-pane drag state (`source-pane-resizing`) and transcript selection shield
  (`session-transcript-selection-active`), including their existing session-page,
  header, input and reload-banner targets. Each class reference is counted in
  `globalPurposeExceptions` in `scripts/css-architecture-baseline.json`.
- `generated.css` owns styles targeting HTML the client does not author as React
  elements: server markdown, Shiki, ANSI, KaTeX, unicode math, server edit/diff
  augments, markdown-preview line boundaries, path linkifiers and local media.
  The fixed-font renderer's inserted HTML strings also belong here. Generated
  class families carry `generated: true` in `scripts/css-runtime-families.json`;
  a runtime-built React class is not a generated family. Shared vocabulary
  listed in a family's `reactAuthored` field needs a purely generated class
  ancestor/subject in the selector (for example a Shiki line's diff prefix).
  Negated or relational arguments do not establish that ancestry. React
  ancestor/context references are counted exceptions with reasons in `globalPurposeExceptions`.
  Data attributes on ancestor compounds are counted too; emitted subject metadata
  is not a React context. Tag/universal subjects and tag-only `:is()` descendants
  may live beneath these boundaries, but a bare React data root (including a
  tag-qualified root) still incurs authored-subject debt.
  A React shell cannot become the styled subject merely by being a context.
  Current counted contexts live in the baseline, with a lasting reason per entry;
  tokens has zero exceptions.
- Shared generated/React media roots retain counted generated-owner exceptions
  and explicit closure conditions. FileViewer owns range markers and fallback
  pre/code resets in its module; emitted Shiki inline-paint resets stay global.
  React wrapper geometry stays modular. Shiki's inline-style resets
  retain `!important` only in generated.css; fallback React gutter tints use
  stronger local selectors so review/hover tint cannot reorder their winner.
  Coupled typography moves preserve specificity and the final legacy values.
  `EmulatorStream.module.css` owns its video.
- `index.css`, `renderers.css` and `tool-rows.css` are empty, with zero-line
  ceilings in `scripts/css-architecture-baseline.json`; step 8 deletes them.
  Feature work never raises these ceilings. New component styles use modules.
  `provider-colors.css` is folded into `tokens.css`; `emulator.css` is removed.
- `purposeGlobals.ts` is the common import entry, in this order: third-party
  KaTeX, tokens, generated content, base. Main/remote (including public share),
  extension side panel, playground, mockups and browser fixtures share it.
  Module CSS is imported by its owner; an empty legacy file supplies no styles.
- A new non-module stylesheet fails `pnpm css:check`; the three purpose globals
  are fixed, not an extensible substitute for component ownership. When legacy
  lines or purpose findings fall, run `pnpm css:check --record` in the same
  change. It only lowers/removes entries, refuses all unreviewed growth before
  writing, and keeps the reasons. Stale purpose counts fail ordinary checking.
- Moving a rule between purposes must preserve declarations, selector
  specificity and the order of competing rules in every entry. Compare the
  flattened cascade before/after with a disposable parser script, investigate
  equal-specificity reversals, and inspect the screen-tour pairs. CSS layers or
  specificity changes are not move-only fixes for an ordering conflict.
- A `var(--name)` read of a custom property that no production client source
  defines fails `pnpm css:check`. Such a read silently takes its fallback, or
  drops its declaration when it has none. The undefined-token pass of
  2026-11-09 emptied `undefinedCustomProperties` in
  `scripts/css-architecture-baseline.json` (62 names and 291 reads when first
  recorded on 2026-11-08), so every undefined read now fails. A definition is
  a CSS declaration or `@property`, or a TypeScript style key, `setProperty`
  call (with the name inline or in a `const` in the same file) or `--name:`
  string; the scan covers CSS and TypeScript under `packages/client/src`,
  excluding tests, and the design playground's reads under
  `packages/client/design` (which its own definitions may satisfy, but
  production reads may not). Read a theme token, define the property, or set it where
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
- `pnpm lint` runs `pnpm css:unused` before Biome, including the module
  contracts also available alone as `pnpm css:modules:check`. The module check is a
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
  `[data-modal-frame]:has(.localContent)` is valid because `.localContent` makes
  ownership and scope explicit.
- CSS analysis compares selector-parser-decoded class values with complete
  whitespace-delimited class tokens from source. Selector-shaped strings are
  parser-decoded, and generated-markup class attributes are tokenized as class
  lists. Escaped punctuation, Unicode, leading digits, and single-character
  classes retain one canonical identity; source tokenization must not split one
  runtime class into ASCII word fragments.
- `pnpm lint` runs `pnpm buttons:check`, the ban for the button, switch,
  segmented-control, menu, popover, field, banner, badge, spinner, tab and
  dialog families
  ([UI design](ui-design.md#shared-controls-and-the-design-playground)). It
  rejects a retired legacy class recorded permanently in
  `design/census/button-allowlist.json`'s `bannedClasses`, a raw `<button>`
  outside `ui/Button.tsx` and the shared controls (composer files exempt), a
  `role="switch"`, `"radio"` or `"radiogroup"` outside `ui/Switch.tsx` and
  `ui/SegmentedControl.tsx`, a menu role outside `ui/Menu.tsx`, a
  `mousedown`/`pointerdown`/`touchstart`/`click`/`focusin` listener on the
  document, its body or the window (hand-rolled outside dismissal) outside
  `ui/Popover.tsx`,
  a new `role="button"`
  element, and a CSS rule, in a module or a global
  stylesheet, whose selector reaches a bare `button` element (`.panel
  button`, `button:hover`) and sets look or size properties. Such a rule
  outranks `ButtonBase`'s zero-specificity reset and ties with `Button`'s
  variants. For fields it rejects a raw `<input>` (text types, number,
  checkbox, radio), `<select>` or `<textarea>` outside `ui/Field.tsx`,
  `ui/Checkbox.tsx` and `ui/Switch.tsx`, and a rule whose selector styles a
  bare `input`, `select` or `textarea` (its last compound, so
  `.row:has(input:checked)` does not count; range, file and color inputs
  are not fields) with look or size properties. It also rejects a tab role
  outside `ui/Tabs.tsx` and a `@keyframes` set that rotates outside
  `ui/Spinner.module.css`; a native `window.confirm`, `alert` or `prompt`
  call outside `ui/ConfirmDialog.tsx`; an `aria-modal` attribute or
  `alertdialog` role outside `ui/Modal.tsx`, `ui/Dialog.tsx` and
  `ui/ConfirmDialog.tsx`; and a rule that reaches into Modal's frame (a
  CSS Module's `:global(.modal…)` outside `components/ui`, or a global
  `.modal…:has(…)` rule), which sized dialogs per feature before `Dialog`
  had a `size`. Exceptions sit in
  `packages/client/design/census/button-allowlist.json` with a count and a
  reason; counts only fall, and `--record` lowers them.
- A global class needs a complete class token in production client source
  (`packages/client/src`, excluding tests), a global reference from a
  production-reachable CSS Module, or a reviewed entry in
  `scripts/css-runtime-families.json`. Tests, E2E fixtures, package scripts,
  design specimens and server/shared source strings do not establish production
  client use. Generated server/shared markup belongs in the declared families.
- Each family names an anchored regular expression, its repository-relative
  constructor/emitter source path, and a reason. Review the emitter before
  declaring a family. A missing source, empty reason, invalid pattern, or pattern
  matching no authored global class fails the check. Keep families finite and
  narrow; inferred template prefixes never establish global liveness.
- Parser-backed tokenization preserves decoded CSS identities and complete
  class-list tokens. Interpolation fragments do not become whole tokens;
  even a base class joined directly to an optional state class needs a declared
  family when its complete token is not present elsewhere.
- `pnpm css:unused` is the blocking global-and-module report run by lint.
  `--dry-run` previews global selector-branch removals and leaves the exit code
  failing while debt remains. `--remove` prunes every occurrence across global
  stylesheets, preserves live siblings in selector lists, and checks the result
  again; skipped nested selectors or module contract issues still fail. A class
  nested in negation or alternation is left for deliberate review. CSS Modules
  are never rewritten. JSON output supports the same preview/write modes.
  Custom `--src-dir` trees exclude test sources too; a `packages` root admits
  only its `client/src` subtree as literal global evidence. Custom CSS trees
  omit the repository family list (the analysis API can supply explicit families).

## Emitted attribute hooks

`pnpm css:hooks` runs in lint. Every data-attribute selector in a client CSS
Module, base.css or generated.css must have a production emitter; custom ARIA
selector values follow the same rule. JSX/spread attributes, dataset writes,
setAttribute/toggleAttribute and generated HTML count; selector strings, reads,
tests and comments do not. Static selector values must match emitted values;
dynamic values remain producer-owned. Generated/runtime attributes can be
explicitly declared with anchored patterns, source and reason. The attribute
family list and counted, reasoned exception list live in `scripts/css-attribute-*`;
ordinary checks reject stale counts and `--record` only lowers/removes entries.
The current scan needs zero exceptions and zero declared attribute families.

## Shared control caller classes

`pnpm controls:check` runs in lint alongside `buttons:check`. For every
production use of Button, IconButton, `buttonClassName()`, Switch,
SegmentedControl, Field/TextInput/Textarea/Select, Checkbox/Radio, Badge,
Banner, Tabs, MenuItem/MenuLinkItem and Dialog, it resolves caller classes
through their CSS Module import or the global stylesheets. Import aliases,
local variables, finite computed keys, templates, conditionals, class combiners,
object spreads and obvious forwarded props count. Dedicated `inputClassName`
and `bodyClassName` props have the same contract.

A caller class may set layout, placement, width limits, truncation and
visibility. It may not declare color, background, border (including radius),
shadow, outline, font, line height, letter spacing, text transformation or
decoration, padding, height limits, scale/rotate transforms, filters, text shadows, SVG fill/stroke
or fractional opacity. Binary `opacity: 0|1`, pointer events and visibility are
reveal behaviour and remain allowed. Translate-only transforms (including
multiple translate functions and calc/var arguments) are layout; mixed
translate/scale or rotate transforms remain look overrides. Custom properties read with `var(--x)`
by the control's own module count as look overrides; the checker derives those
reads rather than maintaining a separate property list. Inline styles follow
the same ownership contract. All matching selector branches,
media queries, nested rules, states, pseudo-elements and descendant styling
count. Negated/relational arguments and unrelated siblings do not assert the
class on the control; an anchor-only rule cannot style a Button. A control's
own implementation owns its variants. Descendant rules aimed at caller-supplied
icons or labels are exempt; rules reaching control-owned children still count.
Same-component ancestor rules aimed at the control count too. Local helper
returns, memo callbacks and named memo/forwardRef prop wrappers are resolved;
an unresolved class expression is a counted finding, never silently accepted.

Reviewed exceptions live in
`packages/client/design/census/control-override-allowlist.json`, split into
button-family and other-control counts by production source file, with a
specific reason per entry. Composer entries use the reason `composer pass`.
A new file, increased count, invalid reason or stale count fails. `--record`
only lowers counts and removes cleared entries; it refuses to write if any
increase is unreviewed. `--json` reports classes, selectors and source lines.
Census/Control overrides shows the same remaining entries and reasons. The
step 3 census is 18 button sites in 9 files and 28 other
control sites in 23 files, including provider/status Badge custom properties.

## ButtonBase surfaces

`ButtonBase` remains the reset for rich rows, disclosure previews, thumbnails
and specialized targets. Ordinary small buttons and chips use Button/IconButton;
link-colored text actions use `Button variant="link"`. Rich whole-card actions
use `SelectableCard`, whose caller classes follow the same layout-only contract.
The card owns padding, border, fill, radius, hover, focus and disabled states;
`selected` supplies pressed state; navigation uses `aria-current`. Hover is
neutral, fine-pointer-only and distinct from the current/selected tint. Compact
rows are 36/44 px, quiet cards de-emphasize secondary choices, and accent cards
retain the queue leading border. Disabled busy cards do not dim their spinner.

`buttons:check` also resolves every production ButtonBase's module/global
classes, forwarded props, inline styles, states, media queries and actual JSX
ancestors using the shared control-ownership analyzer. Background plus painted
border, a box-shadow border ring, a filled rounded padded chip, or link/accent
color or underlined inherited-color text without other chrome requires an
exception; unresolved
classes/styles fail closed. Child content and unrelated siblings do not draw
the target. Local CSS variables are followed; transparent/none backgrounds and
reset borders (including transparent shorthand colors) do not constitute a
painted surface. The shared selectable-card
implementation owns its surface and is excluded from application exceptions.

`design/census/button-base-allowlist.json` records remaining counts by source
file with a specific reason. New/increased, invalid and stale entries fail lint;
`buttons:check --record` only lowers/removes entries and refuses to write on
unreviewed increases. Census/ButtonBase exceptions lists the same counts and
reasons. The strengthened step 3 gate records 28 exceptions in 23 files among
67 application sites; its newly detected categories received specific initial
reasons, and subsequent recording only lowers counts. Generated server media markup keeps its global styles when the
React-authored toggle moves to a shared control.

## Type sizes and radii

`pnpm tokens:check` runs in lint. In CSS Modules under `packages/client/src`,
`font-size`, the size in `font` shorthand, `border-radius` and physical/logical
corner longhands read `--font-size-*` or `--radius-*`. Production TSX style
objects follow the same rule, including named objects, numeric values and
conditional literal branches. Tests and playground specimens are excluded.
The check parses CSS and TypeScript; comments, font weights, line heights and
font-family strings are not size declarations.

`inherit`, `initial`, `unset` and zero are allowed. Font sizes may use `em` or
`%` relative to surrounding text. `calc`, `clamp`, `min` and `max` may combine
tokens and unitless factors (and relative font sizes); absolute lengths hidden
in math or `var()` fallbacks still need an exception. Ordinary circles and pills
use `--radius-full`. A necessary 50%/100% circle/pill radius whose responsive or very large
geometry cannot use that token carries a `radius-percent: <reason>` comment in
its rule (beside a TSX style literal for inline styles).

`design/census/token-literal-allowlist.json` counts findings per file with a
specific reason. New/increased counts, missing reasons and stale entries fail;
`--record` only lowers/removes entries and refuses to write on any increase.
`--json` reports file, line, property and value. The step 4 census falls from
231 type / 180 radius module findings plus 22 type / 15 radius inline findings
to 57 type / 28 radius exceptions in 33 files. Those include semantic output
and source-font reads that must preserve user typography preferences. Boot/crash
fallbacks keep literal sizes and radii so they render without CSS or a theme. Composer
files retain the reason `composer pass`. After the ownership moves, the census
records 151 type / 41 radius exceptions in 85 files; rem-based geometry and
configured typography keep their existing behavior. The type and radius scales live in
[UI design](ui-design.md#shared-controls-and-the-design-playground).

## Command roles and exit behavior

| Command | Role | Exit/write contract |
|---|---|---|
| `pnpm css:check` | Hard global purpose/legacy containment gate | Exits 1 for purpose violations beyond counted reasons, stale purpose counts, legacy growth (target zero), an unreviewed global file, a stale/invalid baseline entry, or newly undefined properties/reads. `--record` only lowers ceilings and exceptions, refusing unreviewed growth before writing. |
| `pnpm buttons:check` | Hard button, switch, segmented-control, menu, popover, field, banner, badge, spinner, tab and dialog ban | Exits 1 for a banned legacy button, switch, option, field, status or dialog class, a raw `<button>`, a `role="button"` element, a `button` look rule, a switch/radio role, a menu role, a document/window pointer listener, a raw field element, a field look rule, a tab role, a rotating keyframe set, a native confirm/alert/prompt, an `aria-modal` or `alertdialog` outside the shared dialogs or a rule reaching into Modal's frame beyond the allowlist, a hand-drawn ButtonBase surface without a counted reason, or an allowlist count above the scan. `--record` only lowers allowlist counts, drops entries at zero and preserves permanent class bans. |
| `pnpm controls:check` | Hard shared-control caller-class ownership gate | Exits 1 for look/size overrides beyond the per-file reasoned allowlist, invalid entries, or stale counts. `--record` only lowers counts/removes cleared entries and refuses unreviewed increases. |
| `pnpm tokens:check` | Hard module/TSX type and radius token gate | Exits 1 for unreviewed literal values, invalid entries or stale counts. `--record` only lowers/removes exceptions and refuses increases. |
| `pnpm css:modules:check` | Hard module usage/global-interop gate | Exits 1 for any module contract issue or an unusable scan; otherwise 0. It never edits CSS. |
| `pnpm css:lint` | Hard authored-CSS lint gate | ESLint with `eslint-cssicorn` over `packages/client/src` and `site/src` CSS; exits 1 on any error or warning. It never edits CSS unless run by hand with `--fix`. |
| `pnpm lint` | Combined repository gate | Runs containment, exact global usage and module contracts, the button ban, shared-control ownership, type/radius tokens, CSS lint, and Biome; any child failure fails lint. |
| `pnpm css:touched` | Advisory feature-diff prompt | Exits 0 for opportunity, deferral, or no matching owner; exits 2 for invalid arguments or a failed git comparison. It never edits files. |
| `pnpm css:inventory` | Advisory ownership drill-down | A valid report exits 0 and never edits files; invalid arguments exit 2. |
| `pnpm css:unused` | Hard global usage and module contract gate | Exits 1 for an unused global class, invalid/stale runtime family, module contract issue, or unusable scan. `--dry-run` previews; `--remove` prunes global selector branches and rechecks, never module selectors. |
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
- A selector appears once per file and media context. The provider, ANSI and diff palettes in
  `tokens.css` deliberately repeat root/theme selectors with disjoint properties,
  retaining their original order under a documented disable comment.
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
- the existing counted React-context anchors for emitted descendants; these
  do not authorize new global composition primitives.

Generated markup does not justify placing an entire surrounding feature in a
global file. Keep the generated vocabulary global and move the React-owned
shell, controls, and layout into modules.

Use `:global(...)` inside a module only for a narrow interop boundary that the
module cannot own. The global selector should be evident beside the local
selector it affects. `HostOfflineModal.module.css`, for example, uses the
shared `[data-modal-frame]` boundary only to size the modal containing its local
content.

The module contract reports the count of reviewed global references as
context, but does not impose a numeric ceiling. A new interop reference is
acceptable when it is local, existent, and intentional; an unanchored or
missing reference is not.

## Component composition

- The component that creates an element owns its class.
- A parent that needs to place a child should prefer a wrapper or an explicit
  `className`/variant prop over reaching into the child's generated class name.
- Reusable visual primitives own a module and expose props or a module class;
  remaining shared global composition is legacy debt, not a new component API.
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

The inventory excludes the three purpose globals and parses only legacy CSS with a CSS parser and authored package source,
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

- **containment** — legacy lines per file (target zero), the three purpose
  globals, and counted purpose exceptions;
- **ownership** — owned, coupled, generated, unresolved, and low-confidence
  rules or lines;
- **module contracts** — unused or undeclared selectors, test-only usage,
  missing production importers, and analysis made unknown by computed access or
  side-effect imports;
- **escape hatches and complexity** — `:global(...)`, `!important`, duplicate
  declarations, descending specificity, and excessive selector depth;
- **dead code** — unused global classes under the whole-token/family contract;
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
when it reports ratchet problems, module issues, or unused global classes; the
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
- tests and Playwright locators, including negative assertions;
- production `querySelector`, `closest`, `matches` and `classList` calls
  naming any moved class (search the whole source, including multiline calls); and
- caller selectors that reach into the component.

Search consumers outside production React too: unit/browser fixtures, Kotlin and
Swift probes, performance scripts, mockups, site code and current documentation
examples. Inspect class tokens in helper arguments, HTML builders, selectors and
`classList`, not just `className`. Semantic hooks without CSS rules need the same
audit. Tests use positive/negative data-attribute assertions for states; a word
boundary regex cannot recognize Vite's `_local_hash_line` names reliably, and a
negative assertion can otherwise pass vacuously. Historical diagnostic prose is
reference data, not a live selector consumer.

For each area, use a disposable audit of module selectors under media/container
conditions and of elements composing classes from different modules, including
classes forwarded through component props. A conditional rule follows its
same-specificity base. Conflicting properties have an explicit winner rather
than depending on import order; shared controls own restated look properties.

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
selector ordering before attempting visual cleanup. A rem value is not equivalent
to a px-based type token across browser default fonts and UI scaling: keep the
literal with a counted, lasting reason unless equivalence holds in every case. Semantic local names no
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
`FilterDropdown` expresses recurring presentation through props: `fullWidth`,
`triggerVariant`, `panelVariant`, and the shared Button's `triggerSize`.
`triggerClassName` adds caller-specific placement. A pass-through targets one
documented element; it is not a licence to restyle the subtree.

When the reach-in runs the other way — several ancestors styling a control they
do not render, as four row lists did to the source row-menu trigger — the child
module exports an opt-in class for the ancestor to apply to itself, and owns the
relationship locally (`.rowSurface:hover > .trigger`). The ancestor declares that
it is the interaction surface; it does not decide what the reveal looks like.

Stage new modules before running root lint, or lint those exact files explicitly:
the Biome wrapper's `.` expansion includes tracked files only. New files need the
same duplicate-declaration and selector-complexity checks as existing modules.

Check cross-module ties on elements that combine owner classes. Make the
intended winner explicit through a compound selector or one shared owner; import
order is not a contract. Check production output as well as development, and
exercise hover, selected, disabled and busy combinations. A folder disclosure
and a real file row need distinct data boundaries when focus queries select
only files.

Check what a moved declaration was actually defending against before calling it
redundant. `.repo-status-bar .copy-button` restated `.copy-button`'s own values
and looked like dead weight, but a second, unrelated `.copy-button` later in
`index.css` was winning against it — `renderers.css` is `@import`ed at the top of
`index.css`, so its rules preceded the application rules. The old entry
placed legacy renderers before legacy application rules, after
tokens/generated content. A module class that replaces a descendant selector
needs the same specificity the selector had, or the outcome silently becomes
stylesheet order.

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

[data-modal-frame]:has(.content) {
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
   file; computed keys and side-effect-only imports make usage undetermined,
   unimported modules are production-unreachable, and module rules are never
   rewritten.
   Its CSS and TypeScript parsers scan authored package source, E2E, and script
   roots, including `.mjs` and `.cjs` harnesses, for module contracts and
   ownership evidence. Global liveness admits only production client whole
   tokens, production-reachable module interop, and the reviewed runtime/generated
   families. The tokenizer parser-decodes dot-led selector strings and preserves
   complete whitespace-delimited tokens and generated-markup class attributes.
   Regex selector vocabulary remains visible to ownership investigation but
   test-only references cannot keep global rules alive. Find the emitter in the
   whole repository before deleting a reported class; declare its narrow family
   if it is built at runtime or generated outside the client.
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

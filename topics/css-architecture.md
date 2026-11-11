# Client CSS Architecture

> React-authored client markup uses co-located CSS Modules. Exactly three
> authored global stylesheets remain: tokens, document defaults/state, and
> generated HTML. Shared controls own their appearance.

Topic: css-architecture

[Plan 191](../docs/tactical/191-css-ownership-and-leak-closure.md) landed
2026-11-11. It is retained as the campaign record; this topic owns the ongoing
contract. The empty legacy stylesheets, line ceilings, migration inventory and
touched-owner reports are removed.

## Contract

The only non-module CSS under `packages/client/src` is:

| File | Purpose |
| --- | --- |
| `styles/tokens.css` | Custom properties on root/theme selectors, bundled `@font-face` and `@property` descriptors; media/supports wrappers. |
| `styles/base.css` | Reset and element defaults, body layout, theme color-scheme, highlight defaults, and document drag/selection state. |
| `styles/generated.css` | Descendants emitted by Markdown, Shiki, ANSI, KaTeX, Unicode math, fixed-font HTML, server diffs, media links and Markdown preview producers. |

`styles/purposeGlobals.ts` imports third-party KaTeX, tokens, generated content,
then base, in that order. Main/remote/public share, the extension side panel,
playground, mockups and browser fixtures use this common entry. Modules are
imported by their owners; portals can use module classes anywhere in the document.

`tokens.css` contains declarations, not component looks. Theme `color-scheme`
belongs in base. Base's state attributes (`data-source-pane-resizing` and
`data-session-transcript-selection-active`) describe document-wide interaction;
the selection shield addresses stable session-header/input/reload boundaries.
Component-specific focus, scrollbars and geometry belong in modules.

Generated CSS styles emitted descendants, never the React shell that inserts
them. React media groups, fallback diff prefixes, source wrappers and gutters
have module owners. Counted React ancestor/data contexts scope emitted content;
they do not authorize styling an authored subject or introducing a new global
composition API. Shiki inline-paint resets retain their necessary `!important`.
Every generated family is declared narrowly in `scripts/css-runtime-families.json`
with an anchored pattern, real emitter source and reason. A missing emitter or
pattern matching no authored global class fails lint. Runtime prefix guessing
never establishes liveness.

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

## Class names and DOM boundaries

`pnpm css:classes` runs in lint across production TS/TSX in
`packages/client/src`. Literal/template class names are rejected in JSX class
props, class-valued objects and assignments, HTML string builders, DOM class
attributes and class-list operations. The AST scan follows constants, finite
maps, class helpers and local/imported helper parameters and returns. Module
exports (`styles.root`, static module lookups), shared-control API values,
empty separators and declared generated/runtime families remain valid.
Generated dynamic constructions must originate in their declared emitter and
match an existing family; a template prefix is not an exception.

Selector strings passed to `querySelector(All)`, `closest` or `matches` follow
the same rule. Prefer refs, roles, labels or stable data attributes. A class
with no CSS rule is deleted; retain a data hook only when code or tests need it.
The six current exceptions recognize external KaTeX clipboard and Pandoc math
markup, with per-name counts/reasons in `scripts/css-class-string-allowlist.json`.

CSS module hashes are implementation details. Each selector must have a known
production use; every module must be production reachable. `styles.foo` and
`styles["foo"]` must name declared local selectors. Computed or side-effect
module access fails rather than keeping an entire module silently live.
Tests, package scripts, E2E fixtures and specimens are separate consumers;
test-only usage never proves shipped code uses a selector.

A module's `:global(...)` or `composes ... from global` must name an existing
authored global class and have a module-local anchor in the same selector branch.
A comma sibling does not scope the reference. Cross-owner React boundaries use
supported props or narrowly scoped data attributes; `[data-modal-frame]:has(.content)`
expresses a local dialog relationship without guessing module hashes.

## Checks and exceptions

All enforcing checks run in `pnpm lint`:

| Check | Enforces |
| --- | --- |
| `css:check` | Exactly the three purpose globals; purpose rules and counted contexts; no undefined `var(--name)` reads. |
| `css:hooks` | Production emission and supported values for CSS data/custom ARIA selectors. |
| `css:classes` | No literal/template class names or class selectors beyond declared families and counted exceptions. |
| `css:unused` / `css:modules:check` | Exact global liveness and production module/interop contracts. |
| `buttons:check` | Shared-element/role bans, permanent retired-class bans and reasoned ButtonBase surfaces. |
| `controls:check` | Shared controls own look and size; caller classes supply layout. |
| `tokens:check` | Module and inline type sizes/radii use tokens. |
| `css:lint` | CSS syntax, specificity, duplication, viewport and module complexity rules. |

An allowlist entry has a positive count and specific reason. New entries or
increased counts require deliberate review; ordinary checks reject invalid and
stale counts. `--record` only lowers/removes entries after validating the entire
scan, refusing to write on any increase. Recording never removes permanent
retired-class bans. Purpose exceptions and undefined-property debt live in
`scripts/css-architecture-baseline.json`; control/token/element/ButtonBase
exceptions live in `packages/client/design/census/*-allowlist.json`.

Undefined-property scanning covers production client CSS/TS and playground
reads. A playground definition cannot satisfy a production read. CSS declarations,
`@property`, TS style keys, `setProperty` and generated property declarations
establish definitions; there are currently zero undefined-property exceptions.
Use a defined token or define the variable at its real owner.

`css:unused` compares parser-decoded whole class tokens, including escaped CSS
identities, and declared families. Tests, server/shared literals and incidental
prefixes cannot keep global rules alive. `--dry-run` previews and `--remove`
prunes dead global selector branches, preserving live siblings and rechecking;
module selectors always require deliberate edits.

`pnpm css:health` is an on-demand summary of global/module file and line totals,
module contracts, global interop and exact dead classes. It has no composite
score, saved health baseline or legacy ownership rows. A successful report exits
0 even if it describes debt; unusable input exits 2. Enforcing checks exit 1 on
violations and never write without an explicit recording/removal option.

## Adding or changing styles

Create `Owner.module.css` beside the component and import it as `styles`.
Use existing tokens and explicit finite module maps for states. Ordinary arrays
and template expressions compose module exports without a runtime dependency.
A reusable look belongs in a shared primitive or a named variant; a parent's
one-off layout belongs on its wrapper or supported `className` prop.

Keep conflicting properties on elements composing multiple modules explicit:
use one shared owner or enough local specificity to express the intended winner.
Import order is not a contract. Check base/context rules within media/container
queries and disabled, busy, hover and selected combinations in production too.
A rem size and a px-based UI token are not interchangeable across browser fonts
and user typography preferences; preserve semantic source/output sizing with a
specific counted reason when no token is equivalent. The fixed 10px
`--font-size-fixed-xs` preserves provider effort and toolbar micro-label widths;
it is separate from both the scaled UI sizes and configured output font sizes.

Before renaming/removing a DOM hook, search all consumers, including helpers,
HTML builders, native Kotlin/Swift probes, performance scripts, fixtures and
mockups. Prefer positive data/role assertions; a negative old-class assertion
can pass vacuously after hashing. Historical diagnostic prose is evidence, not
a live consumer. Scope global interop beneath a local module anchor and keep
React wrapper appearance local.

Appearance-preserving changes retain declarations, responsive behavior, state,
specificity and competing cascade order. Inspect before/after screen tours and
touched playground pages under [UI testing](ui-testing.md), run focused browser
interaction checks, and retain real sequential typing with every key acknowledged
within 100 ms under expected volume/concurrent updates. Root lint, format,
typecheck and tests remain required by [Development](../DEVELOPMENT.md).

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
specific reason per entry. Composer entries name the specific shared-control swap deferred to plan 182.
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
files name the specific geometry, semantic typography or plan 182 control swap. After the ownership moves, the census
records 149 type / 32 radius exceptions in 83 files; rem-based geometry and
configured typography keep their existing behavior. The type and radius scales live in
[UI design](ui-design.md#shared-controls-and-the-design-playground).

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
  (`no-descending-specificity`), When adding
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
  shared controls expose supported variants and sizes.
- Keep design values in existing custom properties. Moving a selector into a
  module does not require copying theme values or introducing JavaScript style
  objects.
- Runtime CSS-in-JS libraries are not part of this architecture. Vite's native CSS
  Modules provide scoping and co-location while retaining static CSS and adding
  no client runtime dependency.

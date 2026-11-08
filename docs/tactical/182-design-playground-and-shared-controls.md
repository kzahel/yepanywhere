# Design playground and shared controls

Topic: ui-design

Status: steps 1 to 3 landed 2026-11-08. The census mapping awaits the
maintainer's review, which gates steps 5 and 6. Step 2's settlement of
undefined tokens moved to step 13 (see there). The maintainer selected the
direction in discussion: a self-built playground rather than Storybook,
census before migration, injected services for scenes, deletion of the
checked-in mockups, and no visual tests in CI.

## Why

The client has one shared overlay primitive (`ui/Modal.tsx`) and one shared
tooltip layer (`ui/TooltipLayer.tsx`). Everything else is reimplemented per
feature. A survey of `packages/client/src` on 2026-11-08 (grep counts over
non-test `.tsx`, approximate) found:

| Control | Current state |
| --- | --- |
| Buttons | 877 raw `<button>`s; 45 global button classes in two competing families (`settings-button*` ~99 uses, `btn*`), 57 module button class names (`.button` defined 43 times) |
| Popovers and menus | ~40 hand-rolled; 27 files write their own outside-click handling and 55 their own `Escape` handling; ~15 `role="menu"` implementations; no shared popover |
| Switches | the `toggle-switch` + `toggle-slider` markup pasted ~71 times in 14 files; `role="switch"` once |
| Segmented controls, radios | ~50 files with their own `aria-pressed`/`radiogroup` markup; at least five separate chip-group or option-row styles |
| Inputs | `settings-input` ~72 uses, `settings-select` ~20, ~22 module input/select/field names; no shared label/error wrapper |
| Banners, inline errors | 13 banner/notice components; ~100 distinct inline error/warning class names |
| Tabs, badges, spinners | 4 tab implementations; ~57 badge/chip/pill class names; 8 spinner classes and ~17 spin/pulse keyframes |
| Tokens | `--bg-primary` (68 uses), `--shadow-*`, `--space-6/8`, `--radius-full`, `--bg-elevated` are used but defined in no client theme; no z-index scale (154 raw values); ~929 hex literals |

The undefined-token part is already recorded as
[client banners use an undefined `--bg-primary`](../../gaps/client-banners-use-an-undefined-bg-primary-variable.md).
The checked-in feature mockups (`packages/client/mockups/`, 11 directories,
each with its own Vite config, tsconfig and capture script) are proposal
snapshots for features that have since shipped; nothing retires them.

## Decisions

- **Self-built, not Storybook.** Storybook 10.3+ now ships an agent-oriented
  MCP addon, but it brings a large dev-dependency tree and its own
  configuration and addon surface, which means a steady stream of security
  updates for a tool that duplicates our Vite entry and
  `artifact:capture` pipeline. Ladle (Vite-native, reads Storybook's story
  format) and React Cosmos 7 (publishes `/cosmos.fixtures.json`) were also
  considered; the playground copies Cosmos's machine-readable index idea.
- **Storybook-compatible example files.** Each example module default-exports
  `{ title, component }` and names one state per export, so a later move to
  Ladle or Storybook would not require rewriting them. No decorators, args
  tables, addons or play functions.
- **Census before migration.** Unification is allowed to change appearance;
  the risk is choosing what collapses into what. A census page renders every
  existing variant next to the proposed canonical set, and the maintainer
  picks the mapping before code moves.
- **Unify first, redesign later.** Migration steps adopt the canonical
  variants and accept small visual changes; deliberate restyling (radius,
  shadow, density) happens afterwards, centrally, in the shared controls and
  tokens.
- **Injected services for scenes.** Scenes that need server data receive it
  through React context, not module aliasing (as `mockups/viewer-header`
  does today) and not a faked network layer. This continues the
  refactor already under way; 96 client modules import the `api` singleton
  directly, so injection is introduced per scene, not as a sweep.
- **No visual tests in CI.** Typecheck covers the example modules;
  screenshots are on-demand through `artifact:capture`.

## Steps

### 1 — playground shell and example runner

Landed as specified, with these settled details (the
[topic](../../topics/ui-design.md#shared-controls-and-the-design-playground)
owns the contract): the index is `pnpm -s design:index`, a static
TypeScript parse rather than a page, so agents need no browser; a dev-only
Vite plugin (`design/vite-plugin-design-data.ts`) serves census data and
appends Storybook's `__namedExportsOrder` so states keep source order; the
guard is a Biome `noRestrictedImports` override in `biome.json`; and
`design:shot` starts its own private dev server unless given `--url`.

- `packages/client/design.html` with its shell under `packages/client/design/`.
  The name `play.html` is taken by the public-share play frame. The Vite dev
  server serves the entry at `/design.html`, so it is reachable through the
  YA dev port (local or Tailscale). The production build never builds it,
  and it is not reachable on relay or hosted clients.
- Example files sit beside their component as `*.specimen.tsx`, collected by
  `import.meta.glob`. Shell-only fixtures live under `design/`.
- Every state has a stable, chromeless URL:
  `/design.html#/<title>/<state>?theme=<verydark|dark|light>&iso`. The shell
  sets the theme, waits for fonts, and marks `[data-design-ready]` for
  capture.
- A grid view shows one title's states across themes and desktop/phone
  widths side by side.
- `/design.html#/index.json` (or a dev-server route) lists every title,
  state, source path and layer, so agents can check what exists before
  writing a new control.
- `pnpm design:shot <title>[/<state>] [--themes all]` wraps
  `artifact:capture` with `--ready-selector '[data-design-ready]'`, so
  captures are presented through the existing pipeline.
- Guard: production modules must not import `*.specimen.tsx` or anything
  under `packages/client/design/`. Extend an existing lint script rather than
  adding a new one.

### 2 — token page and undefined-token report

- Parse the theme blocks in `src/styles/index.css` and render swatches and
  scales (color, spacing, radius, type) for each theme.
- Report custom properties used anywhere in client CSS but defined in no
  client theme, and properties defined but unused. Surface this on the page
  and as a check script.
- Landed: the token page, and the report as a ratchet inside the existing
  `pnpm css:check` (shared scanner `scripts/lib/css-custom-properties.mjs`).
  It recorded 62 undefined names read 291 times, 33 of them with reads that
  have no fallback.
- Settling those names moved to step 13. Defining `--bg-primary` alone would
  turn 65 currently transparent or dropped declarations into painted ones
  across dozens of surfaces in three themes, which is a per-surface visual
  review, not part of standing up the page.

### 3 — button and switch census

- A census page renders a sample button for each global button class and
  each extractable module button class, grouped by visual similarity, with
  the proposed canonical variants beside them. The same for switches and
  segmented controls.
- The maintainer picks the canonical variants and the mapping. Record the
  mapping as a table in code (legacy class → variant), which the migration
  steps follow, and summarize it here.
- Landed with a proposed table in `design/census/mapping.ts`, awaiting
  review. Proposed button variants: `primary` (brand green: `btn-primary`,
  `login-button`), `secondary` (`settings-button`, `btn-secondary`,
  `copy-button`, `session-share-icon-button`), `outline`
  (`settings-button-secondary`, `expand-button`), `ghost`
  (`diff-toolbar-icon-button`), `danger`, `danger-outline`, each in two
  sizes with an icon-only form. Send, toolbar and new-session submit buttons
  are a separate composer family. The census still lists 40 unmapped global
  button classes and 69 module button classes. Proposed `Switch` keeps the
  legacy 44×24 geometry as `role="switch"`; proposed `SegmentedControl`
  keeps the font-size selector's look as a radio group and absorbs the chip
  groups and `AttachmentQualityToggle`.

### 4 — legacy pattern ratchet

- A count-only baseline, in the style of `pnpm css:check`, for legacy
  patterns: `toggle-switch` markup, `settings-button*`/`btn*` classes,
  `createPortal` outside `components/ui/`, hand-written outside-click
  listeners. Counts may only go down; `--record` lowers them.
- The playground shows the current counts as a drift page.

### 5 — `Switch` and its migration

The pilot: one well-understood control, a mechanical swap, before/after
captures. `Switch` renders `role="switch"` with a label and an optional
description. It replaces the pasted `toggle-switch` markup, mostly in
settings.

### 6 — `Button` and `IconButton`

Variants come from the census. `IconButton` requires an accessible label and
uses `TooltipLayer`. Migrate the `settings-button*` and `btn*` families first,
then module button classes as their features are touched.

### 7 — overlay census and `Popover`/`Menu`

- A census of the ~40 hand-rolled popovers and menus: anchoring, dismissal,
  focus handling and mobile behavior.
- `Popover` builds on the Popover API (light dismiss, `Escape`, top layer)
  with CSS anchor positioning and a feature-detected script fallback.
  `Menu` adds roving focus and `role="menu"` semantics.
- Confirm how `popover="auto"` interacts with `Modal`'s layer stack,
  `useModalBackGesture` and Android back handling before migrating callers.
  `<dialog closedby>` is not in Safari, so `Modal` keeps its own `Escape`
  handling. Moving `Modal` onto `<dialog>` (which would supply the focus trap
  it lacks) is evaluated here, not assumed.

### 8 — fields and selection controls

`Field` (label, hint, error), `Checkbox`, `SegmentedControl`. These replace
`settings-input`/`settings-select` and the chip-group variants. Typing in a
migrated field must still meet the sequential-typing requirement in
[AGENTS.md](../../AGENTS.md).

### 9 — status and feedback controls

`Banner`, `Badge`, `Spinner`, `Tabs`, each with its own census.

### 10 — service context for scenes

- Add a client services context that supplies `api` and the connection or
  stream surfaces scenes need. Production mounts it with the existing
  singletons; the playground mounts fixture implementations.
- Convert only the hooks and components the first scenes need. Converting a
  module means it reads services from the context instead of importing the
  singleton.
- First scene: `ProjectCard` with the 16 sample projects from
  `mockups/projects/`, which covers attention/queue counts, long content and
  sparse cards.

### 11 — replace the mockup export and delete the mockups

- `e2e/mockup-export.spec.ts` and `e2e/artifact-relay.spec.ts` build
  `mockups/projects` (through `vite.config.mockup.ts` and `mockups/export.ts`)
  to verify relocatable export and hosted-relay viewing. Point both at a
  static export of the playground (`design:build`), keeping the
  `ya-mockup.json` manifest contract or replacing it in the same change.
- Then delete `packages/client/mockups/`, `vite.config.mockup.ts`,
  `tsconfig.mockups.json`, `playwright.mockups.config.ts` and the `mockup:*`
  scripts. Drop the `packages/client/mockups` exclusion in
  [CSS architecture](../../topics/css-architecture.md#css-lint-rules).
- `inbox-provider-wait` (last touched 2026-11-07) and `extension-side-panel`
  are rebuilt as proposal scenes only if their feature work resumes; git
  history keeps the originals.

### 12 — proposal scene lifecycle check

- A proposal scene (UI that does not yet exist in `src`) declares its owning
  `docs/tactical/*.md` plan or `gaps/*.md` entry.
- The check fails when the declared owner is missing or its `Status:` line
  reads `done`. Retiring or finishing a plan therefore forces deleting or
  promoting its scenes in the same change. The check depends only on
  repository content, never the date, so it cannot start failing on an
  unrelated change.
- Reference scenes render only real components and need no owner.

### 13 — settle the undefined tokens

Can run at any point; nothing else waits on it. For each name on the token
page's undefined list, define it in every theme or remap its reads onto the
token each one wanted, comparing the affected surfaces in all three themes.
This closes the
[`--bg-primary` gap](../../gaps/client-banners-use-an-undefined-bg-primary-variable.md).
Add the missing scales (shadow, z-index, `--space-6/8`, `--radius-full`) only
where reads exist. The `--vscode-*` names are not supplied by any host; they
are dark fallbacks copied into renderer rules and read wrongly in the light
theme. `pnpm css:check --record` lowers the limits as names go.

## Not in scope

- Visual-regression tests in CI.
- A restyle beyond what unification needs.
- Publishing the playground on relay or hosted clients.
- Converting all 96 `api` importers to context.

## Sources consulted

- [Storybook MCP for React](https://storybook.js.org/blog/storybook-mcp-for-react/),
  [Storybook 10.3](https://storybook.js.org/blog/storybook-10-3/)
- [Introducing Ladle](https://ladle.dev/blog/introducing-ladle/),
  [React Cosmos releases](https://github.com/react-cosmos/react-cosmos/releases)
- [Vitest visual regression testing](https://main.vitest.dev/guide/browser/visual-regression-testing)
  (available, not used in CI)
- [Declarative dialog and popover control](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/ui-behaviors/declarative-dialog-popover-control.md)

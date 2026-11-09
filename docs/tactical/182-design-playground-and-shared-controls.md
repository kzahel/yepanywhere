# Design playground and shared controls

Topic: ui-design

Status: rewritten 2026-11-08 around one control family at a time. The
playground, token page, undefined-property limit, button and switch census,
the shared `Button`/`IconButton`/`ButtonBase`, the screen tour and the
whole button family (census, swap, delete, ban) and the token pass have
landed. Order agreed with the maintainer on 2026-11-09: the token pass
(done), then switches and
segmented controls, menus and popovers, fields, banners/badges/spinners/
tabs, the dialog pattern, and the composer last. Each step runs end to
end (implement, independent review, commit) before the next starts.

## Why

The client has one shared overlay primitive (`ui/Modal.tsx`) and one shared
tooltip layer (`ui/TooltipLayer.tsx`). Everything else is reimplemented per
feature. A survey of `packages/client/src` on 2026-11-08 (grep counts over
non-test `.tsx`, approximate) found:

| Control | Current state |
| --- | --- |
| Buttons | 877 raw `<button>`s; 45 global button classes in two competing families (`settings-button*` ~108 uses, `btn*`), 69 CSS Module button classes in 45 modules |
| Popovers and menus | ~40 hand-rolled; 27 files write their own outside-click handling and 55 their own `Escape` handling; ~15 `role="menu"` implementations; no shared popover |
| Switches | the `toggle-switch` + `toggle-slider` markup pasted ~76 times in 14 files; `role="switch"` once |
| Segmented controls, radios | ~50 files with their own `aria-pressed`/`radiogroup` markup; at least five separate chip-group or option-row styles |
| Inputs | `settings-input` ~72 uses, `settings-select` ~20, ~22 module input/select/field names; no shared label/error wrapper |
| Banners, inline errors | 13 banner/notice components; ~100 distinct inline error/warning class names |
| Tabs, badges, spinners | 4 tab implementations; ~57 badge/chip/pill class names; 8 spinner classes and ~17 spin/pulse keyframes |
| Tokens | 62 custom properties read but defined by no client source (291 reads, 168 of them with no fallback, so they do nothing); no shadow or z-index scale; ~929 hex literals |
| Global CSS | ~21k lines in `index.css`, `renderers.css` and `tool-rows.css`, beside ~26.5k lines in 243 CSS Modules |

The census pages made the scale visible: the same button rendered in dozens
of slightly different styles.

## Decisions

- **One control family at a time, finished before the next.** For each
  family: census, build the shared control, swap every use, delete the old
  CSS, ban the old way. No family is left half-migrated while another
  starts. This replaces the earlier order (census everything, then migrate
  everything behind long-lived limits).
- **A quick cut, not a burn-down.** A family's swap happens in a few
  area-sized commits, not opportunistically as features are touched. There
  are no long-lived per-family limits: once a family is swept, lint rejects
  the old classes outright.
- **Design changes are accepted.** A swap adopts the canonical variant even
  where the old style differed; fallout is fixed as it is noticed in normal
  use and in the screen tour (below). Pixel parity is not a goal.
- **Delete global CSS as part of each slice.** A legacy class whose use
  count reaches zero has its rules deleted in the same slice, and
  `pnpm css:check --record` lowers the global stylesheet limits.
- **Composer controls are excluded from the first passes.** The session
  input's controls (send, stop, toolbar, attachment, mode, thinking, voice,
  slash command) and the new-session form's submit are specialized and get
  their own careful census and pass after the general families.
- **Self-built playground, not Storybook.** Storybook 10.3+ ships an
  agent-oriented MCP addon, but its dev-dependency tree and configuration
  surface mean a steady stream of security updates for a tool that
  duplicates our Vite entry and `artifact:capture` pipeline. Ladle and React
  Cosmos 7 were also considered; the playground copies Cosmos's
  machine-readable index idea.
- **Storybook-compatible example files.** A default export
  `{ title, component, parameters }` and one export per state, so a later
  move to Ladle or Storybook needs no rewrite.
- **Injected services for scenes.** Scenes that need server data receive it
  through React context, not module aliasing and not a faked network layer.
  96 client modules import the `api` singleton directly, so injection is
  introduced per scene.
- **No visual tests in CI.** Screenshots are on demand.

## What has landed

- **Playground** (`packages/client/design.html`, `packages/client/design/`):
  dev-only entry with a sidebar, global theme and width settings kept in the
  URL, per-theme grids, phone frames, and chromeless isolated states.
  `pnpm -s design:index` lists every example statically; `pnpm -s
  design:shot` captures states through the artifact-capture presentation.
  Biome rejects production imports of the playground or example files.
- **Token page and undefined-property limit:** theme colors and scales in
  each theme, and every custom property read but never defined, with its
  sites. `pnpm css:check` rejects new undefined names and more reads of
  recorded ones (shared scanner `scripts/lib/css-custom-properties.mjs`).
- **Token pass done (2026-11-09):** every custom property the client reads
  is defined; the `undefinedCustomProperties` baseline is empty, so
  `pnpm css:check` rejects any undefined read. Misspellings moved onto the
  theme tokens (`--color-error` → `--error-color`, `--vscode-*`, `--app-*`,
  `--text-link`, `--focus-ring`, `--border-muted`, …); the 56 reads of
  `--bg-primary` became `--bg-surface`, `--bg-input` (fields) or
  `--bg-elevated` (popovers). New tokens: `--bg-elevated` per theme, the
  tints `--bg-error/-warning/-success/-selected` mixed from each theme's
  colors, `--shadow-sm/md/lg`, `--radius-full`, `--space-6/8`. Values every
  theme shared, the dark defaults the light themes override and the tints
  moved into one `[data-theme]` block, so a nested theme (a playground cell)
  resolves its own and `index.css` shrank by 36 lines. The scanner counts a
  name held in a `const` and passed to `setProperty`. The Tokens page shows
  the `:root` colors and an elevation scale. The z-index scale waits for the
  popover family, which will decide what layers exist.
- **Shared buttons** (`src/components/ui/Button.tsx`, Controls/Button page):
  `Button`, `IconButton`, `ButtonBase` and `buttonClassName`, built from the
  census prototypes, which the button census now renders instead.
- **Button mapping:** every global (54) and CSS Module (79) class *named*
  like a button has a destination in `design/census/mapping.ts`;
  Census/Buttons shows each beside what it becomes, and its Unmapped state
  is empty. That census finds classes by name and only those with rules,
  so the **element census** (Census/Buttons, "Button elements, by
  directory") finds buttons by element instead: every raw and shared
  button, button-classed link or label, and `role="button"` element in
  production TSX, with file, line and className. At its landing it found
  594 raw buttons to swap and 129 left for later families (30 menu, 36
  option, 13 switch, 3 tab, 47 composer).
- **Button family done (2026-11-08):** every button outside the composer
  and the allowlisted later-family controls is on `Button`, `IconButton`,
  `ButtonBase` or `buttonClassName`: the
  settings batch, then modals and other pages, the session view and other
  components, and renderers, blocks and the extension side panel (about 600
  buttons in 190 files). Variants follow one rule (topic, "Buttons"), also
  applied back over settings. The global rules of every legacy button class
  that reached zero uses are deleted (`settings-button*`, `btn-*`,
  `copy-button`, `login-button`, `load-older-button`, the share, revoke,
  queue and commit-browser buttons, …, about 700 lines), and rules on
  classes kept for layout lost their look properties. `IconButton` gained
  `tooltip` for tooltips that say more than the name, and the controls a
  `dense` size for transcript rows. `pnpm buttons:check` in `pnpm lint` is
  the ban; its allowlist holds the menu, tab, option and segmented buttons
  and rules that later families own, the composer's, the crash fallback
  page and 15 pre-existing `role="button"` elements. A second review
  (Opus, 2026-11-08) found no blockers; its fixes covered dense rows, touch
  overflow, specificity ties, the ban's gaps and these docs. The screen
  tour gained a touch-phone pass.
- **Screen tour:** `pnpm -s design:tour --label <name>` (the
  [topic](../../topics/ui-design.md#shared-controls-and-the-design-playground)
  owns the contract).
- **Button and switch census:** proposed canonical variants beside every
  mapped legacy style, unmapped global classes with live use counts from a
  dev-only Vite plugin, and every matching CSS Module class. Proposed
  mapping in `design/census/mapping.ts`.

The [topic](../../topics/ui-design.md#shared-controls-and-the-design-playground)
owns the contract for all three.

## The slice recipe

Every control family follows the same five steps, and a family is done only
when all five are:

1. **Census.** A playground page shows every legacy variant, global and
   module, beside the proposed canonical set. The mapping table in
   `design/census/` assigns each legacy class a canonical variant or a
   disposition (another family, not this control, or excluded).
2. **Build.** The shared control goes in `src/components/ui/` with a CSS
   Module and a `*.specimen.tsx` showing every variant, size and state in
   all themes. It renders from props alone.
3. **Swap.** Every use in scope moves to the shared control, in area-sized
   commits (see the button batches). Feature-specific layout (margins, flex
   placement) stays with the feature; the control owns its look.
4. **Delete.** Each legacy class whose use count reaches zero has its rules
   deleted: global rules from the legacy stylesheets, module rules from
   their modules. `pnpm css:check --record` lowers the limits in the same
   commit.
5. **Ban.** Lint rejects the deleted global class names and, for the
   family's element, new styling outside the shared control (exact rule
   chosen per family, with composer files exempt until their pass). The
   family's census page then shows no legacy entries and stays as a
   regression view.

**Screen tour.** Before the first swap commit, add a capture script that
opens the main screens (projects, a session, new session, each settings
section, file viewer, source control) against an isolated test server
with fixture data, in dark and light, at desktop and phone widths, and
writes them through the capture presentation. Run it before and after each
batch to review fallout side by side. It reuses the E2E server harness
and runs on demand, not in CI.

## Family order

Order, from 2026-11-09: **0** token pass (below, "Supporting work"), then
**3** switches and segmented controls (cheap, visible, census already
built, and it clears most of the button allowlist), **2** menus and
popovers (the largest behavior payoff, once tokens give it raised-surface
and shadow values), **4** fields, **5** banners, badges, spinners and tabs,
**7** the dialog pattern, and **6** the composer last. Numbers are stable
names, not the order.

### 1 — buttons

Scope (2026-11-08): 774 `<button>`s in scope across about 230 files, after
excluding 65 composer buttons and 38 that carry menu, tab, option, radio or
switch roles.

| Batch | Buttons | Files |
| --- | --- | --- |
| Settings pages | 176 | 45 |
| Modals | 37 | 10 |
| Other pages (source control, issues, login, agents, …) | 99 | 32 |
| Session view (header, menu, approvals, questions, turn rail) | 121 | 26 |
| Other components | 264 | 86 |
| Renderers and blocks | 54 | 24 |
| Extension side panel | 15 | 3 |

- **Controls.** `Button` with variants `primary`, `secondary`, `outline`,
  `ghost`, `danger`, `danger-outline` and sizes `default` and `small`;
  `IconButton` for icon-only buttons, requiring an accessible label and
  showing it through `TooltipLayer`. Both forward refs and accept
  `type`, `disabled`, a `busy` state, and ordinary button attributes.
  Coarse pointers get larger hit areas. Variants start from the census
  prototypes in `design/census/proposed.module.css`.
- **Not every `<button>` becomes a `Button`.** Classify each during the
  swap:
  - looks like a button → `Button` or `IconButton`;
  - an inline text action ("show more", "copy") → `Button` `ghost` `small`;
  - a clickable row, card, disclosure arrow or chip → stays a `<button>`
    with its owner's styles, through a shared unstyled base (`ButtonBase`:
    reset, focus ring, `type="button"`) so resets are not repeated;
  - menu items, tabs, segmented options, switches → left for their family;
  - composer controls → excluded.
- **Mapping first.** Extend `design/census/mapping.ts` to assign every
  global and module button class (40 unmapped global, 69 module), and
  switch the census to show each legacy class beside the variant it
  becomes. The maintainer skims that page; the swap then follows the table.
- **Batches** in the order above, one commit each (large batches may split
  by subdirectory). Each batch deletes the legacy rules it leaves unused and
  runs the screen tour before and after.
- **Ban** once all batches land (`pnpm buttons:check`, in `pnpm lint`):
  legacy button classes whose global rules are gone, raw `<button>`s
  outside `components/ui/` and the later families, and CSS Module rules that
  style a bare `button` element's look, each beyond a counted, reasoned
  allowlist (`design/census/button-allowlist.json`).
- **Done when** the button census shows no legacy classes outside the
  composer, the legacy button rules are gone from the global stylesheets,
  and the ban is in lint. Done 2026-11-08; the later families inherit the
  allowlist entries that name them.

### 2 — menus, popovers and dropdowns

Census of the ~40 hand-rolled popovers and menus (anchoring, dismissal,
focus, mobile behavior). `Popover` builds on the Popover API (light
dismiss, `Escape`, top layer) with CSS anchor positioning and a
feature-detected script fallback; `Menu` adds roving focus and `role="menu"`.
First confirm how `popover="auto"` interacts with `Modal`'s layer stack,
`useModalBackGesture` and Android back handling. `<dialog closedby>` is not in
Safari, so `Modal` keeps its own `Escape` handling; moving `Modal` onto
`<dialog>` (for the focus trap it lacks) is evaluated here. Needs the
raised-surface (`--bg-elevated`) and shadow tokens, which the token pass
defined.

### 3 — switches and segmented controls

`Switch` (`role="switch"`, the legacy 44×24 geometry) replaces the pasted
`toggle-switch` markup; `SegmentedControl` (radio group, the font-size
selector's look) replaces the chip groups, option rows and
`AttachmentQualityToggle`. The census for both already exists.

### 4 — fields

`Field` (label, hint, error), text input, select and checkbox, replacing
`settings-input`/`settings-select` and the module variants. Typing in every
migrated field must still meet the sequential-typing requirement in
[AGENTS.md](../../AGENTS.md).

### 5 — banners, badges, spinners and tabs

Each with its own census, in that order.

### 7 — dialog pattern

`Modal` is shared, but what sits inside each dialog is not: header, body
spacing, footer action rows, widths and how actions are ordered and
coloured differ per feature. A `Dialog` pattern on top of `Modal` (title,
optional description, body, a footer action row that applies the button
variant rule: one primary, Cancel secondary, destructive confirms danger)
and a confirm-dialog helper replace the per-feature layouts and the
`window.confirm` calls where a styled confirm fits. Census first: every
`Modal` caller with its width, header and footer shape. Also decide
whether `Modal` moves onto `<dialog>` for its focus trap, if family 2 has
not.

### 6 — composer controls

A careful census and pass over the session input and new-session form
controls, which the earlier families exclude.

## Supporting work

These are not control families; each is scheduled where noted.

- **Undefined-token pass:** done 2026-11-09 (What has landed); it closed
  the `--bg-primary` gap.
- **Service context for scenes** (when the first scene needs it). A client
  services context supplies `api` and the connection surfaces scenes need;
  production mounts the existing singletons, the playground mounts
  fixtures. First scene: `ProjectCard` with the 16 sample projects from
  `mockups/projects/`.
- **Replace the mockup export, then delete the mockups.**
  `e2e/mockup-export.spec.ts` and `e2e/artifact-relay.spec.ts` build
  `mockups/projects` to verify relocatable export and hosted-relay viewing.
  Point both at a static export of the playground, then delete
  `packages/client/mockups/`, `vite.config.mockup.ts`,
  `tsconfig.mockups.json`, `playwright.mockups.config.ts` and the `mockup:*`
  scripts, and drop the mockups exclusion in
  [CSS architecture](../../topics/css-architecture.md#css-lint-rules).
- **Proposal scene lifecycle check** (with the first proposal scene). A
  proposal scene declares its owning plan or gap; the check fails once that
  owner is missing or its `Status:` reads `done`.

## Step names before the rewrite

| Earlier step | Now |
| --- | --- |
| 1 playground shell, 2 token page, 3 button and switch census | What has landed |
| 4 legacy pattern ratchet | Dropped; each family is banned once swept |
| 5 `Switch` | Family 3 |
| 6 `Button` and `IconButton` | Family 1 |
| 7 overlay census and `Popover`/`Menu` | Family 2 |
| 8 fields and selection controls | Families 3 and 4 |
| 9 status and feedback controls | Family 5 |
| 10 service context for scenes | Supporting work |
| 11 replace the mockup export and delete the mockups | Supporting work |
| 12 proposal scene lifecycle check | Supporting work |
| 13 settle the undefined tokens | Supporting work: undefined-token pass |

## Not in scope

- Visual-regression tests in CI.
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

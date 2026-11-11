# Design playground and shared controls

Topic: ui-design

Status: rewritten 2026-11-08 around one control family at a time. The
playground, token page, undefined-property limit, button and switch census,
the shared `Button`/`IconButton`/`ButtonBase`, the screen tour and the
whole button family (census, swap, delete, ban), the token pass, the
switch and segmented-control family, the menu and popover family, the
field family, the banner, badge, spinner and tab family and the dialog
pattern have landed. Order agreed with the maintainer on 2026-11-09: the
token pass (done), switches and segmented controls (done), menus and
popovers (done), fields (done), banners/badges/spinners/tabs (done), the
dialog pattern (done), and the composer last, still open. Each step runs end to end
(implement, independent review, commit) before the next starts.

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
  separate entry with a sidebar, global theme and width settings kept in the
  URL, per-theme grids, phone frames, and chromeless isolated states.
  `pnpm -s design:index` lists every example statically; `pnpm -s
  design:shot` captures states through the artifact-capture presentation.
  Biome rejects production imports of the playground or example files.
  On 2026-11-10 the maintainer requested hosted availability: the remote build
  now includes `design.html` and its source census snapshot in the normal
  deployment output, including Latest. Website 1.14.1 publishes it at
  `/remote/design.html`; Latest retains its normal successful-CI deployment gate.
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
  the `:root` colors and an elevation scale. Reads that had been dropped now
  apply, so some looks changed: cards and popovers gained their raised
  background, borders and shadows, and the fork menu's touch items their
  larger text. An Opus review (2026-11-09) found no blockers; its fixes
  moved the `:root` accent and wordmark aliases into the shared block (they
  had resolved against `<html>`'s theme in nested cells), raised the dark
  `--bg-elevated` values above the panels, and repaired four contrast or
  intent slips in the renames. `css:check` also reads the playground. The
  z-index scale waits for the popover family, which will decide what layers
  exist.
- **Shared buttons** (`src/components/ui/Button.tsx`, Controls/Button page):
  `Button`, `IconButton`, `ButtonBase` and `buttonClassName`, built from the
  original census prototypes; Controls/Button renders the shared variants.
- **Button census:** at its landing the mapping covered 54 global and 79
  module names; the element scan found 594 raw buttons to swap and 129 for
  later families. Plan 191 step 5 removes the completed-family pages and
  mapping. Current open work is Audit / Unfinished migrations, with counted
  reasons under Reviewed exceptions; permanent bans live in
  `button-allowlist.json`.
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
- **Switch and segmented-control family done (2026-11-09):** `Switch`
  (`ui/Switch.tsx`, a checkbox with `role="switch"` on the legacy 44×24
  track) and `SegmentedControl` (`ui/SegmentedControl.tsx`, a radio group
  with roving focus, a `segmented` and a `cards` look, `inline`/`fill`/
  `stack` layouts and two sizes), each with a Controls page and tests. All
  76 pasted `toggle-switch` copies in 14 files became `Switch`, and about
  35 one-of-many pickers became `SegmentedControl`: the `font-size-option`
  groups across settings, the provider, permission-mode and helper option
  cards, host icon presets, the usage window, recap mode, emulator fps,
  width and quality, the model switch modal's thinking, effort and speed
  chips, the restart modal's handoff/fork pair, the public share scope,
  the image viewer's Fit/100%, the session search's age basis, and the
  Source/Preview and Contents/Blame pairs. `role="group"` plus
  `aria-pressed` single-choice groups are now radio groups, so tests and
  E2E specs query `radio` and `switch` roles. The unused
  `AttachmentQualityToggle` and the census prototypes were deleted, and
  so were the legacy rules (`toggle-switch`, `font-size-*`,
  `provider-option*`, `mode-option*`, `new-session-helper-option*`,
  `host-identity-preset*`, `model-switch-chip`, `toggle-btn`, the dead
  `patient-queue-switch`, about 600 lines). `pnpm buttons:check` now also
  bans those classes and any `role="switch"`, `"radio"` or `"radiogroup"`
  outside the two controls, and no longer exempts option or switch
  buttons; the allowlist names what is left (radios inside the speech
  menu, the thinking choices shared with the composer's popover, the
  model list, the question panel's answers, and one native radio group
  for the fields family). The onboarding theme picker became a stacked
  list of cards. An Opus review (2026-11-09) found the font pickers had
  lost their typeface previews (an option's `className` now lands on its
  label), arrow keys saving on every press (groups that save use
  `activation="manual"`) and dropping focus while saving (options are
  `aria-disabled`), the model switch modal's lost "current" marker (now
  a "Current" line), a wrapping icon-style picker and gaps in the ban;
  all were fixed.
- **Menu and popover family done (2026-11-09):** `Popover`
  (`ui/Popover.tsx`) and `Menu`/`MenuItem`/`MenuLinkItem`/`MenuGroup`/
  `MenuSeparator`/`useMenuTrigger` (`ui/Menu.tsx`), with a Controls/Menu
  page and tests, and the layer scale `--z-modal`, `--z-popover`,
  `--z-tooltip`. The Popover API's top layer was evaluated and not used
  (topic, "Menus and popovers"): it would cover tooltips and toasts,
  `Modal`'s capture-phase Escape cancels its close request, and `auto`
  light dismiss races React state; popovers instead join `Modal`'s layer
  stack (`useModalLayer` can now decline an Escape), and `Modal` stays a
  portal `div`. The former menu census found
  23 hand-rolled surfaces in scope (plus the anchored `Modal`, kept); all
  moved: the session menu (no roles,
  Escape or focus handling before), the account chip, the project
  reclassify menu, recent sessions, the issues menu (rows are real links),
  the fork-turn, notch, source and file context menus (with a nested
  submenu), recent hosts, the folder listing, the async questions panel
  and row menu, ACLI commentary, the search match menu and status, the
  shortcut, metrics, delivery and aside help popovers, `FilterDropdown`
  (about 28 callers, checkbox or radio items, a bottom sheet on phones),
  the project picker and the git help. `Modal`'s anchored mode shares the
  placement function. Dead rules went with them (`project-reclassify-*`,
  the delivery and git help popovers, dead mode-selector and
  `filter-dropdowns` rules), as did the overlays' dismiss labels. `pnpm
  buttons:check` now bans menu roles outside `Menu` and document or window
  pointer listeners outside `Popover`, and counts menu and listbox buttons
  as raw buttons; the allowlist names what is left (the composer's
  surfaces and gesture or link-routing listeners that are not dismissals).
  An Opus review (2026-11-09) found three blockers, all fixed: a check
  failing on intermediate commits (regrouped), the dismissing press also
  clicking what lay underneath (the click is now swallowed, as the old
  overlays did) and menus inside a `Modal` landing outside its
  `aria-modal` dialog (they now portal into it). Its other fixes: a
  default type size and a roomier `card` surface for text popovers, hover
  reveals keyed on `:focus-visible` so focus returned after a mouse pick
  leaves no trigger painted, popovers closing when their trigger is
  parked or scrolled away, the Escape order taken at open, typeahead on
  labels only, menus opened by pointer leaving focus where it was (moving
  it into the menu pulled it out of the composer, whose layout change
  stopped the transcript following new output; a header E2E spec had
  turned flaky), the switch-host menu anchored to its button, model badges
  in the icon slot, wider ban patterns, a heading made a group label, and
  a dead composer popover deleted.
- **Field family done (2026-11-09):** `Field`, `TextInput`, `Textarea` and
  `Select` (`ui/Field.tsx`) and `Checkbox` and `Radio` (`ui/Checkbox.tsx`),
  with a Controls/Field page, tests and a temporary field census. A census
  by element found 332 raw inputs, selects and textareas: 77 checkboxes,
  63 selects, 22 textareas, 9 radios and the rest text, number, password, url and search boxes, 205 of them in settings,
  styled by `settings-input` (~70 uses), `settings-select` (~20), the
  `form-*` and `login-field` rules and about 40 module look rules. All moved
  except range, file and hidden inputs, the composer's fields and seven
  chromeless editors whose owners draw the frame (the header title editor,
  the source editor's code textarea, the find bar, the transcript search
  scope, the vhost address and search age fields, the aside composer).
  The controls are stateless pass-throughs, so typing costs nothing beyond
  the caller's render; the per-key 100 ms E2E checks over the instruction
  path, the gateway URL and the template revision fields cover the swap.
  Every checkbox that saved on click became a `Switch`; the
  remaining native radio groups (Codex update policy, storage locations,
  template grants, the gateway effort mode, the project start palette)
  became `SegmentedControl`s; radios spread across rows (the default
  gateway service, browser host, Rendez defaults) are `Radio`. Labels
  wrapping a field became `Field`s, so hints and errors are linked and
  invalid fields are `aria-invalid`. The legacy rules were deleted
  (`settings-input*`, `settings-select`, `settings-textarea`, `form-field`,
  `form-select`, `login-field*`, the Codex prompt's hand-drawn checkbox,
  about 400 lines of global CSS). `pnpm buttons:check` now also bans raw
  field elements and rules that style a bare `input`, `select` or
  `textarea`; Biome's label rule knows the shared controls. An Opus
  review (2026-11-09) found no blockers. Its fixes: about 25 save-on-click
  boxes that one area had left as checkboxes became switches, the theme
  colors of the open select list (a fix the swap had dropped) moved into
  `Select`, the source search boxes regained room for their shortcut
  overlay, deliberate 44 px touch rows came back, narrow number boxes kept
  their widths (`inputClassName`), warnings stopped marking fields invalid
  and were linked instead, hints became `Field` hints, a Field's id now
  wins over its control's, required markers moved onto `Field`, fields
  share the `--focus-border` ring, selects keep their arrow in forced
  colors, unnamed fields got names, and the ban now reads `:is()` and
  `:where()` subjects, rules after `@layer`/`@import` statements and
  `max-` sizes.
- **Banner, badge, spinner and tab family done (2026-11-09):** `Banner`,
  `Badge`, `Spinner` and `Tabs`/`TabPanel` (`ui/`), each with a Controls
  page, tests, and a temporary status-family census in the family's order.
  The census found the settings and form message styles (`settings-warning` ~25 uses,
  `form-error`, `form-warning`, `login-error`), a dozen one-off notice
  boxes, 13 notice components and many module error and notice classes;
  the renderers' `.badge` family (~70 uses) and about 45 named badge
  classes; eight spinner classes with fourteen rotate keyframe sets (five
  of them a global `spin` overriding each other); and three tab strips,
  one with roving focus. About 270 files moved, area by area: messages
  became `Banner`s in the matching tone (notice components keep their
  logic and placement and draw their box through it), labels and counts
  `Badge`s (brand and tracker colors through `--badge-color`), every
  busy indicator `Spinner` or a button's `busy`, and the source control,
  model switch and question panel strips `Tabs`. Toasts, tool output
  error text, system message rows and clickable chips stayed what they
  were. About 850 lines of global CSS went with the classes, and the
  layout classes kept on the shared controls lost their look properties.
  `pnpm buttons:check` now also bans tab roles outside `Tabs`, rotating
  keyframes outside `Spinner` (the new-session submit's spinner is
  allowlisted for the composer) and the legacy status classes, and tab
  buttons lost their exemption. An Opus review (2026-11-09) found two blockers, both
  fixed: equal-width source control tabs cut their labels (fill tabs now
  wrap, and `fill-phone` keeps equal columns to narrow screens), and
  single-field validation errors had become alerts that interrupted
  typing (they are role-less again, still linked to their fields). Its
  other fixes: badge text mixed toward the text color and darker solid
  fills for 4.5:1 contrast, source tabs with manual activation (arrowing
  had pushed history entries), notices from polled or initial state no
  longer announced, one mounted status region kept where saved and failed
  results alternate, labelled spinners holding their text, answered
  question tabs named as such, floating banners' shadows back, the
  attention badges blue again, unnamed count badges named, about ten
  missed error lines and count pills swapped, and weakened tests
  restored.
- **Dialog pattern done (2026-11-10):** `Dialog` and `confirmDialog`/
  `promptDialog` (`ui/Dialog.tsx`, `ui/ConfirmDialog.tsx`), a Controls
  page whose states open their dialogs, tests, and a temporary dialog and
  confirmation census. The census found 32 files rendering `<Modal>`: 19 forms, choices and notices, each with its
  own width hack (`:global(.modal):has(…)` in modules and global
  stylesheets), padding and action row, the action row usually inside the
  scrolling body and in varying order; viewers (diff, file, blame, media,
  logs, process and tool details); three hand-rolled modal surfaces
  (GoalPanel, SourceEditor, FilePathLink's file viewer); and 20 native
  `window.confirm` calls plus one `window.prompt`. `Modal` stays a
  portaled `div` rather than a modal `<dialog>`, because the tooltip
  layer, hover cards and selection actions portal into the body and the
  top layer would cover them and make them inert; it gained a Tab trap,
  focus return to its opener, `aria-labelledby` its title (ReactNode
  titles were unnamed), an `alertdialog` role and a footer slot. The 19
  dialogs moved onto `Dialog` (`small`/`medium`/`large`, a description,
  the action row as a footer with Cancel first and one primary or danger
  action last, cards near the top on phones at every size), the confirmations onto
  `confirmDialog` with a question title, the old prompt as the message and
  a named action, and the project copy name onto `promptDialog`. Viewers
  stayed on `Modal`. About 190 lines of global CSS went (the model switch
  action rows, onboarding footer and progress dots, schema warning frame,
  share and provider editor widths). `pnpm buttons:check` now also bans
  native confirm, alert and prompt calls, `aria-modal` and `alertdialog`
  outside the shared dialogs, rules that reach into Modal's frame (viewers'
  and the composer's are allowlisted) and the old frame and footer classes.
  An Opus review (2026-11-10) found one blocker, fixed: confirmations drew
  at `--z-modal`, under the full-screen source editor, so its discard and
  rebuild questions were invisible yet focused (Enter approved an unseen
  command); they now draw on a `--z-confirm` layer, with an E2E click that
  fails if covered. Its other fixes: a Tab from a removed or disabled
  control returns into the topmost modal, focus returns to the menu
  trigger when a menu item opened the dialog, large dialogs are cards on
  phones too (onboarding and the file share dialog are medium), the
  handoff dialog's wide full-pane composer is wide again, model switch
  sections no longer double their spacing, the ban catches
  `window.confirm?.(`, `window["confirm"](`, cast and bare `:global .modal`
  forms and skips definitions and comments, and copy and spacing nits.
- **Screen tour:** `pnpm -s design:tour --label <name>` (the
  [topic](../../topics/ui-design.md#shared-controls-and-the-design-playground)
  owns the contract).
- **Open-work audit:** plan 191 step 5 removed swept-family samples. The
  Audit report now separates unfinished migrations, reviewed exceptions and
  generated-content boundaries. Each row gives its element/class, location
  or count, reason and resolution; shared Controls/Patterns retain the
  standard examples.

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
   family's swept census rows and page are removed; permanent class bans
   stay in `button-allowlist.json`. Controls/Patterns show the standard,
   while Audit distinguishes unfinished migrations from reviewed exceptions.

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
  prototypes (`design/census/proposed.module.css`, since deleted).
- **Not every `<button>` becomes a `Button`.** Classify each during the
  swap:
  - looks like a button → `Button` or `IconButton`;
  - an inline text action ("show more", "copy") → `Button` `ghost` `small`;
  - a clickable row, card, disclosure arrow or chip → stays a `<button>`
    with its owner's styles, through a shared unstyled base (`ButtonBase`:
    reset, focus ring, `type="button"`) so resets are not repeated;
  - menu items, tabs, segmented options, switches → left for their family;
  - composer controls → excluded.
- **Mapping first (completed).** The original temporary mapping assigned
  each button class a shared destination before the sweep. Plan 191 step 5
  removes that completed inventory; Audit / Unfinished migrations retains
  the open pass.
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
defined. **Done 2026-11-09** (What has landed). Left for other families:
the composer's popovers and completion lists (composer), the model switch
list inside its Modal, and `GoalPanel`, a form already on the layer stack.

### 3 — switches and segmented controls

`Switch` (`role="switch"`, the legacy 44×24 geometry) replaces the pasted
`toggle-switch` markup; `SegmentedControl` (radio group, the font-size
selector's look) replaces the chip groups and option rows. **Done
2026-11-09** (What has landed). Left for other families: radios inside
menus (menu family), the thinking choices the composer's popover shares
(composer), native `<input type="radio">` groups (fields), and the
question panel's answer list, which mixes single and multi select with
previews and an Other field.

### 4 — fields

`Field` (label, hint, error), text input, select and checkbox, replacing
`settings-input`/`settings-select` and the module variants. Typing in every
migrated field must still meet the sequential-typing requirement in
[AGENTS.md](../../AGENTS.md). **Done 2026-11-09** (What has landed). Left
for other families: the composer's fields (composer) and the chromeless
editors the allowlist names.

### 5 — banners, badges, spinners and tabs

Each with its own census, in that order. **Done 2026-11-09** (What has
landed). Left for other families: the composer's spinner and messages
(composer); toasts keep their own stack.

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
not. **Done 2026-11-10** (What has landed): `Modal` stays a `div` with
its own trap. Left for other families: the composer's full-pane form
inside the handoff dialog (composer).

### 6 — composer controls

A careful census and pass over the session input and new-session form
controls, which the earlier families exclude. Start at Audit / Unfinished
migrations for live class/element locations and Reviewed exceptions
for counted reasons; swept-family inventories were removed by plan 191 step 5.

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
- Converting all 96 `api` importers to context.

## Sources consulted

- [Storybook MCP for React](https://storybook.js.org/blog/storybook-mcp-for-react/),
  [Storybook 10.3](https://storybook.js.org/blog/storybook-10-3/)
- [Introducing Ladle](https://ladle.dev/blog/introducing-ladle/),
  [React Cosmos releases](https://github.com/react-cosmos/react-cosmos/releases)
- [Vitest visual regression testing](https://main.vitest.dev/guide/browser/visual-regression-testing)
  (available, not used in CI)
- [Declarative dialog and popover control](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/ui-behaviors/declarative-dialog-popover-control.md)

# UI design and mockup exports

> YA's design language is moving onto a small set of shared controls that are
> shown and captured in a separate design playground. UI proposals use real
> client components in isolated Vite fixtures, exported as relocatable HTML,
> CSS, JavaScript, fonts and linked captures.

Topic: ui-design

Read this topic before choosing fixtures or rendering/export commands for UI
appearance or interaction proposals, including prose discussions of UI ideas.
Respect explicit prose-only requests and the user's visual-verification
handoff. For a requested mockup, a source file or dev-server URL alone is not a
viewable handoff; use the capture and delivery workflow below.

## Design language and component owners

Start with the actual surface being proposed: `pages/ProjectsPage.tsx` and
`components/ProjectCard.tsx` for project browsing, `pages/SessionPage.tsx`
for a session, and `pages/settings/` for settings. These paths are relative to
`packages/client/src`. Check the current component API and its providers before
reusing it. [UI architecture](ui-architecture.md) owns rendering boundaries;
[CSS architecture](css-architecture.md) owns styles and their containment.

`src/styles/tokens.css` supplies the existing dark/light/verydark themes,
semantic colors, spacing, typography, and bundled font faces; component-owned
styles live beside their components in CSS Modules. Reuse those tokens and
component SVGs. The normal UI font is the system sans; the example explicitly
selects the existing **YA Inter** option to exercise bundled font loading.
This is fixture configuration, not a change to the application's default.
Keep related controls grouped, allow long content to scroll, and inspect the
real desktop and phone renders under [UI testing](ui-testing.md).

## Shared controls and the design playground

Status: direction selected 2026-11-08.
[Plan 182](../docs/tactical/182-design-playground-and-shared-controls.md)
sequences the work. The playground, its token page, the undefined-property
limit, the button and switch census, the shared button family, the
shared switch and segmented control, the shared popover and menu, the
shared fields, the shared banner, badge, spinner and tabs, and the dialog
pattern have landed. For controls without a
shared version yet, the owners above remain the reference.

[Plan 191](../docs/tactical/191-css-ownership-and-leak-closure.md) (selected
2026-11-10; steps 1–7 landed) closes the leaks around shared
controls: caller classes that override a control's look, `ButtonBase` uses
that draw a button by hand, literal type sizes and radii, and census pages
that still list swept work. `controls:check` now enforces caller-class ownership
with a counted, reasoned allowlist; Census/Control overrides shows the exceptions.
`buttons:check` also rejects hand-drawn ButtonBase surfaces or link actions,
with rich/specialized exceptions listed in Census/ButtonBase exceptions.
`tokens:check` enforces token-owned module and inline type sizes/radii, with
counted reasons for remaining exceptions ([CSS contract](css-architecture.md#type-sizes-and-radii)). The
purpose split preserves appearance: `tokens.css` owns themes/fonts,
`base.css` owns document defaults/state, and `generated.css` styles emitted
HTML. `purposeGlobals.ts` is the common ordered entry (KaTeX, tokens, generated,
base); the three legacy stylesheets are empty pending step 8 deletion. The playground
reads token data from `tokens.css`; generated-content wrappers retain counted
context exceptions ([global contract](css-architecture.md#contract)).
Login pages share `LoginLayout.module.css`; host/monitor/share pages and relay
setup own modules. `YepAnywhereLogo` owns its login/monitor variants; callers
do not reach into its glyph or wordmark. These ownership moves preserve appearance. Cross-module look ties have explicit
winners, including host-picker heading margins and disabled/busy cursors. Source
typography keeps rem values where browser root-font preferences make a UI token
non-equivalent.
Settings row/search visibility, category icons/navigation, toolbar specimens,
shared device/command content and onboarding now use their owning modules.
The settings and onboarding move preserves all shared control states and
geometry; preview-specific data attributes mark the remaining composer boundary.
Source browser columns, search, file/revision rows, detail banners, diff controls
and file-page chrome now have shared module owners. Their compact typography,
resize geometry, selected/read cues, focus rings and phone layout stay unchanged;
source previews and EditRenderer import the same context-control look. FileViewer,
CodeOutput and DiffOutput now share source typography and gutters across viewer
and tool surfaces. Transcript lists/blocks, thinking/activity previews, tool rows
and tool-renderer families own their layout through modules. Emitted Markdown,
math and Shiki descendants share generated.css under counted data boundaries;
inline-style resets and fallback gutter specificity keep their previous winners.
These are appearance-preserving moves, including root-font scaling, streaming
input acknowledgement, hover/focus and phone geometry.
Collection pages, compact session rows, sidebar density/collapse and navigation
now retain their existing look through explicit shared modules. Page scrolling
and retained-route lookup use stable data boundaries; the composer is unchanged.
Shared page/session headers, viewport/split layout, /btw pane and footer chrome
now have module owners. Header density, inline/dialog rename, connection states,
selection shielding and content-width/overflow behavior retain their existing
look. Stable data boundaries serve DOM consumers and browser fixtures; the
composer controls now have module owners as well, with their look unchanged.
Input, toolbar and new-session forms share action/dot styles; speech, mode,
thinking, context, recall and attachment controls retain their previous states
and responsive geometry. Sequential typing remains independent of streaming
updates and must acknowledge every key within 100 ms. Control swaps still
belong to plan 182's composer pass.
Ownership repairs keep Bash/Web copied feedback visible after hover/focus ends
for its existing three-second interval; source-view partial copy remains exact.
Rendered Edit panels and Grep directory labels share their established owners.
Viewer range tints and fallback source resets are modular; only emitted Shiki
inline paint is reset globally. Composed caller layout and brand sizing have
explicit specificity, including shared wordmarks and page workspaces.

**Buttons.** `src/components/ui/Button.tsx` owns the button family:

- `Button`: variants `primary` (brand green), `secondary` (the default),
  `outline`, `ghost`, `link`, `success-outline`, `attention-outline`, `danger` and `danger-outline`;
  sizes `default`, `small`, `dense`, `large`, `inline` and `inline-icon`. `link` is link-colored text,
  transparent with an underline on hover. It inherits the surrounding font size
  and line height, has no horizontal padding or minimum height on fine pointers,
  and keeps the focus ring. Coarse pointers get an invisible hit area of at
  least 44 px without growing the text line. `success-outline` is the green
  outline used by copied transcript/tool/diff actions and active viewer links.
  `attention-outline` is the shared warning outline for both newer-content
  Reload actions and Force start. `elevated` gives Button/IconButton an opaque
  surface and shadow over content: bulk select, public-share toggle/follow and
  gallery arrows share it; filled variants retain their opaque tone.
  `large` is 36 px (44 px on coarse pointers), used by page/header navigation
  and the session-header menu. `dense` (22 px) is for controls inside dense rows
  (tool rows, code lines, hover-revealed copy actions): on coarse pointers
  it keeps its drawn size and extends its hit area by 8 px per side (38 px
  total), so adjacent dense controls do not gain overlapping 11 px halos.
  `touchTarget="large"` gives small controls a drawn 44 px touch target.
- `IconButton`: icon-only; its required `label` is the accessible name and
  the tooltip, following the user's tooltip setting (`data-tooltip` for
  `TooltipLayer` when themed, `title` when native). `tooltip` replaces the
  tooltip text when it should say more than the name (a gesture hint, a
  freshness state). Defaults to `ghost`; a ghost with `aria-pressed="true"`
  shows as a bordered, filled chip. A pressed secondary has a green border,
  and weight 600; a pressed outline also gains the green border, weight 600
  and hover surface. User chips use outline so their unselected border remains.
  A popover/menu trigger uses `data-selected={open}` for the secondary or
  outline selection border (outline also gains a fill), alongside `aria-haspopup` and `aria-expanded`; it is not a toggle.
- `ButtonBase`: an unstyled button for clickable rows, cards, disclosure
  arrows and image wrappers. Ordinary chips use Button/IconButton; rich
  whole-card actions use SelectableCard (below). Its reset has zero specificity, so the owner's styles
  always win, including ancestor rules such as `.list button`; it keeps the
  focus ring. Its text is `--font-size-base` rather than inherited, the
  size raw buttons had, so a swapped row keeps its text size; an owner whose
  row should follow its context sets `font-size: inherit`.
- `buttonClassName()`: the same look for an `<a>` or router `Link` that is a
  button-shaped navigation target.

All of them default `type` to `button`, so none submits a form unless asked,
pass ordinary button attributes through (including `data-testid`) and take
`ref`. `busy` shows a spinner, sets `aria-busy` and ignores clicks and form
submission while keeping focus. Coarse pointers get 44 px (default and
icon) and 36 px (small) controls. A text glyph used as an icon (×, ↑)
renders larger than label text. A caller's `className` adds layout only
(margins, flex placement, width); the control owns colors, borders,
padding, size and type. Look/size overrides require a counted reason in
`design/census/control-override-allowlist.json`; `pnpm controls:check` (in lint)
resolves module/global classes, states, media queries, descendant rules and
obvious prop forwarding. `--record` only lowers counts. This applies to every
shared control below, including field input and dialog body class props.
Hover-revealed copy actions remain keyboard reachable; Enter/Space on the
tool-header copy action copies without toggling the enclosing disclosure.
Caller-supplied SVGs and keyboard hints may be styled as children; descendants
owned by the shared control retain its look. See [CSS ownership](css-architecture.md#shared-control-caller-classes).

Which variant: the single main submit or confirm action of a form or
dialog is `primary`; a destructive confirm is `danger`; a destructive action
beside others (Remove, Delete, Revoke, Forget) is `danger-outline`; Cancel,
Close and every other action is `secondary`; an inline text action ("Show
more", "Copy", "Edit") is `ghost` `small`; an icon-only button is an
`IconButton`. A text action that should read as a link uses `link`. `outline`
remains for the few places that must differ from a neighbouring secondary.

Client buttons are on the shared controls except those the allowlist
below names: listbox options, the composer's controls, the crash fallback
page, and 15 pre-existing `role="button"` elements.
`pnpm buttons:check` (part of `pnpm lint`) keeps it so. It rejects:

- a retired legacy class recorded in `design/census/button-allowlist.json`'s
  permanent `bannedClasses` list (`toggle-switch`, `font-size-option`, …).
  Deleting a census row or restoring CSS never lifts a ban. Before retiring
  a row whose rules are deleted, add all its retired classes to that list;
- a raw `<button>` outside `ui/Button.tsx` and the shared selection, menu
  and tab controls, unless it sits in a composer file;
- a new `role="button"` element (use `ButtonBase`);
- a CSS rule, module or global, whose selector reaches a bare `button`
  element and sets look or size properties (`.panel button { background:
  …; min-height: … }`), which would outrank `ButtonBase`'s reset and tie
  with `Button`'s variants;
- a `role="switch"`, `role="radio"` or `role="radiogroup"` (as an
  attribute, in a conditional, or as a `role:` prop) outside
  `ui/Switch.tsx` and `ui/SegmentedControl.tsx`. A `role="option"` button
  (a listbox in a dropdown) counts as a raw button;
- a menu role (`menu`, `menuitem`, `menuitemradio`, `menuitemcheckbox`,
  `menubar`) outside `ui/Menu.tsx`;
- a press or focus listener (`mousedown`, `pointerdown`, `touchstart`,
  `click`, `focusin`) on the document, its body or the window (also
  through a `doc` or `*Document` variable) outside `ui/Popover.tsx`: the
  mark of a hand-rolled outside dismissal. Plumbing that needs one (drag
  and text selection, pull to refresh, the tooltip layer, link routing in
  share frames) is allowlisted with its reason;
- a raw `<input>` (text types, number, checkbox, radio; not range, file,
  hidden or color), `<select>` or `<textarea>` outside `ui/Field.tsx`,
  `ui/Checkbox.tsx` and `ui/Switch.tsx`, and a CSS rule whose selector
  styles a bare `input`, `select` or `textarea` element with look or size
  properties (`.form input { border: … }`); the legacy field classes
  (`settings-input`, `settings-select`, …) once their rules are gone;
- a tab role (`tab`, `tablist`, `tabpanel`) outside `ui/Tabs.tsx`, a
  `@keyframes` set that rotates outside `ui/Spinner.module.css`, and the
  legacy banner, badge, spinner and tab classes (`settings-warning`,
  `form-error`, `badge-error`, `login-spinner`, `model-switch-tab`, …,
  recorded in `bannedClasses`);
- a native `window.confirm`, `alert` or `prompt` call outside
  `ui/ConfirmDialog.tsx`, an `aria-modal` attribute or `alertdialog` role
  outside `ui/Modal.tsx`, `ui/Dialog.tsx` and `ui/ConfirmDialog.tsx`, a
  CSS Module rule outside `components/ui` that reaches into Modal's frame
  (`:global(.modal…)` or `[data-modal-*]` frame hooks), a global `.modal…:has(…)` rule, and the old dialog
  frame and footer classes (`model-switch-actions`, `onboarding-footer`, …,
  recorded in `bannedClasses`).

Exceptions sit in `design/census/button-allowlist.json`, each with a count
and a reason; counts only fall (`--record`). Census/Element exceptions lists
all nonempty sections, including CSS rules and document listeners, with each
file's count against its section's exception total. Composer-file exemptions
are also visible on Census/Composer even when they need no counted entry.

**Selectable cards.** `src/components/ui/SelectableCard.tsx` owns rich card
and navigation-row surfaces. Hover uses a neutral border only on hover-capable
fine pointers; `selected` sets `aria-pressed`, while navigation uses
`aria-current` (`page` or `true`). Current/selected surfaces have a green border
and tinted fill distinct from hover, including on touch. Ordinary actions omit
both attributes. Default cards are at least 44 px tall; `size="compact"` gives
36 px mouse rows and 44 px touch rows. `variant="quiet"` de-emphasizes secondary
login choices with a transparent, dashed surface; `variant="accent"` keeps the
project queue's 3 px leading accent. Disabled cards mute text without dimming
children; `aria-busy` preserves full spinner emphasis while connecting.
Caller classes own content layout only. Login/host/share/answer actions,
SidePanel and project queue rows, child/conversation/settings/submission
navigation share it. Specialized measured transcript previews retain ButtonBase
with explicit reasons. Patterns/Selectable card shows these states.

Buttons support `textFlow="wrap"` (inline text flow, anywhere wrapping) and
`textFlow="truncate"` (a single ellipsized line within the caller's width).
`mono` uses the fixed-font family and size; filename actions use this consistently
across Read/Edit/ViewImage/WriteStdin and review-comment locations.
`FileActionButton` supplies the wrapping mono link defaults for edit summaries.
`size="inline"` keeps gallery chips at 0.78em without growing prose line boxes;
`inline-icon` draws an 11 px path-copy icon. Both retain invisible 44 px coarse
hit areas. `subdued` starts at 40% opacity and reveals on hover/focus/copy success.
`CopyTextButton` uses Button/IconButton; success-outline feedback lasts 1.8 s.
Prompt action slots and measured controls agree at 26 px fine / 36 px coarse,
independent of prompt width. Math/render toggles use an opaque elevated surface
and retain hover/focus reveal on both mouse and touch; they remain Tab reachable.

**Switches and segmented controls.** `src/components/ui/Switch.tsx` is the
on/off control: a native checkbox with `role="switch"` drawn as the 44×24
track the settings pages always had. Space toggles it and assistive
technology announces it as a switch. `onCheckedChange(checked, event)`
reports changes. Name it with `label` (visible text beside the track;
clicking the text toggles) or, in a row whose own text names it,
`aria-label`. On coarse pointers its hit area grows to 44 px tall without
growing the row.

`src/components/ui/SegmentedControl.tsx` picks one value of several. It is a
radio group: `role="radiogroup"` with `role="radio"` options, one tab stop
(the selected option, else the first enabled one), and arrow keys, Home and
End that move focus and select, skipping disabled options. It has two looks
with one behavior: `segmented` (default; options in one track, the selected
one filled in the primary green) for short labels, and `cards` (each option
framed, the selected one outlined in green) for options with an icon, a
swatch or a description line. `layout` is `inline`, `fill` (equal widths
across the row) or `stack` (one option per row); `size` is `default` or
`small`. Options take `icon`, `description`, `disabled`, `ariaLabel` (for an
icon-only option), `tooltip` (through `TooltipLayer`, as on `IconButton`)
and a `className` that lands on the label text, for content styling such
as a font preview; a `description` describes its option rather than
adding to its name. Name the group with `aria-label` or
`aria-labelledby`. A group whose change saves to the server sets
`activation="manual"`: arrows move focus, Space or Enter selects, so
arrowing across options does not send a write per key. Disabled options
are `aria-disabled` rather than natively disabled, so a group disabled
while it saves keeps keyboard focus.

Which control: one setting on or off is a `Switch`; one of several values
is a `SegmentedControl`; one thing on or off in a toolbar stays an
`IconButton` or ghost `Button` with `aria-pressed`, and so does a
multi-select chip filter. Radios inside a dropdown are `Menu` radio items;
a choice whose options sit in separate rows is a `Radio` (Fields, below).

**Menus and popovers.** `src/components/ui/Popover.tsx` is the anchored
floating surface: menus, dropdowns, pickers and small panels that open from
a trigger (`anchorRef`), a measured rect (`anchorRect`) or a point
(`anchorPoint`, a context menu at the pointer). It renders through a portal
into `document.body` at `--z-popover`, above modals and below tooltips, on
the raised `--bg-elevated` panel with `--shadow-lg`. A script places it: it
flips to the side with more room, shifts to stay in the viewport, caps its
height to the room left, and follows scrolling, resizing and its own size.
It closes on a press outside the surface and its trigger (document capture
phase, so a row or `Modal` that stops its own events cannot hide the
press), and the click that ends that press is swallowed, as the old
dismiss overlays did, so dismissing a menu never also presses what lay
under it (a row, a link, a dialog's backdrop). It also closes on Escape,
when its trigger is hidden (a parked page) or scrolled out of view, and
optionally on the phone back gesture (`closeOnBackGesture`). Inside a
`Modal` it portals into the dialog element, so assistive technology does
not treat it as outside the modal dialog. Escape goes through `Modal`'s layer stack
(`useModalLayer`), so inside a dialog the popover closes first; a field
inside it can keep Escape for itself through `onEscapeKeyDown`. Focus inside
the surface returns to the trigger when it closes. A popover opened from
another (a submenu) is nested: presses inside it are not outside its parent.
`phoneSheet` presents a long picker as a bottom sheet over a backdrop on
phones (≤768 px), and `maxHeight` caps a long list below the room left.
`surface` is `panel` (menus: 4 px padding, small type), `card` (help text
and small forms: roomier padding) or `plain` (the content frames itself).

`src/components/ui/Menu.tsx` puts `role="menu"` on a `Popover`. Opened
from the keyboard it focuses the first item (a radio menu its checked
one); opened by pointer it leaves focus where it was, as menus here
always did, so a click never pulls focus out of the composer, and the
first arrow key brings focus in. Arrows wrap, Home and End jump, a letter
jumps to the next item whose label starts with it, Tab closes. `MenuItem` takes `icon`,
`description`, `shortcut`, `tone="danger"`, `tooltip` (a disabled item stays
focusable, `aria-disabled`, so its tooltip can say why) and `checked` with
`kind` (`menuitemcheckbox` or `menuitemradio`); selecting closes the menu
unless `keepOpen` or the handler calls `preventDefault()`. `MenuLinkItem`
is an item that is a link (`href`, with `onNavigate` to route in-app), so
copying the link and modifier or middle clicks work as on any link and
keep the menu open. A radio menu opens on its checked item. `Menu`'s
`selection` says how checked items look: `mark` (default) puts a dot or
check in a leading column; `highlight` tints the checked row instead, for
select-style lists whose rows lead with their own dots or badges.
`FilterDropdown` uses `highlight` for single-select. Its `triggerSize` passes
a shared Button size through; `triggerClassName` adds layout only. `MenuGroup`
labels a group and `MenuSeparator` divides. `useMenuTrigger()` wires the
trigger: `aria-haspopup="menu"`, `aria-expanded`, toggle on click,
ArrowDown to open.

Why not the Popover API's top layer: it would cover the tooltip layer; `Modal`'s capture-phase Escape handler cancels the key before a
popover's close request, so popovers need the layer stack anyway; and
`popover="auto"`'s light dismiss races React-owned open state on the
trigger's own click. CSS anchor positioning is missing from older iOS
WebKit (the native shell). One script path places every popover, and
`Modal`'s anchored mode shares its placement function. `Modal` stays a
portal `div` rather than `<dialog>` (see Dialogs below).

Which control: a list of actions is a `Menu`; a one-of-several choice in a
dropdown is a `Menu` of radio items, and a filter with several selections a
`Menu` of checkbox items; anything else floating (help text, a small form, a
list of links with other content) is a `Popover` with its own role
(`dialog`, `status`). Completion lists driven by a text field stay
listboxes, and hover cards stay with `TooltipLayer`'s timing.

**Fields.** `src/components/ui/Field.tsx` owns the text fields:
`TextInput` (a single-line `<input>` of any text type, number included),
`Textarea` and `Select` (a native `<select>` with a chevron drawn in the
text color). They share one box: `--bg-input` with an `--border-input`
border, 32 px tall (44 px on coarse pointers), small type, the
`--focus-border` ring every control uses, a red border while
`aria-invalid`, and `size="small"` (26 px) for dense rows. `mono` sets the
code font for commands, paths, tokens and ids; `unit` puts a muted unit
after a narrow number box without spinners (`inputClassName` then sizes
the box). Inputs and textareas fill their container, selects size to
their options, and the open option list is pinned to the theme's colors. They
are plain elements with no state of their own, so the caller's `value` and
`onChange` reach the element untouched and typing costs nothing beyond the
caller's render (the 100 ms rule in [AGENTS.md](../AGENTS.md)). Width
defaults to the container's at zero specificity, so a caller's single
layout class wins; the control owns everything else.

`Field` is a label above one control, with an optional `hint` and `error`
below: it names the control with `<label htmlFor>`, links the hint and
error through `aria-describedby`, marks the control `aria-invalid` while
`error` is set and `required` when asked. The control picks these up from
context, so `<Field label="URL" hint="…"><TextInput … /></Field>` needs no
ids; inside a `Field` the Field's id wins over the control's. A settings row whose own title names its control passes `aria-label`
instead.

`src/components/ui/Checkbox.tsx` has `Checkbox` and `Radio`: native inputs
in the accent green, with an optional `label` (clicking it toggles) and a
muted `description` line that describes rather than names, and
`onCheckedChange(checked, event)`. `indeterminate` shows a mixed state.

Which control: one setting on or off that applies at once is a `Switch`; a
checkbox picks several independent things (a selection, a filter, an
"also do this" beside a form's submit); one of several values shown
together is a `SegmentedControl`; `Radio` is only for a choice whose
options sit in separate rows or cards (the default among listed services).

**Banners, badges, spinners and tabs.** `src/components/ui/Banner.tsx` is
a message about a page, panel, form or action: `tone` `info`, `success`,
`warning` or `error`, drawn as a box tinted from the tone's color with a
tone-colored left edge, text in the primary text color. `title` is a bold
first line, `actions` hold its buttons (they wrap under the text when the
banner is narrow), and `onDismiss` with a `dismissLabel` adds a close
button (the caller's translated label; the control takes no i18n
context). An error banner is `role="alert"`, the
others `role="status"`; a notice that is part of the page from the start,
or comes from polled state, passes `role="none"` (`"note"` for an aside),
so it is not read out on load or on every poll. A live region announces
changes to content already on the page, so a result that replaces an
earlier one (saved, then failed, then saved) keeps one mounted status
element and changes its text, with an error banner beside it. `compact`
tightens it for a row or small panel. `elevated` supplies the shared large shadow
for notices floating above page content; caller classes supply their placement. An error or warning that belongs to
one field is that `Field`'s `error` or `hint`, never an alert that fires
as the user types. Toasts,
tool output error text in the transcript, system message rows and empty
states are not banners.

`src/components/ui/Badge.tsx` is a short label that is not a control: a
state, a kind or a count. `tone` is `neutral`, `info`, `success`,
`warning`, `danger` or `accent` (the brand green, for "current", "default",
"live"); `emphasis="soft"` is a tint with colored text and `solid` a filled
chip for counts that ask for attention; `shape="count"` is a pill with
tabular figures; `size="small"` fits dense rows; `mono` sets the code font.
Soft text is the tone mixed toward the text color, and the accent and danger
solid fills are darkened, so 10–11 px type stays above 4.5:1 in every
theme. A component whose color comes from data (a provider's brand color)
sets `--badge-color` and `--badge-soft` (and `--badge-on` for solid text)
on a compounded class it passes (`.badge.claude`), never `color` or
`background`. A count or a state its text does not say needs `role="img"`
with an `aria-label`; `tooltip` is visual and names nothing. A clickable
chip is a button, not a badge. Only a badge with a `tooltip` subscribes to the
tooltip setting, so badges cost nothing extra in the transcript.

`src/components/ui/Spinner.tsx` is the one busy indicator: a ring in the
current text color with one gap, `small` (0.9em, inline with text and in
`Button`'s `busy` state), `default` (16 px) and `large` (32 px, page-level
loading), slower under reduced motion. Without `label` it is decoration
beside text that says what is happening; with `label` it is a
`role="status"` named by the label, which it also holds as visually hidden
text so screen readers announce it. It reads `--ya-activity-play` where an
ancestor sets it, so a tool row scrolled out of view pauses its spinner;
elsewhere it runs. Its keyframes are the client's
only rotating set.

`src/components/ui/Tabs.tsx` is a tab strip: `role="tablist"` with
`role="tab"` buttons, one tab stop, Left/Right, Home and End that move and
select (`activation="manual"` to move focus only), disabled tabs skipped.
`variant="underline"` (default) heads a pane, dialog or panel and wraps
onto a second row rather than scrolling tabs out of sight;
`variant="pill"` sits in a toolbar or page header. `layout="fill"` gives
equal columns whose labels wrap, `fill-phone` only at ≤760 px. A tab takes
`icon` (decorative, so a state it shows, such as answered ✓, also goes in
`ariaLabel`), `count` (a small count badge, part of its name unless
`ariaLabel` replaces it) and `ariaLabel`. Tabs whose switch is costly (a
route change, heavy panes) use `activation="manual"`. Given an `id`, the selected tab points at the
`<TabPanel tabsId={id} value={tab}>` holding its pane, which is labelled
by the tab.

Which control: a message about a page or action is a `Banner`, a passing
confirmation of an action a toast; a label beside content is a `Badge`;
work in progress is a `Spinner`, or `busy` on the button that started it;
switching between panes of one surface is `Tabs`, choosing a value a
`SegmentedControl`.

**Dialogs.** `src/components/ui/Modal.tsx` is the modal surface: overlay,
Escape through the layer stack, Android back (`closeOnBackGesture`),
optional anchoring beside a trigger, a header with the title and close
button, and a scrolling content area. It is named by its title
(`aria-labelledby`), keeps Tab inside itself, and returns focus to the
element that opened it when it closes (or to the menu trigger, when a
menu item that opened it went away with its menu). A Tab pressed while
focus is on nothing, because the focused control was removed or
disabled, goes back into the topmost modal. It stays a portaled `div` rather
than a modal `<dialog>`: the tooltip layer, hover cards and selection
actions portal into the body, and the top layer would draw over them and
make them inert. Viewers (files, diffs, media, logs, process details) use
`Modal` directly. `ui/Modal.module.css` owns the shared frame; stable
`data-modal-*` hooks identify frame, overlay, header, title and scrolling content.
Existing caller frame reach-ins remain counted exceptions, including attribute
aliases, until shared variants replace their specific geometry requirements.

`src/components/ui/Dialog.tsx` is the pattern for everything else shown
over the page: a form, a choice, a notice. `size` is `small` (24rem, a
confirmation or one field), `medium` (32rem, the default, a short form) or
`large` (48rem, a long form or a list); on phones every size is a
full-width card near the top, as tall as its content and clear of the
keyboard (content that needs the whole screen sets its own height).
`layer="confirm"` (`--z-confirm`) draws above every full-screen surface,
for a question one of them asks.
The body is padded and stacks its children with one gap; `description` is
an intro sentence the dialog is described by; `footer` is the action row
below the scrolling body, and `footerStart` holds actions for its other
end (Back, Skip). The footer applies the button variant rule: Cancel and
other secondary actions first, at most one `primary` action last, and a
destructive confirmation `danger` instead of primary. A form keeps its
`<form>` in the body and its submit button in the footer names it with the
`form` attribute, so Enter in a field still submits. Width and padding come
from `size`, never from a caller rule on Modal's frame.

`confirmDialog({ title, message, confirmLabel, tone })` in
`src/components/ui/ConfirmDialog.tsx` replaces `window.confirm`: a small
`alertdialog` whose title asks the question ("Delete user?"), whose
message says the consequence, and whose confirm button names the action;
`tone="danger"` makes it a danger button and starts focus on Cancel. It
draws on the confirm layer, above the source editor and other full-screen
surfaces, and the same question asked again while open (a double click)
is answered "no" at once. It resolves `true` or `false`, so the caller
awaits it. One
`ConfirmDialogHost` per entrypoint shows requests in turn; without one (a
component test) it falls back to `window.confirm` with the message.
`promptDialog` does the same for one text answer (`window.prompt`).

**Layers.** The design language has four layers. Each lower layer may not
depend on a higher one:

1. **Tokens:** the theme custom properties in `src/styles/tokens.css`
   (color, spacing, radius, type, shadow and the layer scale `--z-modal`,
   `--z-popover`, `--z-confirm`, `--z-tooltip`). Other fixed surfaces still carry their
   own numbers, some above `--z-modal` (the source editor, the fullscreen
   file viewer and its toolbar, the prompt history rail); popovers stay
   above them, and moving them onto the scale is open. A token used in client CSS must be defined in every client
   theme, and `pnpm css:check` rejects a read of a property no client source
   defines ([CSS architecture](css-architecture.md#contract)). Surfaces are
   `--bg-surface` (the page), `--bg-secondary`/`--bg-tertiary` (panels),
   `--bg-elevated` (popovers, menus, raised cards) and `--bg-input` (fields);
   `--bg-error`, `--bg-warning`, `--bg-success` and `--bg-selected` are tints
   mixed from each theme's status and primary colors; `--shadow-sm/md/lg`
   is the elevation scale; `--radius-full` makes a pill. The type scale is
   `--font-size-xs` 10px, `-caption` 11px, `-sm` 12px, `-base` 13px,
   `-lg` 14px, `-xl` 16px and `-2xl` 18px at 100%. All seven follow the
   UI font preference: the default 115% gives an 18.4px root (1rem), with
   each type token multiplied by 1.15. Rem conversions compare those computed
   sizes; fixed radii do not scale with that preference. The radius scale is
   `--radius-xs` 3px, `-sm` 4px, `-md` 6px, `-lg` 8px and `-full` 999px.
   The Tokens/Scales page shows every step. A new step needs roughly eight
   uses; uncommon heading/glyph sizes and user-configured output/source sizes
   retain counted reasons instead. Values every theme
   shares, the dark defaults and the tints live in one `[data-theme]` block
   before the theme blocks, so a nested theme (a playground cell) resolves
   its own.
2. **Controls:** prop-driven shared components in `src/components/ui/`, each
   with its own CSS Module. The planned set is `Button`, `IconButton`,
   `Switch`, `SegmentedControl`, `Checkbox`, `Field`, `Popover`, `Menu`,
   `Banner`, `Badge`, `Spinner`, `Tabs`, `Modal` and `Dialog` (with
   `confirmDialog`), beside `TooltipLayer`. A control renders from props alone: no server, router or
   app-level context. Needing a service makes it a pattern or a scene.
3. **Patterns:** reusable compositions of controls, such as a settings row,
   a confirm dialog or an icon toolbar group.
4. **Scenes:** real surfaces rendered with fixture data. Server-backed data
   reaches a scene through injected services (React context), never through
   bundler aliasing of production modules.

**Unification rules.**

- Control families are unified one at a time, each finished before the next:
  census, build the shared control, swap every use, delete the old CSS, ban
  the old way. The plan owns the order; composer controls are excluded until
  their own pass.
- During a family sweep, choose variants from a temporary census of legacy
  looks beside the proposed shared set. Once swept, remove those rows and
  their mapping data; Controls/Patterns remain the standard to use, and
  Census lists only work still outside that standard.
- A swap adopts the canonical variant even where the old style differed;
  design changes are accepted and fallout is fixed as noticed. It is a quick
  cut in a few area-sized commits, not an opportunistic burn-down.
- A legacy class whose uses reach zero has its rules deleted in the same
  slice, global stylesheets included. Once a family is swept, lint rejects
  its old classes outright, and new code uses the shared control.

**Playground.** `packages/client/design.html` is a separate entry served by
the Vite dev server at `/design.html` on the YA dev port (local or Tailscale).
The remote static build also includes it, so the normal Latest deployment
publishes it at `https://latest.yepanywhere.com/design.html` alongside the app,
without a separate release or a running YA server. The same build works below
a configured base path (for example `/remote/design.html` on the website).
Census data reflects the deployed source revision; development recomputes it
as sources change. Hash links, themes, phone frames and isolated states work
in both builds. The local packaged client does not include the playground.
Biome rejects any import of
`packages/client/design/`, a `*.specimen.tsx` file or the playground's data
module from production client code.

Example files are `*.specimen.tsx`: beside their component under `src/`, or
under `packages/client/design/` for playground-only pages. They use a
Storybook-compatible subset of Component Story Format: a default export
`{ title, component?, parameters }`, where `parameters.layer` is `token`,
`control`, `pattern`, `scene` or `census`, and one exported function per
state, optionally named with `storyName`. Decorators, args, loaders and play
functions are not supported. Ids follow Storybook's rules: `Census/Composer`
is `census-composer`, and its `Remaining` state is
`census-composer--remaining`. States keep source order.

| URL (after `/design.html`) | Shows |
| --- | --- |
| `#/` | Index, grouped by layer |
| `#/<specimen-id>` | Every state, one column per theme (verydark, dark, light) |
| `#/<state-id>` | One state across the themes |
| `…?theme=light` | One theme only |
| `…?phone` | Grid cells as 375 px frames, so media queries respond |
| `#/<state-id>?iso&theme=light` | The state alone on a bare page, for capture |

Every page except an isolated state has a sidebar listing the layers and
their specimens, with the current specimen's states expanded beneath it. Its
top holds the global view settings: themes shown (all, or one of the three)
and width (natural or phone). They live in the URL (`?theme=light`,
`?phone`), and every playground link carries them, so a choice holds while
navigating. With one theme chosen the whole page, sidebar included, takes
that theme; with all three, each cell carries its own and the shell stays
dark. Below 760 px wide the sidebar
becomes a drawer behind a **Pages** button, which closes on following a link,
Escape or a tap outside it, and the theme columns stack. Specimens with
`parameters.width: "fill"` (census and token pages) always stack their themes,
and their rows wrap details under the name rather than narrowing a column.
Each grid cell carries its own `data-theme`, so theme tokens resolve per cell.
An isolated page marks `[data-design-ready]` once fonts load; a state still
loading data marks an element `data-design-pending`, and capture waits for it
to go. A state that throws renders its error in place and logs a console
error.

```bash
pnpm -s design:index                       # JSON: every specimen, state and URL
pnpm -s design:shot census-composer         # each state, dark theme, 1000 px
pnpm -s design:shot tokens--colors --theme all --phone
pnpm -s design:shot controls-button--variants --grid --theme all
pnpm -s design:shot census-composer --url http://localhost:3400
```

`design:index` parses the example files statically, so it needs no browser or
server; check it before writing a new control. `design:shot` starts a
private dev server for the checkout on a free loopback port (with its own
optimizer cache) and closes it afterwards, unless `--url` names a running
one. It captures full-page PNGs in the system Chrome inside its sandbox and
writes them with the same `capture.json`, `links.md` and image commentary as
`artifact:capture`, under `.artifacts/design-shots/`. Page errors, console
errors, failed requests and HTTP errors fail it with exit 3; invalid
arguments exit 2. Inspect the images before claiming visual quality.

The playground's pages:

- **Tokens:** every theme color resolved in each theme, the spacing, radius,
  elevation and type scales, and the undefined properties (none since the
  2026-11-09 token pass; the page lists any a future baseline records).
- **Controls/Button:** every variant, size and state of the shared button
  family.
- **Controls/Switch** and **Controls/SegmentedControl:** each state, both
  looks, sizes and layouts.
- **Controls/Field:** text inputs, selects, textareas, checkboxes and radios.
- **Controls/Menu**, **Controls/Banner**, **Controls/Badge**,
  **Controls/Spinner** and **Controls/Tabs:** the shared states and variants.
- **Controls/Dialog:** shared dialog sizes, forms, choices and confirmations.
- **Patterns/Selectable card:** shared rich action and navigation surfaces.
- **Census/Composer:** remaining composer look rules with module locations and
  excluded raw buttons/fields with TSX locations. Their appearance now lives
  in owner/shared CSS Modules. It owns plan
  182's composer follow-up; no swept-family samples remain.
- **Census/Control overrides:** every counted caller-style exception, split
  into button and other-control sections.
- **Census/ButtonBase exceptions:** counted rich/specialized painted targets.
- **Census/Element exceptions:** every nonempty section of
  `button-allowlist.json`: raw buttons, roles, fields, modal reach-ins,
  look rules, rotating keyframes and document listeners. Permanent class
  bans are enforcement history, so they are not open-work rows.
- **Census/Token literals:** counted module/inline type and radius exceptions.
- **Census/Runtime class families:** each declared runtime/generated pattern,
  emitter, match count against all global classes, reason and closure boundary.
  Generated markup may remain a deliberate continuing exception.

Every census page begins with what it lists, what done means and its enforcing
command. Rows use one layout: element/class, location or use count, why it is
an exception, and what closes it. Allowlist rows show each file's count against
the section's total exceptions (not a historical migration denominator).
Counts and reasons come directly from the enforcement lists. The separate
"Button elements, by directory" view and its shared/link inventory are removed
because the exception pages cover the remaining work; parser scans of raw
buttons and fields remain necessary for lint and the composer page.

The Vite data plugin refreshes composer locations and runtime match counts
when source or census inputs change and freezes them into the remote build.
It does not load every component's CSS Module to render legacy samples.

No visual-regression test of the playground runs in CI. Screenshots are
taken on demand.

**Screen tour.** `pnpm -s design:tour --label before` captures the main
screens (projects, a session, new session, the file viewer, source control
and every settings section) in dark and light at 1000×600 and 375×812. It
runs `e2e/tour/screen-tour.tour.ts` through `playwright.tour.config.ts`,
which reuses the E2E suite's global setup: a freshly built client and an
isolated server with the fixture profile, never the operator's YA. The
relay is not started. Each capture is the viewport as a user first sees it,
written through `recordUiCapture` into `.artifacts/design-tour/<label>/` and
presented by the suite's teardown. `--grep settings` limits it to matching
screens; an existing label directory is refused (exit 2) and a failed screen
exits 3. Settings sections also get a dark 1000×2400 capture, because their
panes scroll inside the page where a full-page screenshot cannot reach
controls below the fold, and every screen gets a dark touch-phone capture
(375×812 with `isMobile` and `hasTouch`) so coarse-pointer sizing shows; the
plain phone captures are a narrow desktop viewport. The `.tour.ts` suffix
keeps it out of the ordinary E2E run and CI.
A control-family batch runs it before and after its swap to review the
fallout side by side.

**Mockup lifecycle.** A proposal mockup is temporary. Delete it in the change
that implements or abandons the proposal; git history keeps it. Do not leave
proposal fixtures checked in after the real UI ships. When the playground
lands, proposals become proposal scenes that declare their owning tactical
plan or gap, and a check fails once that owner is gone or marked done.
Reference scenes render only real components and are kept. The existing
`packages/client/mockups/` directories are scheduled for deletion once the
export tests below move to a playground export.

## Authoring and commands

This section describes the current export fixture. Plan 182 replaces it with
a static export of the playground, after which the `mockup:*` commands are
removed.

The retained example is `packages/client/mockups/projects/`: an HTML entry,
React source importing the actual `ProjectCard`, and a fixture-owned CSS
Module. Sixteen sample projects exercise attention/queue counts, long content,
responsive columns, code-name chips, captions, and the card's gear/trash/plus
controls; every third project omits its caption and code name so the sparse
card is covered too. Each card has four SVG controls: settings, removal, new
session, and the caption pencil, including when the caption is empty (64 SVGs
across the 16 cards). `I18nProvider` uses English, and `MemoryRouter` keeps
card/new-session navigation inside the fixture. The gear, trash, and inline
code-name/caption editors change local feedback or preview state only;
navigation displays its destination. No action contacts a provider, changes or
removes a project, or starts a session. The fixture's explanatory copy and sample data are fixed English.

From the checkout root:

```bash
# Author the fixture on an unused port; stop this server when done.
pnpm --filter @yep-anywhere/client mockup:dev --host 127.0.0.1 --port 4310 --strictPort

# Typecheck and build HTML/CSS/JS/assets plus the versioned manifest.
pnpm --filter @yep-anywhere/client mockup:build

# Build, compare source/export renders, capture, and check direct YA viewing.
pnpm --filter @yep-anywhere/client mockup:export

# Repeat capture/direct verification against an existing build.
pnpm --filter @yep-anywhere/client exec playwright test --config playwright.mockups.config.ts

# Independently build the fixture and check hosted-relay viewing.
pnpm --filter @yep-anywhere/client exec playwright test --config playwright.artifact-relay.config.ts
```

Playwright Chromium must be installed for export/capture. The relay test also
requires OpenSSL and the relay workspace's native dependencies; see the
[isolated relay recipe](media-rendering-and-routing.md#interactive-artifact-relay-verification)
for the temporary-home wrapper and browser cache setting. The source/dev and
viewer servers used by tests are fresh, use unused ports, and are closed
by the tests. No test restarts the operator's YA server.

Output is `.artifacts/mockups/projects/`. A build replaces that generated
directory; copy an export elsewhere before regenerating if it must be kept.
The source stays in Git. `mockup:build` does not produce screenshots;
`mockup:export` is complete only on exit 0 and adds four PNG captures plus
`review.html`, whose images link to their interactive document/state.
Source-comparison and direct/relay captures are retained separately under
`.artifacts/mockups/captures/projects/`.

To revise the example, change its fixture source/data and regenerate. To build
another surface, use an isolated HTML/React entry with its actual component
providers and explicit local service substitutes, then adapt the fixture root,
metadata, and behavior assertions. The current adapter is one example, not a
component catalogue or arbitrary source-to-HTML converter. Production client
entries do not import it.

## Portable artifact captures

For an already-built HTML entry or an existing HTTP(S) artifact URL, use the
committed command from the checkout root:

```bash
pnpm --filter @yep-anywhere/client exec playwright install chrome
pnpm -s artifact:capture path/to/index.html --json
pnpm -s artifact:capture path/to/index.html --out .artifacts/captures/review-1 --json
```

The first command is one-time browser setup after the normal `pnpm install`
or `pnpm setup:core`; skip it where Google Chrome is already installed. The
capture renders agent-authored pages, so it runs them in the system's Google
Chrome, which the OS keeps current with security fixes, rather than in
Playwright's pinned Chromium build, which lags them; and, like every Chromium
launch in this repository, inside Chrome's sandbox. `pnpm lint` rejects a
launch that omits `chromiumSandbox: true`. No private dotfiles, `~/agents` checkout, Python, relay
installation, running YA server, or configured artifact hostname is required.
The helper uses the existing Node/tsx, Playwright, shared capability code, and
server MIME table. It is development tooling and is not imported by the app.

The command captures exactly 1000×600 and 375×812 viewport PNGs in fresh browser
contexts. Local entries use a browser-only HTTP origin rooted at the HTML
directory; requests for sibling styles, modules, images, and fonts are served
from disk without a listening port. Canonical paths must stay in that directory,
including through symlinks. Requests outside the document origin fail unless
`--allow-network` is explicit. Service workers are blocked; no browser profile,
YA cookies, or existing tab is reused. This is a static-bundle renderer, not a
development server or backend API emulator.

Before the browser starts it also makes a color emoji font available to this
host, so YA's emoji-bearing UI photographs as itself rather than as fallback
boxes; [UI testing](ui-testing.md#emoji-need-a-font-on-the-capture-host) owns
that contract, including the one-download-per-machine cache and what a host
without fontconfig reports instead.

It waits for network idle and fonts, and accepts `--ready-selector <css>` for
an application-specific ready state. Load failures, console errors, missing
assets, and operation timeouts fail the command. Browser warnings remain visible
in the JSON `warnings` array and Markdown handoff; captures with warnings do not
certify a clean page. `--timeout-ms` defaults
to 30000 per browser/API operation.
Capturing succeeds only after both viewports and the output manifest are
written. A successful capture does not certify appearance or test interaction:
the agent must open and inspect both PNGs sequentially before handing them off.
Behavior checks belong to the caller's browser workflow or the interaction
module described below; capture alone makes no assertions about them.

Each invocation owns a new directory, defaulting to
`.artifacts/captures/<unique-id>/` in this checkout. `--out` selects another new
directory; an existing directory fails rather than overwriting prior captures.
The helper never edits Git excludes or the input bundle. Output files are
`desktop.png`, `phone.png`, `capture.json`, and `links.md`. JSON stdout is one
complete object by default (`--json` makes this explicit); `--text` emits the
same Markdown as `links.md`. Use `pnpm -s` to keep pnpm banners out of stdout.
JSON includes `_acli.commentary` by default: the Markdown handoff followed by
an ordinary two-column Markdown table containing image references for both
captures, labeled with their viewport dimensions. Expanding both previews
shows the sizes side by side; no custom image syntax is required.
`--no-commentary` omits that metadata while retaining all ordinary result
fields; `--text` has no structured metadata.
`--help` and the script header declare `acli: 1 +commentary`; ordinary
execution emits `# acli: 1 +commentary` on stderr before capture work.
`--acli-quiet` or nonempty `ACLI_QUIET` suppresses that banner and therefore
does not activate YA's current output-based commentary recognition.
Errors are structured JSON on stderr; exit 0 means complete, 2 means invalid
arguments, and 3 means a capture/delivery/filesystem failure. Partial PNGs may
remain after failure, but are not a successful handoff.

### Capturing a driven workflow

An explicit local interaction module can reach the desired state before each
capture:

```bash
pnpm -s artifact:capture path/to/index.html --interact path/to/workflow.mjs --ready-selector '[data-ready]' --json
```

The module default-exports an async function receiving `{ page, viewport }`:

```js
export default async ({ page, viewport }) => {
  await page.getByRole("textbox", { name: "Reply" }).fill("Show this result");
  await page.getByRole("button", { name: "Submit" }).click();
  await page.getByText("Show this result", { exact: true }).waitFor();
};
```

The module is trusted caller-owned Node code, loaded from the supplied path
relative to the command's working directory; JavaScript and TypeScript are
supported by the existing tsx entry point. It is never loaded from artifact
content. It runs once in each fresh viewport after DOM-content navigation,
before `--ready-selector`, font readiness, and the screenshot. The ordinary
no-module path retains its network-idle wait. Playwright operations use the
configured timeout; the module owns any non-browser waits and assertions.
Keep its stdout clear for the command's JSON result. Callback errors fail the
capture, close the browser, and revoke any grant created by this invocation.
Network restrictions and YA-header separation remain unchanged. Reopening
the artifact starts the document normally; the interaction module is not
bundled into the document or replayed by the viewer.

For an existing Playwright workflow that already owns its browser, input
sequence, authentication, and screenshots, import `writeCapturePreview` and
`emitCapturePreview` from `packages/client/scripts/artifact-capture.ts`:

```ts
const preview = await writeCapturePreview({
  input: "Session question workflow",
  out: ".artifacts/provider-output-contract/20260908T070000Z-question-menu",
  screenshots: [
    { name: "desktop", width: 1000, height: 600, path: desktopPng },
    { name: "phone", width: 375, height: 812, path: phonePng },
  ],
  warnings: browserWarnings,
});
emitCapturePreview(preview);
```

This helper verifies nonempty screenshot files, canonicalizes their paths,
and writes the same `capture.json`, `links.md`, and image commentary used by
the CLI. It accepts one or more uniquely named states with positive viewport
dimensions. It never navigates, recaptures, copies images, closes the caller's
browser, or creates a delivery grant. The caller remains responsible for
assertions, browser errors, warning collection, and teardown. Optional `file`
and `delivery` describe an already-established interactive artifact; omit them
for screenshots of an ephemeral test server. Existing manifest or link files
are not overwritten; failure can leave partial output, never a success result.
`emitCapturePreview` writes the capability banner and JSON to the tool output
so supporting YA sessions present the image files beside that call. Agents
still inspect each image themselves before claiming visual quality.

### Optional interactive delivery

```bash
pnpm -s artifact:capture path/to/index.html --ya-url http://localhost:3400 --json
pnpm -s artifact:capture path/to/index.html --ya-url https://your-ya-host --audience public --ya-headers /private/ya-headers.json --json
```

`--ya-url` is an explicit YA server origin, not a relay or hosted-client URL.
For local HTML it defaults to the launcher's informational `AGENT_SERVER_URL`.
An explicit URL wins; `--local-only` disables YA requests even inside a YA
session. Without either URL source, capture stays local. The server must see
the same absolute HTML path. With a server selected and no announced origin,
the helper reads `/api/version` once and checks the
artifact capability, availability, and selected local/public origin. An absent
capability or disabled/unconfigured selected origin skips the grant request,
and still produces local captures and the file-viewer link.
It does not guess another audience, enable hosting, or change settings.

A session launched by YA already knows that answer:
`AGENT_ARTIFACT_VIEWER_ORIGIN` carries the isolated local origin when the
viewer is available, so the helper skips the capability query and requests the
grant directly. See
`topics/ya-env-vars.md` on child launch markers. The marker is only present for
a loopback session and the local audience; without it the helper asks the
server as above.

Enabled or not is the whole delivery decision, and the grant request is its
authority: a viewer that is off, or was disabled after a marker was published,
refuses the grant. Whether the origin *resolves* is never asked, because a
browser maps `*.localhost` to loopback itself under RFC 6761 with no hosts
file and no flag, which is what the default local origin relies on. Both PNGs
render the returned artifact URL, verifying that delivery path.
The success result retains that grant for the user and includes its expiration.
A failed capture revokes the grant it created. A non-isolated origin or a
refused grant skips delivery with that reason rather than failing the
run, so a misconfigured artifact service costs the
interactive link and never the captures. Explicit hosting failures for an
origin that did mint a grant are still reported rather than silently claimed as
working delivery; use `--local-only` when only local captures are needed.

Authentication is optional and explicit: `--ya-headers` reads a private JSON
object of string request headers, for example a supported session Cookie or
`X-Desktop-Token`. Keep this file outside the export directory. These headers
go only to the supplied YA origin, with
redirects rejected. They never enter artifact probes, browser contexts, logs,
or the output manifest. TLS verification remains enabled. Existing URL input
is captured directly, without querying YA or creating/renewing a grant; its
expiry is reported as unknown.

### Standard handoff

With [Tool commentary](acli-commentary.md) enabled and a supporting YA server,
the JSON-producing call itself fulfills the artifact handoff: YA presents the
following links and both image previews beside the tool output, including a
collapsed code-mode `Exec` row. Image expansion follows the existing inline
media preference and controls. No separate assistant message repeating these
links is needed. Inspect both PNGs before claiming visual quality; automatic
presentation precedes that judgment and is not a delivery/read receipt.

If that presentation is unavailable or disabled, present the returned Markdown
after inspection. The handoff uses this order:

1. **Open in YA** — the absolute HTML file-viewer link, when input was a file.
2. **Interactive** — the verified artifact URL and expiry, or an explicit
   reason interactive delivery was skipped.
3. **Captures** — the desktop and phone PNG file-viewer links.

Keep the local file-viewer link even when an artifact URL is available. A file
link can be opened weeks later while the file still exists and is authorized;
starting interactive preview creates a fresh grant with a new expiration.
An existing grant URL never renews merely because someone opens it, and a
server restart may invalidate it before its expiry. Captures remain the saved
pixels, while the file-viewer link opens the file's current contents.

The command and tests use portable Node filesystem/process APIs. Linux Chromium
is exercised; macOS and Windows execution remain unverified. The tests include
paths with spaces, Windows-formatted handoff destinations, disabled hosting,
credential separation, broken loads, traversal rejection, and CLI invocation
from a different working directory.

## Export contract

`ya-mockup.json` is version 1 of the `ya-ui-mockup` metadata format. It declares:

- `title`, relative HTML `entry`, and `presentation` (`scripted` here);
- selected `theme`, `locale`, and `font`;
- `states`: names and entry URLs (`default`, `selected`);
- `viewports`: named width/height pairs (1000×600 and 375×812);
- `files`: the complete finite set of exported relative file paths, including
  the manifest itself and, after capture, screenshots and the review page;
- `screenshots`: state, viewport name, image path, and linked document URL;
- `regenerate`: the command that recreates the bundle and captures.

The development manifest has empty file/capture lists because source serving
is not an export. The build manifest declares every output asset; screenshot
metadata is added by the capture command. This manifest is portable authoring
metadata, not a YA protocol capability, security allowlist, or installation
format. YA currently opens the HTML entry and does not interpret the manifest.

Vite builds with `base: "./"`, no public-directory copying, and file-based
assets. Keep all required resources below the HTML entry's directory. Import
assets through the builder; root-relative resources, parent-directory assets,
external services, and history-router fallback are not supplied by this
adapter. Viewing the export needs no source server, package install, or build.
Transfer the whole directory; an optional ZIP must be extracted before viewing.
Local state is illustrative and resets on document reload unless the fixture
deliberately implements persistence.

## Delivery and verification

When presenting a proposal, give a clickable absolute local path to the
exported HTML, such as `[Open mockup](/absolute/checkout/.artifacts/mockups/projects/index.html)`,
and a path to `review.html` or an inspected PNG as the fallback. Resolve the
actual checkout path; do not give only a source-code path or a dev URL. Explain
the interactive-preview setting below when it is required. The file-viewer
link opens the document; it is not a publicly shareable artifact grant.

When interactive delivery is configured, also create a grant through the
existing `POST /api/artifacts` route for the exported HTML and present its
returned `url` on the configured artifact domain, with its expiry. Select
the local/public audience appropriate to the user's connection. Verify that
URL in a browser, including its assets and an interaction, before calling it
usable. Ordinary taps on configured artifact links inside an authenticated
session open its [managed viewer](parked-file-viewer.md#interactive-artifact-links),
keeping the session and composer mounted on mobile as well as desktop. Prefer
that interaction for review; deliberate browser new-tab gestures remain
available. A parent policy that blocks embedding requires a frontend restart
and then a page reload. Keep the grant's directory limited to the
export, and never substitute a URL on YA's authenticated application origin.
The URL grants access until expiry or revocation; do not commit it into docs.

Open `index.html` in YA's file viewer and click the top-row source/preview
toggle once. It starts interactive HTML directly; switching back to source
stops it. Interactive HTML artifacts must be enabled in Local Access, with
a reachable separate artifact origin. Local access can use
`artifacts.localhost` on the forwarded YA port; hosted clients need a configured
public HTTPS artifact address. The exact configuration, grant, expiry, and
security contract lives in [active content security](active-content-security.md#interactive-html-artifacts).
Any required restart of a live YA server belongs to the operator.

Source/scriptless viewing remains available when interactive delivery is
disabled or unsupported; it cannot run the React fixture. Link directly to the
PNGs as the fallback. The gallery also needs interactive asset delivery to
show its linked images inside YA's viewer. An on-disk bundle or localhost dev URL alone
does not prove remote reachability. Check the user's actual configured path
before promising access through a particular hosted installation.

If **Run interactive preview** produces the browser's blocked-content page,
check the parent YA document's CSP as well as the artifact response. A stale
Vite process may still serve `default-src 'self'` without the current
`frame-src 'self' blob: http: https:` directive from `vite-plugin-csp.ts`.
That policy blocks the separate artifact host even when its grant works. It requires an operator-owned frontend restart and a page reload;
ordinary module hot reload does not establish that the HTML policy is current.
The viewer now replaces an enforced frame-policy failure with an explanation
and a link to open the granted document in a separate tab. That link remains
owned by the viewer and is revoked when it is stopped or closed.

The automated export check compares source and relocated production output
pixel-for-pixel at equal fonts, theme, state, and viewport, after waiting for
fonts. It verifies every declared file's served bytes, rejects undeclared or
external runtime requests, and checks font loading, SVG icons, scrolling,
overflow, and the card's settings control. The source server is closed before
the export is viewed. The direct test embeds it through the existing same-port
artifact-host route; the relay test uses real encrypted authentication/grants
and a separate disposable HTTPS gateway, exercises the card controls and
navigation at desktop and phone sizes, checks credential separation, and
revokes the grant.

Chromium on Linux is verified. The tests use portable Node filesystem/server
APIs; macOS, Windows, and WebKit remain unverified. The relay gateway explicitly
skips when OpenSSL is unavailable. These local-service tests do not attest to
a particular public tunnel or published hosted-client build. Broader HTML
inspection controls remain owned by [the HTML viewer gap](../gaps/html-document-viewer.md).

## Design decisions

- **A dedicated Vite entry with real components**, versus a new renderer or
  Storybook catalogue: uses the existing builder without runtime dependencies
  or a second UI implementation. A project with established stories can use
  its static exporter, but must prove the same completeness and viewing path.
- **A self-built playground**, versus Storybook, Ladle or React Cosmos
  (re-evaluated 2026-11-08): Storybook 10.3+ adds an agent-oriented MCP
  addon, but its dev-dependency and configuration surface means continual
  security upkeep for capability the Vite entry and `artifact:capture`
  already provide. Example files keep a Storybook-compatible subset so that
  choice stays reversible. The machine-readable index follows React Cosmos's
  fixture list.
- **Injected services for scenes**, versus bundler aliases or a faked network
  layer: aliases silently break when module paths move, and a network fake
  would duplicate the server contract. Context injection matches the ongoing
  client refactor.
- **A directory plus ordinary HTML metadata**, versus mandatory single-file
  inlining or browser-specific bundle navigation: preserves modules and fonts
  and works with the existing artifact grant. The current export includes the
  full shared stylesheet/font inventory and locale chunks; it favors fidelity
  over a minimal download. It does not install applications or launch servers.
- **Reuse the existing artifact isolation**, versus new hosting machinery:
  source authoring and document delivery remain separate concerns. The broader
  [Interactives](interactives.md) proposal is not required for mockup review.

# Session page header, footer and pop-ups

Topic: typescript-module-boundary-refactor

Status: in progress 2026-11-08 (slices 0 to 3 landed).

The next step after [plan 181](181-session-page-feature-hooks.md) for
[the session page hub gap](../../gaps/session-page-react-hub.md). About
1,500 of the 5,157 lines in `packages/client/src/pages/SessionPage.tsx`
(at `bbc6244b5`) are one block of markup returned by `SessionPageContent`.
The header (about 630 lines), the composer footer (about 430) and the
pop-ups (about 150) each become a component, and the header's actions and
project move menu become two feature hooks. The header changes more often
than anything else in the file; after this, most header and footer edits
land in a file a tenth the page's size.

Nothing is rewritten. Each slice moves code verbatim; the hooks follow plan
181's contracts, and the components follow the ones below.

## Contracts these moves carry

- **Markup moves verbatim.** Each component's body is the moved JSX,
  unchanged apart from indentation: it moves left by four to six spaces,
  so the formatter may re-wrap lines at 80 columns, which is whitespace
  only. Every name the JSX reads from the page becomes a prop of the same
  name, passed as `name={name}`, so the JSX inside the component is the
  page's with whitespace aside. A script checks every attribute at the
  three call sites has that form, and another compares each moved range
  with the component's JSX with all whitespace removed (below). A name the
  JSX binds itself is not a prop: the footer's `catch (error)` (4706)
  shadows the page's `error`. Compound expressions (`status.owner
  === "self"`, `serverHasCapability(versionInfo, …)`, the inline arrows)
  stay inside the component, which receives their inputs (`status`,
  `versionInfo`, the setters), not a precomputed value. Module imports the
  JSX uses (`api`, `serverHasCapability`, `toBrowserAppHref` and so on)
  are imported by the component file. The CSS modules are the same files:
  the header imports `./SessionHeader.module.css` as `sessionHeaderStyles`,
  and the footer and pop-ups import `../pages/SessionPage.module.css` as
  `styles` (CSS module class maps are untyped strings, so the review checks
  the path).
- **Prop types are derived, not written.** A prop that is a hook's result
  is typed `ReturnType<typeof useX>["y"]`; any other prop gets the type the
  TypeScript checker gives the page's own declaration, printed with its
  alias names (`Dispatch<SetStateAction<boolean>>`, `PermissionMode`), so
  no type widens or narrows a value. A script generates the props
  interface and the call site from the checker's list of the free names.
- **Rendering.** The components are plain function components declared at
  module level, not wrapped in `memo`. The page re-renders every second;
  each component re-renders with it exactly as the inline markup did, and
  the inline arrows and objects keep their per-render identity. Element
  types are stable across renders, so the state of everything inside (the
  rename editor, the session menu, the recent sessions dropdown, the
  composer) persists as now. Components add no DOM elements, so layout and
  CSS selectors see the same tree. The one component defined during render
  today, `SidebarIcon` (3538), moves into the header's body unchanged and
  keeps remounting each render; making it a module-level component is a
  follow-up, not part of the move.
- **Hooks in components.** A component calls only `useI18n` for `t` and,
  where the moved JSX calls `showToast`, `useToastContext`, as plan 181's
  hooks do; both return the values the page reads. No other hook moves into
  a component, so the page's hook and effect order is unchanged by slices
  3 to 5. Children's effects still run in tree order before the page's.
- **Refs.** Refs the JSX attaches (`headerRef`, `titleRowRef`,
  `projectBreadcrumbRef`, `projectReclassifyMenuRef`,
  `titleEditControlsRef` and the `attachTitleInput` callback ref) are
  passed under their own names, never as `ref`, and attach to the same
  elements at the same point of the commit.
- **Hooks.** Slices 1 and 2 follow plan 181: bodies move verbatim, each
  dependency list gains only refs and state setters that became parameters
  (listed in the landing note), `t` and `showToast` come from the context
  hooks inside, and the hook takes the page's `location` and `navigate`.
  A block with effects is called where it stood.
- **Keystroke latency** (AGENTS.md). Typing paths that move under a new
  parent: the rename editor and the retitle field (slice 4); and the
  composer (`MessageInput`), the question panel's Other answer, the
  approval feedback field and the approval toolbar's inputs (slice 5). The
  retitle field's value is page state (`renameValue`), so each key
  re-renders the page as now; the others keep their text in their own
  state. Their props are the same values with the same identities, so no
  keystroke path changes; the typing checks below run per slice.
- **The composer stays lazy.** The footer file defines the `lazy()`
  wrapper and imports only types from `./MessageInput`, so the composer
  stays out of the page's bundle chunk; a check enforces it (below).

## What moves

Line numbers are at `bbc6244b5`.

1. **Header actions** → `hooks/useSessionHeaderActions.ts` (~165 lines
   out). The contiguous block 3309-3472: `handleToggleArchive`,
   `handleToggleStar`, `handleTogglePromptSuggestions`, `hasUnread`,
   `handleSetUnread`, `handleToggleRead`, the read-shortcut effect,
   `handleTerminate`, `handleRestartProvider`, `handleShare`,
   `handleShareIndicatorClick` and `handleShareIndicatorContextMenu`; and
   the share modal state (`showShareModal`, `shareModalView`,
   `shareModalAnchor`, 1933-1938), read only by these handlers and the
   header.
   Takes: `sessionId`, `projectId`, `actualSessionId`, `session`,
   `sessionCollectionRecord`, `status`, `setStatus`, `isArchived`,
   `isStarred`, `promptSuggestionMode`, `localPromptSuggestionMode`,
   `setLocalIsArchived`, `setLocalIsStarred`,
   `setLocalPromptSuggestionMode`, `isDomLingerParked`, `loading`,
   `draftControlsRef` and `publicShareManagementAvailable`.
   Returns: the handlers, `hasUnread`, the share modal state and its
   setters (the header's close handler sets both).
   Stays: the local metadata state and its reset effect (1724-1747), which
   title editing and the session-boundary handler (2042) also write;
   `isArchived`, `isStarred` and `promptSuggestionMode` (3135-3143).
   Order: the hook is called at 3309, so the read-shortcut effect keeps its
   place. The share state moves from 1933 to 3309, later in the hook order,
   past state, memos, callbacks, effects and custom hooks
   (`useEngagementTracking`, `useSessionTitleEditing`, `useDocumentTitle`
   and others), none of which reads or sets it, so the move is not
   observable.
2. **Project move menu** → `hooks/useProjectReclassifyMenu.ts` (~110
   lines). `showProjectReclassifyMenu`, `isReclassifyingProject` and the
   two refs (1718-1722), `projectReclassifyOptions`, the outside-click and
   Escape effect, `handleProjectBreadcrumbContextMenu` and
   `handleReclassifySessionProject` (1749-1849).
   Takes: `projectId`, `actualSessionId`, `projects`, `basePath`,
   `location`, `navigate`, `isDomLingerParked` and
   `setShowRecentSessions`.
   Returns: the menu state, the two refs, the options and both handlers.
   Order: called at 1749, so the effect keeps its place; the state and refs
   move from 1718 to 1749, past only the local metadata state, the
   collection record and their reset effect, which do not read them.
   `handleProjectBreadcrumbContextMenu` gains `setShowRecentSessions` (a
   state setter, now a parameter) in its dependency list.
3. **Pop-ups** → `components/SessionPageModals.tsx` (~150 lines). The five
   conditional pop-ups at 4212-4363: project session defaults, recaps, the
   long-context effort warning, the model and info panel, and handoff
   (`RestartSessionModal`). The page renders `<SessionPageModals …/>` where
   they stood, between the header and `ExternalSessionWarning`.
4. **Header** → `components/SessionHeader.tsx` (~630 lines), named for the
   `SessionHeader.module.css` it uses. The `<header>` element (3584-4210)
   and `SidebarIcon` (3538-3553, see Rendering above).
5. **Composer footer** → `components/SessionComposerFooter.tsx` (~430
   lines). The `<footer>` element (4645-5070): the creation recovery notice
   and its button, the connection bar, the btw sticky cards, the question
   and tool approval panels with the approval toolbar, the question aside
   card and `MessageInput` with its props. `MessageInput`'s lazy wrapper
   and `LazyMessageInput` (317-321, 348-354) move to the footer file, its
   only user, and the page's `import type` of its types (110-113) moves
   with them; `SessionRouteModuleFallback` (323-334), which the
   `MessageList` wrapper also uses, moves to
   `components/SessionRouteModuleFallback.tsx` and both import it. The
   lazy loader is the shared `loadMessageInputModule`, so module loading
   is unchanged.

The props each component takes are the free names of its JSX; the landing
note lists them. Not moved: the transcript region (`<main>` with its
providers and `MessageList`, 4389-4613), whose ~70 props are mostly
`MessageList`'s own, so a wrapper would add a layer for little gain; the
btw pane and its handle; and the right pane.

`SessionPage.tsx` goes from 5,157 to about 3,900 lines (each component's
call site adds back one line per prop); each new file stays under the
1,500-line threshold.

## Slices

0. **Pins.** Browser specs over the fixture session with the plan 181
   harness, recording request bodies. The harness gains an option for the
   session read's `pendingInputRequest` (with process state
   `waiting-input`). Cases:
   - header actions: archive and unarchive from the menu (request body,
     toast, the Archived badge) and an archive failure (error toast, no
     badge); star (request, toast, the starred mark) and a star failure;
     prompt suggestions on, and a failure that puts the menu label back;
     terminate (the abort request with `blockResume`, toast) and its
     failure toast; restart provider (abort without `blockResume`, then
     reactivate, then a reload) and its failure toast. Read and unread, by
     menu and shortcut, are covered by `session-read-state`; Share (the
     menu item, the indicator's left and right click, and closing) by
     `public-share-management`.
   - project move menu: right-clicking the breadcrumb lists the other
     projects by name; choosing one sends the move request, shows the toast
     and replaces the URL with the new project's, keeping the search and
     history state (recorded from `history.replaceState`, since the
     fixture's reads then send the canonical-project redirect back); a
     failure shows the error toast; Escape and a click outside close the
     menu.
   - pop-ups: the model badge opens the panel on the Model tab and a right
     click on the Info tab; the menu's Session info opens the Info tab;
     Recaps opens the recap pop-up and saving it shows the toast; Project
     settings opens the defaults pop-up; Handoff opens the handoff pop-up,
     and starting it shows the toast and opens the new session. The
     long-context warning is covered by `long-context-effort-warning`.
   - header markup: the breadcrumb links to the project's session list;
     the title and the chevron toggle the recent sessions dropdown, and
     opening the session menu closes it; at phone width the sidebar button
     opens the sidebar; Clear opens a new session with the project and
     provider in the URL; a routed session's account chip shows its pool
     and account and opens the Info tab; and keys typed into the retitle
     field (reached through a failed Generate Title) each show within
     100 ms while live updates arrive, then Ctrl+Enter saves them.
   - footer: a pending tool approval shows the approval panel and toolbar
     instead of the composer; Yes and No send their responses; an edit
     approval's "don't ask again" sends `approve_accept_edits`; a reason
     typed key by key (each within 100 ms during live updates) denies with
     that feedback; collapsing the panel shows the toolbar's expand control
     and expanding brings it back; a pending question shows the question
     panel with the composer beneath, and submitting sends the chosen
     option, or an Other answer typed key by key (each within 100 ms); the
     composer's placeholder for an idle session without a process and for
     a busy one. The creation recovery button is covered by
     `durable-session-creation`; the question aside card by
     `question-aside`; attachments and the fork summary composer by plan
     181's pins. The btw sticky cards (4723-4732) have no browser coverage
     and no pin here (they need a live btw aside); their six props are
     held by the `name={name}` check and review.
   Test-only, plus this plan added to the gap's burn-down list and doc
   058's priority-queue item 2.
1. Header actions hook.
2. Project move menu hook.
3. Pop-ups component.
4. Header component.
5. Composer footer component.

Each of slices 1-5 is one commit: the new file, the page call, a doc 058
row (2.37 to 2.41) and landing note listing what moved, the parameters or
props, the returned names and any added dependencies, and the
`SessionPage.tsx` budget ratchet. The last slice marks this plan done in
the gap and doc 058.

## Checks

- Browser, per slice: slice 0's specs and plan 181's
  (`session-page-*-paths`), plus the existing specs for what moved:
  header actions and markup (`session-read-state`,
  `session-header-responsive`, `public-share-management`,
  `session-title-access`, `session-resume-settings` for the menu's Clone,
  `slash-command-argument-completions`), pop-ups
  (`long-context-effort-warning`) and the footer
  (`durable-session-creation`, `question-aside`, `audio-memo`,
  `session-send-paths`, `queued-message-recall`).
- Typing: `draft-sync.spec.ts`, `bang-command.spec.ts` and
  `composer-recall-drawer.spec.ts` per slice; for slice 4,
  `session-header-responsive.spec.ts` (rename editor typing during live
  updates) and slice 0's retitle field case; for slice 5, slice 0's
  feedback and Other answer cases.
- Verbatim: a script over each component call site reports any attribute
  not of the form `name={name}`; another compares each moved range at
  `bbc6244b5` with the component's JSX, all whitespace removed. Review with
  `git diff --color-moved=zebra --color-moved-ws=allow-indentation-change`.
- Lazy composer: `rg` finds no value import from `./MessageInput` in the
  footer file (only `import type`), and the client build's chunk list
  keeps `MessageInput` in its own chunk.
- Unit: the client suite passes unchanged; no new unit tests.
- `pnpm console:scan` and `pnpm i18n:scan` for moved calls and keys.
- Budgets: `SessionPage.tsx` ratchets down each slice.
- Tier 2 and Tier 3 per slice; Opus 5.5 review of this plan and of the
  series.

## Not in scope

- The transcript region, the btw pane and the right pane (above).
- Making `SidebarIcon` a module-level component, or memoizing any of the
  new components.
- Any behavior change. A difference found while moving is recorded, not
  fixed.

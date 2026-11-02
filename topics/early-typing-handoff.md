# Early typing handoff

> Any navigation whose point is to leave the user typing must take focus in
> the commit that creates the field, and where the field cannot exist yet,
> hold the keys struck in between and hand them over in order once it does.
> Retirement waits for the field to hold focus and already show what was
> taken, is bounded so a field that rewrites its own text cannot trap the
> keys, and repairs the caret when it ends that way.

Topic: early-typing-handoff

Status: implemented for reverse search, session entry with a prefilled or
focused composer, both rename fields, and the new-session prompt
(2026-09-19), and for a tab opened on the new-session page before the app
loads (2026-09-27, § Pre-boot composer).

## Why

A dropped keystroke is never acceptable
([AGENTS.md](../AGENTS.md) § sequential typing), and deferred focus drops
them silently: between asking for a typing target and that target holding
focus, keys reach whatever had focus before. In YA that is usually the
transcript, where single letters are shortcuts, so the keystroke is not just
lost but acted on.

The observed shapes, all of which existed at once:

- **A frame.** Reverse search focused its query input in a
  `requestAnimationFrame`, and that frame also called `select()`, so a
  character typed in the gap was left selected and the next keystroke
  replaced it. CI caught it as `"ho"` typed and `"o"` read.
- **A timer.** Both rename fields focused from `setTimeout(…, 0)`.
- **A passive effect.** The new-session prompt focused from a mount effect,
  which React runs after paint. React does flush the effects of an update a
  click or key handler made before the next event, but the same effect run
  after a navigation or an asynchronous load waits for paint, so rule 1 does
  not lean on that distinction.
- **A whole load.** Entering a session with `composerPrefill` or
  `focusComposer` could only reach the composer once the session had loaded,
  because that is when the composer exists.

## Contract

1. **Focus in the mounting commit.** Use a ref callback, not an effect, a
   timer or a frame. A field that exists when the request is made is focused
   synchronously in the handler.
2. **Hold the keys when the field cannot exist yet.** Start the handoff at the
   request, not at the arrival, and write the held characters into the state
   the field will render, so they are simply its initial value.
3. **Hand over on evidence, per key.** Retire when the field holds focus *and*
   already shows everything taken so far, then let that key through. Retiring
   earlier lets a key report a value missing held characters and overwrite
   them; retiring later keeps intercepting after the user clicks elsewhere.
   There is no pending-key queue to transfer, so this per-event check is what
   makes the switchover gapless.
4. **Bound the wait.** A field that rewrites what it is given never agrees, so
   focus alone retires the handoff after `attempts` (focus plus one key), and
   that escape puts the caret after whatever the field shows: at most the last
   character is out of order.
5. **Bound the hold.** An unclaimed handoff stops intercepting after 15 s
   rather than for the rest of the page's life. Expiry ends interception only:
   keys it already took were kept from the page, so it still delivers them
   to a field that claims later, such as a composer behind a slow session
   load. Keys struck after expiry reach the page as usual. Only an abandoned
   request (a new navigation, leaving the page) forgets the held keys.
6. **Take printable keys and Backspace only**, and only for the span of one
   request. This is not a general keystroke recorder, and modified or named
   keys keep reaching the shortcuts they belong to.
7. **Respect the caret the action intends.** Held characters go where the
   request meant them to go relative to any prefilled text — after it for a
   prefilled composer — and the caret ends after them. Where the text arrives
   after the keys and was never shown while they were typed (a new-session
   launch seed that is still being fetched), the typed text follows it as its
   own paragraph unless the seed already ends in whitespace.
8. **A refused commit keeps its field rather than refocusing it.** Enter
   commits in place, and the field stays focusable while a save is in flight
   (read-only, not disabled), so a refusal leaves the user typing in it with
   no later focus call. A commit started by leaving the field does not pull
   focus back from where the user moved it.

## Where it lives

`packages/client/src/lib/earlyTypingHandoff.ts` owns the mechanism;
`startEarlyTypingHandoff(sink?)` takes a sink when the field already exists
and buffers internally when it does not, replaying in order on `claim`.
`packages/client/src/lib/earlyComposerTyping.ts` adapts it to a composer's
`DraftControls`, which is why that interface exposes `isFocused`.

Call sites: `useMessageListIsearch` (reverse search),
`SessionPage` (`flushEarlyComposerTyping`, claimed from the navigation effect
or from `handleDraftControlsReady`), `NewSessionForm`, `SessionListItem` and
`SessionPage`'s title rename, and the Projects card's `ProjectCaptionEditor`
and `ProjectCodeNameEditor` (focus only — those fields mount with their row,
so there is no window to hold; the two Projects editors also follow rule 8).

## Pre-boot composer

A tab opened directly on `/new-session` has no app yet: loading it takes
seconds (about 2–3 s against the dev server, 2026-09-27), so neither a ref
callback nor a key buffer inside the app can help. The HTML therefore carries
its own composer.

1. **Typeable from the document alone.** On `/new-session` (local or relay
   path, without a `prefillToken`) an inline script shows a focused textarea
   during HTML parse, before any module is requested. Measured on the local
   dev server, it holds focus 28–34 ms after navigation starts; the rest of
   the tab's startup does not delay it.
2. **Adopted in one commit.** The page's `NewSessionForm` takes the text and
   selection in the ref callback that creates its own textarea and focuses
   it there, so no key falls between the two fields. On the local route the
   field already shows the current account's saved new-session draft. Draft
   hydration cannot overwrite an edit made during ref/layout adoption, even a
   lone leading space that is intentionally absent from durable draft storage.
   Switching to a different draft identity still loads that identity's value.
   Edits replace that draft once, including an intentional deletion; they are never
   appended to it. An untouched snapshot does not overwrite a newer draft
   loaded by the app. A change of account before adoption discards the old
   account's snapshot. On remote paths identity is not known before boot, so
   early text still follows the unseen restored draft as its own paragraph
   (rule 7). Launch composers (fork, handoff) never adopt it. The form does
   not wait for the selected project's record: it mounts, adopts and takes
   typing at once, shows the project as loading rather than detached, and
   holds Start (button and Enter) until the record arrives and fills the
   project field.
3. **Never covers another page.** When routing settles anywhere other than
   the new-session route (a login redirect) or the error boundary catches,
   the overlay is removed and non-empty text is kept in `sessionStorage` for
   the next adoption in that tab. It sits below the app's modals, so a
   blocking dialog raised at the same URL (host offline) shows over it.
4. **A reload before adoption keeps the text.** The pre-boot field writes its
   text, account-scoped draft address and edit state to the tab's
   `sessionStorage` stash on every input and restores them,
   caret at the end, when a reloaded document shows it again. Reloads during
   boot are real: the development source-version check reloads at a lazy
   import, and a limited user's newly published browser defaults reload once.
   Adoption spends the stash, so the text is adopted once; after adoption the
   form's own draft persistence owns it.
5. **Enter does not send yet.** On a fine pointer, plain Enter is swallowed
   rather than becoming a newline, because the app's Enter would have sent;
   Shift+Enter still adds a newline. On a coarse pointer, Enter is a newline,
   as in the app.
6. **The tab honors the saved sidebar mode**, including on reload (see
   [Session UI](session-ui-customization.md#desktop-sidebar-display-modes)). The
   pre-boot field reserves the saved desktop sidebar width, including the
   collapsed rail or minimized mode, rather than hiding navigation. An explicit
   `?sidebar=expanded` overrides the saved mode; responsive width limits still
   apply.
7. **Geometry follows the page.** The pre-boot textarea sits where the form's
   textarea will be at each width, including the reader's content width, so
   the handoff does not visibly move the text. Its copy is English only: the
   app's catalog is not loaded yet.

`packages/client/preboot/new-session-composer.js` is the inline source,
injected into both entry documents by `vite-plugin-preboot-composer.ts`
ahead of the CSP pass, which hashes it for the production policy. The inline
bundle shares the app's draft envelope reader and account-key encoding; it
does not fetch modules to restore the draft.
`src/lib/prebootComposer.ts` owns adoption and retirement;
`e2e/new-session-preboot-composer.spec.ts` holds the app's scripts, types,
releases them, and checks the handoff.

## What does not need it

A request handled synchronously in its own event already satisfies the
contract: `useSourceSearchShortcut` focuses and selects the commit/blame
search field inside the `/` keydown handler, so no key can fall between.
Fork deliberately takes no focus at all (`RestartSessionModal` passes
`autoFocus={!isFork}`), so there is nothing to hold.

## Not covered

An IME composition begun before the field exists cannot be carried across:
`keydown` reports only `Process`, and the composed text belongs to whatever
element held focus. Composition-heavy input still depends on the field
existing early, which is what rule 1 is for.

# Session Retitle

> Session retitle is the explicit, user-confirmed title editing flow that
> combines manual rename and one-click LLM-generated titles behind a dedicated
> button, keeping the title tap itself on recent-session navigation so a
> generated rewrite is never applied by accident.

Topic: session-retitle

Related topics: [recaps](recaps.md), [side-session-config](side-session-config.md),
[fork-from-turn](fork-from-turn.md), [session-ui-customization](session-ui-customization.md),
[vanilla-defaults](vanilla-defaults.md).

## Contract

- Provider-native automatic title generation is disabled by default at session
  launch. This is separate from YA's explicit retitle helper: an adapter may
  use a fixed provider-visible title to suppress upstream generation while YA
  continues to derive and display its own session title normally.
- A session title must not change from generated text without an explicit user
  confirmation or the clearly requested one-shot generated-and-apply action.
- The existing session-menu **Rename** entry remains manual rename. It does not
  start the generated-retitle helper flow, but it should share the same
  temporary confirm and dismiss controls as the retitle surface.
- Tapping the non-menu title text opens the recent-sessions dropdown (session
  navigation); the small chevron beside it does the same and stays as the
  dropdown affordance. The title tap must never start a generated retitle: it
  is a large, frequently-tapped target (especially on mobile), so wiring it to
  an automatic LLM rewrite is too easy to trigger by accident. Generated
  retitle has its own dedicated button instead (see One-Shot Apply).
- Escape, an `X` button, or losing interest in the helper proposal must leave
  the current title unchanged.
- Opting a provider into its own automatic title generation is an explicit
  provider-session option. A live change must report whether it was applied,
  needs a restart, is unsupported, or remains unknown; it must not silently
  reuse YA's generated-retitle preference as authorization.
- Codex user-confirmed titles are provider-owned metadata. YA reads
  `thread.name` through app-server, writes accepted manual or generated titles
  through `thread/name/set`, and keeps its persisted `customTitle` only as a
  fallback when no native title exists. A native write failure must leave the
  local title unchanged rather than reporting a YA-only success.
- One process-wide Codex title projection refreshes every ten seconds through
  bounded, state-database-only `thread/list` pages. Notifications update names
  immediately within YA's app-server process; names changed by a separate
  Codex app-server converge on the next refresh. No title path reads or writes
  Codex's private index or database files directly.

## Manual Rename Surface

Manual rename stays an inline edit of the title field. It should use all
available header width while editing, instead of clipping against a fixed
viewport heuristic.

Confirmation should be visible beside the edit field and shared with generated
retitle:

- **Enter** is the default generated-title accept path when generated retitle
  mode is active. If the helper title is already present, Enter combines it with
  the edit field text according to the current selection and saves that combined
  value as the session title. If the helper is still computing, Enter arms a
  deferred accept that performs the same combine-and-save when the generated
  title arrives.
- A thought-bubble/send glyph is the pointer equivalent of Enter: use the LLM
  title, with the same deferred behavior while the helper is still computing.
- `Ctrl+Enter` is the hard-confirm-as-is path: save the text exactly as it is
  currently typed, without waiting for or inserting a generated title.
- A separate hard-confirm button, likely a disk glyph or quote-mark glyph,
  mirrors `Ctrl+Enter` for pointer users and mobile users.
- `Esc` or `X` cancels with no metadata update.

## Generated Retitle Flow

Generated retitle is a separate helper action, distinct from the **Rename**
menu entry (which stays a manual typed edit). It is reached only through the
dedicated generated-title button in the header, which enters a compact
title-edit surface and starts a one-shot generate-and-apply.

Generation prompt shape:

```text
What is a good new title for this session?

Target length: <configured or UI-stated length target>.
Return only the title.
```

The browser Appearance setting **Generated Title Length** controls the target.
It defaults to 80 characters and clamps the visible setting to 50-132
characters. The server accepts that upper bound so the client cannot choose a
target that the retitle route rejects.

The first implementation should use a temporary fork, matching the
fork-after-summary constraint: do not pollute the source provider transcript
with a "summarize/title yourself" turn. The generated title is viewer/UI state
until accepted.

For a stopped session, retitle must first resolve the session's real provider
from live YA ownership, persisted metadata, or cross-provider transcript
readers before testing fork support. If YA can tail/display that stopped
session but has no live source process, retitle reactivates the primary session
with the ordinary message-less resume path before creating the helper fork. That
reactivation is single-flight by YA session id, so a normal user send that
arrives concurrently waits for the same resumed process and then queues its
turn there instead of starting a second resume.

When generation finishes, show the proposed title near the current title or
below the inline edit surface. Do not overwrite the user's typed edit text.
If the user already hard-confirmed the manually typed value, the later helper
result is stale and must not change the title or edit field.

## Accepting Generated Text

Generated text has two possible accept shapes; both remain explicit:

Enter or the thought-bubble/send glyph accepts generated text as the title to
save. The generated text is combined with the edit field according to the
selection captured at accept time: replace selected text, or insert at the
caret, which naturally appends after a typed prefix when the caret sits at the
end. A fully selected title therefore becomes just the generated title.

If generation is still pending when the user presses Enter or the
thought-bubble/send glyph, YA captures that selection/caret state and performs
the same combine-and-save when the generated title arrives. This is a deferred
metadata save, but only because the user already made the explicit generated
accept gesture. `Ctrl+Enter` / hard-confirm remains the separate path for
saving the field exactly as typed, without waiting for generation.

While that deferred accept is armed, the title edit field should stop looking
editable and momentarily show a generating-title placeholder until the helper
result lands. The `X` escape hatch remains visible; additional typing should
not be encouraged because it would not be part of the captured deferred save.
The generating/deferred status surface exposes the submitted helper turn text
on hover so the user can inspect what YA asked the provider to do.

## One-Shot Apply

The compact generated-title button sits after the recent-session chevron and
generates and applies a new title in one click. It enters the retitle surface,
immediately arms the deferred generated-title accept path, and shows the
generating placeholder (with its `X` escape hatch) until the helper returns. The
generated text replaces the whole current title because there is no active caret
or text selection before the one-shot action starts.

This button is the only pointer entry to generated retitle. The title tap and
the chevron both open recent sessions instead, so an LLM rewrite is never
started by the navigation gesture; manual **Rename** from the session menu
stays the typed-edit path. The button only renders for providers that advertise
transcript forks (`supportsForkFromTurn`).

## Typed `/title`

The Mother-session composer also exposes `/title` as a YA-local operation. It
never sends command text to the provider:

- `/title <text>` immediately trims and persists `<text>` through the existing
  session-metadata title route. The composer recovery copy is cleared after the
  save succeeds and restored when it fails.
- Bare `/title` immediately starts the same token-using one-shot
  generate-and-apply flow as the dedicated header button. Starting the helper
  consumes the command; generation or save failures remain visible in the
  existing retitle surface.
- The command is blocked with its draft restored when attachments are present
  or when the composer currently targets a `/btw` aside. It does not become
  aside input or provider text.

Title operations are immediate-only. They do not use the turn-boundary command
lane or imply a generic persisted scheduler for later UI operations.

## Helper Model Notes

The first helper can use the same temporary-fork strategy as
fork-after-summary. Future work may use a lesser helper model over a bounded
subset of turns, favoring user turns, to produce quicker title proposals.
That optimization belongs under [side-session-config](side-session-config.md):
it should share helper model/lifecycle policy rather than creating a private
retitle-only helper configuration.

## Tests That Should Fail On Contract Regressions

- Generated retitle output is not written into the source provider transcript.
- A generated title does not update `customTitle` until the user accepts it.
- A pending generated-title accept inserts into the edit field at the captured
  selection/caret when the helper result arrives.
- A manual hard-confirm while generation is pending invalidates the helper
  result; the late proposal must not overwrite the saved title.
- Manual **Rename** opens the edit surface without starting generation.
- Title-text tap and chevron tap both open recent sessions; the dedicated
  generated-title button is the only pointer entry that starts generated
  retitle, and the title tap never starts it.
- `Esc` and `X` exit either manual or generated retitle mode without changing
  session metadata.
- Stopped mixed-provider sessions use the provider found by transcript readers,
  wake the source session before the helper fork, and do not race a concurrent
  normal send into a second resume.
- `/title <text>` persists no provider turn, while bare `/title` starts the
  existing generated-and-apply helper. Neither command reaches a focused aside.
- A Codex rename is visible through `thread/read`, and a native Codex rename
  replaces YA's displayed title without changing the rollout transcript.
- A failed Codex native rename does not create or update Yep-only
  `customTitle` state.

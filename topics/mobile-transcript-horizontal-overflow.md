# Mobile transcript horizontal overflow

Status: **implemented.** The transcript is the contained horizontal fallback
for content wider than its viewport. Ordinary content still reflows, and
renderer-owned scrollers remain useful local exceptions, but unanticipated wide
content must stay reachable without widening the page shell.

Related: PR [#90](https://github.com/kzahel/yepanywhere/pull/90), "Fix
horizontal page scroll on mobile chat view", opened by `joshtech90` and closed
on 2026-06-25 under the unsolicited-code-PR policy. The PR was not closed
because the bug report was invalid. The maintainer also reproduced the issue
with Codex Grep output causing a horizontal scrollbar.

## Original symptom

On phone-sized session views, some sessions gained horizontal overflow from
wide renderer content. The original report described the whole session layout
shifting sideways rather than only the scrollable transcript, which could leave
the header, composer, or ordinary message rows misaligned.

This only appears in sessions whose transcript contains horizontally wide
content. Recent confirmed examples:

- Codex `Grep` summaries with long path/file names.
- Grep result previews and fixed-font tool rows.
- Long code/tool output that should scroll inside its own renderer box, not
  widen the whole transcript.

## Owning mechanism

`main.session-messages` owns both transcript axes with `overflow: auto`. Its
grid track uses `minmax(0, 1fr)`, and both the session split and transcript have
`min-width: 0`, so wide descendants increase the transcript's `scrollWidth`
without increasing the document width. This makes the longstanding horizontal
fallback explicit instead of relying on the CSS rule that a `visible` axis can
compute to `auto` when the other axis is scrollable.

The wide-screen `/btw` split preserves the same horizontal fallback in its
messages track. Candidate wide content includes Markdown tables, Grep
summary/path markup, fixed-font rows, and future generated renderer content
whose minimum width exceeds the transcript column.

## Prior Patch

PR #90 proposed a four-line CSS fix in `packages/client/src/styles/index.css`:

- add `overflow-x: hidden` and `min-width: 0` to `.session-messages`;
- add `min-width: 0` to `.session-split`;
- add `min-width: 0` to the mobile `.message-list` content-width rule.

The rationale was that inner code/tool blocks already had their own
`overflow-x: auto`, so wide content could scroll locally instead of widening
the page. That was incomplete: Markdown tables and future renderer output do
not necessarily have dedicated wrappers, and clipping the transcript makes
their overflow unreachable.

## Diagnostic Value

Horizontal overflow remains useful both as a fallback and as diagnostic
evidence that a renderer exceeded the normal content width. The containment
boundary is the transcript, not the document: the header, composer, follow
controls, and connection bar stay fixed while the user pans the transcript to
reach the wide content.

## Contract

The desired invariant is:

- ordinary transcript content reflows to the content column; delivery-status
  markers stay beside their own bubbles within the transcript viewport and
  never create horizontal overflow for otherwise wrapping user text;
- when any transcript descendant is wider than that column, the transcript
  provides a generic horizontal scrolling fallback;
- known wide renderer content may still own a local scroller when that gives a
  better interaction, but correctness must not depend on every renderer doing
  so;
- turn image galleries may own horizontal touch scrolling without transferring
  their overflow to the document, and centering a gallery image (opening the
  gallery, returning from the image viewer) scrolls only the gallery's own
  rows sideways, never the transcript;
- horizontal transcript movement must not widen or move the header, follow
  controls, connection bar, composer, or document viewport.

## Acceptance

- On phone and desktop viewports, a session containing a wide Markdown table or
  renderer row has `main.session-messages.scrollWidth > clientWidth` and can be
  scrolled horizontally.
- The document does not gain horizontal overflow, and the header/composer stay
  aligned with the viewport while the transcript moves.
- Local horizontal scrollers still work where they are intentional, especially
  code blocks and file/tool output previews.
- The bottom fade/connection-bar/composer boundary remains visually continuous
  when scrolled near, at, and away from the tail.
- Verify with a real mobile browser or in-app mobile shell; desktop emulation is
  useful but not sufficient for scrollbar/gesture behavior.

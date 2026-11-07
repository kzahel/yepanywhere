# Composer Rich Input (future vision)

> Aspirational, not planned. A future direction for the message composer's text
> input that would let styled provisional speech, and possibly future
> attachment/command chips, live *in the text flow* with the caret naturally
> positioned after them — something a plain `<textarea>` structurally cannot
> do.

Topic: composer-rich-input

Status: **vision only.** The shipped approach is the textarea + overlaid
draft-mirror (see [mic-button-speech-ui.md](mic-button-speech-ui.md)); the
caret after provisional speech is faked there (option "B"). Status strings
such as `Transcribing…` live beside the mic and never use the mirror. This doc
records why a richer input is the clean long-term structure, so the tradeoff is
not re-derived each time.

## Why a textarea can't do it

The composer input is a plain `<textarea>`. Two hard limits drive everything:

- **No styled text runs.** A textarea holds plain text only, so provisional
  speech cannot be underlined independently inside it. YA redraws the draft in
  an aria-hidden mirror while interim speech exists.
- **Caret position is value-driven.** Provisional speech is absent from the
  textarea *value* — it exists only in the mirror — so the native caret sits
  structurally before it. Placing the caret after the visible phrase requires
  either temporary characters in the draft value (which could be submitted) or
  a separately rendered caret with the native one hidden.

## What a rich input would enable

A `contenteditable` (or a small rich-text model rendered to one) would make
provisional speech a **real inline text run**:

- Its underline could be applied without redrawing committed text.
- The caret would naturally land after the provisional phrase because the
  phrase has real width in the document.
- Streaming interim preview and selected-span replacement would share one node
  model instead of the value/mirror split.

## Shipped image intake stays outside the text model

Image attachments do not require a rich editor. The shipped desktop-paste and
installed-PWA image-share behavior, browser-local bounds, and consumer
acknowledgement boundary are current product behavior owned by
[attachment-intake.md](attachment-intake.md). A future rich editor must
preserve that contract rather than reimplementing intake inside its text model.

## Design decisions

- **Keep attachment intake outside a `contenteditable` migration:** Android
  gains a standard, explicitly invoked screenshot path without changing
  submitted text or taking on rich-editor input-method risks.

## Costs and risks (why "not for now")

`contenteditable` is notoriously finicky; a switch must re-validate, at minimum:

- IME composition (CJK and others) — the current textarea path has explicit
  `isComposing` handling.
- Mobile soft keyboards, autocorrect, and `enterKeyHint`/submit behavior.
- Paste sanitization (today plain text + file paste are handled deliberately).
- Draft persistence/restore, undo/redo, selection math (the speech insertion
  ranges and their mapping-through-edit logic assume string indices).
- Accessibility and tests across both composers (MessageInput and
  NewSessionForm).

Until those are worth taking on, the provisional-only textarea mirror with a
faked caret is the interim, and this richer input stays a vision.

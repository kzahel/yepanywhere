# Mic Button Speech UI
> YA's mic button owns a speech insertion transaction: it captures either
> streaming or batch speech, integrates recognized text at the user's selected
> draft position, and treats spoken commands as control events rather than
> dictated text.

Topic: mic-button-speech-ui

See also:

- [pluggable-speech-recognition.md](pluggable-speech-recognition.md) for
  backend selection, server/direct STT routing, and provider capability rules.
- [streaming-speech-capture.md](streaming-speech-capture.md) for the client
  Web Audio PCM pipeline, warm mic visibility lifecycle, and readiness
  indicators.
- [composer-bottom-bar-overflow.md](composer-bottom-bar-overflow.md) for the
  active-capture waveform's measured center-space and overflow contract.
- [direct-xai-speech.md](direct-xai-speech.md) for direct browser-to-xAI STT.

## Speech Input UX Overview

YA offers browser-native Web Speech when the browser exposes
`SpeechRecognition` or `webkitSpeechRecognition`, plus configured streaming or
batch STT backends. The Mic glyph identifies the method actually used. Starting
capture records the current selection as the insertion target; mutable speech
appears as an underlined preview, and finalized text commits into the ordinary
editable draft at that mapped target.

Manual Send, Steer, Queue, and Project Queue during capture stop capture, wait
for successful transcription settlement, and then deliver the final ASR wording
at the captured insertion target. A failed or cancelled cycle does not silently
deliver provisional text. Streaming backends may commit
several chunks and support Smart Turn or spoken control words; batch backends
return one final transcript after recording stops and do not provide mid-
utterance Smart Turn.

`send`, `cancel`, and `wait` are control words when the selected backend emits
the required command metadata. A Smart Turn endpoint may send automatically;
manual non-whitespace editing holds only that automatic endpoint send, and an
optional command grace window (see *Command grace window* below) briefly keeps
capture live after the endpoint so resumed speech reclaims the turn. Optional
follow-up listening can start another streaming transaction after a speech-
triggered delivery.

The browser-local **Speech message prefix** setting defaults to `🎤`. It can
instead prepend `[ASR]`, `[STT]`, `[Dictation]`, a custom one-line prefix, or
nothing when Off. The prefix warns the agent that submitted text may contain
transcription errors.
Speech-triggered delivery always uses the selected prefix. The optional 0–5000
ms **Quick-send speech-prefix window** extends it to one rapid manual delivery
after finalized speech. Every visible delivery cue is derived from the same
prefix decision as its payload: all eligible Send, Steer, Queue, Project Queue,
New Session, overflow, and mobile-keyboard controls show the exact selected cue
when their activation will prepend it, and no prefix cue otherwise.

## Speech Insertion Transaction

Pressing the mic button creates a speech insertion transaction at the current
textarea selection. If no text is selected, final speech inserts at the cursor.
If text is selected, the selected text remains in the textarea and should still
look selected while capture starts; YA deletes it only when a non-command final
transcript chunk is committed. A spoken cancel command before any committed
speech therefore leaves the selected text untouched.

Final speech chunks are speech-owned spans. User edits map those spans through
ordinary textarea changes; YA must not infer replacement by substring matching.
When final speech lands in the middle of draft text, subsequent final chunks in
the same mic transaction insert after the previous final chunk, not at the
draft end and not over the previous chunk.

While capture is still listening and no provisional fragment is visible, the
textarea's live selection becomes the target for the next new final speech
chunk. Typing retargets a collapsed caret immediately; arrow-key movement and
mouse or touch placement retarget it when the native selection moves. A new
final therefore follows manually entered text at the visible blinking caret.
Previously finalized speech remains tracked as speech-owned chunks: a provider
revision still corrects its own latest span, and spoken `cancel` still removes
the most recently committed speech chunk even when the user moved backward in
the draft. Post-capture batch processing keeps its click-time target mapped
through edits rather than following later caret movement.

Browser-native Web Speech result events carry the complete result list, while
`resultIndex` identifies the first entry that changed. Final entries before
that index are immutable history and must not be reprocessed as the current
utterance. YA considers only changed final entries, so an old result retained
in Chrome's list cannot pull resumed speech back into its earlier contiguous
span.

While browser-native speech is still provisional, a manual caret action queues
the target for the next fragment without changing the current fragment's
anchor. Continued interim revisions remain underlined at their original target
and never enter the draft early. When Chrome finalizes that fragment, YA commits
it at the original target, maps the queued selection through that edit, and
then creates the provider insertion boundary. If the same result event also
contains the next interim fragment, the final commits before that interim is
shown, so the new underlined text starts at the queued caret. Repeated caret
moves replace the queued target; stopping or cancelling capture discards it.

Interim streaming text is only a preview at the transaction insertion point. It
does not delete pending selected text and does not enter the textarea value
until the provider finalizes it.
When a provisional selected replacement target exists, the preview mirror
renders as if the selected text were replaced so following text wraps at the
same positions it will use once a final chunk commits.

If the user makes a non-empty selection after the mic transaction is already
active, YA treats that selection as a provisional replacement target for the
next non-command final speech chunk. The replacement is not committed
immediately: a final chunk that arrives within 300 ms of the selection is held
until that grace window ends. The value is an explicit speech-UI exception
authorized for this race, not a general readiness or latency delay. If the user
types, cuts, copies, pastes, or collapses the selection before the held final
chunk commits, the manual action wins and the provisional speech replacement
is cleared.

Speech providers may sentence-initial-capitalize the first word of a chunk even
when the user is replacing a lowercase word in the middle of a sentence. For
explicit selected-span replacement, YA may lowercase a title-case first word
when the selected text starts lowercase and the replacement context is not
sentence-initial. It must not do this for collapsed-cursor insertion or for
all-caps/acronym-looking words.

Across separate finalized chunks in one mic transaction, YA also smooths a
provider-created capitalization boundary when the new chunk begins with a
conservative allowlist of ordinary continuation words in mid-sentence context.
This behavior is always active and has no setting. It applies only after at
least one chunk has committed, never to provider revisions or explicit
selected-span replacements, and preserves sentence starts, acronyms, single
letters, and unlisted title-case words such as likely names. A provisional
preview for such a later chunk uses the same normalization, so capitalization
does not visibly change merely because the chunk commits.

For browser-native Web Speech, **Infer punctuation from speech** is a
browser-local, default-off preference. When enabled, YA feature-detects the
`SpeechRecognition.unspokenPunctuation` property and sets it to `true`; when
disabled, YA leaves inferred punctuation off. Recognizers without that property
must continue normally with their raw transcripts. The Web Speech API exposes
only this boolean control: alternative confidence applies to the whole
transcript hypothesis, not to individual inferred punctuation marks, so YA
must not present a punctuation-confidence threshold it cannot enforce. The
capitalization fallback above remains active because older Chrome and Android
do not provide inferred punctuation through this interface.

## Streaming Behavior

Streaming providers may emit mutable interim text, finalized chunks
(`is_final`), and utterance-final or end-of-turn events. YA commits finalized
chunks into the speech transaction as they arrive, using provider audio timing
where available to advance the insertion target.

Mutable interim text uses the same typography and text color as committed
draft text, with a thin underline in that same text color as its only
provisional treatment. The textarea's native caret is hidden while this mirror
preview is visible, and the mirror draws a caret immediately after the
provisional phrase so the visible insertion endpoint follows the user's
speech. The mirror is used only while actual provisional text exists. Active
capture does not insert a `Listening…` label into the draft; the animated mic
control is the capture affordance.

Desktop capture start and stop return focus to the textarea. This keeps the
native typing caret visible at the speech insertion point while batch
transcription or a streaming flush finishes. On a coarse-pointer device, mic
start and stop do not focus the textarea: YA-owned dictation must not summon
the on-screen keyboard. A deliberate textarea press remains the keyboard-open
signal. The mic is a 60px-wide rectangular target while retaining the bottom
bar's existing height. On a coarse-pointer device its hit area extends 10px
upward into the composer and 4px below the control without contributing to
layout height.

When the phone-width composer is collapsed and its configured action is the
microphone, the Mic occupies the far-left edge and the text field begins to its
right. A simultaneously available fallback send action remains at the far-right
edge; neither control may overlay the editable text or force the composer wider
than the session viewport.

If the keyboard is already open and the composer switches to its compact
delivery row, the mic remains pinned alongside the delivery controls so
entering text does not remove the active speech control. When waveform display
is enabled, the row preallocates the Mic's full 150px-maximum slot before
capture so starting the waveform does not move its neighbors. The Mic button
itself fills that outlined slot before and during capture, with no untappable
gap; pressing anywhere in the rectangle toggles capture. The Mic reserves its
60px target plus a compact backend glyph and the real waveform may use the
remaining space, up to 78px. Under width pressure the waveform shrinks to zero
before the Mic can shrink; a wide Send or Steer action must yield the
waveform's available space.
Session-only delivery actions do not leave empty placeholders while
unavailable; an adjacent visible action absorbs that space.

The mic always includes a short backend glyph (`Web`, `Grok`, `Deep`, `Whsp`,
`Para`, `NeMo`, or `Test`) beside the microphone icon. An unknown backend uses
the first five characters of its method id after any `ya-` prefix. The glyph
reports the method actually selected for the live control, including an
availability fallback; it is not merely the stored preference.

An explicit browser-native preference is effective only while the current
browser context exposes Web Speech recognition. If that API is unavailable
and the connected host advertises another speech method, YA uses the preferred
available method for the live control without overwriting the stored browser
preference. Unsupported methods remain visible but disabled in selectors; an
unavailable selection must not leave a reserved blank Mic slot.

xAI STT has two timing notions. The top-level `start`/`duration` on a partial
can identify the current segment window and remain fixed while several
separate finalized sub-chunks arrive. Word timestamps are the committed audio
span for a chunk. YA therefore uses word timestamps, when present, for the
committed cursor and uses the top-level `start` only as the segment group key.

Within one xAI segment group, a later `speech_final` partial may revise the
text made from earlier non-empty `is_final` sub-chunks. YA must not append a
tail guessed from the segment window in that case. It replaces the currently
owned text for that segment with the `speech_final` text by emitting explicit
replacement metadata to the composer.

If a later `speech_final` starts at an earlier committed segment group and its
text is no longer prefixed by the already-committed group text, YA treats it as
a correction spanning the committed groups from that start point to the current
insertion target. It replaces that owned suffix instead of slicing off only the
word-timestamp tail.

An empty finalized chunk is not committed speech. It must not clear the mutable
preview and must not advance the committed audio cursor; xAI can emit empty
`is_final` chunks before a later non-empty final chunk for the same audio span.

When Smart Turn triggers an automatic send from an endpoint event, the provider
may still deliver additional final text in its done event. YA must commit that
uncommitted tail before applying the send command metadata.

**Command grace window.** A browser-local Smart Turn setting (`graceMs`,
0–1500 ms, default 0/off, the "Command grace" slider) delays only the
*automatic* endpoint send: after an endpoint with no recognized spoken
command, the provider commits the transcript but keeps capture and the
recognizer stream live for the window instead of stopping. Any non-empty
recognizer text arriving inside the window abandons the pending automatic
send and the turn simply continues — a late spoken `send`/`cancel`/`wait`
therefore needs no separate matching; it is recognized by the ordinary
command decision at the next endpoint, whose grace re-arms. If the window
expires silent, the deferred stop/submit proceeds exactly as the immediate
path. A recognized spoken command, manual stop, manual delivery, cancel, or
a connection failure is never held: spoken commands act immediately, and
during the window the provider state is indistinguishable from active
listening, so every manual action behaves as it does mid-capture (a manual
stop or connection loss also clears the pending automatic send rather than
submitting it). The setting is client-side only — it is not sent in the
streaming start frame or to xAI. The cost is added latency on every Smart
Turn auto-send while the window is enabled; the win is that premature
endpoints and just-too-late commands stop racing the submit.

An automatic Smart Turn endpoint send is held — committed to the draft but not
submitted — once the user has manually edited the composer during the active
mic transaction. This protects a turn the user is co-authoring by hand from
being submitted out from under them by an endpoint. The hold is specific: it
applies only to the *automatic* endpoint send (carried as `smartTurnAutoSend`
in the result metadata, distinct from an explicit spoken `send`); an explicit
`send` command and a manual Enter always submit. The triggering edit must add or
delete non-whitespace text — whitespace-only changes and cursor moves do not
count — and speech-inserted finals (which reach the draft programmatically, not
through the textarea's change event) are never treated as manual edits. The hold
is scoped to the current mic transaction and resets when the next one starts.

When Smart Turn actually submits on a coarse-pointer device, YA blurs the
textarea after submission so the on-screen keyboard closes with the completed
turn. Desktop Smart Turn keeps the ready-to-type refocus behavior. A held
automatic send does not blur because no submission occurred and the user still
owns the draft for review.

xAI may also send one or more non-empty final partials after YA has sent
`audio.done`, then send an empty `transcript.done`. YA stages such post-stop
final partials in order and uses them only if the final done event has no text,
preserving protection against bad stop-flush partials when `transcript.done`
does contain text.

Manual stop for streaming STT stops capturing new audio immediately. When no
provisional speech is visible, it remains a flush/finalize operation and final
transcript updates for audio already sent may still reach the composer. When
provisional speech is visible, Stop instead commits the exact click-time
projection at its displayed insertion or replacement span; later provider
revisions settle the capture but must not rewrite or duplicate that committed
snapshot. Only one streaming provider request is active at a time in the
current implementation, so a reclick during streaming finalization does not
start a competing stream. Future work may make that reclick start local
prerecording immediately, buffer PCM into a new speech transaction, and open
the next provider stream only after the previous `transcript.done` resolves.
That follow-up must preserve the user's click-time insertion target and flush
the buffered audio without dropping first words.

A stop before YA has sent the streaming start message is startup cancellation,
even if the browser audio clock has already produced a frame and the Mic briefly
showed listening. It invalidates the startup owner, closes a late socket, and
returns idle without an error or transcript. Once the start message has been
sent, Stop retains the flush/finalize behavior above; a subsequent connection
failure remains a real error unless existing transcript salvage applies.

Stop and delivery have different review contracts. Plain Stop commits the
visible snapshot into the editable draft for review. Enter, Send, Steer, Queue,
and Project Queue during capture authorize an **unreviewed speech send**: the
user has not yet seen the recognizer's final wording, even if a full interim
preview was visible. ASR therefore gets its final pass before delivery. This
is the maintainer-directed correction of 2026-10-20, not a separate hotkey.

In the active-session composer, delivery records its intent and detaches the
draft and speech insertion target at the press. Final recognizer results revise
that detached draft; successful provider settlement authorizes sending it. Text
typed afterward belongs to the next draft and is neither consumed nor
overwritten. The new-session composer also waits for speech to settle before
delivering, but sends the text visible at the press: its draft stays in the
field, and recognizer results that arrive after the press do not change what is
sent (maintainer decision, 2026-11-07). These sends use the configured Speech
message prefix (including Off or custom text) independently of the Quick-send
speech-prefix window. The timing window applies to later manual sends after
capture has already settled, not Enter during capture. A failed speech cycle
clears pending delivery and restores recoverable text; a later deliberate
delivery press may still send the retained draft. The rest of this contract
applies to both composers and to mic-button or keyboard-shortcut invocation of
the same action. Action eligibility is checked before speech ownership
transfers and again before a deferred typed action runs. The pending intent
keeps recovery ownership of its detached draft until the typed action accepts;
rejection or an exception restores that draft. A Smart Turn send rejected by
its typed action settles as unhandled and does not arm follow-up listening.
Generated-summary and no-summary forks are typed delivery intents under the
same settlement owner: command-only generated-summary speech may invoke its
valid empty-instructions action, while no-summary dispatches exactly once only
after successful settlement and restores the detached draft on failure.

In the active-session composer, that delivery press also transfers the current
draft and speech insertion target into a delivery-owned transaction and clears
the live field for the next turn. Backend-final text may update only the
detached outgoing turn. Text begun after the press must neither join that turn
nor be cleared when speech settles or when the server later acknowledges the
delivery. A failed or cancelled speech cycle restores the detached text ahead
of any newer live draft so neither turn is lost.

When server-routed speech audio retention is enabled, YA persists structured
streaming transcript events next to the retained audio. The older
tab-separated text trace is kept for grepping, but the structured trace keeps
`isFinal`, `speechFinal`, `start`, `duration`, and word timestamps for replay
and reducer tests.

Spoken commands are evaluated from finalized speech, not from mutable interim
text. A command word is a trailing lexical token such as `send`, `cancel`, or
`wait`, after punctuation/quote stripping and case normalization. Recognized
command words are control tokens and are removed from the textbox — except
`wait`, which is intentionally left in place (see its bullet below).

Current streaming command semantics:

- `cancel` removes only the most recent committed final speech chunk in the
  current mic transaction and keeps recognition running.
- `wait` stops recognition, keeps committed speech text, and does not submit.
  It **holds the send even when Smart Turn's endpoint would otherwise auto-send**
  the turn. Unlike `send`/`cancel`, `wait` is recognized eagerly: it does not
  require a deliberate pause before it, because a missed `wait` prematurely
  submits the turn (the disruptive failure) while a missed `send`/`cancel`
  merely takes no action. So the pause gate that separates a spoken `send`/
  `cancel` command from dictation does not apply to `wait`. Because dropping the
  pause check means a sentence legitimately ending in the word "wait" also
  holds, `wait` is **left in the draft** (not stripped, unlike `send`): a false
  hold is then a one-click manual send with nothing lost. The `send`/`cancel`
  pause gate is 300 ms.
- `send` submits the whole composer.
- **Follow-up listening** is a browser-local Smart Turn option, default off.
  After a speech-triggered send, a non-zero window actively starts a fresh
  speech transaction. That transaction owns its insertion target from its
  start, so a recognizer revision of its earlier chunks (for example xAI's
  whole-utterance `speech_final`) replaces them rather than appending a second
  copy; the previous transaction settles before the follow-up one begins.
  Recognizer revisions of manually edited dictation are an open design:
  [sketch](../gaps/sketches/speech-revision-vs-manual-edits.md).
  Speech beginning before the deadline is allowed to
  finish rather than being cut off by the deadline; another speech send renews
  the window. The coordinator survives the New Session -> active-session
  navigation boundary. With Keep Mic Warm off, YA retains the device only for
  this temporary window and releases it when the window ends. With Keep Mic
  Warm on, the same active-listening window ends on schedule while the ordinary
  idle warm stream remains. Only a streaming backend that advertises Smart
  Turn can use this option.
  Non-empty interim and final transcript events count as speech begun even
  when the backend keeps its status at `listening`. Enabling follow-up does
  not open the mic before the user's first activation. That activation shares
  its device with subsequent follow-up turns, including across composer
  navigation. Command grace keeps capture running; automatic-send
  finalization retains the device until the result can arm the next turn.
  Stop cancels the held automatic send and releases temporary device ownership.
  Disconnect, disposal, or a five-second finalization failure bound also
  releases it; failure salvages recognized text without sending it.

The browser-local **Speech message prefix** selector defaults to the `🎤`
preset. Its other presets are `[ASR]`, `[STT]`, and `[Dictation]`; Custom
accepts one trimmed, non-empty line up to 64 characters and adds no brackets.
The selector represents the microphone preset with the same monochrome outline
glyph as the composer microphone control; that display glyph does not replace
the provider-bound `🎤`. An enabled prefix is added only to the provider-bound
message, never the editable draft, to tell the agent that the text may contain
speech-recognition errors. The preference is
backend-independent: browser-native Web Speech and configured STT backends use
the same selection. Off guarantees verbatim provider-bound text for both
manual and speech-triggered delivery.

When prefixing is enabled, Smart Turn's automatic endpoint send and an explicit
spoken `send`, including the batch form, receive the selected prefix. A separate
browser-local **Quick-send speech-prefix window** controls the same attribution
for a manual Send, Steer, Queue, Project Queue, or eligible fork/summary delivery
after finalized speech. It is configurable from 0–5000 ms and defaults to 0
(disabled). A non-empty finalized speech commit arms the window; one successful
eligible delivery consumes it. Later manual delivery remains unmarked. The
window is disabled in the UI while the prefix is Off, but its stored duration is
preserved.

A delivery pressed during capture is evaluated only after the backend final is
committed. Successful provider settlement rearms the quick-send window before
the recorded delivery runs, so backend processing time cannot consume the
configured delay. Send, Steer, Queue, Project Queue, New Session, overflow-menu,
and mobile-keyboard controls consume the same resolved prefix as their payload.
They retain their normal glyph and gain a compact cue for that exact prefix only
when activating them will prepend it; the full prefix is present in tooltip and
accessible copy. With prefixing Off or the manual window inactive, no prefix cue
appears merely because speech is pending. A speech-triggered send with neither
text nor attachments remains a no-op.

Open design slot: command recognition should eventually work per `is_final`
chunk after a YA command-settle signal. That settle signal may be a timeout
shorter than the Smart Turn timeout, but the value is not chosen here. Per the
speech UI timing rule, do not implement a fixed delay unless the maintainer
explicitly authorizes the value.

Open feasibility slot: audio captured during that command-settle delay which
is neither a command nor represented in the current finalized transcript may
belong at the front of the next follow-up ASR request. Retaining and prepending
that PCM is desirable only if a replay test proves the current request did not
already consume it; otherwise the handoff would duplicate words across the
turn boundary. Do not implement this until provider event timing can identify
the unconsumed audio span and the behavior can be exercised deterministically.

## Batch Behavior

Whisper receives the already-composed text before the speech insertion cursor
as its transcription prompt. A selected replacement and the suffix after it
are excluded. The active-session and new-session composers both provide
this context. Each recording snapshots it before microphone acquisition;
later edits and overlapping recordings cannot change that recording's prompt.
The client sends at most the last 8000 characters through the existing batch
`prompt` field; faster-whisper applies its own token context limit. Other
backends receive no invented text-prompt parameter. Grok's vocabulary-bias
integration is tracked separately in
[the unigram gap](../gaps/speech-unigram-vocabulary.md).

Batch providers produce no streaming drafts and no mid-utterance Smart Turn.
The default batch result is "wait": insert the whole recognized transcript at
the speech transaction point, stop recognition, and do not submit.

Stopping a batch recording ends capture synchronously. The mic button must
clear its red/listening state immediately; slower upload, provider latency,
local model load, or a slow CPU plus large ASR model are post-capture
processing and must not make the mic look active.

While the batch result is pending, the composer stays fully native and usable:
the textarea keeps its real, visible draft and native caret, and the user may
type or edit anywhere. The captured insertion target maps through those
ordinary textarea edits. A single `Transcribing…` status appears beside the
mic in the toolbar, never inside the textarea or its mirror. Overlapping
requests must not duplicate status strings in the draft.

**Known limitation — typing at/after the insertion span.** While a speech
preview is active, the provisional span is absent from the textarea value but
the overlaid mirror reserves visual space for it, so the native selection and
the rendered text diverge at and after that point. A mirror-drawn caret
communicates the visible speech insertion endpoint, but typing to edit text
*at or after* the insertion/replaced span is effectively unavailable until
the provisional preview resolves. This limitation applies only while actual
interim speech is visible; processing and finalizing never activate the
mirror. The clean fix for the remaining provisional-state limitation is a
richer input (see
[composer-rich-input.md](composer-rich-input.md)).

### Cancel contract

Cancel during the post-capture wait is **Escape**. The toolbar status is
informational and there is no inline `✕`. Escape ends the pending speech
transaction and drops its insertion target; active `listening` still finalizes
on Escape instead (keeping interim), and the mic can still start an overlapping
new recording during the wait.

The guarantee is result-suppression, not necessarily work-interruption: a
transcription that finishes after cancel must be fully inert — it inserts
nothing, replaces nothing, and triggers no send. The provider discards the late
result via its `cancel()` method (see
[pluggable-speech-recognition.md](pluggable-speech-recognition.md)). Actually
interrupting the backend request or model work is an optional optimization and
may never be implemented; the only contract is that a completed-after-cancel
result is a no-op.

### Unifying batch and streaming

Batch is a special case of streaming: one `is_final` block per mic activation,
possibly with a high startup latency (model cold-load). The pending-result wait
(`processing`) and the streaming finalize wait (`finalizing`) are the same
conceptual state at different latencies, surfaced by one status beside the mic.
The distinct surface wording is deliberate and stays — `Transcribing…` for
batch and `Finalizing…` for streaming. The composer still receives the pending
*kind* (`starting` | `listening` | `transcribing` | `finalizing`) from the mic
button for transaction lifecycle, but none of those status strings enter the
draft. Provider startup and
reconnection belong to the same speech transaction as capture. A composer
target is cleared only when a previously non-null kind returns to null (or its
mic control unmounts), so `idle -> starting -> listening` preserves the
captured caret. Startup failure is a terminal settlement: a recorded delivery
must fail and restore its detached draft rather than hang or disappear.

Cancel (Escape) abandons only the in-progress, non-final portion of the active
mini-turn; already-accepted `is_final` blocks remain in the draft. For batch
there is no committed block during the wait, so cancel drops the whole pending
result. For streaming, `cancel()` discards the uncommitted preview / in-flight
tail and ignores any racing `final` (a start-token bump makes later socket
messages inert), while the `is_final` blocks already emitted to the draft stay;
this is distinct from `stop()`, which finalizes/flushes the tail.

Implemented: the draft mirror surfaces underlined provisional speech during
capture and nothing else. `Transcribing…` (batch) and `Finalizing…` (streaming
flush) render once beside the mic while the textarea and native caret remain
untouched. During active capture the animated mic remains the stop/finalize
control. Escape cancels the post-capture wait and routes to the unified
`cancel()`.

When the batch result arrives, YA treats it as one delayed finalized streaming
chunk. It uses the speech transaction target captured at mic start, including
the originally selected replacement span, rather than whatever selection or
speech transaction is current at result time. User edits made while the batch
is pending map that target through ordinary textarea edits. A new recording may
start while the earlier batch transcription is still pending; if multiple batch
transcriptions overlap, each result must either carry a distinct speech target
or be blocked until the previous pending result has landed.

Batch supports simple whole-batch spoken commands:

- A trailing `send` word is stripped, the preceding recognized text is inserted
  at the speech transaction point, and the composer is submitted. If the batch
  transcript is only `send`, YA submits the existing composer unchanged.
- A trailing `cancel` word cancels the whole batch result. It inserts nothing
  and, when the mic started over a selection, leaves that selected text
  untouched.
- `wait` is not a batch command. If the recognizer returns a transcript ending
  in `wait`, YA treats it as dictated text because batch already defaults to
  stop-without-send.

## Stop And Escape

Clicking the active mic button or pressing the voice shortcut toggles capture
off using the provider's normal stop behavior. For xAI streaming STT, manual
stop sends `audio.done` immediately and waits for `transcript.done`. The mic
button must clear its red/listening state as soon as capture stops, but the
speech provider remains in a non-recording finalizing state until the final
response lands. If an interim preview is visible at the explicit stop, YA
commits that exact preview immediately and ignores later text revisions from
the stopped capture. With no visible interim, normal provider finalization
continues, which preserves batch and non-preview streaming behavior. Smart
Turn/endpointing still finalizes through `is_final` transcript partials. In the
initial implementation, Esc may duplicate that same toggle behavior when focus
is in the composer.

The voice shortcut is Ctrl+Space, judged by the modifiers that genuinely
apply rather than by the raw `ctrlKey` flag
(`packages/client/src/lib/modifierChords.ts`), so fast "Ctrl+V, Space"
rollover types a space instead of toggling the mic. A fresh Ctrl hold always
makes Space the shortcut, whichever key is released first. After an earlier
key in the same hold, the gap since that key's release decides: under 50 ms
(or before its release) Space is typed; from 300 ms it is the shortcut; in
between it is the shortcut unless Ctrl is released before Space. Gaps are
measured from the events' own timestamps, so a busy main thread delivering a
keystroke burst late does not change the verdict.

Proposed stronger Esc behavior: while a mic transaction is active, Esc should
remove all speech inserted since the button press and stop recognition. That
is broader than spoken `cancel`, which only removes the latest finalized
speech chunk and keeps recognition running.

## Feedback

The browser/window title starts with `◷🎙` while capture is starting and `🎙`
while recording, including audio memos. These cues remain visible independently
of the optional composer hotkey beacon and playback reduction setting. They
disappear when capture stops; final ASR processing and idle warmed microphone
tracks do not count as recording. Multiple mounted controls retain the cue
until the last active capture stops. The leading cue leaves configured title
formats and the trailing delivery/beacon suffix intact.

Browser-native delivery waits for recognition's final results and end event
after stopping. If it does not finish within five seconds, delivery fails and
the draft remains recoverable; late results cannot send it afterward.

The mic's capture readiness stays event-driven. While the capture path is
initializing or browser-native capture is reconnecting, the mic uses an amber
treatment and the wide-screen status says `Starting…`. Amber means capture was
requested but no real audio/capture event has arrived; it never claims the mic
is recording. Once the path produces a real capture event, the mic turns red
and the wide-screen status says `Speak now…`; while the recognizer reports
speech or delivers transcription results, it says `Listening…`. Because
browsers do not reliably emit a matching
speech-end event, 1.2 seconds without a provisional or final recognition update
returns the status to `Speak now…`; an explicit speech-end event returns it
immediately. This inactivity inference changes only the feedback label, never
transcript boundaries or capitalization.
Browser-native Web Speech sessions that end unexpectedly and are automatically
restarted return to `Starting…`; they do not expose the network-sounding
internal `reconnecting` state. The changing words provide the status feedback;
status text keeps the normal text color and weight, and actual error text
remains red. The mic control itself turns red after the active path produces a
real listening/capture event. Its active icon is a microphone
knocked out of a filled circle in the input background color. The unified disc
stays still at `Speak now…` and pulses only while the state says `Listening…`.
Only the filled circle changes size; the larger microphone glyph remains fixed
so the activity cue does not make the symbol itself wobble. Idle, starting, and
active states all render the exact same microphone SVG geometry and size;
capture changes only its foreground/background treatment and adds the disc
behind it. The 18px icon is sized to balance with neighboring toolbar glyphs
without filling the button. Even at rest, the disc fully contains the
microphone and its stand; active pulsing expands outward from that baseline
rather than shrinking behind the glyph. Its resting scale includes the
microphone stroke extending beyond the path's nominal bounds. This is
deliberately activity-driven, not a fabricated volume meter;
browser-native Web Speech exposes sound/speech events but not audio samples.
With Smart Turn follow-up enabled, the waveform slot stays visible for up to
300 ms after capture stops. A new capture within that interval cancels removal,
so a brief finalization/start handoff does not collapse and reopen toolbar
space. Samples are still cleared immediately when capture stops: the retained
slot does not fabricate live audio or change microphone/recognizer ownership.
Errors and disabling waveform display remove it immediately.

While capture is active, the configurable live waveform is a non-interactive
backdrop across the toolbar's left and center span. It owns no required width
and never displaces or covers the right-side status and delivery controls.
Empty gaps over that span remain completely clear: there is no translucent
toolbar-wide veil. Each actual control paints only its own background at the
browser-local **Button background opacity over waveform** value (0–100% in 5%
steps, default 70%). Icons, labels, borders, focus indicators, and hit targets
remain fully solid. The parked or open file-viewer controller follows the same
background opacity even though it is portaled for stable positioning. If
starting, finalizing, or error status text ever coincides with the waveform,
the text receives a fully opaque backing; red error text is never drawn
directly over the waveform.

The animated mic and changing status copy are the only persistent capture
indicators: neither the session composer nor the new-session composer draws a
pulsing red strip across its top edge. Overflow behavior remains as specified
in [composer-bottom-bar-overflow.md](composer-bottom-bar-overflow.md). The
waveform is a default-on element in Toolbar settings. It is available for
YA-controlled capture paths, where YA receives real audio samples;
browser-native Web Speech does not expose its microphone samples and therefore
does not show a fabricated waveform. When the waveform is shown, the desktop
`Speak now…` / `Listening…` text beside the mic is suppressed as redundant;
starting, finalizing, and error text remain useful state feedback. Waveform
amplitude uses a bounded decibel scale, saturates at 80% input amplitude, and
may reach the toolbar's exact top and bottom bounds without a rectangular
background or outline. The visible sample count is a client-side presentation
effect derived from the waveform element's measured pixel width; capture and
transport remain layout-independent. It renders one sample vertex per measured
CSS pixel in a continuous mirrored envelope, so there are no visual gaps and
saturation intentionally becomes a visibly clipped band. The envelope is
painted directly to a canvas with a smooth, symmetric vertical gradient: the
center stays warm orange, then transitions through coral to rose at the outer
peaks without discrete meter bands. The Toolbar settings specimen uses this
same renderer with a deterministic speech-like envelope whose height is mostly
below 60%; live capture continues to use only real microphone samples. Neither
path uses a cached bitmap or a separately styled waveform. Audio
callbacks only overwrite the latest pending sample buffer; at most one
`requestAnimationFrame` is queued, accepted draws are capped at 60 fps, and
intermediate samples are coalesced when the browser is busy. Hidden documents
queue no paints. Spoken commands may be shown as
temporary UI feedback near the mic, such as a small command chip, but the chip
is advisory UI only: the command word still must not appear in the textarea
value.

`Reduce playback while dictating` is a browser-local, default-on capture
setting. From the first starting state until the last microphone track closes,
YA exactly mutes every HTML audio/video element it owns, including media inserted or
unmuted during capture. Partial/final transcript updates, command grace,
automatic-send finalization, and idle retained microphones do not restore
playback while that device remains open. Multiple capture owners share the mute;
YA restores each element's original muted state only after the last owner is
idle. The default also requests echo cancellation for YA-controlled microphone
streams, which lets Android Chromium select its communication/AEC capture path.
Noise suppression and automatic gain control remain off, and the speech wire
format remains mono 16 kHz PCM16. Browser-native Web Speech cannot receive YA's
media constraints, but the exact YA-media mute still applies. Opening the
microphone alone ducks other Android apps only momentarily, so on Android the
same span also plays a detached, unmuted, looping one-second silent clip:
Chrome holds `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` for playing media of known
duration up to five seconds, which keeps other apps (for example a YouTube
mini player) ducked until the last capture owner is idle. A retained idle
microphone is not such an owner: it keeps YA media muted but does not keep
other apps ducked between dictations. The clip is never
in the document, so the YA-media mute cannot reach it. Apps that handle focus
loss themselves may pause instead of ducking. Turning the setting off is the
explicit raw-capture opt-out: YA does not mute its media, holds no audio
focus, and requests echo cancellation off.

Each stopped batch recording also owns a terminal settlement event keyed by
its captured speech target. A later mic activation does not cancel or replace
that queued request. Completion, cancellation, or failure retires exactly that
target; in particular, an older failure while a newer capture is active must
not leave an orphan `Transcribing…` tag or clear the newer target.

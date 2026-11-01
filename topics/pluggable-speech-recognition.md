# Pluggable Speech Recognition Providers
> YA speech recognition should be an explicit user-selected method:
> browser-native remains a device-local option when available, while configured
> YA server backends receive browser-captured audio for transcription or future
> audio forwarding without exposing speech credentials to clients.

Topic: pluggable-speech-recognition

See also: [direct-xai-speech.md](direct-xai-speech.md) for the hosted Grok
plan where the browser sends audio directly to xAI and YA only brokers
explicit credential/config material.
See also: [mic-button-speech-ui.md](mic-button-speech-ui.md) for the mic
button's composer insertion, selection replacement, and spoken-command
behavior across streaming and batch STT.

## Contract

- `VOICE_INPUT=false` is the master kill switch. When it is false, YA does
  not advertise voice input or server-routed speech backends.
- Server-routed backends are off unless an explicit signal enables them.
  Local backends (`ya-whisper`, `ya-parakeet`, `ya-nemo`, `ya-granite`) are
  enabled by the union of `YEP_VOICE_BACKENDS` and the persisted server
  setting `speechVoiceBackends` (Speech settings checkboxes). On startup the
  env list is copied into that setting when missing; the env list never
  removes a saved backend. `ya-dummy` remains env-only. Cloud backends
  (`ya-deepgram`, `ya-grok`) auto-enable when their YA-scoped key is provided,
  since providing a metered key is the operator's explicit opt-in. Configured
  backends appear immediately through `/api/version.voiceBackendStatuses`, but
  only backends that pass startup validation are routable and advertised as
  `voiceBackends`. Saved additions validate asynchronously without restarting
  YA; removing a running backend or changing the process environment takes
  effect on the next YA restart. Existing workers and in-flight speech remain
  intact while new backends validate.
- Browser-native Web Speech recognition is a selectable local escape hatch,
  not a YA server backend. The browser still owns its recognizer, credentials,
  latency, and failure modes.
- The user chooses among advertised methods. YA should not silently fall back
  from one configured server method to another, and it should not auto-enable
  a backend merely because its code exists — enablement requires an explicit
  signal: a `YEP_VOICE_BACKENDS` entry, a saved Speech settings checkbox, or a
  provided cloud key.
- OS keyboard dictation is outside YA's speech stack. If the user taps the
  keyboard's mic glyph, that is device-native text entry, not YA-mediated
  speech recognition.
- Server-mediated recognition is valuable only if it buys something browser
  native cannot: server-side keys, backend choice, project/session biasing,
  retry/buffering under YA's transport, or direct audio input to an
  audio-capable agent provider.
- Speech readiness UI is event-driven. The mic must not turn red, show
  recording bars, or display "Listening" from a fixed delay or from a weak
  start-request acknowledgement. Use real capture/listening events from the
  active path: first Web Audio processor frame for YA-controlled PCM capture,
  browser Web Speech audio/sound/speech events for browser-native STT, and
  backend/socket events only for backend readiness. A fixed delay or warm-up
  margin may be proposed, but it requires explicit maintainer authorization
  before implementation.
- YA-server recognition keeps an audit trail by default. Captured speech audio
  is retained for eight weeks or 400 MB, whichever limit prunes it first, using
  a speech-appropriate compressed browser recording such as Opus/WebM. Each
  retained utterance has sidecar metadata that includes backend id, MIME type,
  byte size, timing, transcript text, the ordered streaming recognizer trace
  when available, and the best available session plus client-turn pointer. This
  is intentionally useful for local speech-model fine-tuning,
  transcription-quality audits, and debugging backend selection.
- Ordinary server logs should identify the selected speech backend, request
  source, audio size, MIME type, session/turn pointer, duration, transcript
  character count, and retention result. Logs must not include the transcript
  text itself; retained metadata is the place where transcript text belongs.
- A provider may implement an optional `cancel()` to abandon an in-flight
  post-capture (`processing`) transcription. The contract is result-suppression,
  not work-interruption: after `cancel()`, a transcription that still completes
  must be discarded — no `onResult`, and no state change beyond returning to
  idle. Cancellation is batch-token-specific: starting a newer recording must
  not cancel or suppress an older queued transcription. Aborting the underlying
  request or model work is an optional optimization. Every stopped batch also
  emits one terminal settlement keyed by its captured speech target, including
  completion, cancellation, and failure, so consumers can retire the exact
  pending insertion target independently. See the batch cancel chip in
  [mic-button-speech-ui.md](mic-button-speech-ui.md).

## Intended Architecture

The browser-native path uses `SpeechRecognition` /
`webkitSpeechRecognition`. YA receives only transcript text and appends it to
the composer as if the user had typed it.

The YA-server path captures audio in the browser and has the server dispatch it
to the selected backend. Backends advertise optional capabilities alongside
their ids; `streaming: true` means the client may use YA's streaming speech
WebSocket instead of the batch POST path. Batch transcription records
speech-appropriate compressed audio with `MediaRecorder`, buffers until stop,
then sends the complete utterance through YA's ordinary API transport so local,
hosted, and relay clients share the same request path. Streaming transcription
captures Web Audio samples, converts them to raw PCM16 little-endian at a
backend-supported sample rate, and sends binary frames to the direct
`/api/speech/ws` route locally or to a dedicated secure relay `speech` channel
remotely. The relayed channel is a second WebSocket/TCP stream for speech, not
PCM multiplexed through the app/control relay socket.

Backends should implement a common `SpeechBackend` contract:

- validate credentials or local runtime/import readiness at startup without
  forcing an expensive local model load;
- advertise only validated ids plus their capabilities;
- transcribe a complete utterance with optional `mimeType`, `prompt`, and
  `keyterms` options;
- optionally open a streaming session that accepts raw audio frames and emits
  interim/final transcript events;
- keep expensive local models warm rather than loading per utterance.

Local STT backends should use the same event contract when the model/runtime can
produce meaningful stream updates. A local model that exposes partial/final
segments, timestamps, endpoint confidence, or a confidence signal that an audio
chunk is transcribable should feed those events through the generalized
streaming path instead of inventing a separate UI flow. Offline-only models
such as a basic faster-whisper worker remain batch backends until a verified
streaming/confidence surface exists.

## Implemented

- Client speech capture was refactored behind a `SpeechProvider` interface.
  `BrowserNativeProvider` owns the Web Speech state machine, explicit
  language setting, interim/final result handling, mobile cumulative-final
  deduplication, and auto-restart behavior. Browser-native result handling uses
  `resultIndex` as the changed-range boundary: immutable final entries before
  it remain history, a changed final at the same index can replace text YA
  committed for that index, and a higher index remains a distinct result. A
  recognizer restart clears that index ownership before accepting results from
  the new run.
  Server model-selection options are passed only to their owning backend.
  Discovering Parakeet or Whisper capabilities must not recreate an active
  browser-native recognizer or interrupt its next result.
- `YaServerProvider` captures microphone audio with `MediaRecorder`, buffers a
  complete utterance, and posts it to `/api/speech/transcribe` through the
  shared client API helper. Remote/SecureConnection clients therefore use the
  same transport as ordinary YA API calls.
- When the selected server backend advertises `streaming: true`,
  `YaServerProvider` captures microphone audio through Web Audio, downsamples it
  to 16 kHz signed PCM16 little-endian, and sends binary frames to
  `/api/speech/ws`. Interim and chunk-final events update the composer
  preview; final partial events commit provider-owned transcript segments into
  the editable draft without stopping the mic, and utterance-final partials
  (`speech_final=true`) close or Smart Turn-decide the speech turn.
  For xAI-style streaming events, YA treats word timestamps as the committed
  audio span when they are present. The top-level `start` plus `duration` may
  instead describe a broader segment window that remains fixed while xAI emits
  several non-empty `is_final` sub-chunks. YA uses the top-level `start` as the
  replacement group key, uses word spans to advance the committed cursor inside
  that group, and treats a later `speech_final=true` event for the group as an
  authoritative correction of the group-owned text. If a stitched
  utterance-final event starts at an earlier committed group and no longer has
  the already-committed group text as its prefix, YA replaces the owned group
  range through explicit composer replacement metadata. If the event is merely
  cumulative and still has the committed group text as a prefix, YA keeps only
  the word-timestamp tail after the committed-audio cursor. Distinct later spans
  append even if their transcript text is identical. The streaming path must
  not dedupe or slice by substring comparison.
  The client does not infer safe sub-spans from punctuation, confidence, or
  sentence boundaries; safe-to-edit text is only the text already committed by
  provider event semantics.
  Clicking stop commits the currently visible preview before ignoring
  stop-flush partials, and the final event carries the retained transcription
  id.
  Interim streaming text is rendered through an inline textarea mirror: it wraps
  in the same visual compose plane as the committed draft and highlights the
  mutable tail, but it is not part of the textarea value. The textarea remains
  the committed draft only, so user edits do not accidentally freeze recognizer
  text that may still be revised. A caret move during an interim queues the
  insertion target for the following provider fragment; the current interim
  stays anchored until its final arrives.
  Appending committed speech deltas must not steal the textarea cursor: if the
  user is editing earlier committed text, preserve selection and scroll; if the
  cursor was already at the old end, let it follow the appended speech.
  Starting the mic also creates a speech-owned insertion range. If committed
  text is selected, YA deletes that selection first, places the cursor at the
  deletion point, and inserts final speech deltas there rather than at the end.
  User edits map the speech-owned range through ordinary textarea changes;
  edits inside that range remain part of the speech-owned text. A Smart Turn
  `wait` command leaves the range's committed text in the composer without
  sending, while `cancel` removes the range and clears the mutable preview.
  Selection restoration is tied to the committed textarea value update, not to a
  fixed UI delay.
- Backends may advertise `smartTurn: true` when their streaming API supports
  ML end-of-turn detection. Grok STT exposes this through the xAI
  `smart_turn` threshold and `smart_turn_timeout` parameters. The client shows
  Smart Turn controls only when the selected backend advertises that capability.
- Grok STT through YA is advertised as a streaming method. `ya-grok` captures
  Web Audio in the browser and sends raw 16 kHz PCM16 frames to YA for
  streaming recognition. The retained `ya-grok-batch` implementation uses the
  browser's MediaRecorder output and the batch transcription route, but normal
  STT menus do not offer it. Smart Turn depends on streaming `speech_final`
  events and is therefore only active for methods whose capabilities advertise
  both `streaming` and `smartTurn`.
- `useSpeechRecognition` selects browser-native when the method is
  `browser-native`; `xai-grok-direct-streaming` constructs a direct xAI
  streaming provider; the retained `xai-grok-direct-batch` id constructs a
  direct xAI batch provider but is not advertised in normal STT menus;
  advertised server backend ids construct `YaServerProvider` unchanged.
- The client speech-method selector is data-driven from
  `/api/version.voiceBackends`, the special browser-native fallback, and direct
  xAI client methods only when direct xAI can run: either `ya-grok` is
  advertised or this browser has a local xAI STT key. It does not keep a
  client-side whitelist of server backend ids; unknown advertised ids remain
  selectable and route through YA unchanged. Grok batch ids are hidden from the
  normal selector; stored batch selections resolve to streaming Grok when Grok
  STT is available.
- `NewSessionForm` and the active session composer toolbar build
  speech-method dropdowns from the same advertised active backend list. The
  dropdown is shown only when more than one method is available.
- `useModelSettings` persists an explicit browser-local `speechMethod` under
  `yep-anywhere-speech-method`. When there is no explicit local choice,
  server-learned `clientDefaults.speech` from `/api/version` supplies the
  client default. Speech setting changes write both the local explicit value
  and a partial server client-default update so a later browser with no
  explicit local override inherits the most recent UI choice.
  If neither local nor server default exists, the effective runtime default
  prefers direct Grok streaming when `ya-grok` is configured, otherwise active
  server-routed STT over browser-native, with `ya-deepgram` ranked ahead of
  unknown server backends. Browser-native remains the explicit local escape
  hatch.
- Server config parses `VOICE_INPUT`, `YEP_VOICE_BACKENDS`,
  `YEP_STT_DEEPGRAM_API_KEY`, `YEP_STT_XAI_API_KEY`, `XAI_API_KEY`,
  `WHISPER_MODEL`, `WHISPER_DEVICE`, `WHISPER_COMPUTE_TYPE`,
  `PARAKEET_MODEL`, `PARAKEET_DEVICE`, `NEMO_MODEL`, and `NEMO_DEVICE`.
  `YEP_STT_XAI_API_KEY` takes precedence for `ya-grok`; `XAI_API_KEY` is a
  convenience fallback that is scrubbed from `process.env` after config load.
- `SpeechBackendRegistry` supports `ya-dummy`, `ya-deepgram`,
  `ya-grok`, `ya-whisper`, `ya-parakeet`, `ya-nemo`, and `ya-granite`. It records configured
  backends immediately as pending, validates them asynchronously, and keeps
  pending/disabled entries out of routing. `/api/version` exposes validated ids
  plus capabilities separately from the full pending/enabled/disabled status
  catalog, allowing clients to show startup state without sending audio early.
- `ya-grok` posts batch multipart audio to xAI's `POST /v1/stt`
  endpoint and implements xAI's `wss://api.x.ai/v1/stt` streaming endpoint.
  In streaming mode it can enable Smart Turn and pass through xAI word
  timestamps so the client can recognize optional paused end commands.
  Both cloud backends auto-enable when their key is present
  (`YEP_STT_XAI_API_KEY` or scrubbed `XAI_API_KEY` for `ya-grok`,
  `YEP_STT_DEEPGRAM_API_KEY` for `ya-deepgram`) because providing a metered key
  is the operator's explicit opt-in. `ya-grok` is currently the only backend
  advertising streaming.
- Deepgram and local faster-whisper backend implementations exist. The local
  Whisper path uses a warm Python worker subprocess around `faster_whisper`.
  The local Parakeet path uses the same pixi `stt` environment with a separate
  Transformers/PyTorch bootstrap and a warm Python worker around
  `pipeline("automatic-speech-recognition")`. The local NeMo Parakeet path is a
  separate explicit `ya-nemo` backend in the isolated pixi `stt-nemo`
  environment installed by `nemo-bootstrap`. It uses a warm `nemo.collections.asr`
  worker and decodes compressed browser recordings through `ffmpeg` only when
  needed before handing NeMo a mono 16 kHz WAV. The browser can choose the
  Parakeet model id per request from STT settings or the mic options panel for
  either Parakeet backend; `PARAKEET_MODEL` / `NEMO_MODEL` remain server
  fallbacks for clients that send no model. The implemented presets are
  limited to model ids tested in the current runtimes:
  `nvidia/parakeet-tdt-0.6b-v3`, `nvidia/parakeet-ctc-1.1b`, and
  `nvidia/parakeet-rnnt-1.1b`. Presets carry backend compatibility metadata:
  model selection keeps the current compatible backend, switches to another
  enabled compatible backend when needed, and hides or disables presets that no
  enabled backend can run. Custom model ids stay backend-neutral and are sent to
  the currently selected Parakeet backend. Both local Parakeet backends are
  batch-only until a local streaming/chunking surface is proven.
- `ya-granite` runs IBM Granite Speech through Transformers in the shared pixi
  `stt` environment, bootstrapped by `stt-bootstrap-granite`
  (`requirements/stt-granite.txt` adds torchaudio and PEFT on top of the
  Transformers Parakeet install). Granite Speech is a 2B speech-aware language
  model rather than a CTC/RNNT recognizer, so `granite_worker.py` builds the
  documented `<|audio|>` chat prompt and calls `generate()` instead of the
  Transformers ASR pipeline, sizing the token budget from the utterance
  duration. The browser sends no per-request model id for this backend, for
  either transcription or prewarm, so `GRANITE_MODEL` chooses the model for
  every YA-client dictation and `GRANITE_DEVICE` chooses the device. That is a
  client contract, not a server refusal: `WarmPixiSttBackend` honors an
  explicit request `model` for every family it runs, so a direct authenticated
  `POST /api/speech/transcribe` naming a `model` loads that model for Granite
  too. Device has no per-request form at all.
- Parakeet, NeMo, and Granite share one warm-worker implementation,
  `WarmPixiSttBackend`: pixi environment probe with auto-bootstrap, deferred
  model load, single worker, and the one-JSON-object-per-line worker protocol.
  A model family contributes only its pixi environment, worker script, model
  default, timeout, and repair advice. The Python workers likewise share
  `stt_worker_common.py` for container handling, ffmpeg decoding to mono
  16 kHz, and model-load error advice. Whisper keeps its own backend class: its
  model-swap and initial-prompt behavior differ.
- Each local backend (Whisper, Parakeet, NeMo, Granite) keeps a single worker and
  serializes all loads and transcriptions onto one FIFO queue (`SerialQueue`).
  A request that arrives while a model is still loading — or while a model swap
  is in flight — waits its turn (record audio, block on the load, then
  transcribe) instead of being rejected with "backend is busy with another
  request". A model swap still kills the old worker before loading the new one
  (single worker by design), but the swap-load is just another queued step, so
  it blocks rather than errors. A failed load (e.g. a NeMo-only model sent to
  the Transformers `ya-parakeet` backend) rejects only that request; the queue
  continues. Client batch providers retain each recording's captured speech
  target while it waits and emit a target-specific terminal settlement, so
  overlapping requests can complete or fail independently without orphaning
  composer tags.
- The normal `index.ts` runtime mounts `/api/speech` after
  `createNodeWebSocket()` creates the shared `upgradeWebSocket` helper.
- `createSpeechRoutes` implements `POST /api/speech/transcribe` for batch
  transcription and `GET /api/speech/ws` for both buffered WebSocket
  transcription and streaming transcription to capable backends. The WS route
  accepts JSON control frames even when the unified Node WS path presents text
  frames as `Buffer`s. Streaming metadata includes the ordered transcript trace
  as one recognizer event per line.
- `createSpeechRoutes` also exposes direct xAI credential brokering:
  `/api/speech/xai-client-secret` mints a short-lived xAI client secret for
  browser WebSocket streaming to `/v1/stt`, while
  `/api/speech/xai-client-key` returns the long-lived STT key only when
  `YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS=1` enables direct batch borrowing.
- `xai-grok-direct-streaming` reuses the YA Web Audio PCM16 capture path but
  opens `wss://api.x.ai/v1/stt` directly from the browser with
  `Sec-WebSocket-Protocol: xai-client-secret.*`. `xai-grok-direct-batch`
  records a complete `MediaRecorder` utterance and posts it directly to
  `POST /v1/stt`, so it emits final text only.
- The browser-local xAI STT key field is always reachable from STT settings and
  from the mic-button speech options. Saving a non-empty browser key updates
  the method list locally and can make direct Grok streaming the selected
  default even when the YA server advertises no Grok STT backend. The masked
  key field is a new credential, never a saved-login password; browser password
  managers must not pair it with an earlier text or search field.
- YA-controlled and direct xAI STT paths share one browser mic capture owner
  when Keep Mic Warm is enabled. The shared stream is keyed by the selected mic
  device, requests the same raw speech constraints for batch and streaming
  paths (mono / 16 kHz / 16-bit ideals, echo cancellation, noise suppression,
  and auto gain off), and survives provider disposal during STT backend
  switches. Provider disposal cancels that provider's active capture and
  subscriptions; shared idle warm mic ownership is separate from provider
  lifetime and may survive disposal/backend replacement when Keep Mic Warm is
  still enabled and the selected mic/constraints are compatible. Idle warm
  ownership is gated by page visibility rather than focus: a visible but
  unfocused YA page may keep the idle stream warm, a hidden page releases only
  the idle warm stream, and active ASR capture/finalization is never stopped
  merely because the page loses focus or becomes hidden. The idle warm stream is
  released when Keep Mic Warm is disabled, the selected mic changes, the tab
  closes, the page becomes hidden, or the shared release path explicitly runs.
- Browser-native STT does not consume YA's shared mic stream: Chrome owns the
  Web Speech capture path. Its UI treats `SpeechRecognition.onstart` only as a
  start acknowledgement; red/listening state waits for Web Speech
  audio/sound/speech start events or for a result event if Chrome skips the
  earlier events.
- Hosted/relay clients can stream to server STT through a dedicated secure
  relay `speech` channel. The server registers that channel separately from the
  app channel under the same relay username/install id, the browser opens a
  second relayed WebSocket, resumes the same YA remote-access session on it,
  sends speech controls as encrypted JSON, and sends PCM frames as encrypted
  binary speech-audio frames.
- Tests cover registry defaults, explicit backend advertisement, disabled
  voice input, `/api/version.voiceBackends`, HTTP batch transcription, and the
  dummy backend through the mounted WebSocket route.

## Current Remaining Gaps

The 2026-05-30 wiring audit found three end-to-end blockers: the real server
did not mount speech routes, the client stripped the `ya-` backend prefix, and
the client used a raw same-origin WS that bypassed YA's remote transport. The
current implementation fixes those blockers for batch transcription by
mounting `/api/speech`, preserving backend ids, and routing the production
client through `fetchJSON("/speech/transcribe", ...)`.

- With no cloud STT keys and an empty `YEP_VOICE_BACKENDS`, a server advertises
  `voiceInput` but `voiceBackends: []`, causing the UI to expose only
  browser-native recognition when that browser supports it. A browser without
  Web Speech instead shows the visible-disabled unavailable mic state.
- `/api/speech/ws` remains the direct/local streaming endpoint. Relay streaming
  uses the dedicated secure relay `speech` channel instead of trying to route a
  raw browser WebSocket through the hosted app origin.
- Previously selected methods are reconciled against the current source's
  `voiceBackends` and browser capability before the mic button is used. If an
  explicit server method disappears, or an explicit browser-native choice is
  unavailable in the current browser, the resolver returns an explicit
  unavailable state rather than silently choosing another method. The mic stays
  visible-disabled with unavailable copy, and the user can choose an advertised
  method from the selector. Legacy hidden Grok batch ids still migrate to Grok
  streaming only while the corresponding Grok method remains available.
- The current UI setting is a server-learned client default plus local override,
  not a true per-session speech method. The original plan's per-new-session
  override is not persisted as session metadata or passed through message
  submission.
- Audio retention settings exist conceptually as a global option: enable/disable
  saving, age limit, and size limit. The UI for changing those limits is a
  follow-up, but the runtime default is enabled with the eight-week / 400 MB
  retention contract above.
- Backend biasing is not wired. There is no `buildBiasingContext()` helper
  feeding Whisper `initial_prompt` or Deepgram `keyterm` values from project
  and session context. See *Keyterm Biasing* below for the plumbing status
  and the command-word assessment.
- Deepgram streaming partials are not implemented. Deepgram, Whisper, and dummy
  backends still use batch transcription unless a future backend explicitly
  implements the streaming extension.
- The current Smart Turn end-command recipe is deliberately simple: when Grok
  returns `speech_final=true`, a final `send`, `cancel`, or `wait` word only
  acts as a command if word timestamps show a pause longer than 500 ms before
  it; otherwise the word remains part of the dictated message. If no command is
  recognized, the action defaults to `send`. This fixed pause rule is ripe for
  improvement: a future model-side judge could decide whether the word is
  likely intended as message content or as an end command, including cases with
  a smaller pause. Do not build that extra judging layer until we have traces
  that justify it.
- Direct Grok streaming has a browser WebSocket auth probe and focused client
  tests for the xAI socket adapter, but it still needs a live
  browser-plus-xAI smoke test with a real microphone or captured audio source.
- Switching speech methods no longer intentionally tears down the warmed
  YA-controlled mic stream. If Chrome still pays a later cold-open cost after a
  backend switch, treat it as a browser/device behavior to measure, not a
  provider-disposal consequence.
- Live browser-native testing dropped the first second of "1 2 3 4..." after
  Chrome had fired `SpeechRecognition.onstart`; YA therefore does not treat
  `onstart` as a red/listening event. Browser-native remains a fallback whose
  capture and first-word behavior are owned by Chrome, not YA. Grok PCM
  streaming through YA appears reliable in live `ya.graehl.org` testing,
  likely because YA buffers PCM frames while the socket/provider handshake
  finishes.
- Audio-as-modality forwarding to providers that natively accept audio is not
  implemented. All current YA-server backend code is transcript-first.

## Remaining Plan

1. Surface a one-time notice or explicit re-pick prompt when a stored server
   `speechMethod` is no longer advertised.
2. Decide whether speech method is global-only for the first usable release or
   truly per-session. If per-session, persist it with session metadata and pass
   the session context into speech requests.
3. Add UI for global speech-audio retention settings. The first implementation
   may use the default eight-week / 400 MB contract without exposing controls.
4. Add `buildBiasingContext(session, project)` and thread its output into
   Deepgram keyterms and Whisper initial prompts.
5. Add backend-specific streaming partials beyond Grok where the backend
   supports them. Deepgram is the next candidate; local Whisper needs chunking
   or VAD and should remain a follow-up.
6. Re-check current provider audio-input support before implementing
   audio-as-modality. Providers that accept audio should get the original
   audio content, while text-only providers keep the transcript-first path.

## Local recognition candidates — 2026-09-08

The server defaults to `distil-large-v3.5` for Whisper and
`nvidia/parakeet-unified-en-0.6b` for NeMo Parakeet, at the maintainer's
request. Explicit `WHISPER_MODEL` and `NEMO_MODEL` settings remain authoritative.
Transformers Parakeet defaults to the English v2 HF conversion
`ai-and-i-project/parakeet-tdt-0.6b-v2-hf`; unified RNNT is a NeMo model.
Explicit multilingual v3 selections remain available. These choices are not
verified tablet-quality improvements.

Speech settings and the microphone menu offer recent model presets and custom
IDs. Whisper offers distilled v3.5, full large-v3, turbo, and distilled v3;
NeMo adds unified English and TDT v2 alongside the existing compatible models.
The microphone menu lists only models supported by its selected backend.
Its popup stays inside the viewport horizontally when opened or resized,
including phone widths where the microphone sits away from the left edge.
An unset browser preference or "Server default" omits the model override on
capable servers, preserving the server configuration. Explicit saved browser
choices persist and take effect immediately across mounted composers.

The `local-speech-model-selection` capability gates the new choices. Without
it, Whisper sends no model override; Parakeet uses its existing v3 fallback
when unset or when a saved new preset is unsupported. Saved preferences are
preserved, not rewritten when connecting to an older server. Existing custom
Parakeet IDs remain available. Whisper loads, prewarms, and transcriptions share
one queue: a model switch waits for the preceding transcription and the old
worker's exit. A failed load returns an error and permits a later retry.

| Candidate | Why compare it | Existing YA execution path |
| --- | --- | --- |
| [Distil-Whisper v3.5](https://huggingface.co/distil-whisper/distil-large-v3.5) | A newer English distilled model, trained with more varied data and augmentation. The authors report better short-form results than v3; this is not a tablet measurement. | `WHISPER_MODEL=distil-whisper/distil-large-v3.5-ct2` uses the published faster-whisper weights. The inspected faster-whisper 1.2.1 also recognizes `distil-large-v3.5`. |
| [Whisper large-v3](https://huggingface.co/openai/whisper-large-v3) | Full model as the accuracy-oriented comparison; expect more work per utterance than the distilled default. | `WHISPER_MODEL=large-v3`; the existing worker remains batch-only. |
| [Whisper large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo) | Pruned decoder trades some quality for speed according to its model card. Compare when full large-v3 latency is unacceptable. | `WHISPER_MODEL=large-v3-turbo`; supported by the inspected faster-whisper registry. |
| [Parakeet TDT 0.6B v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) | English-only comparison against multilingual v3; not evidence that older v2 is better. | Custom Parakeet model name `nvidia/parakeet-tdt-0.6b-v2`; verify load/decoding in the selected backend before adopting. |
| [Parakeet unified English 0.6B](https://huggingface.co/nvidia/parakeet-unified-en-0.6b) | Released April 2026; supports offline and buffered streaming inference with configurable context. Vendor leaderboard gains do not establish tablet gains. | Selectable on NeMo's isolated `stt-nemo` runtime. CPU and GPU worker transcription checked; YA currently uses batch inference. |
| [Canary-Qwen 2.5B](https://huggingface.co/nvidia/canary-qwen-2.5b) | English speech-language model worth a later accuracy comparison. | Requires a different `speechlm2`/`SALM.generate` worker, not the existing Parakeet `ASRModel.transcribe` contract. |

First compare distilled v3.5 and full large-v3 on the same retained tablet
clips, with manually verified text. Keep capture settings and preprocessing
identical, count dropped/substituted words and invented text on silence, and
measure latency separately. Follow with Parakeet v2/v3 and the isolated newer
NeMo candidate if needed. Do not upgrade the shared STT environment to make
the newer NeMo model fit; the coexistence constraints below still apply.

## Generative local recognizers — 2026-09-15

`ya-granite` adds the first local recognizer that generates its transcript
instead of decoding a frame alignment.

| Candidate | Why compare it | YA execution path |
| --- | --- | --- |
| [Granite Speech 4.1 2B](https://huggingface.co/ibm-granite/granite-speech-4.1-2b) | Apache-2.0, ungated, 2B parameters, English/French/German/Spanish/Portuguese/Japanese with punctuation and truecasing. IBM also publishes keyword-list biasing, speaker-attribution (`-plus`), and non-autoregressive (`-nar`) variants. | `ya-granite`, shared pixi `stt` environment. `GRANITE_MODEL` selects a variant. |
| [cohere-transcribe-03-2026](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026) | Apache-2.0, 2B, 14 languages, top of the Open ASR leaderboard in March 2026. Needs `transformers>=5.4`, which the `stt` environment already satisfies. | Not implemented. Downloading weights requires a Hugging Face contact-information agreement; that does not prevent implementing an install/access card. See `gaps/cohere-speech-backend.md`. |

### English candidate screening — 2026-09-16

The [Open ASR English short-form results snapshot](https://huggingface.co/datasets/hf-audio/open-asr-leaderboard-results/blob/19aa77a9ec5cb8aa353670a97a603794979e75d7/english_short_latest.csv)
reports the following candidates. WER is the macro-average over its eight
current test sets (AMI-Cleaned, Earnings22-Cleaned-AA-chunked,
Gigaspeech-Cleaned, LibriSpeech clean/other, SPGISpeech, Voice Arena Monsoon,
Voxpopuli-AA-Cleaned). The CSV does not supply per-split sample counts or all
hardware/batch details. These are published screening results, not local
dictation measurements or statistically established superiority. Do not mix
these numbers with older model-card averages using the previous test sets.

| Candidate | Mean WER (%) ↓ | Reported RTFx ↑ | Why retain for English evaluation |
| --- | ---: | ---: | --- |
| Qwen3-ASR-1.7B-hf | 4.31 | 819.96 | Installable `ya-qwen` backend, batch recognition |
| Hojo-ASR-V1 | 4.33 | 72.51 | Evaluated candidate; user subsequently dropped it |
| Granite Speech 4.1 2B | 4.62 | 545.64 | Current keyword-biased recognizer; keep the biasing axis |
| Cohere Transcribe 03-2026 | 4.67 | 906.56 | Close accuracy/throughput candidate; requested but missing backend |
| Granite Speech 4.1 2B NAR | 4.68 | 2073.53 | Faster decoding candidate, not a drop-in worker model swap |
| Parakeet TDT 0.6B v2 | 4.70 | 6024.67 | English option; lower mean English WER than v3 |
| Granite Speech 5.0 470M TurboCTC NC | 4.78 | 12761.85 | Fast English candidate with noncommercial license |
| Parakeet TDT 0.6B v3 | 4.86 | 6076.07 | Multilingual option |
| Granite Speech 5.0 470M TurboCTC | 5.04 | 12945.54 | Small, Apache-2.0 English speed candidate |
| Distil-Whisper large-v3.5 | 5.40 | 879.27 | Recommended only without GPU in YA |

RTFx is audio duration divided by processing time. Batched throughput does not
predict single-utterance response latency. A useful YA comparison fixes the
same real English dictation, technical names, silence/noise, punctuation, and
capture settings; records warmed latency separately from initial loading;
and measures memory and keyword benefit. None of the newly listed candidates
has been benchmarked locally by this screening pass.

User-directed shortlist: expose Granite 5.0's fast English-only path in future
YA work; retain Qwen3-ASR-1.7B-hf; exclude Canary-Qwen and Hojo-ASR-V1.
[Hojo's model card](https://huggingface.co/HojoAI/Hojo-ASR-V1) documents a
dedicated `hojo-asr` runtime and Qwen3 decoder. Its much lower reported
throughput and package constraints add integration cost. The user cancelled
its retrieval attempt before completion; no Hojo runtime was installed.
Cohere remains comparison and gap only in this pass.

NeMo's default install and fallback model remains Unified English, following
the user's final preference after considering NVIDIA's comparison. Explicit
saved model choices and environment overrides remain unchanged. V2 and v3
remain selectable. Separately, the user requested plain Transformers Parakeet
default to v2, not v3. NVIDIA's v2 repository only ships a `.nemo` bundle, so
YA uses the documented HF conversion `ai-and-i-project/parakeet-tdt-0.6b-v2-hf`.
The native NVIDIA v2 preset remains NeMo-only; the HF-converted v2 preset is
Transformers-only. Legacy-client compatibility requests retain v3.

The conversion's revision `72a7290b5a7594bb7cdd109694d184d108c8a260`
(2,471,976,417 repository bytes) loaded and transcribed the known Quilter
sample through YA's existing `parakeet_worker.py` and unchanged `stt` runtime
on 2026-09-16. Its card describes unchanged upstream weights with tokenizer
packaging corrected for v2's vocabulary. UI WER is explicitly labeled
"upstream v2", not a new evaluation of the conversion. Install, server fallback,
standalone worker fallback, and client preset all name the same converted model;
existing explicit saved models and `PARAKEET_MODEL` remain authoritative.

[IBM's August 25 release](https://huggingface.co/blog/ibm-granite/granite-speech-5-0-470m-turboctc)
introduces encoder-only 5.0 TurboCTC, newer than 4.1. It sacrifices speech
translation and keyword biasing; the NC variant uses additional training data
under CC-BY-NC-SA-4.0. Both need a CTC inference path, not YA's current
Granite generative worker. The
[4.1 NAR card](https://huggingface.co/ibm-granite/granite-speech-4.1-2b-nar)
also describes a distinct decoding path. These cannot be enabled safely just
by adding checkpoint IDs to a dropdown.

NeMo Parakeet's existing unified-en-0.6b remains useful for its unified offline
and streaming capability; it is absent from this exact CSV snapshot, so do not
insert its older model-card WER into this ranking. NVIDIA's separate
[offline evaluation](https://huggingface.co/nvidia/parakeet-unified-en-0.6b#asr-performance-wo-pnc)
reports Unified at 5.91% versus TDT v2 at 6.04%, without punctuation and
capitalization. NeMo has a heavier separate software installation; YA uses
batch inference rather than the model's streaming path.

Model choices and install cards show English WER to two decimal places from
the dated snapshot, or explicitly say unavailable. Unified instead shows its
5.91% NVIDIA evaluation with an explicit different-evaluation label and source.
Distil large-v3.5 shows its model-card count of 756M parameters. NeMo's install
caption estimates 8,000 MB installed Linux runtime, excluding model weights
and distinguishing download size: the local isolated environment measured
7,662 MiB on 2026-09-16. Cache sharing and platforms change disk/download needs.
Whisper's performance caption says optimized CPU inference, with GPU
acceleration available when configured. YA defaults to CPU/int8 and does not
automatically choose CUDA. The server's saved GPU checkbox overrides
`WHISPER_DEVICE`; absent a saved choice, that environment variable still applies.
Whisper is recommended only
without a GPU. Its [model card](https://huggingface.co/openai/whisper-large-v3)
documents invented transcript text; silence/non-speech hallucinations are
separate from speech-set WER and should be checked in local evaluation.
Whisper's current
[distil-large-v3.5 card](https://huggingface.co/distil-whisper/distil-large-v3.5)
reports a short-form speed/accuracy advantage over turbo, while turbo retains
a long-form advantage on its evaluation. Retain full large-v3 and turbo as
alternatives for existing Whisper support rather than claiming a universal
winner from an English short-form table.

The deferred UI design is tracked in
[`speech-backend-model-selection`](../gaps/speech-backend-model-selection.md);
Cohere's missing implementation is tracked separately in
[`cohere-speech-backend`](../gaps/cohere-speech-backend.md).

### Qwen retrieval and integration probe — 2026-09-16

Manually retrieved `Qwen/Qwen3-ASR-1.7B-hf` revision
`bcd2b5b7f32b480ab5790554cfa8347f246a14f3`, ungated, 4,087,646,324
repository bytes. The Transformers-native model needs >=5.13 according to its
model card. An isolated test environment inherited YA's Torch 2.12.0+cu130 and
installed Transformers 5.17.0. The resolver initially installed NumPy 2.5.3,
which failed in the inherited Librosa/Numba stack; pinning NumPy <2.5 selected
2.4.6 and resolved it. No production dependencies changed.

CUDA BF16 load and generation passed on the public
`bezzam/audio_samples/librispeech_mr_quilter.wav` clip, yielding
"Mr. Quilter is the apostle of the middle classes, and we are glad to welcome
his gospel." This is an integration smoke on one known clip, not a quality or
latency benchmark. The first assertion used a different sample URL from the
card with the Quilter expected text; the fixture mismatch was corrected before
acceptance. Logs and scripts are in `.artifacts/speech-candidates/` locally.

The `ya-qwen` backend now installs through `stt-bootstrap-qwen`, appears in
the enable/install catalog, and becomes selectable after live validation.
Selecting it in Default speech backend prewarms its persistent worker.
`QWEN_MODEL` and `QWEN_DEVICE` override the default model and automatic CUDA
selection. Its native `apply_transcription_request` receives decoded 16 kHz
audio and returns transcription text without language tags. Streaming,
Smart Turn, and learned keyword bias are not advertised.

Qwen, Granite, and Transformers Parakeet share `stt`, pinned to Transformers
5.17.0 and NumPy <2.5. Actual worker transcription passed for all three after
installing that solve. Whisper CPU remains in `stt`; Whisper GPU uses
`stt-whisper-gpu` because CTranslate2 requires CUDA 12/cuDNN 9 libraries and
the Torch installation uses CUDA 13. The GPU worker starts with its own
environment's library paths, without inheriting host library overrides.
Actual Whisper transcription passed on both CPU/int8 and CUDA/int8.

Hojo retrieval was cancelled by user direction. Its 0.1.3 package pins
Torch >=2.5.1,<2.6 and Transformers >=4.57.3,<5, conflicting with this shared
stack; it was not installed or run. Cohere remains a deferred gap.

Streaming follow-up: [`local-parakeet-streaming`](../gaps/local-parakeet-streaming.md).

### Existing Granite smoke

Local smoke on the RTX PRO 6000 host, 2026-09-15, through
`granite_worker.py` directly: cold load 8.4 s with weights cached (~5 GB
download on the first run), 0.6 s warm per 8-second WebM/Opus utterance after
the first request's 1.5 s, correct punctuated English and French from the model
card's own multilingual sample, and an empty string for a silent clip. Latency
is therefore well inside press-to-talk usefulness on this GPU while being
slower than the 0.6B Parakeet recognizers; a CPU-only host should expect a much
worse ratio because every transcript is generated token by token.

Granite keyword biasing uses the same learned top-100 list as Grok. Frequency
already chose membership; listed terms are treated equally. The worker rebuilds
IBM's trained `Keywords:` prompt per utterance and applies a constant prefix
logit boost (`GRANITE_KEYWORD_BIAS`, default `1.0`; `0` keeps the prompt and
disables the extra processor). Direct Grok still does not consume this list.

## Keyterm Biasing

Status 2026-09-09: persistent vocabulary collection and Grok-through-YA
biasing are implemented as independent, default-off Speech settings. The
speech-vocabulary UI appears when discovery SQLite is ready, which every
current server is because it does not start otherwise. Older servers could run
without it and then hid the UI.
Ranking approximations are recorded in
`gaps/sketches/speech-vocabulary-ranking-approximations.md`.

### Design decisions

- **Rely on discovery SQLite having opened** (vs. building the vocabulary
  services whenever a SQLite driver loads): a running server has already
  established both facts this feature needs. The runtime has a working SQLite
  driver, and the data directory is local disk rather than a network share.
  The learned table is its own database file rather than a table inside
  `discovery.sqlite`, so without that guarantee it would put a
  written-per-scan table on exactly the share the discovery refusal exists to
  avoid. Until 2026-10-11 storage was optional and the services were gated on
  readiness; the server now refuses to start instead, so the gate is gone.

### Where the learned table lives

The learned table and its fingerprint filter live in the data directory,
alongside the settings file. That directory is local disk whenever this feature
can run at all: the server only starts once discovery SQLite has opened, and
startup refuses that database on a network filesystem, so the placement the
earlier separate reservation searched for is now guaranteed rather than sought
(see [optional SQLite](optional-sqlite.md) § Data directory placement). The
filter is still sized against free space and keeps a gigabyte of headroom, so a
machine with little room gets a smaller filter rather than a full disk. Profiles
stay separate because their data directories are separate. Installs that used
the previous reserved directory are moved on first open: the table is renamed or
copied, and the filter is renamed when that is free and abandoned otherwise,
since it only saves relearning that the table's own checkpoints already prevent.

Losing either file costs a rescan, never a wrong answer, and the table is
written with synchronous commits off: a power loss or kernel crash can drop
recent counts, an ordinary process crash cannot, and the journal mode stays
write-ahead so the failure is lost counts rather than a corrupt file.

Word counts, observed spellings, and scan checkpoints are rows in a SQLite
database there. Only the rows a scan touched are written, in bounded
transactions that yield between them, so recording a scan costs what the scan
observed rather than the size of everything ever learned. Iteration returns the
word strings, which top-N ranking needs.

Content fingerprints are a blocked Bloom filter, resident in memory and backed
by a fixed-size file in the same directory. Each key sets eight bits inside one
64-byte block, so a flush writes only the 64 KB regions that changed, in place,
with no truncate and no window where a reader sees an empty set. The default
reservation is 256 MB, holding well over a hundred million distinct messages
before its design load; `YEP_SPEECH_VOCABULARY_BYTES` moves it. The filter is
allocated on first use, so a server whose owner never turned learning on pays
nothing. Membership is approximate in one direction: a message that was counted
always reads as seen, while an uncounted one can read as seen at well under a
percent, which skips that message. Adding never clears a bit, so a partial write
can lose evidence but never invent it.

Nothing on the scan path waits for those writes. A flush commits to memory,
hands the changed rows to a single coalescing writer, and returns; the writer
runs one batch at a time and folds in whatever arrived meanwhile. A scan that
observed nothing new does not flush at all, so the catalog republications that
live sessions produce every few seconds cost no writes, no rebuilt ranking, and
no new revision.

Writes are also floored at one every ten minutes, moved by
`YEP_SPEECH_VOCABULARY_WRITE_SECONDS`. Waiting shrinks the work rather than
merely delaying it, because a word seen fifty times inside one interval is still
one row written once. A crash costs at most one interval of learning, and even
that is recovered by a rescan, since each session's checkpoint is written in the
same batch as the counts it covers. Shutdown, reset, and the adoption of the
previous layout's files write immediately instead of waiting; the old files are
deleted only after the adopting write lands, so a server killed inside the
interval still has them, and so does one whose adopting write failed.

The filter has two responses to filling up, and the cheap one gets the first
chance. At a false-positive rate of a tenth of a percent — 137.6 million
messages for the 256 MB default, against the 179.0 million at which the filter
is called full — YA compacts it: a replacement filter is built from the last
epsilon of history in the same small yielding steps a scan uses, then swapped in
by rename, and a floor is recorded at the moment the rebuild started. Learned
counts are untouched. The floor is what makes the forgetting safe: content at or
before it counts as already seen without consulting the filter, so the messages
the rebuild dropped cannot be counted twice. Epsilon defaults to two hours and
`YEP_SPEECH_VOCABULARY_EPSILON_HOURS` moves it; hours rather than minutes
because provider timestamps are not assumed to come from a monotonic,
daylight-saving-immune clock, so the window has to absorb a wall-clock step.
Compaction backs off for an hour, since a window that cannot fit the filter
would otherwise rebuild in a loop.

Only if the filter still passes its design load does YA empty it along with
everything counted through it and relearn the retained window, since a filter
that can no longer tell new text from old would silently stop counting. That
path discards learned counts, which is why compaction exists to precede it. Settings, which a
rescan cannot rebuild, stay in `{dataDir}/speech-vocabulary-state.json`, written
through a temporary file and a rename so no reader sees a partial file. An
unreadable settings file reverts to defaults with a logged warning rather than
failing server construction. The previous layout's `speech-words.json`,
`speech-word-case.json`, and `speech-seen.hash` are adopted once on first start
and deleted once the write carrying the adopted counts commits; a write that
fails keeps them, and the next start adopts them again.

The controls live at the top of Settings → Speech backends, under Learned
speech vocabulary. Settings search finds them by vocabulary, keyterms, lexicon,
Scan + Learn, Stop + Clear, and Explore vocabulary. When the capability is absent,
the same searchable entry explains disabled/unavailable storage or the need to
update the server; it mounts no controls and makes no vocabulary requests.

### Learned vocabulary contract

The server learns submitted user text and assistant text from durable provider
history through the existing session readers and normalization. It does not
learn unsubmitted browser drafts, tool arguments/results, reasoning blocks,
explicit metadata messages, or compact summaries. Untimestamped records are
excluded because they cannot be assigned to the requested history window.
The catalog supplies source identity and recency; UI order and live partial
message IDs are never learning inputs. Native scope and original project select
history readers, including when a YA id differs from its native id. Native
catalogue/checkpoint keys stay intact. Old Claude/Codex rows without source scope
wait for a fresh scoped publication and leave their checkpoints untouched;
they do not read an ambient same-string transcript or block other learning.

Speech settings offer a numeric hours field and slider, a
green Scan + Learn and red Stop + Clear actions, progress, and a separate
recognition-biasing switch. Clicking Scan + Learn turns learning on if it
was off, then starts a scan. Stop + Clear cancels the current scan and clears
counts, hashes, and checkpoints while preserving the opt-in settings.
Enabling collection starts the selected retrospective scan. Catalog changes
and completed/live session activity schedule coalesced subsequent learning.

Hours accepts any finite value of zero or more, fractions included; one hour
looks back an hour and zero looks back at nothing. The slider's track stops at
8760 because a year is a reasonable end for a drag, not because larger values
are refused — the field takes them.

The hours setting says how far back to look, and that is all it says. It does
not expire anything already collected: only Stop and Clear followed by a fresh
start does that. It permits, and does not promise against, content before the
window going uncollected. Nor does it promise that everything inside the window
is collected — the floor described above can sit inside it after a compaction,
and a scan counts nothing below the floor. So the setting bounds a scan's reach
downward and guarantees nothing upward.

Pausing collection and resuming it leaves a gap, and the slider is not moved to
cover it. Progress is per session rather than one global mark: each session
records the version and cutoff it was scanned at, so resuming rescans any
session whose source changed during the pause or whose stored cutoff is later
than the new one, and the fingerprint filter keeps the rescan from counting
anything twice. Content from the gap that falls outside the current window is
simply not collected, which the setting permits. YA does not widen the user's
window on their behalf to close a gap; the setting is theirs, and a silent
change to it would be a worse surprise than the omission it prevents.

Stop and Clear discards the floor along with the counts, receipts, and
checkpoints. That coupling belongs to the stop rather than to the fingerprint
filter: the floor records how far counting already reached, so any future mode
that dedupes differently, or not at all, still keeps a floor and still has to
clear it here. A floor that survived a clear would tell the next scan that
everything older was already counted, and the cleared store would silently
refuse to relearn it.
Disabling collection stops it without clearing committed counts or progress;
recognition can independently continue using the saved vocabulary. Interrupted
scans resume by reconciling incomplete sessions on reentry. Reset clears counts,
contribution receipts, and scan checkpoints together; it cancels old work but
keeps the two opt-in settings. A later explicit scan can relearn that history.
Automatic catalog publications after reset learn only records timestamped
after reset; stale catalog work cannot silently restore old history.

Word counts use Unicode NFKC normalization and lowercase, retaining internal
apostrophes, underscores, dots, and hyphens. Numeric-only tokens and tokens
longer than 100 characters are excluded. User and assistant counts remain
separate; no generated contribution is relabeled as user text.

Alongside each count the server records how the word was written, so a term can
be sent to a recognizer spelled as its writers spell it. Two positions withhold
that evidence. A capital at the start of a line, a sentence, or anywhere in a
Markdown heading line is forced by position and says nothing about the first
letter; quotes, brackets, list markers and emphasis are looked past to find the
real position. An all-lowercase spelling is discounted rather than trusted,
because typing everything lowercase is as ordinary as capitalizing a sentence,
and it leaves every letter open rather than only the first. Interior capitals
are never forced and always count. At most three spellings are kept per word,
the newcomer inheriting the weakest slot so a spelling that appears late can
still overtake. Case evidence is not user-visible: exploration and the stored
counts stay keyed by the lowercase word.

A word is then sent spelled as its strongest free-position evidence, or as the
plain lowercase word where the only capitals were forced and carry no interior
capital. `The` at a hundred sentence starts is still `the`; `YA`, `JSONL` and
`SQLite` keep their capitals.

The local-disk table owns the word counts, the observed spellings, and the scan
checkpoints; the filter beside it owns the fingerprints. Spellings are their own
rows, so a server without this feature reads the counts unchanged and a server
with it treats missing spellings as no evidence. Already-seen fingerprints skip
tokenize; new messages are tailed. Scan work yields in small bursts so the Node
process stays responsive. Distinctive ranking uses
`(observed - expected) / sqrt(expected + 1)` from this topic, not raw
excess count. The server keeps a global top-500 heap and a per-session
top-100 with the session multiplier already applied. A recognition request
merges them by word, and the session entry replaces the global one rather than
adding to it, so a term in both scores exactly its multiplier and not one more.
The multiplier is applied once, where the word is offered to the session heap.
Any path that feeds these heaps therefore offers each word to both, at its plain
score globally and its multiplied score per session; feeding only the session
heap would leave the global list stale between rebuilds.
Live increments re-score only the updated word; a full rebuild of those
heaps runs on flush. A receipt fingerprints the durable
role, timestamp, and complete extracted text using SHA-256. Exact duplicate
records with those same fields in the same source session count once;
identical text at different durable timestamps counts separately. Presentation
IDs, record positions, read-window indexes, and metadata unrelated to the text
do not affect the fingerprint. No vocabulary row stores a list of fingerprints.

A session's counts and its scan checkpoint are written together, so a session
that finished scanning is not scanned again while its source version holds.
Previously learned history outside the window is preserved. Revised or removed
text is not subtracted: the fingerprint of the old wording simply stops
appearing, and its counts stand. Reset advances a persistent generation; an
in-flight scan from an older generation cannot restore cleared data. Losing only
scan checkpoints causes a rescan rather than double counting, because the
fingerprint filter still recognizes the messages already counted. Losing the
filter as well means those messages are counted a second time, which is why
Reset clears counts, spellings, checkpoints, and fingerprints together.

The collector keeps only its current reader window and 32-message batch; it
does not retain transcripts in its own cache. It reuses provider reader bounds
and caches, including Codex compact-window paging where available. Cold reader
costs remain those of the existing provider readers. The synchronous database
transactions never await provider I/O; scan work yields between batches and
windows. Disabling or disposing the service prevents further publication, and
closing Settings releases its progress timer.

#### Vocabulary exploration

Speech settings provide an **Explore vocabulary** action. Its default view
shows up to 18 distinctive recurring words in a compact table with counts and
baseline-frequency ratios. In-cell bars have length proportional to count,
split blue/purple for user/assistant contributions. Green bars extend left
from the ratio column's right edge, scaled by `log(1 + ratio)` relative to the
largest visible value (with a denominator floor of one). Missing baseline
words have no ratio bar. Hover shows a tooltip; click, tap, or keyboard focus
selects a word and expands exact source counts directly beneath its row.
The table leads the view, with filters and explanation below it; a top-right
close icon dismisses the view even while loading. A **Most frequent** view and
adjustable minimum count (initially six learned occurrences, combining user
and assistant counts) make early scan results browsable. Totals update
after each completed session, while message progress also advances during
scanning. Candidate counts are requested only while exploration is open, using
GET `/api/speech/vocabulary?includeWords=1`; at most 2,000 words are returned,
ordered by combined count then spelling. This is a bounded frequent-word view,
not an exhaustive search of every learned outlier.

The browser fetches Hermit Dave's English OpenSubtitles 2018 top-50,000
unigram counts on first opening the view, pinned to FrequencyWords commit
`525f9b560de45753a5ea01069454e72e9aa541c6`. The plain-text resource is
approximately 623 KB, lives outside Git, and needs no runtime decoding library.
The view links to its source and CC BY-SA 4.0 license. It sends no learned words,
credentials, or referrer to that fixed public URL. Browser HTTP caching may
reuse the response. A failed fetch leaves raw-count exploration available;
reopening retries. There is no startup download. Recognition independently
loads the same pinned resource on demand and caches it in server app data.

Baseline frequencies are normalized within that published list. Distinctive
words must exceed their expected count, and rank by
`(observed - expected) / sqrt(expected + 1)`. Smoothing limits the influence of
tiny reference counts; this is exploratory ranking, not a significance test.
Unknown words have no ratio and appear separately by count. Subtitle language,
code, other languages, and differing tokenization make this a rough reference.

Closing exploration aborts an outstanding reference fetch, releases its parsed
reference map and candidate arrays, and stops detailed word requests. The full
learned lexicon stays in the in-memory count map, with `count > k` as a
linear filter for display and recognition.
Any future permanent server reference cache may retain about 10,000 word/frequency
pairs; larger reference tables require eviction. Display-only resources may load
on demand. Corpus-derived embeddings, cooccurrences, or occurrence references
change collection and remain in the
[semantic-map sketch](pluggable-speech-recognition.sketches.md).

Recognition selects up to 100 terms of at most 50 characters, xAI's documented
limits. All learned terms with positive excess over English are candidates,
including single occurrences, assistant-only terms, and words absent from the
reference. The top 1,000 English words are explicitly excluded, even when locally
overrepresented.

One exception admits an excluded word: where writing settles on a spelling with
an interior capital, that spelling is a different term from the English word and
is counted and offered under itself. `YA`, `HEAD` and `OK` become terms while
`ya` stays blocked, and a spelling loses this standing as soon as it stops being
the word's dominant form, so an occasionally shouted `NOT` never qualifies. Such
a term is charged the rarest listed English frequency rather than treated as
never seen, and at most a fifth of a selection may be these spellings. Case is
not meaning-carrying and a spoken acronym is usually transcribed correctly
anyway; the point is to spell it as the reader expects, not to crowd out jargon
the recognizer has no prior for. The selector uses the in-memory distinctive heaps (global ~500, per-session
100) rather than walking every stored word; exploration's 2,000-word view and
six-occurrence display filter do not constrain recognition.

Usage and rarity supply a first approximation to expected missed uses. Global
priority uses `(observed - expected) / sqrt(expected + 1)`, with expected count
computed from all counted user and assistant tokens. Unlisted words use zero
reference frequency in this heuristic and compete normally, except where the
reference splits a token YA keeps joined. The published list carries `'s`, `'t`
and `'ll` as their own rows, so every contraction and possessive is missing from
it and would otherwise rank as maximally distinctive — `i'll` and `i'm` were the
two highest-scoring terms before this. A joined form is never more frequent than
any of its parts, so the smallest listed part bounds it, which also keeps
`agentctl's` from competing with `agentctl`. Eligible active-
session terms receive a configurable priority multiplier, five by default:
that many times the score the same term would carry globally, not one more.
Ties break lexically.

A multiplier alone cannot keep a fresh session visible, and the setting exists
to be turned down rather than up. Global counts grow with history without
bound while a new session's stay small, so for any fixed factor there is a
history long enough to swamp it. The reservation is the mechanism that does
not decay: a configurable share of the selection, zero by default, is held for
the active session before score alone decides the rest. It is a floor and not
a ceiling — session terms that outrank everything still take more than their
share, and the list is filled to its limit with unique terms either way. A
principled replacement would blend session and global evidence in probability
space rather than scale a score; see
[the ranking approximations gap](../gaps/sketches/speech-vocabulary-ranking-approximations.md). The score only selects the list inside YA: Grok receives plain
repeated `keyterm` values, never numeric scores or weights. Acoustic confusion,
homophones, and measured error probabilities remain in the requested
[error-modeling gap](../gaps/sketches/speech-recognition-error-modeling.md); no
transcription-quality gain is established by this heuristic.
Caller-supplied keyterms take priority within Grok's same limits. Batch and
both direct-to-YA and relayed streaming requests use the same selection;
request logs record exactly the selected terms, and retained batch audio
metadata also records them. No new words are implicitly added to the
send/cancel/wait command vocabulary.

With biasing off, recognition does not load the English reference. First use
with biasing on reads the pinned app-data text cache or downloads the fixed
public resource with a five-second network timeout and 2 MB response limit.
Concurrent requests share the load. No learned text is sent to the resource
host, and no frequency table ships in Git. The parsed 50,000-row map is retained
for the process lifetime once loaded, and is pre-warmed at startup when learning
or biasing is already enabled, so no dictation request pays for it. Parsing that
list measured about 60 ms: 49 ms to parse, 10 ms to rank the common words, 2 ms
to find the floor. A derived on-disk form was measured and rejected — it saved
25 ms of that once per server start for a file 2.6 times the size of the source,
because rebuilding the map dominates and no format avoids it. Its text cache
still survives server restart. Shutdown aborts loading and releases the map. Reset or disabling biasing during loading cannot
publish stale terms. A reference load/cache failure logs a diagnostic and
continues ordinary recognition with caller-supplied terms only; another request
may retry after one minute. A malformed on-disk cache must be removed to refetch.
Reference loading shares the streaming handshake promise, so incoming audio can
buffer in order. A disconnected or superseded stream cannot open an upstream
connection after that load completes.

The browser maintains a growing active-session term set from messages already
loaded in its current session view. It starts on speech use, includes submitted
user and assistant text, and ignores provisional streaming text, tool payloads,
reasoning, and metadata messages. Trimming the rendered transcript window does
not discard observed terms. The set has no time window or decay, makes no
additional history reads, and is released with the view. Terms first introduced
by an ASR result alone are excluded from the bonus. Later assistant use, including
an echo, establishes discussion relevance and makes the term eligible; terms
already present before that ASR result remain eligible. Live ASR callbacks
and loaded `messageMetadata.speech` establish origin independently of a visible
prefix such as 🎤. Historical records lacking speech metadata cannot establish
ASR origin; this is not retrospective recovery of missing provenance.

At most 10,000 terms travel in `context.sessionTerms`; larger local sets retain
all terms and send their latest 10,000 additions. The server normalizes and bounds
this list. Hints only boost existing learned candidates and do not increment
durable counts. It caches at most 16 selected 100-term lists, keyed by a digest
of the supplied set and invalidated by committed count changes or reset. An
unchanged selection can be reused without consulting the reference map. Hint lists
are omitted from retained audio metadata and request logs; selected keyterms
remain auditable.

The optional `speech-vocabulary-session-terms` capability (permanent ID 66,
introduced in 0.8.2) gates this field on existing batch and stream requests and
is advertised only with ready SQLite. The maintainer-approved release corpus
is v0.8.0 and v0.8.1; both lack session hints. Without it, the browser neither
maintains nor sends the hint set, and existing recognition continues. The older
`speech-vocabulary` capability retains its original meaning.

The session-terms contract extends the request payload on the existing
transcription route and WebSocket GET upgrade. It does not own the whole
speech route module or gate its key, prewarm, and other recognition routes.

The [project-specific vocabulary gap](../gaps/sketches/project-specific-speech-vocabulary.md)
tracks project-wide selection beyond the active-session bonus. Durable learned
counts remain installation-wide; no per-project occurrence records are added.

The optional `speech-vocabulary` capability (permanent ID 65, introduced in
0.8.2) is advertised only with ready SQLite. It owns GET/PUT
`/api/speech/vocabulary` and POST `.../scan` and `.../reset`. The approved
optional release corpus is v0.8.0 (2026-08-31) and v0.8.1 (2026-09-05);
both lack these routes. Without the capability, clients hide the controls and
make no vocabulary request. Existing capabilities retain their meanings.

Direct Grok does not consume learned vocabulary in version 1. Its later
in-memory replica needs a separately approved snapshot/reset version and
incremental synchronization contract. Deepgram and other backend integrations
also remain future work. Whisper's full text before the insertion cursor is a
separate context input, not a replacement for or use of unigram statistics.

### Backend biasing primitives

What the backends offer. xAI STT (batch and streaming) and Deepgram accept a
repeatable `keyterm` parameter that biases recognition *toward* the listed
vocabulary (xAI: up to 100 terms, each ≤50 chars; see
[direct-xai-speech.md](direct-xai-speech.md) for the endpoint facts). Biasing
is the strongest primitive available: neither backend documents word-level
confidence, n-best alternatives, or any "score this audio against a command
list" query, so a resemblance-style constrained-command match cannot be built
from the API surface — only a thumb on the transcript scale.

`POST /api/speech/transcribe` accepts explicit `keyterms`; Grok and Deepgram
forward them. Learned terms currently augment Grok and Granite requests. The server
adds streaming Grok terms when opening the upstream session; browser-direct
Grok has no learned-vocabulary integration. Granite batch requests receive the
same list in the `Keywords:` prompt plus the constant logit boost.

Candidate uses, in rough value order:

1. **Project/session vocabulary** — the planned `buildBiasingContext()`
   (Remaining Plan item 4) feeding file names, glossary terms, and session
   nouns. This is the use keyterm exists for: rare terms the recognizer
   has no prior for.
2. **Spoken command words** — biasing `send`/`cancel`/`wait` on streaming
   Smart Turn input. Assessed below; weaker case than it first appears.

Command-word biasing tradeoff. The command vocabulary is already among the
most common English words, so the recognizer needs no help on a clean
utterance; the plausible win is only the turn-end trailing token
("send" → "sent" style misses). Against that, the bias applies to the whole
stream, so near-homophones anywhere in ordinary dictation can be pulled toward
command forms ("sent"→"send", "weight"→"wait") — a transcript-quality cost on
every utterance to improve a rare boundary token. The command *action* surface
is partially guarded: mid-utterance text is never a command, a trailing
`send`/`cancel` needs a >500 ms pause, but `wait` deliberately skips the pause
gate, and a trailing word biased into `send` after a real pause would submit.
Net: probably safe at three terms, but unverified — xAI does not document
bias strength, and we have no observed command-word misrecognition to fix.
Do not wire it ahead of evidence (same stance as the Smart Turn judging
layer above). If wired, record the sent keyterms in retained-utterance
metadata so before/after transcription quality is auditable.

## Server-Local STT Deployment Plan

Server-local STT is still a first-class reason to keep the YA-mediated speech
flow. The hosted Grok path should prefer browser-to-xAI when browser-safe auth
is acceptable, but a local recognizer is different: the model and its warm
state live on the YA host, so browser audio must go to YA.

Deploy it in stages:

1. **Batch first, streaming later.** Make `ya-whisper` reliable for
   press-to-talk batch transcription through `POST /api/speech/transcribe`
   before attempting local streaming partials. A complete utterance is enough
   for local Whisper's natural operating mode; local streaming requires VAD or
   chunk-stitching and should not block the first usable server-local release.
2. **Use the existing warm worker as the first runtime.** Start with the
   current `faster-whisper` subprocess (`whisper_worker.py`) because it already
   matches YA's backend contract and keeps the model loaded. Treat
   `whisper.cpp` or another runtime as a swappable backend implementation only
   if deployment friction, CPU performance, or packaging makes
   `faster-whisper` the wrong choice.
   Parakeet is a plausible alternate local recognizer, especially if current
   Hugging Face / Transformers support keeps installation lighter than a full
   NeMo stack. Do not wire it directly into the YA Node runtime first: the
   Rocky 8 host has old glibc and an old/easy Docker path may not match modern
   NVIDIA container assumptions. Spike it in an isolated Python environment or
   pinned container, verify CUDA/PyTorch compatibility on the L40S, and expose
   it behind the same warm-worker `SpeechBackend` boundary only if install plus
   cold/warm latency beats `faster-whisper` for this server.
3. **Ship explicit operator configuration.** The opt-in is
   `YEP_VOICE_BACKENDS=ya-whisper`, `YEP_VOICE_BACKENDS=ya-parakeet`, or
   `YEP_VOICE_BACKENDS=ya-nemo`. The backend is pixi-only in the first
   implementation: the YA checkout commits a `stt` pixi environment, and the
   server validates the backend by importing the required Python packages; if
   that import probe fails for an explicitly enabled local backend, startup runs
   the matching pixi bootstrap task once (`stt-bootstrap` for `ya-whisper`,
   `stt-bootstrap-parakeet` for `ya-parakeet`, `stt-bootstrap-granite` for
   `ya-granite`, `stt-bootstrap-nemo` for
   `ya-nemo`) and then probes again. `stt-bootstrap-all` intentionally covers
   Whisper plus Transformers Parakeet only; NeMo is a heavier optional add-on.
   Runtime validation and the warm worker use `pixi run --frozen -e stt
   python`, not ambient `python3`, so old system Python cannot accidentally
   become the ASR runtime. Parakeet validation also loads the configured
   fallback model at startup; if Hugging Face auth, model access, cache space,
   or model loading is broken, YA logs repair hints and does not advertise the
   broken backend to the UI. Model/runtime knobs stay server-local for Whisper:
   `WHISPER_MODEL`, `WHISPER_DEVICE`, and `WHISPER_COMPUTE_TYPE`. For
   Transformers Parakeet, `PARAKEET_MODEL` is the server fallback and
   `PARAKEET_DEVICE` is the server device policy. For NeMo Parakeet,
   `NEMO_MODEL` is the server fallback and `NEMO_DEVICE` is the server device
   policy. Authenticated browser UI may send a per-request Parakeet model id to
   either backend. Selecting a Parakeet model in either global STT settings or
   the mic-attached speech options picks a compatible enabled backend when the
   preset requires one, then asks YA to prewarm that backend/model in the
   background; the UI request returns immediately and model-load success or
   failure is logged server-side. Whisper's default should remain CPU-safe
   (`device=cpu`, `compute_type=int8`). Parakeet defaults to
   `nvidia/parakeet-tdt-0.6b-v3` with `device=auto`, which lets the worker
   choose CUDA when available without making CUDA a startup requirement.
4. **Add a readiness surface before advertising.** Startup validation should
   confirm pixi exists, the `stt` environment is already bootstrapped,
   `faster_whisper` imports, the configured model can load, and a tiny known
   audio sample transcribes within an acceptable timeout. Only then should
   `/api/version.voiceBackends` advertise `ya-whisper`. Failures should be
   actionable in logs: missing pixi, stale/missing pixi lock or environment,
   missing package, missing model/cache, unsupported device/compute type, or
   model-load timeout. The YA server should still start with a requested local
   backend disabled if bootstrap or validation fails; deploy wrappers may
   choose to run `stt-bootstrap`/`stt-check` as a strict preflight and abort
   before launching YA.
5. **Make model warm-up observable.** The first utterance may legitimately pay
   model-load cost, but the UI and logs should distinguish "loading local STT
   model" from ordinary recognition. Record model name, device, compute type,
   cold-load duration, and per-utterance real-time factor in server logs and
   retained metadata.
6. **Keep audio retention useful for tuning.** Retained audio plus sidecar
   transcript metadata is especially valuable for local STT. The sidecar
   should include model/runtime settings and biasing prompt/keyterms so bad
   transcriptions can be reproduced after changing model size or prompt
   construction.
7. **Add biasing before optimizing streaming.** Local Whisper's biggest YA
   advantage is project/session context. Implement `buildBiasingContext()` and
   feed its prompt into Whisper before spending effort on local streaming
   partials.
8. **Verify with a fixed audio fixture and one live mic pass.** The deployment
   smoke should cover a generated/checked-in short utterance, an empty/silence
   file, and one browser capture. Acceptance is: backend advertised only when
   ready, first request may be cold but succeeds or reports a clear error,
   subsequent requests reuse the worker, and transcription metadata records the
   runtime settings.

### Local STT pixi bootstrap

The committed pixi environment is intentionally not part of the normal
Node/PNPM install. To enable local Whisper on a server:

1. Install pixi on the host.
2. Either let YA run the relevant bootstrap task when the backend is explicitly
   enabled, or preflight it manually from the YA checkout:
   - `pixi run -e stt stt-bootstrap` for `ya-whisper`;
   - `pixi run -e stt stt-bootstrap-parakeet` for `ya-parakeet`;
   - `pixi run -e stt stt-bootstrap-granite` for `ya-granite`;
   - `pixi run -e stt-nemo nemo-bootstrap` for `ya-nemo`;
   - `pixi run -e stt stt-bootstrap-all` for Whisper plus Transformers
     Parakeet.
   These commands create the corresponding environment from `pixi.lock` and
   install its Python requirements file(s).
3. Start YA with `YEP_VOICE_BACKENDS` containing `ya-whisper`, `ya-parakeet`,
   `ya-nemo`, `ya-granite`, or any comma-separated combination.

For the private `reyep` helper, the local-STT switch should be set-union logic,
not assignment. A `YEP_LOCAL_STT=1 reyep`-style wrapper should append
`ya-whisper` only when the current comma-separated `YEP_VOICE_BACKENDS` does not
already contain it. Cloud STT backends still auto-enable from their
`YEP_STT_*` keys; the wrapper must not read or print those keys.

Transformers Parakeet reuses this deployment shape through
`requirements/stt-parakeet.txt` and `stt-bootstrap-parakeet`. NeMo Parakeet
uses `requirements/stt-nemo-recent.txt` and `nemo-bootstrap` in the isolated
`stt-nemo` environment. The YA server runs those bootstraps only
after the operator explicitly names the matching backend; a deploy wrapper may
still choose to run the pixi bootstrap as a stricter preflight.

YA's automatic import checks, bootstrap commands, and all local speech workers
remove inherited `LD_LIBRARY_PATH` and `LD_PRELOAD`. The pixi/Python environment
owns its runtime libraries, so a login shell's system CUDA toolkit cannot
override the packaged CUDA/cuDNN libraries. This boundary is speech-specific;
the server's environment and other provider subprocesses are unchanged. GPU
visibility, model choices, cache locations, proxies, and credentials retain
their configured values. For manual pixi commands in a shell with library
overrides, use `env -u LD_LIBRARY_PATH -u LD_PRELOAD pixi run ...`.

Import validation is not a GPU inference test. YA does not reinstall a working
environment merely because a host toolkit changed, silently fall back to CPU,
or replace a selected model after inference fails. The installed package stack
still needs a compatible GPU driver and hardware. After a host migration,
verify an actual transcription as well as backend advertisement.

On 2026-09-14, production Whisper, Transformers Parakeet, and NeMo backend
validation and transcription all passed with a deliberately inherited system
CUDA 13.3 library path. Before this isolation, the same Parakeet workers loaded
their models but failed at inference with cuBLAS/cuDNN loader errors. The smoke
used distilled Whisper v3.5 on CPU/int8, Parakeet TDT 0.6B v3 on GPU, and NeMo
unified English 0.6B on GPU; all transcribed a synthetic spoken sentence.

### STT env recovery before NeMo spikes

`requirements/stt-known-good-2026-06-16.txt` pins the working pixi `stt`
environment after Whisper plus the Transformers Parakeet install. It exists so
NeMo experiments can be attempted in-place without guessing how to recover the
known-good ASR runtime.

If a NeMo install poisons the environment, reset and repin it from the YA
checkout:

1. `pixi reinstall --frozen -e stt`
2. `pixi run --frozen -e stt python -m pip install --requirement requirements/stt-known-good-2026-06-16.txt`
3. `pixi run --frozen -e stt stt-check`
4. `pixi run --frozen -e stt stt-check-parakeet`

When testing whether NeMo can coexist with the current stack, install it under
that pin set as a constraint first:

`pixi run --frozen -e stt python -m pip install --constraint requirements/stt-known-good-2026-06-16.txt 'nemo_toolkit[asr]'`

That command is a meaningful coexistence test: it may add packages, but it must
not downgrade or upgrade Torch, Transformers, faster-whisper, or the CUDA
package set that the working Transformers Parakeet path is using. If the
resolver cannot satisfy NeMo under those constraints, use a separate pixi
environment for NeMo rather than weakening the current STT runtime.

The 2026-06-16 coexistence spike found:

- `nemo_toolkit[asr]==2.7.3` does not coexist with the exact current pins. It
  requires `fsspec==2024.12.0`, while the known-good STT env has
  `fsspec==2026.4.0`; an unconstrained dry run would also replace the
  Transformers git build with `transformers==4.57.6` and change protobuf,
  packaging, and Hugging Face hub packages. Treat modern NeMo as a separate
  pixi environment unless those pins are deliberately moved together.
- `nemo_toolkit[asr]==2.0.0` does coexist with the current pins when installed
  through `requirements/stt-nemo.txt`. The install also needs
  `pytorch-lightning==2.4.0`; the resolver's newer default no longer exports
  `NeptuneLogger`, which NeMo 2.0.0 imports. `matplotlib` is also needed
  because NeMo ASR imports VAD plotting utilities during module import.
- Under that NeMo 2.0.0 add-on, `pip check`, `stt-check`, and
  `stt-check-parakeet` pass; `nemo.collections.asr` imports successfully.
- `nvidia/parakeet-rnnt-1.1b` and `nvidia/parakeet-ctc-1.1b` both load on CUDA
  and transcribe a short 16 kHz mono PCM WAV smoke file. The RNNT model loaded
  in about 13 s and transcribed a 7.4 s file in about 0.54 s; the CTC model
  loaded in about 13 s and transcribed the same file in about 0.43 s.
- NeMo 2.0.0 still expects NumPy's removed `np.sctypes` table during audio
  preprocessing. A NeMo worker can patch this process-locally before importing
  NeMo:

  ```python
  import numpy as np

  if not hasattr(np, "sctypes"):
      np.sctypes = {
          "int": [np.int8, np.int16, np.int32, np.int64],
          "uint": [np.uint8, np.uint16, np.uint32, np.uint64],
          "float": [np.float16, np.float32, np.float64],
          "complex": [np.complex64, np.complex128],
          "others": [np.bool_, np.object_, np.bytes_, np.str_],
      }
  ```

- `nvidia/parakeet-unified-en-0.6b` does not load under NeMo 2.0.0. Its config
  passes `att_chunk_context_size` to `ConformerEncoder`, and this older NeMo
  encoder does not accept that argument. Keep the unified streaming target on
  the separate/newer-NeMo track.

The current batch-only `ya-nemo` backend uses the isolated runtime below. The
older shared add-on remains a recovery recipe, not its active runtime. Any
NIM/NGC multilingual RNNT variant should be considered only if there is a
host-installable local runtime that fits the Rocky 8 / pixi deployment
constraints.

Hosted relay support for server-local STT is a product choice, not a technical
requirement. If the operator wants phone-to-local-Whisper dictation through
YA, the existing batch YA API path is the safer first target; relayed streaming
to a local model remains a later optimization after local batch is solid.

### Isolated NeMo runtime

`ya-nemo` launches in the separate pixi `stt-nemo` environment with
`nemo_toolkit[asr]==3.0.0`, installed by
`pixi run -e stt-nemo nemo-bootstrap`. Whisper and Transformers remain in
`stt`; their lock entries and the known-good recovery pins are unchanged.
The committed pixi environments currently support Linux x86-64 only.

The [unified model card](https://huggingface.co/nvidia/parakeet-unified-en-0.6b)
names NeMo 2.7.3, but that release fails to load its encoder configuration.
The failure is also recorded in
[NVIDIA's issue tracker](https://github.com/NVIDIA-NeMo/Speech/issues/15705).
[NeMo Speech 3.0](https://github.com/NVIDIA-NeMo/Speech/releases/tag/v3.0.0)
includes the required encoder. Its file-input transcription path still reads
a missing `validation_ds` from this checkpoint, so YA decodes every upload to
16 kHz mono float samples and uses NeMo's supported waveform-array input.
This also normalizes WAV input instead of assuming its channel/sample rate.
Hypothesis results contribute their text, never an object representation.

The backend remains batch-only. Model-native streaming support does not make
the YA endpoint a streaming recognizer. Failed model loads and requests return
explicit errors; the worker never substitutes a different model. Validation
checks/imports bootstrap this isolated environment, while actual model loading
remains deferred to prewarm or transcription.

## Verification Checklist

- With no cloud keys and empty `YEP_VOICE_BACKENDS`, `/api/version` returns
  `voiceBackends: []`, the selector is hidden, and browser-native remains the
  only YA mic method.
- With `YEP_VOICE_BACKENDS=ya-dummy`, `/api/version.voiceBackends` includes
  `ya-dummy`, the selector appears, and choosing it posts `backendId:
  "ya-dummy"` to `/api/speech/transcribe`.
- The dummy backend returns a deterministic transcript through both
  `POST /api/speech/transcribe` and the mounted local `/api/speech/ws` route.
- Remote clients use the existing `fetchJSON` / `SecureConnection` path for
  batch transcription; direct WS streaming needs a separate remote transport
  decision before it is treated as a remote-supported path.
- With `YEP_STT_DEEPGRAM_API_KEY` present, startup validation auto-enables and
  advertises `ya-deepgram`; with a missing or rejected key, it does not.
- With `YEP_STT_XAI_API_KEY` exported in the YA server environment,
  `/api/version.voiceBackends` includes `ya-grok`, and a short batch
  transcription through `/api/speech/transcribe` returns text or a provider
  error from xAI.
- With `YEP_STT_XAI_API_KEY` exported in the YA server environment,
  `/api/version.voiceBackendCapabilities["ya-grok"].streaming` is true, the
  client uses `/api/speech/ws` for Grok STT, interim events update the composer,
  chunk-final events commit locked deltas into the draft, and the final event
  includes the retained transcription id.
- With `YEP_STT_XAI_API_KEY` exported, the version response advertises
  `voiceBackendCapabilities["ya-grok"].smartTurn: true`. Selecting Grok STT
  shows Smart Turn threshold and timeout controls; selecting browser-native,
  Deepgram, Whisper, or dummy hides those controls unless that backend later
  advertises `smartTurn: true`.
- With Grok Smart Turn enabled, `speech_final=true` commits any remaining
  uncommitted delta, stops the streaming recognizer, and then applies a paused
  final command:
  `send` submits, `cancel` discards the speech turn, and `wait` leaves the
  draft for keyboard editing or thought. No recognized command defaults to
  `send`.
- With `Grok STT through YA` selected, the WebSocket start frame advertises
  `mimeType: "audio/pcm;rate=16000;encoding=s16le"`, `sampleRate: 16000`, and
  `encoding: "pcm"`. The hidden `Grok STT through YA batch` path uses
  MediaRecorder batch transcription and has no streaming `speech_final` events.
- With both `ya-grok` and `ya-deepgram` advertised and no explicit stored
  speech method, the client selects `Grok STT direct` as the effective mic
  backend. The through-YA Grok methods remain explicit fallback/debug choices.
- A successful server-routed transcription emits positive-path logs naming the
  backend and audio metadata without logging transcript text.
- A successful server-routed transcription writes retained audio plus metadata
  under the configured data directory by default, and the metadata contains the
  returned transcript plus session/client-turn pointers when the client has
  supplied them.
- A successful streaming transcription writes each interim update, chunk-final
  partial, speech-final marker, and final done transcript into retained
  metadata as an ordered one-line-per-event trace.
- With an advertised backend id not hardcoded in the client, the selector still
  displays that id generically and sends it unchanged as `backendId`.
- With `YEP_VOICE_BACKENDS=ya-whisper` and `faster_whisper` importable, startup
  validation advertises `ya-whisper`; the first utterance warms the model once
  and later utterances reuse the worker.
- With `YEP_VOICE_BACKENDS=ya-parakeet`, the Parakeet Transformers runtime
  importable, and the configured fallback model loadable, startup validation
  advertises `ya-parakeet`; otherwise it logs the cache/auth/model-load repair
  hint and hides the backend from the UI. Choosing a different Parakeet model
  in STT settings or mic options sends that model id to `/api/speech/transcribe`
  and restarts the warm worker for the new model.
- With `YEP_VOICE_BACKENDS=ya-nemo`, the NeMo ASR runtime importable, and the
  configured fallback model loadable, startup validation advertises `ya-nemo`;
  otherwise it logs cache/auth/model-load repair hints and hides the backend
  from the UI. The same Parakeet model selector sends model ids to `ya-nemo`;
  compressed batch recordings are decoded through `ffmpeg` only when needed
  before NeMo transcribes them.
- With both local Parakeet backends enabled, selecting an RNNT-only preset while
  the Transformers backend is active switches the STT backend to `ya-nemo` and
  prewarms that model. With `ya-nemo` unavailable, compact mic options hide that
  preset and global settings disable it with a required-backend hint.
- Removing a previously selected backend does not silently select another
  provider: the current method resolves unavailable, the mic remains visible
  and disabled with unavailable copy, and advertised methods remain available
  for explicit re-selection.

## Local backend enablement and install

Speech settings ends with wrapping install/enable rows for the five local
backends. Checkboxes write `speechVoiceBackends` in the YA data-directory
settings file. `YEP_VOICE_BACKENDS` is copied into that list on startup when
missing and is unioned at runtime, so an env entry cannot turn a saved backend
off. Get / install runs the pixi bootstrap if needed, then downloads default
weights into the Hugging Face cache; the scrollable install log is that
command output. Installing retries a failed runtime validation without replacing
an existing warm worker. Runtime validation does not prove the model weights
are cached: install downloads them explicitly, and first use can download them
too. The catalog displays checking, available, and failed validation with the
failure reason. Its bounded polling runs only while setup or validation is
active, and refreshes the shared speech-method catalog as readiness changes.

Restart YA is a user-elected safe restart through the same service as the
maintenance controls, including the ordinary server-main route mount. It waits
for unsafe active work, is unavailable without a restart-capable launcher, and
rejects restart while a model install is running. Disabling a running backend
is saved immediately and takes effect on this restart.
The button explains that it is only needed for disabling. Environment-locked
checkboxes explain why they are disabled and that removing the environment
entry on a later start preserves saved enablement and unlocks the checkbox.

Model page / access opens inline instructions and a direct Hugging Face link.
Granite enablement opens those instructions only when its default model files
are missing. A filesystem-only check follows the Hugging Face main snapshot,
verifies processor/tokenizer metadata and every indexed weight shard, and
follows symlinks to reject missing blobs. Runtime validation alone does not
establish cache presence. The login command first changes to the server's
actual pixi working directory, shell-quoted for paths containing spaces.
Hugging Face blocks embedded frames, and gated-model access requests require a
browser: the user accepts any terms/contact-sharing request on the model page,
authenticates the server with `hf auth login` using the same account, and retries
the install. Cached files are reused. The default Granite 4.1 2B repository
reported `gated: false` on 2026-09-16; the access path remains available for
changed gates or account-dependent failures.

**Design decision:** add backends live while retaining restart for removals,
and prewarm local models when the user selects Default speech backend in
Speech settings. Session reloads do not trigger it. Prewarm loads the model
without microphone access or dummy transcription; the server keeps the worker
alive for subsequent dictation. Explicit Parakeet model-preset changes also
prewarm the selected model.

The registry retains existing workers
rather than replacing running workers on every settings change. This preserves
in-flight transcription and existing model instances. The additive
`liveEnablement` receipt selects the new explanation; earlier setup-capable
servers retain their restart-based explanation and routes. Servers lacking
`speech-backend-setup` receive no setup request.

| Backend | Enable | Install | Notes |
| --- | --- | --- | --- |
| Browser Web Speech | No server env | None | Device-local escape hatch |
| Grok through YA | `YEP_STT_XAI_API_KEY` auto-enables | None | Cloud, streaming |
| Grok direct | Browser key or server share | None | Not a YA backend id |
| Deepgram | `YEP_STT_DEEPGRAM_API_KEY` auto-enables | None | Cloud, batch |
| Whisper `ya-whisper` | `YEP_VOICE_BACKENDS` and/or Speech settings checkbox | `pixi run -e stt stt-bootstrap`, then default faster-whisper weights | CPU-safe default |
| Parakeet `ya-parakeet` | same | `pixi run -e stt stt-bootstrap-parakeet`; HF login if gated | Transformers ASR pipeline |
| NeMo `ya-nemo` | same | `pixi run -e stt-nemo nemo-bootstrap`; HF login if gated | Isolated pixi env |
| Granite `ya-granite` | same | `pixi run -e stt stt-bootstrap-granite`; default `ibm-granite/granite-speech-4.1-2b` | Learned `Keywords:` prompt + `GRANITE_KEYWORD_BIAS` |
| Qwen `ya-qwen` | same | `pixi run -e stt stt-bootstrap-qwen`; default `Qwen/Qwen3-ASR-1.7B-hf` | Shared Transformers runtime, ungated download |

Whisper's **GPU** checkbox persists `speechWhisperGpu` in server settings.
It selects CUDA when checked and CPU when unchecked, retaining the selected
Whisper model. A loaded worker changes device after queued dictation finishes;
a cold worker uses the new device on its next load. First GPU activation
bootstraps the separate CUDA 12 environment. Installation/reload errors remain
visible; the saved setting survives restart and there is no silent CPU fallback.
The checkbox remains usable for recovery when runtime validation failed.
The optional `whisperGpu` setup receipt gates this route: older servers that
omit it show no control and receive no request to the new endpoint.

Settings recommend Grok for streaming or Smart Turn in YA. xAI's
[commercial-domain evaluation](https://x.ai/news/grok-stt-and-tts-apis)
reports 6.90% overall WER, which is explicitly separate from the local-model
English leaderboard. The proposed 5–6% aggregate was not verified. NVIDIA's
Unified evaluation reports 5.91% batch, 6.14% at 2.08-second streaming latency,
and 8.44% at 160 ms. The UI identifies YA's NeMo path as batch-only and its
streaming integration as planned, rather than suggesting streaming has the
batch score.

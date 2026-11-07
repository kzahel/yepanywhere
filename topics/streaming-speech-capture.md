# Streaming speech capture (client PCM pipeline)

> YA's server-streaming speech path treats browser microphone capture as a
> stateful device pipeline: PCM frames from the first real audio callback,
> direct `/api/speech/ws` locally or a dedicated secure relay speech channel
> remotely, AudioWorklet capture with a ScriptProcessor fallback, and explicit
> opt-in for warm mic.

Topic: streaming-speech-capture

See also: [pluggable-speech-recognition.md](pluggable-speech-recognition.md)
(server-side backend registry, batch transcription, Smart Turn recipe). This
doc covers the **client** capture pipeline for server-mediated streaming STT -
the path from microphone to PCM16 frames over `/api/speech/ws` or the relayed
speech channel - and the contracts that kept biting it.

Primary code: `packages/client/src/lib/speechProviders/YaServerProvider.ts`
(`doStartStreaming`), `packages/client/src/components/VoiceInputButton.tsx`,
`packages/server/src/routes/speech.ts`, and
`packages/server/src/services/voice/xaiSttBackend.ts`.

## Capture modes

Every YA Web Audio microphone consumer (streaming STT, the waveform monitor,
and audio memo recording) reads samples through one shared tap,
`connectMicSampleTap` in
`packages/client/src/lib/speechProviders/micSampleTap.ts`. Either mode
delivers the same mono `Float32Array` batches (1024 samples for STT and the
waveform, 2048 for memos), so consumers do not know which mode ran. Both modes
reach `destination` through a zero-gain node, since an unconnected capture
node is never pulled. YA requests a 16 kHz `AudioContext` for STT so Web Audio
can resample the mic track to xAI's native STT rate before YA packs samples
into PCM16.

- **AudioWorklet mode (default).** A small processor running on the audio
  rendering thread re-batches 128-sample render quanta and transfers each
  batch to the main thread. A main-thread stall therefore delays batches
  rather than dropping them, and the ScriptProcessor deprecation warning goes
  away. The module is loaded from a blob URL (the app CSP allows `blob:`
  scripts), and loading starts when the capture `AudioContext` is created, in
  parallel with `getUserMedia`. A module load is per context and took 30-75 ms
  on desktop Chrome, longer than a warm mic takes to open, so with **Keep Mic
  Warm** on, streaming STT reuses one capture context
  (`streamingCaptureContext.ts`): it is created and loaded at prewarm (after
  the page has had user activation) or at the first dictation, resumed in each
  dictation's gesture, suspended when no dictation uses it, and closed when the
  page is hidden while idle. Without Keep Mic Warm, the mobile norm, each
  dictation creates and closes its own context as before. Speech in the gap
  before the capture is built is not buffered, so this load shows directly as
  later `first audio frame` and later red indicator.
  The browser-local Speech setting **Capture microphone off the main thread**
  (`yep-anywhere-speech-audio-worklet`, default on by maintainer direction)
  turns it off. The setting is read at each capture start.
- **ScriptProcessor mode (fallback).** The deprecated `ScriptProcessorNode`,
  used when the setting is off, when `audioContext.audioWorklet` or
  `AudioWorkletNode` is missing (older iOS before 14.5), or when the module
  load or node construction fails. A failure logs one
  `[YaAudio] AudioWorklet … using ScriptProcessor capture` warning, and the
  STT `[YaSTT] graph built (capture=worklet|script-processor)` mark names the
  mode that ran. AudioWorklet inside iOS web views has broken across versions,
  so this fallback is required, not optional.

Neither mode fixes the pre-graph `getUserMedia` cold-open latency, which
occurs before either capture node exists.

The real-Chromium fake-microphone check in
`packages/client/e2e/audio-memo.spec.ts` asserts that default capture
constructs an `AudioWorkletNode` under the app's real CSP. jsdom unit tests
exercise the fallback; the processor's re-batching is unit-tested in
`packages/client/src/lib/__tests__/micSampleTap.test.ts`.

## Hard contracts (each cost a debugging cycle)

1. **Transport.** Direct/local clients use `/api/speech/ws`. Hosted/relay
   clients use a **second secure relay WebSocket** registered on the `speech`
   channel for the same relay username/install id. Do not tunnel PCM frames
   through the existing app/control relay socket: speech gets its own TCP/WebSocket
   stream so app traffic and audio traffic do not head-of-line block each other.
   The speech channel reuses the same YA remote-access authentication boundary:
   the relay enforces username ownership with the same install id, and the
   browser resumes the same end-to-end SRP-backed session over the new socket.
   It is not a new bearer secret.

2. **Capture from mic-on, no dead window.** Build the audio graph the instant
   `getUserMedia` resolves and **buffer PCM frames until the socket handshake
   completes**, flushing in order. Do not gate capture on the socket/resume.
   Symptom when violated: the first seconds of speech are dropped (a 5s
   utterance arrived as 2.2s).

3. **"listening" means audio is actually flowing.** Status flips to
   `listening` only from the **first real sample batch** delivered by the
   capture tap (in either mode), not after a fixed sequence or node creation. A suspended/dead context never reaches `listening`; the
   3.5s audio-flow watchdog then surfaces a visible error. `resume()` rejection
   is logged, not swallowed.

4. **Capture constraints: communication/AEC by default, raw as an opt-out.**
   `echoCancellation` is **on** by default for every YA-controlled microphone
   stream. In Android Chromium this is the standards-facing request that lets
   the browser select its communication/AEC capture path and use a playback
   reference without exposing that reference to page JavaScript. It does not
   by itself hold Android audio focus; sustained ducking of other apps comes
   from the capture-span focus hold in `mic-button-speech-ui.md`. `noiseSuppression`
   and `autoGainControl` remain **off** because they reshape speech level and
   timbre. Keep `channelCount: 1` (a proper mono downmix transcribes better
   than one channel of a stereo stream; dropping it hurt quality).

   The browser-local, default-on `Reduce playback while dictating` setting
   owns this choice. While capture is starting or active, YA also exactly
   mutes its current and newly inserted HTML audio/video elements and restores
   each element's prior muted state after the final capture owner goes idle.
   Browser-native Web Speech gets that YA-media mute even though its capture
   constraints are browser-owned. Turning the setting off requests
   `echoCancellation: false` and disables YA-media muting, providing a raw
   capture escape hatch for devices or Bluetooth routes where communication
   mode regresses quality or latency.

   Capture **level** is managed by **input-device selection**, not AGC. Retained
   captures showed peak swinging 0.5%-16% FS with quiet ones mis-transcribing
   ("Thank you" for "Testing"); the level was fixed by choosing a good input
   device (here, switching the OS mic to 44.1 kHz), which is why the device
   picker matters. (Note: AGC normalization was hypothesized from that
   correlation but never verified and did **not** turn out to be the fix - do
   not re-enable it on that reasoning.) Evidence lives in
   `~/.yep-anywhere/speech-audio/<date>/` `.bin`+`.json` - analyze peak/RMS vs
   transcript directly rather than trusting the browser console.

5. **PCM packing must not allocate per callback.** The streaming path targets
   xAI-native mono 16 kHz PCM16 and emits 100 ms chunks (1600 samples / 3200
   bytes, 256 kbit/s). Communication/AEC processing changes microphone samples,
   not this transport format.
   `Pcm16Chunker` reuses fixed buffers and only flushes a short final frame on
   manual stop. If Web Audio still reports a non-16 kHz context, the fallback
   resampler averages input windows and each output sample must span at least 1
   input sample, or a slice of output becomes silence.

6. **Mid-session failure must reach the client.** `SpeechStreamHandlers.onError`
   carries an upstream timeout/drop (no caller awaits `openPromise` once the
   session is live). The route forwards it as `{type:"error"}`. The client
   **salvages the live preview** (commits already-transcribed words) and only
   shows an error when there is nothing to salvage - never hangs on
   "listening". Guarded by request id so a superseded session is closed and
   cannot steal a newer request's buffered frames.

## Microphone lifecycle (latency + device selection)

The `getUserMedia` **device cold-open** dominates start latency and is
device-dependent - measured from ~60ms (a silent/disconnected default device
that opens instantly) to ~2080ms (the real mic). Diagnose with the `[YaSTT]`
console marks (`start` -> `getUserMedia call` -> `getUserMedia ready` ->
`graph built` -> `first audio frame` -> per-frame `frame peak=`). A fast open
with `frame peak~0.003` means the **wrong input device** was selected, not a
code fault.

Implemented as STT settings (`pluggable-speech-recognition.md` covers the
settings surface):

- **Mic device picker.** An explicit native input-device chooser lives in the
  shared `SpeechControlMenu` STT options surface (the mic-attached menu reused
  by the new-session composer and message toolbar). It enumerates
  `audioinput` devices, stores the browser-local selected `deviceId`, and
  passes it to `getUserMedia` for both warm-mic pre-open and per-dictation
  capture. Fixes silent capture from a wrong default device, and lets the user
  avoid a slow-opening device. Do **not** expose low-level capture params such
  as downsampling, mono mixing, sample size, or AudioContext sample rate in
  that UI; those remain browser/Web Audio responsibilities governed by the
  capture contracts above.
- **Grok audio mode and Smart Turn controls are transport-neutral.** Direct
  and relayed clients both have a streaming speech path now; do not hide the
  PCM/browser-compressed choice or Smart Turn controls merely because the app
  connection is reached through relay.
- **Warm-mic option (implemented, opt-in, default off).** A **standalone**
  browser-local setting that applies to **all server-mediated speech
  recognition** (every backend, both the PCM streaming and the compressed batch
  paths) - not nested under `GrokSpeechAudioSettings`. It is **device-local** (a
  phone and a desktop want different warm behavior), so it must **not** sync as
  a server-side client default. When enabled, keep an idle mic stream warm while
  the document is visible: acquire the `MediaStream` once and keep its tracks
  open between dictations, so repeated visible-page dictations skip the device
  cold-open. "Warm" means the **mic device / MediaStream only** - no audio is
  sent and the streaming WebSocket is **not** held open or fed between
  dictations; the WS + frame sending stay strictly per-dictation. Privacy-
  visible (Chrome shows the mic indicator while the idle stream is held) - the
  explicit, accepted tradeoff of enabling it. On phones and tablets, holding
  the browser microphone may also prevent the on-screen keyboard's microphone
  or another voice-input method from opening; Settings copy must warn about
  that platform interaction. Do **not** use a short idle TTL that silently
  re-incurs the cold-open.

  The warm-mic ownership gate is **page visibility, not focus**. A visible but
  unfocused YA window/tab is still eligible for idle warm ownership because the
  user may be deliberately dictating through Smart Turn while looking at that
  visible window. When `document.visibilityState` becomes `hidden`, release only
  the idle warm stream; active capture and streaming/batch finalization continue
  until the user, Smart Turn, or the provider lifecycle stops them. When the
  document returns to `visible`, reacquire the idle warm stream only if Keep Mic
  Warm remains enabled and no active capture already owns the mic. Provider
  disposal cancels that provider's active capture and subscriptions; the shared
  idle warm stream may survive provider disposal/backend replacement when Keep
  Mic Warm remains enabled and the selected mic/constraints are compatible. The
  idle warm stream is released on option-off, selected mic change, hidden
  document, tab close, or the shared release path explicitly running. Browser
  page visibility is the portable signal: YA cannot reliably detect true pixel
  occlusion by another OS window.

  Cross-tab handoff is allowed to take a short delay. When a hidden tab becomes
  visible while another YA tab's warm-mic lease is still current, it must keep
  the reacquire intent alive and retry after the previous owner releases or the
  lease expires; it must not give up after the first refused acquire.

  Default off keeps no speculative capture.

  Smart Turn follow-up listening is independent of this preference. A non-zero
  follow-up window temporarily uses the same shared warm stream so a second
  utterance can start without another device cold-open. Expiry stops an idle
  follow-up, but speech begun before the deadline may finish; the temporary
  stream releases when that transaction settles. With Keep Mic Warm on, only
  follow-up listening ends; the visibility-scoped idle stream remains under the
  ordinary warm-mic contract.

  The first user-started capture already uses this shared stream when
  follow-up is enabled; follow-up alone never triggers speculative prewarm.
  During automatic-send finalization, retain the device until transcript
  delivery has synchronously established the next turn's warm ownership.
  The coordinator owns this retention across composer navigation. A missing
  final response releases temporary ownership after five seconds, salvages
  recognized text, and does not send. Manual stop, disconnect, and disposal
  also release the handoff. The audio graph and socket remain per-dictation;
  retaining a device does not buffer speech during the finalization gap.
  Non-empty partial or final text marks a follow-up as speech-started, without
  depending on a backend-specific status transition.

  With playback reduction enabled, an open YA microphone stream itself owns
  the YA-media mute. Only actual track closure releases that ownership, even
  if the composer has become idle or unmounted. Explicit track stop and
  browser-originated track termination both restore playback when the last
  capture owner ends. This extends to intentionally retained idle warm mics.
  The Android audio-focus hold that keeps other apps ducked does not: a
  retained stream mutes YA media only, and the hold follows active dictation
  or recording.

  Settings copy should name this visibility scope. Prefer wording like "Keep
  this browser's microphone stream ready while this tab is visible between
  server-routed dictations. The browser may show the mic indicator while the
  idle stream is held; no audio is sent between dictations." Avoid an
  unqualified "while this is on" caption, because hidden tabs intentionally
  release the idle warm stream.
  Warm triggers route through the selected speech provider's optional
  `prewarm()` hook, so **browser-native Web Speech is deliberately non-warmed**:
  `BrowserNativeProvider` has no prewarm implementation and YA must not call
  `SpeechRecognition.start()` before the user presses the mic button. This
  avoids the browser-owned recording indicator sitting on constantly when the
  selected ASR backend is browser-native.

  Implementation detail: initial warm acquisition is triggered idempotently
  when a desktop mouse pointer nears the mic control (the clickable rect plus
  margin), using the currently selected mic device. If Chrome
  microphone permission is not already granted, the first mic click still
  performs the permission/device open; subsequent dictations reuse the warm
  stream when the active non-browser provider and Keep Mic Warm setting permit
  it.
- **Warm-mic also warms the server STT model.** The same pointer-near warm
  trigger fires a one-shot `/speech/prewarm` for the selected server-routed
  backend (`YaServerProvider.prewarm`), so the first dictation skips the
  backend's cold model load (e.g. parakeet's ~20s first-load). This widens the
  earlier "warm = mic/MediaStream only" rule: warm now also covers a server
  model load. It stays an HTTP prewarm call — no audio, no held speech
  WebSocket — and needs no mic permission, so it runs even where the mic warm
  cannot. It is fired once per backend+model per provider instance (cleared on
  failure to allow retry). The server load is **singleflight**: `prewarm` and a
  subsequent mic-activated `transcribe` of the same model share one
  `warmPromise` in the local backend, so a backgrounded warm and the first real
  transcribe coalesce to **one** model instance with no aborted load — the
  transcribe simply awaits the in-flight warm. Gated on the warm-mic opt-in:
  with it off, no speculative model load is requested.

The cold-open cannot be eliminated for the *first* use without prewarming
before the click (mic indicator before intent), which is exactly why warm-mic
is an explicit option rather than default behavior.

WebSocket policy: create a fresh speech socket per dictation on click, parallel
with `getUserMedia`, and close it on final/error/stop so close remains a clean
utterance boundary. Direct/local mode opens `/api/speech/ws`; relay mode opens
the dedicated `speech` relay channel and resumes the secure YA session there.
If future `[YaSTT]` timing shows `ws open` is a material latency source, the
correct optimization is a short-freshness speculative pre-open that is dropped
when too old, not reuse of an arbitrarily idle STT socket.

## Transport reliability

Both direct and relay streaming ride WebSocket over TCP/TLS. TCP gives YA an
ordered, reliable byte stream: under packet loss the browser/server see delayed
frames or a close/error, not silent holes. WebSocket does not add packet-loss
aware redundant-send semantics, and YA should not add app-level duplicate PCM
frames to fight TCP; that cannot recover latency properties TCP has already
lost and would complicate the encrypted stream semantics.

In direct mode the path is browser -> YA server speech WebSocket -> backend STT
WebSocket. In relay mode the browser opens browser -> relay and server -> relay
WebSockets for the `speech` channel; the relay forwards opaque encrypted
frames between those two ordered streams, preserving frame order per channel.
The relay can observe usernames, channel names, timing, and ciphertext sizes,
but not speech audio or control contents after the YA SRP transport is
established. The server then forwards ordered PCM frames to the selected STT
backend or fails the speech session.

The encrypted JSON control path has per-connection sequence checks. Raw binary
PCM and upload frames are individually authenticated encrypted envelopes and
rely on TCP/WebSocket ordering rather than an extra YA sequence number. That is
intentional for now: duplicate/redundant audio is not a supported recovery
facility.

## Mobile: "turns yellow, never red" (open, unresolved)

Observed: on mobile (hosted ya.graehl.org client) the mic shows the amber
**connecting** state ("starting") and never reaches the red **listening**
state. Per contract #3, `listening` is gated on the first real sample batch,
so "never red" means **the first audio frame never fires** - the indicator
gate is doing its honest job; the fault is upstream in capture, not in the
button. The observation predates AudioWorklet mode and did not record the
device or browser. Best guesses, roughly in order:

1. **Streaming capture runs but `ScriptProcessorNode` never fires.** On mobile
   browsers (iOS Safari especially) `ScriptProcessorNode.onaudioprocess` is
   unreliable and/or the `AudioContext` stays `suspended` despite the in-gesture
   `resume()` call. Either way no first frame arrives, so the mic stays yellow.
   The 3.5s audio-flow watchdog should then surface an error; if only
   persistent yellow is seen, the watchdog isn't reaching the mobile UI (or is
   being cleared) - worth checking.
2. **Device open itself stalls.** `getUserMedia()` may hang/reject on mobile;
   the streaming path only reaches graph setup after a live `MediaStream`.
   The Grok batch implementations remain in code, but normal STT menus no
   longer advertise them; they have different browser-default processing and no
   streaming Smart Turn.
3. **AudioWorklet mode is the likely real fix.** The deprecated
   `ScriptProcessorNode` is exactly the component that is flaky on mobile, and
   AudioWorklet mode is now the default. Retest on the affected device first:
   if it now turns red, guess 1 was the cause.

Next diagnostic step (not yet done): enable **Remote Log Collection**
(Developer Mode) on the phone so the `[YaSTT]` marks reach
`~/.yep-anywhere/logs/client-logs/`, then read which mark is last:
- `graph built` present but no `first audio frame` -> capture node /
  suspended-AudioContext on mobile (guess 1/3); the mark's `capture=` names
  which mode failed.
- no `getUserMedia ready` -> the device open itself hangs on mobile.
- also confirm whether the transport resolved to direct `/api/speech/ws` or the
  dedicated relayed speech channel; both should still reach the same client
  capture marks.

## Implementation status (keep current)

- **Done:** direct `/api/speech/ws` streaming and dedicated relayed speech
  channel selection (contract #1); capture from mic-on with handshake
  buffering (#2); first-frame-gated `listening` + watchdog (#3); default-on
  communication/AEC capture, YA-media muting, raw opt-out, and
  `channelCount: 1` (#4); resampler at-least-1-sample span (#5);
  `onError`/timeout salvage + request-id guard (#6); browser-local warm-mic
  option with pointer-near initial prewarm; temporary Smart Turn follow-up
  listening across composer navigation; browser-local mic device picker;
  `[YaSTT]` diagnostics; default-on AudioWorklet capture with ScriptProcessor
  fallback for every Web Audio mic consumer.
- **Open / not implemented:** mobile "never red" (above), pending a retest
  with AudioWorklet mode on iPad/phone.

## Diagnostics

`[YaSTT]` console marks (including actual track rate, channel count, sample
size, processing constraints, and latency where the browser reports it, plus
`frame peak=`) are intentionally kept in
`doStartStreaming` while this path is being hardened; they flow to the remote
client log collector too. Remove or gate them once AudioWorklet mode has
proved reliable on desktop and mobile.

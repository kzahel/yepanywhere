# Provider runtime notifications and user-visible status

> Provider retry and terminal-failure notifications must remain distinguishable
> from transcript content, survive the lifecycle that owns them, and tell the
> user whether recovery is automatic or requires action.

Topic: provider-runtime-status

## Layers

Provider failures reach YA through three related but distinct layers:

1. **Provider notification.** The native SDK or app-server emits its own event.
   Examples include Claude `system/api_retry` messages and Codex app-server
   `error` notifications followed by `turn/completed`.
2. **Normalized SDK message.** The provider adapter converts the native event
   into YA's loose `SDKMessage` envelope. Live transcript errors need stable
   identities so a following id-less result/status message cannot replace them.
3. **Session runtime status.** `Process` and `Supervisor` project actionable
   retry/failure state into REST, session subscriptions, the activity bus, and
   the composer status surface. This is status about the provider runtime, not
   a provider-authored conversation turn.

Do not infer terminal failure from silence. A terminal status requires an
explicit provider error or failed-turn signal. Liveness remains a separate
answer to whether the process is alive, active, idle, or waiting for input.

Codex can carry the only error in its failed `turn/completed` notification.
YA surfaces that error once, including when Codex skips the separate
`error` notification.

A Codex terminal error asking the user to re-authenticate with a hardware
key shows an **Action needed** banner above the composer. The server owner
can open the focused sign-in for a Direct session, or provider settings for
a routed account. Once sign-in succeeds, the owner can restart the
conversation and retry the prompt. The session detail can recover this
notice from the latest failed turn in Codex's native history database, when
available for the bound session. A subsequent turn supersedes that failure.

## Recovery semantics and color

Color follows recovery behavior rather than the underlying error taxonomy:

| Runtime kind | Meaning | Surface tone | Clear condition |
| --- | --- | --- | --- |
| `retrying` | The provider or YA's documented adapter policy will retry automatically. | Warning/yellow | Provider progress, completed turn, abort, or replacement status. |
| `terminal` | The current turn ended and will not retry automatically. The session may still be usable. | Danger/red | The next user turn begins. A restart clears live-only status. |

“Terminal” is turn-scoped. UI copy should say that the provider stopped or the
turn ended; it must not imply that the session or provider process crashed.
Hover/title detail should say explicitly whether retry is automatic and include
the provider's error text when available.

Changing models while `retrying` is an explicit recovery override. Interrupt
the provider-owned retry wait first so its model-control RPC cannot remain
blocked behind that wait, then apply the new model through the retained session
before releasing queued messages. Clear the retry status only after the
interrupt is accepted and the model applies. A model change during an ordinary
active turn must not truncate useful output. Codex 0.151 and later publishes a
non-default model through its experimental `turn/settings/update` control; the
selection also seeds later turns. Providers without an active-turn control
retain the selection for the next turn. If a provider can change models
dynamically but cannot interrupt a retrying request, YA must restart that
provider process rather than leave the old-model retry clock in control.

Changing Claude effort during an ordinary active turn remains a next-turn
setting. YA accepts the selection immediately, applies it at the provider idle
boundary before queued work, and never interrupts the current turn. Codex
0.151 and later instead publishes a non-default effort through
`turn/settings/update` while preserving the same no-interrupt rule, then
retains it for later turns. Codex may have already captured child sessions or
other work under the old settings; an `applied` response promises publication,
not retroactive replacement. If the turn ends first and answers
`targetUnavailable`, the selection still applies to the next turn. Clearing a
model or effort override also takes effect at the next turn because Codex
treats `null` as "leave this running turn unchanged." Manual stop remains
independently available; treating a configuration choice as a stop can discard
nearly completed, already-paid-for reasoning on a high-cost turn.

If Codex refuses a live effort update with JSON-RPC `-32600` (invalid
request), YA accepts and retains the effort for the next turn. This includes
selection during compaction and runtimes where `step_model_switching` is
disabled. The selector stays on the user's choice, subsequent selections
replace it, and the next submitted turn carries that effort through normal
Codex turn validation. YA does not interrupt compaction or poll/retry the live
control. A refusal of the optional live control is not a refusal of the
next-turn configuration.

At the supervisor boundary, an unsuccessful live effort control is accepted
as a retained next-turn selection while the process remains alive. The config
response returns that choice immediately after the live attempt, so the
selector updates without a reload or a false failure toast. This also covers
older hosted provider workers that survive a server reload. YA logs the live
failure and retries once at the provider turn boundary before queued work;
it does not interrupt work or add a polling retry. Subsequent choices replace
the pending selection, including clearing it to Default. Idle or turn-boundary
application failures still surface as configuration errors and block delivery.

Effort control writes are serialized and latest-selection-wins: a slower older
provider call cannot overwrite a newer choice. At a turn boundary, failure to
apply the selected effort retains that selection and keeps the process
non-idle, so deferred work cannot start under the previous effort. A later
selection retries the provider control; only a successful application
completes the idle transition and releases queued work. The failed control
write is surfaced to the active client as a configuration error and logged
without terminating the process's provider-message consumer, so the resumed
turn can still report progress and completion.

The last successfully applied model, thinking, and effort selections remain
session state after the live provider process is reaped. Session metadata and
detail responses expose that public subset as `effectiveModelSettings`; they
do not expose retained permission or service-tier launch state (Session Info
reads the tier from the live process or `effectiveLaunchSettings`; see
[service tier](service-tier.md)). The client
resolves model controls and badges from the live process first, then these
durable settings, then the initial Codex configuration acknowledgement used by
older servers. Therefore an initial `medium` acknowledgement cannot overwrite
a later durable `high` selection after reload. An explicit durable null means
provider default and also blocks the stale acknowledgement value.

YA's initial Codex `CodexErrorInfo` normalization maps as follows:

- `serverOverloaded` and `policyCapacityUnavailable` -> `overloaded`
- `usageLimitExceeded`, `sessionBudgetExceeded`, and `rateLimitExceeded` ->
  `rate_limit`
- `internalServerError` -> `server_error`
- HTTP/response-stream connection and disconnect variants -> `network`
- all other terminal errors -> `unknown`

The `sessionBudgetExceeded` mapping is a known semantic mismatch: Codex uses it
for its configured shared rollout token budget, not subscription credits. A
future taxonomy should distinguish at least context/session budget, auth,
policy, request, and sandbox failures from billing rate limits.

Claude SDK providers also turn an explicit synthetic API-error assistant
message into terminal runtime status before terminating the unusable provider
process. Structured HTTP 402 and 429 failures normalize to `rate_limit`, 529 to
`overloaded`, provider-supplied retry reasons retain their shared normalized
meaning, and other 5xx failures normalize to `server_error`. The provider's
message remains the diagnostic detail.

Claude Gateway has one additional observed boundary shape: a failed native
`/compact` arrives as a `system/local_command` stderr wrapper rather than an
API-error assistant message. YA recognizes only the exact compaction-error
wrapper whose parsed HTTP 402 payload carries `error.code: "quota_exceeded"`;
it records terminal `rate_limit` status with the payload's message. Arbitrary
local-command output containing quota-like text does not qualify. This failed
turn does not imply that the retained provider process crashed.

## Codex 0.149.0 source audit

The findings in this section were checked against the official Codex source at
tag `rust-v0.149.0`. Root `package.json`
`yepAnywhere.codexCli.expectedVersion` has since advanced; the error-taxonomy
and detail-string changes checked at later tags are folded into the mapping and
table above, and each version's evidence is in
[provider-refresh](provider-refresh.md). Run `pnpm references:sync` to put the
gitignored `references/codex` checkout at the currently expected tag, or `pnpm
references:check` to verify an existing checkout without changing it; state the
mismatch explicitly when reading a different tag than the one a claim cites.

The most useful upstream coordinates are:

- `codex-rs/protocol/src/error.rs`: `CodexErr`, `CodexErr::is_retryable`, and
  `CodexErr::to_codex_protocol_error` define retry policy and public error
  classification.
- `codex-rs/protocol/src/protocol.rs`: `CodexErrorInfo::affects_turn_status`
  separates failed turns from command/control errors.
- `codex-rs/core/src/responses_retry.rs`:
  `handle_retryable_response_stream_error` controls retry count, backoff,
  WebSocket-to-HTTPS fallback, and visible reconnect notifications.
- `codex-rs/core/src/session/mod.rs`: `Session::notify_stream_error` constructs
  the intermediate retry event.
- `codex-rs/app-server/src/bespoke_event_handling.rs`: the `EventMsg::Error`
  and `EventMsg::StreamError` branches translate core events into app-server
  notifications; `handle_error_notification` records terminal turn state.
- `codex-rs/app-server-protocol/src/protocol/v2/notification.rs`:
  `ErrorNotification` documents `willRetry` as the authoritative recovery
  signal.
- `codex-rs/app-server-protocol/src/protocol/v2/shared.rs`: the camel-case
  app-server `CodexErrorInfo` wire variants consumed by YA.
- `codex-rs/app-server-protocol/src/protocol/thread_history.rs`:
  `ThreadHistoryBuilder::handle_error` reconstructs failed turns when a durable
  core `ErrorEvent` is available.
- `codex-rs/app-server/src/request_processors/turn_processor.rs` and
  `codex-rs/core/src/session/turn_input.rs` preserve empty-input turn starts as
  resampling without adding a user message.
- `codex-rs/tui/src/chatwidget/streaming.rs`: `ChatWidget::on_stream_error`
  shows automatic retries in the status area.
- `codex-rs/tui/src/chatwidget/turn_runtime.rs`:
  `ChatWidget::handle_non_retry_error` and its helpers show first-party
  terminal presentation choices.

Paths above are relative to `references/codex`. Do not use a floating `main`
checkout as evidence for the pinned runtime without first comparing its tag.

### Automatic retry pipeline

Native Codex retry is not inferred from an error name. The app-server's
`ErrorNotification.willRetry` boolean is authoritative for the native retry
loop:

1. A retryable `CodexErr` reaches
   `handle_retryable_response_stream_error`.
2. Codex retries with backoff and may fall back from WebSockets to HTTPS.
3. For a visible retry, `Session::notify_stream_error` emits
   `EventMsg::StreamError` with message `Reconnecting... n/max`, the original
   error text in `additionalDetails`, and `responseStreamDisconnected` as the
   public error info.
4. App-server converts that to `error` with `willRetry: true` without marking
   the turn failed.
5. The first-party TUI routes it to `on_stream_error`, which updates the status
   pane rather than adding an error history row.

Release Codex may intentionally hide the first WebSocket retry notification to
avoid noisy transient reconnect messages. This helps explain why retries can
appear inconsistently in raw observations. Older/raw JSONL or event consumers
may expose `StreamError` as an event, but it is provider runtime status, not a
provider-authored conversation message or a completed failed turn.

YA converts `willRetry: true` into yellow Codex runtime status and renders its
live transcript row as a warning rather than a terminal error. It retains the
provider message and `additionalDetails` for diagnostics and clears retry state
when provider progress resumes. No retry countdown is invented: app-server
does not send the actual backoff delay.

YA has one explicit adapter-owned exception for `serverOverloaded`. Codex
classifies a selected model at capacity as non-retryable, but the failed turn
has already recorded its user input. After consuming the matching failed
`turn/completed`, YA starts a new turn with empty input; Codex treats that as a
new sample over existing thread history without adding or resending a user
message. The same selected model is retried up to 16 times. Delays are
`min(180, 5 × (attempt + 1)²)` seconds: 20, 45, 80, 125, then 180 seconds
for every remaining retry. This is the wait after the failed attempt completes,
not a start-to-start interval or a deadline on the request itself. The full
backoff budget is 40 minutes 30 seconds, excluding provider request durations.
Retry status includes the next delay, attempt, and limit. Stop cancels the
current timer immediately while keeping the session available; provider
shutdown also cancels the timer.

An explicitly requested `/compact` uses the same bounded overload policy,
repeating `thread/compact/start` on the same thread. It never substitutes an
empty-input ordinary turn for a failed manual compact. From acceptance through
completion or recovery exhaustion, queued user input waits behind compaction
and another manual compact is refused. Successful compaction, terminal failure,
or an interrupted retry releases the operation. Provider-started work not
requested by YA does not acquire a manual-compaction retry policy.

This exception matches only the structured `serverOverloaded` category and
`policyCapacityUnavailable`, which Codex 0.166 split out of it for capacity on
a policy-restricted route, with the same retry advice (upstream #57452).
`usageLimitExceeded`, `sessionBudgetExceeded`, HTTP 429 retry exhaustion, and
all other terminal failures retain Codex's non-retry behavior. If all 16
overload retries fail, the last error becomes terminal.

### Compaction request patience

YA does not impose a three-minute deadline on active Codex compaction. In
Codex 0.153.3 and 0.153.4, the native streaming inactivity default is five
minutes; incoming transport activity renews that wait. V2 compaction permits
two stream retries per transport, switching from WebSocket to HTTPS with a
fresh retry budget while preserving V2 compaction semantics. It does not
automatically select the legacy `/responses/compact` endpoint after V2 fails.
Native timeout/reconnection exhaustion remains terminal under the adapter
policy above; increasing request patience does not increase YA's backoff.

Codex owns `model_providers.<id>.stream_idle_timeout_ms`. These versions reject
redefining the reserved built-in `openai` provider, so increasing its timeout
requires an explicitly selected custom provider configuration or an upstream
runtime change. YA does not silently change provider identity to set patience.

A custom provider name is not an equivalent timeout-only override. The native
resume picker filters by provider id, and persisted thread metadata can restore
the original provider on resume. Changing the default therefore does not
guarantee longer patience for existing threads. A ten-minute setting means
`stream_idle_timeout_ms = 600000`, not a ten-minute total turn deadline.

### Terminal error pipeline and classification

Core `EventMsg::Error` values that affect turn status become app-server
`error` notifications with `willRetry: false`. App-server also repeats the
error in the following failed `turn/completed` payload. YA should use the
boolean for red/yellow recovery semantics and the error info only for reason,
copy, and suggested action.

The adapter consumes the matching `turn/completed` before releasing queued
work, even when a preceding terminal error has already been surfaced. A dead
app-server is the exception: process exit ends consumption without waiting for
an event that can no longer arrive.

| App-server `CodexErrorInfo` | Codex meaning | Suggested YA reason/action |
| --- | --- | --- |
| `contextWindowExceeded` | Model context is full. | `context`; suggest clearing earlier history or starting a new thread. |
| `sessionBudgetExceeded` | Configured shared rollout token budget is exhausted. | `budget`; do not describe it as subscription credits. |
| `usageLimitExceeded` | Usage, quota, or plan inclusion limit. | `rate_limit`; retain provider/account guidance. |
| `rateLimitExceeded` | Upstream rate limit inside the response stream. Codex treats it as retryable, so it normally arrives with `willRetry: true` and is terminal only after Codex gives up. | `rate_limit`; the same account/quota copy as `usageLimitExceeded`. |
| `serverOverloaded` | Selected model is at capacity. Codex itself does not retry it. | `overloaded`; YA retries the same model under the bounded adapter policy above. |
| `policyCapacityUnavailable` | Capacity is unavailable on a policy-restricted route (Codex 0.166+; earlier versions reported it as `serverOverloaded`). Same retry advice as `serverOverloaded`. | `overloaded`; same bounded same-model retry. |
| `cyberPolicy` | Cyber-safety policy ended the turn. | `policy`; mirror the first-party dedicated safety notice. |
| `misalignmentPolicyViolation` | A misalignment policy blocked the request. | `policy`; the top-level message can be a generic fallback, so show `misalignment.detailedExplanation` as the detail. |
| `httpConnectionFailed` | HTTP connection failed after retries. | `network`; retain `httpStatusCode`. |
| `responseStreamConnectionFailed` | Response stream could not be established after retries. | `network`; retain `httpStatusCode`. |
| `responseStreamDisconnected` | Response stream disconnected before completion. | `network`; normally intermediate when `willRetry` is true, terminal if false. |
| `responseTooManyFailedAttempts` | Codex exhausted response attempts. | `rate_limit` for HTTP 429; otherwise retry-exhausted/network/server copy. |
| `internalServerError` | Upstream internal failure or internal agent death. | `server_error`; retry requires a new user turn after Codex exhausts its own retry loop. |
| `unauthorized` | Auth refresh failed. | `auth`; offer authentication diagnostics or reauthentication. |
| `badRequest` | Unsupported operation, missing thread, agent limit, or another rejected request. | `request`; raw provider text is important because the category is broad. |
| `sandboxError` | Codex sandbox execution/setup failed. | `sandbox`; distinguish it from user denial and point toward the permission/environment boundary in [codex-permission-mode](codex-permission-mode.md). |
| `other` or absent | No stable public classification. | `unknown`; always preserve the provider message and request id. |

App-server fills the error's `additionalDetails` only on retryable stream
errors; for a terminal error it leaves that field null and, since Codex 0.151,
carries a misalignment block's substantive explanation in `misalignment`
instead. The two never arrive together, so YA reads one detail string —
`additionalDetails` when present, otherwise `misalignment.detailedExplanation` —
and shows it wherever the provider detail already appears. Retry diagnostics are
unchanged by that fallback.

`misalignment.steer.message` is the text Codex expects a client to submit as the
next user turn if the user chooses to continue. YA does not offer that
continuation: doing so is a deliberate interaction design, not a detail string,
and Codex requires showing the explanation before offering it at all.

`threadRollbackFailed` and `activeTurnNotSteerable` explicitly return false
from `affects_turn_status`. App-server normally resolves or suppresses them as
request/control failures rather than failed-turn notifications. YA should
defensively avoid retaining either as a terminal turn incident if protocol
drift ever exposes one through the generic error path.

### Process failures and non-error notifications

YA's Codex app-server client synthesizes `error` with `willRetry: false` when
the child process exits. That notification intentionally has no thread or turn
id. The loose fallback conversion preserves its nested message, such as `Codex
app-server exited (code=..., signal=...)`, and marks its optional scope as a
provider-process failure. New clients can explain that the process stopped;
older clients safely render the same ordinary error envelope.

Codex also sends `warning`, `guardianWarning`, `configWarning`, and
`deprecationNotice`. YA's Codex SDK adapter currently drops these in the
default notification branch. They are not terminal incidents; a later
notification-surface pass should decide which belong in transient yellow/info
UI, diagnostics, or transcript display objects.

### Hosted-client compatibility

Provider runtime status crosses REST, session SSE, the activity bus, and remote
relay transports without a separately negotiated schema version. Evolve it
additively:

- keep `retrying` and `terminal` as the stable discriminants;
- add diagnostic fields such as retry message/details and terminal scope only
  as optional properties;
- keep normalized provider errors in the existing loose `SDKMessage`
  envelope, where older clients ignore new Codex metadata;
- make new clients treat absent optional fields as the older behavior (`error`
  remains terminal-looking when `codexWillRetry` is absent, and terminal scope
  defaults to the current turn);
- never require an older server to send the new scope/details fields for the
  composer or transcript to render safely.

This permits a newer hosted frontend to connect to an older YA server and an
older frontend to consume a newer server. Mixed versions may have less precise
copy or color, but must not crash, hide the provider message, or misread a new
wire discriminant.

## Surfaces

### Composer status

The composer status is the durable-within-the-running-YA explanation of why a
turn stopped. Retrying status may show a retry clock. Terminal status stays
visible while the user is deciding whether to retry or change models.

The status is available through session REST snapshots, live subscription
snapshots, and activity events so reconnecting clients converge.

### Inbox rows

Inbox rows carry a compact projection of the status, so a session paused by a
rate limit, or stopped by a terminal error, is visible without opening it. The
projection and its republish rules are in
[Inbox](inbox.md).

### Live transcript

A provider error may also appear at the live transcript tail, where it explains
the exact turn boundary. Codex's first-party TUI renders `serverOverloaded` as
a warning history row. During YA's bounded overload recovery, each failed
attempt is a retry warning; only exhaustion becomes terminal/danger. The
provider message remains intact.

This row is live-only when the provider does not persist the notification. It
must have a stable message id, but YA must not write a shadow provider turn to
make it survive reload.

### Restricted capability

A provider may answer a refusal by retrying on a different model and leaving
the session there. YA reports the recorded evidence; it never infers a
restriction from wording or from a model change alone.

Claude Code is the one provider with durable evidence today. It writes a
`model_refusal_fallback` system row naming the original and fallback models,
the refusal category when the provider gave one, and whether the swap is for
the session or for one subagent or side-question reply.

- The row renders in the transcript as a warning notice with both model
  names and the category.
- A Claude session summary carries `capabilityRestriction`: the eight newest
  fallbacks on the current branch, whether earlier ones exist, and
  `activeModel`, the fallback model of the latest session-wide swap. A swap
  stops being active when a later assistant turn on that branch is answered by
  a different model. A single-reply fallback never makes a session active. The
  field is absent when no fallback is recorded; other providers and older
  servers never send it.
- The session header shows a **Restricted capability** badge whenever the
  summary or the loaded transcript holds a fallback. It is warning-colored and
  labelled while active, and a muted icon afterwards. Its menu states the
  status and lists the fallbacks, newest first, each a link that opens the
  session scrolled to that row. Narrow headers keep the icon alone.
- A fallback that arrives on the live stream shows at once: the client
  continues the server's summary through the loaded rows, accepting the live
  message's snake_case fields as well as the durable camelCase ones.

The summary fact is part of the existing Claude summary parse and its
condensed index form, so it adds no transcript reader. A durable index built
by an older server does not hold fallbacks recorded before it was built; they
appear after that session's index is rebuilt.

Session lists do not show the badge yet, and Codex's equivalent is not
surfaced; see the gaps
[session lists](../gaps/capability-restriction-missing-from-session-lists.md)
and [Codex reroutes](../gaps/codex-model-reroute-not-surfaced.md).

### Diagnostics

Process info may expose kind, reason, provider message, source notification,
turn id, timestamps, retry timing, and attempt counts. Diagnostic detail must
not be the only place the user can learn that a turn ended.

## Persistence and resource ownership

The observed `serverOverloaded` rollout contained `task_complete` with a turn
id and nullable last agent message, but no durable error event. Codex source
does support reconstructing a failed `Turn.error` when a core `ErrorEvent` is
present in app-server thread history. These are conditional facts, not a
guarantee that every rollout or YA JSONL reader can recover the error. YA must
not manufacture a pseudo-turn to bridge the gap; prefer native `thread/read`
data if it becomes reliably available, otherwise use bounded runtime status.

Terminal runtime status is retained in a bounded, in-memory Supervisor map
keyed by YA session id. It survives provider process reaping and client
disconnects, but not a YA server restart. It is not stored in
session metadata and is not a transcript display object.

The map has a fixed entry cap and no timer or background loop. A retained
status must never retain a provider process, watcher, heartbeat, or client
subscription. The next user message clears the old incident before the new
turn proceeds; a repeated failure records a new terminal incident.

The overload timer is different from retained terminal status: it belongs to
an unresolved active provider turn, has one timer at a time, and ends on
success, explicit Stop/abort, app-server shutdown, or the 16-retry ceiling. It
does not depend on heartbeat or a connected browser tab.

## Tests

Coverage should prove:

- retrying and terminal statuses have different color/copy semantics;
- changing models during retry interrupts the held wait before model control,
  applies the model before queued delivery, and clears the retry status;
- changing models during an ordinary active turn does not interrupt it;
- Codex publishes active-turn model and effort selections through
  `turn/settings/update`, retains them for later turns, and falls back to the
  next turn when the live target is unavailable;
- Codex `willRetry: false` errors become terminal status with the right reason;
- terminal status survives `result`, idle transition, and idle process reap;
- the Supervisor serves retained terminal status without a live process;
- a new user message clears the retained incident;
- a following id-less/result message does not replace the live error row;
- subscriptions and REST snapshots carry both status kinds.

Codex coverage should additionally prove:

- `willRetry: true` becomes yellow retry status and is not styled as terminal;
- structured `serverOverloaded` failures retry with 20, 45, 80… second timing,
  expose their retry clock, and become terminal after the bounded limit;
- overload retries start an empty-input turn and emit the original user message
  only once;
- Stop/abort tears down the overload wait, while quota failures never enter it;
- terminal classification covers the source table above without string
  matching the recovery decision;
- `sessionBudgetExceeded` is not called a subscription rate limit;
- app-server exit notifications preserve their real process error;
- non-turn control errors do not leave retained terminal status;
- warning/config/deprecation notifications follow an explicit surface policy.

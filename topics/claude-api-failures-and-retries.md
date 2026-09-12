# Claude API Failures and Retries

> The Claude SDK auto-retries transient API failures internally (observed:
> `max_retries: 10`, exponential backoff, ~3.3 min for a 529 Overloaded
> episode). YA-owned Claude launches now keep retryable failures inside that
> original provider turn: 429/529 retries use Claude Code's persistent retry
> watchdog with exponential backoff capped at five minutes, while the documented
> retry-count limit is effectively unbounded for other retryable server,
> timeout, and connection failures. Stop/abort still cancels the wait; YA does
> not synthesize or resend a second user turn.

See also:
- [`claude.md`](claude.md) — "Transcript Structure" documents the SDK's
  internal retry bookkeeping (`api_error` connector rows) and the
  resume-context-loss bug it can cause.
- [`provider-state-machine.md`](provider-state-machine.md) — process lifecycle.
- [`compact-and-handoff.md`](compact-and-handoff.md) /
  [`resume-compaction.md`](resume-compaction.md) — the resume-at-message-id
  prefix-resume fallback for persisted synthetic error tails.
- [`../docs/tactical/049-provider-runtime-retry-status.md`](../docs/tactical/049-provider-runtime-retry-status.md)
  — plan and first slice surfacing live `api_retry` status in process info
  (`Topic: provider-runtime-status`); builds on this doc's finding that
  `api_retry` rows are live-stream-only.

Topic: claude-api-failures-and-retries

## Context

Codex was reported (by the user, not verified here) to recover transient server
failures automatically at the harness/SDK level, keeping the turn alive. The
question was whether the Claude SDK does the same. The evidence below shows it
**does** retry transient failures internally — but after exhausting its budget
it used to surface a terminal error that YA did not handle live, so the turn
ended. YA now opts into the harness's persistent retry path instead of trying to
reconstruct and resend the turn outside Claude. Baseline observations come from
session
`84aae708-b140-483b-a324-9e0603b5028d` (a 529 on 2026-06-17, claude CLI
2.1.170 / `@anthropic-ai/claude-agent-sdk@0.3.170`) plus an aggregate scan of
local session jsonl. The implemented path was source-audited against Claude Code
2.1.183 / Agent SDK 0.3.183 on 2026-06-19.

## Verified: the SDK's default finite retry

The Claude CLI/SDK retries transient failures itself and **streams progress
live** as `system` messages with `subtype: "api_retry"`. Each carries:

```jsonc
{ "type": "system", "subtype": "api_retry",
  "attempt": 10, "max_retries": 10, "retry_delay_ms": 37281.4,
  "error_status": 529, "error": "overloaded" }
```

For the observed 529: **10 attempts** (`attempt` 1→10, `max_retries: 10`, all
`error_status: 529` / `error: "overloaded"`), exponential backoff that doubles
then saturates a **~37s cap**, taking **~3.3 minutes** end to end (first
`api_retry` ≈ 15:18:39Z → terminal error 15:21:59.171Z = 199.8s):

| attempt | `retry_delay_ms` | wall gap to next |
|--:|--:|--:|
| 1 | 616 | 3.9s |
| 2 | 1086 | 3.8s |
| 3 | 2414 | 4.3s |
| 4 | 4775 | 7.4s |
| 5 | 8226 | 10.8s |
| 6 | 16888 | 19.1s |
| 7 | 36407 | 38.8s |
| 8 | 32097 | 35.2s |
| 9 | 33178 | 37.3s |
| 10 | 37281 | (gives up ~39s later) |

So a single overload episode pins the turn "thinking" for ~3 minutes before any
terminal error appears. The `retry_delay_ms` numeric code (`error_status`) **is**
present on these live `api_retry` messages.

A separate verified case in [`claude.md`](claude.md) (Cloudflare 502, session
`c5b32eda`) shows this layer **succeeding** after a transport error, recorded as
a `system` `api_error` connector row.

## Verified: Claude Code 2.1.183 persistent retry

Claude Code's current public error reference says server errors, overloaded
responses, request timeouts, temporary 429 throttles, and dropped connections
are retryable, and documents `CLAUDE_CODE_MAX_RETRIES` as the attempt limit:
<https://code.claude.com/docs/en/errors#automatic-retries>.

Source inspection of the bundled 2.1.183 executable establishes the stronger
watchdog behavior used by YA:

- `CLAUDE_CODE_RETRY_WATCHDOG=1` puts retryable 429 and 529 responses into a
  persistent branch that does not exhaust `CLAUDE_CODE_MAX_RETRIES`.
- Backoff starts at 500 ms with jitter and caps at 300,000 ms (five minutes).
  A server-provided unified 429 reset may request a longer wait, capped at six
  hours; the normal exponential path itself stays at five minutes.
- Long waits are split into 30-second chunks and remain abort-signal aware.
- Credit/extra-usage-required 429 responses are rejected before this persistent
  branch, so enabling the watchdog does not loop the observed 1M billing error.
- Other retryable failures still use the documented attempt limit. YA sets that
  limit to `2147483647`, an effectively unbounded operational value, while
  preserving an explicit operator override.

This keeps the request that failed inside Claude's own API loop. It avoids the
known unsafe alternative: appending a second user turn after a synthetic API
error can make Claude send the synthetic `previous_message_id` and receive a
400.

## Verified: the terminal failure signal

After the retry budget is spent, two messages stream:

```jsonc
// assistant (synthetic) — NOTE: no isApiErrorMessage / apiErrorStatus on the stream
{ "type": "assistant", "error": "server_error",
  "request_id": "req_011Cc94BqVu5Q84wZ8AscCVc",
  "message": { "model": "<synthetic>", "stop_reason": "stop_sequence",
    "usage": { /* zeros */ },
    "content": [{ "type": "text",
      "text": "API Error: 529 Overloaded. … try again in a moment. …" }] } }
// immediately followed by:
{ "type": "result", "subtype": "success", "is_error": true }
```

Verified live markers (from `sdk-raw.jsonl`, logged pre-`convertMessage`):
- terminal `assistant`: top-level `error: "server_error"`, `request_id`,
  `message.model: "<synthetic>"`, the text. **No `isApiErrorMessage`, no
  `apiErrorStatus`.**
- terminal `result`: `is_error: true` (note `subtype: "success"` is present and
  therefore not a reliable error discriminator).

## Verified: structured fields live only in the persisted transcript

The same 529 as written by the CLI to
`~/.claude/projects/<proj>/<id>.jsonl` (line 558) **does** carry the structured
fields:

```jsonc
{
  "type": "assistant",
  "isApiErrorMessage": true,   // only in the persisted jsonl, not the stream
  "apiErrorStatus": 529,       // only in the persisted jsonl, not the stream
  "error": "server_error",
  "requestId": "req_011Cc94BqVu5Q84wZ8AscCVc",
  "message": { "model": "<synthetic>", "stop_reason": "stop_sequence",
    "content": [{ "type": "text", "text": "API Error: 529 Overloaded. …" }] }
}
```

These fields originate in the CLI binary that writes the transcript, not from
YA and not from the streamed object. Verified three ways:
- `sdk-raw.jsonl` (the raw streamed message) lacks both fields.
- No code in `packages/server/src` or `packages/shared/src` assigns them (grep:
  only reads/comparisons). `claude.ts wrapIterator` logs the raw message, then
  `convertMessage` only normalizes content blocks — it adds no fields.
- `@anthropic-ai/claude-agent-sdk@0.3.170` does not contain those identifiers in
  its shipped files.
- One older transcript entry (2026-02-10) had `apiErrorStatus` absent entirely,
  with the code present only in the message text (`API Error: 500 {…}`).

## Verified: observed error codes (aggregate local scan, 2026-06-17)

From all session jsonl under `~/.claude/projects/`:

| `apiErrorStatus` | `error` | seen | message text |
|---|---|---|---|
| **500** | `server_error` | 6 | "Internal server error. … usually temporary — try again in a moment." |
| **529** | `server_error` | 1 | "Overloaded. … usually temporary — try again in a moment." |
| **429** | `rate_limit` | 4 | "Usage credits required for 1M context · turn on usage credits…" |
| **401** | `authentication_failed` | 2 | "Failed to authenticate. API Error: 401 Invalid authentication credentials" |
| **404** | `model_not_found` | 1 | "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it." |
| *(absent)* | `unknown` | 1 | "API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\"…}}" |

This is only what was observed on this machine; it is not an exhaustive list of
what Anthropic can return.

Three observations grounded in the text above:
- `server_error` (500, 529) self-describes as transient ("usually temporary —
  try again in a moment").
- The locally observed `rate_limit` (429) was a **billing** condition ("usage
  credits required"), while Claude's current error reference also defines a
  temporary 429 throttle unrelated to plan quota. Status or the broad
  `rate_limit` semantic alone cannot safely distinguish them; Claude Code's own
  retry classifier checks the credit-specific detail before entering persistent
  retry.
- `authentication_failed` (401) and `model_not_found` (404) require user action.

## Verified: current YA handling

- **Launch policy** —
  `packages/server/src/sdk/providers/env-filter.ts` defaults
  `CLAUDE_CODE_RETRY_WATCHDOG=1` and
  `CLAUDE_CODE_MAX_RETRIES=2147483647`, preserving explicit operator values.
  YA uses Agent SDK 0.3.183, whose bundled executable is Claude Code 2.1.183.
  Targeted transient failures therefore remain in the original provider turn
  until success or user/process abort.
- **Schema** — `packages/shared/src/claude-sdk-schema/entry/AssistantEntrySchema.ts`
  declares `isApiErrorMessage` (optional bool). `apiErrorStatus` is **not** in
  the schema; it is read as an untyped field.
- **Terminal fallback** — `packages/server/src/supervisor/Process.ts`:
  - `isClaudeSdkApiErrorMessage()` requires
    `message.isApiErrorMessage === true`; on match YA first records terminal
    provider-runtime status, then calls `abortFn()` and
    `markTerminated("Claude SDK API error; restart required")`. HTTP 402/429
    classify as `rate_limit`, 529 as `overloaded`, and other 5xx failures as
    `server_error`.
  - **For the observed 529 this hook did not fire**: the live terminal message
    lacks `isApiErrorMessage`, so the predicate is false. The trailing `result`
    message then runs `transitionToIdle()` (L2724); the `result` handler does
    **not** inspect `is_error`. Net live behavior: the session goes **idle**, not
    terminated, and no API error is surfaced to YA's state machine. With YA's
    default launch policy, retryable 429/529 failures should no longer reach
    this terminal shape; the limitation remains relevant when an operator
    disables persistent retry or an upstream behavior changes.
  - The termination path is unit-tested with messages that already carry
    `isApiErrorMessage: true`. Streams that omit the marker still cannot be
    classified from their trailing `result` alone.
  - Claude Gateway compaction quota failure has a separate observed shape: a
    `system/local_command` stderr wrapper containing an HTTP 402 JSON payload.
    YA parses that boundary only when the payload code is `quota_exceeded` and
    records terminal `rate_limit` status without terminating the retained
    process.
- **Read/resume path** — `packages/server/src/routes/sessions.ts`
  `getClaudeResumeApiErrorBlocker()` (L143) reads the persisted jsonl (where the
  fields exist), detects a trailing API-error assistant row, and returns a
  blocker carrying `apiErrorStatus` plus a **`resumeAtMessageId`** (uuid of the
  last good assistant message before the error tail, a prefix-resume point).
  Recovery is `"handoff-required"` (`CLAUDE_RESUME_API_ERROR_RECOVERY`) and
  user-triggered. This is the contract noted in [`claude.md`](claude.md): an
  SDK API-error row blocks normal resume.

The read/resume guard remains necessary for old transcripts, external Claude
processes, and explicit launch overrides that allow the finite retry budget to
be exhausted.

## Model switch during a held retry

Claude owns the retry delay inside the current SDK query. YA does not reject a
send based on a separate rate-limit clock: while that query remains active, a
new user message is steered or deferred behind the same provider turn. Before
2026-07-23, changing the Claude model called the SDK's model setter for a later
request but did not cancel the request already sleeping on the old model's
retry schedule.

Session `6ed5ccec-0f4f-4c2a-beb4-5d428a01b918` demonstrated the failure:

- Claude persisted a synthetic Fable rate-limit assistant row at
  `2026-07-23T05:33:27.578Z`.
- `/model` selected Opus at `05:33:54`, followed by queued `continue`
  operations at `05:34:14` and `05:35:26`; neither became a durable user turn.
- After YA recreated the provider process, `continue` became a real user row at
  `06:13:06` and Opus answered at `06:13:09`.

The recovery contract is now status-sensitive: a model switch while YA has an
explicit Claude `api_retry` status interrupts that held retry first, then applies
the new model before releasing queued messages. An ordinary active turn is not
interrupted; its model change
continues to apply at the next turn boundary. This is a user override of
Claude's retry ownership, not a second YA retry or resend loop.

## Verified: retries are not rendered (and why)

The `api_retry` messages never reach the UI, for two stacked reasons:

- **Not persisted.** The CLI writes the terminal error row to the transcript
  jsonl (as the `isApiErrorMessage` assistant row) but does **not** write the
  `api_retry` rows. Session `84aae708`'s only persisted `system` rows are
  `stop_hook_summary`; zero `api_retry`. So they are live-stream-only and absent
  from any reload / catch-up / resume (all of which read the transcript).
- **Dropped by the client even live.** The server forwards everything
  (`shouldEmitMessage()` is hardcoded `true`, Process.ts:159), so the client
  does receive `api_retry` on the live stream. But `messageProjection.ts`
  (`packages/shared/src/transcript/messageProjection.ts`) renders
  only an allowlist of `system` subtypes (`compact_boundary`, `turn_aborted`,
  `config_ack`, `away_summary`, `subagent_activity`); all others hit "Skip other
  system entries … they're internal" (~L300) and are discarded. `api_retry` is
  in that dropped set.

The terminal error is visible only because it is an `assistant` message whose
text content is literally `"API Error: 529 Overloaded…"` — ordinary assistant
text. The client does not reference `isApiErrorMessage` in rendering, so there
is no error-styled card to attach retry context to.

### Scope decision (2026-06-17): not surfacing retries yet

Reliably showing retry info (a live "retrying…" indicator, or a "failed after N
retries over T" summary on the terminal error) cannot be done from the
transcript alone, because `api_retry` is ephemeral and the CLI-written transcript
cannot be amended. Doing it durably would require YA to **persist its own SDK
session enrichment sidecar to disk** and merge it at render time.

**Decision: we are not doing that yet.** The cost (a parallel persistence layer
mirroring/augmenting CLI transcripts) is not worth it for retry visibility
alone. Persistent retry works without it because Claude owns the retry loop.

## Observed recovery for this session

After the terminal error at 15:21:59Z the session produced no further activity
for ~20 minutes. At 15:41:15Z a new user message was enqueued and the session
then ran normal turns again (real model `claude-opus-4-8`, not `<synthetic>`) —
i.e. it recovered once the overload cleared, via a manual re-send.

## Implemented recovery (2026-06-19)

YA delegates retry ownership to Claude Code rather than adding a second
supervisor timer or resend path:

1. Start and mid-session API calls share the same Claude request loop, so the
   launch env covers both failure locations.
2. Persistent 429/529 retry uses Claude's original request and five-minute
   backoff cap.
3. Other failures that Claude classifies as retryable use an effectively
   unbounded attempt limit.
4. User stop, process abort, or server process teardown cancels the SDK wait.
5. Non-retryable billing, authentication, model, permission, and malformed
   request failures still surface normally.
6. The existing unsafe-resume blocker remains the fallback for persisted
   synthetic API-error tails created by older or explicitly overridden
   processes.

## Not yet observed / unknown

- A real outage smoke has not yet held a YA-owned 2.1.183 process through more
  than ten retries to success; the persistent behavior is source-audited and
  launch-policy tested.
- Whether other status codes (e.g. 503, timeouts) appear in local transcripts,
  and what their `error` / `error_status` look like. Only `server_error`
  (500/529), `rate_limit` (429), `authentication_failed` (401), and
  `model_not_found` (404) have been seen locally.
- Whether `isApiErrorMessage` presence on the **live** stream varies by SDK
  version (it was absent for 2.1.170 / sdk 0.3.170; the L2676 hook and its tests
  imply some path expects it).
- Codex retry behavior is now source-audited separately in
  [provider-runtime-status](provider-runtime-status.md); selected-model
  overload recovery includes a bounded YA-owned exception there.

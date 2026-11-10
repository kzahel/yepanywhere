# Fable 5.2 completion-estimate investigation

Date: 2026-11-10. This is live-probe evidence and a possible follow-up, not
an implemented ETA feature or an accuracy qualification.

Fable 5.2 can provide completion estimates when asked. No native structured
completion-time estimate was found in the installed Claude Code 2.1.322 /
Agent SDK 0.3.322 declarations or in the captured SDK events. A small custom
SDK MCP reporting tool successfully obtained typed estimates before and after
work. That is a harness convention, not evidence of a new native model/API
feature.

## Live probes

All three used `claude-fable-5-2` and real foreground shell waits. No repository
files were changed by the model; no subagents or scheduled jobs were created.
The first used the running YA server on localhost:3400. The other two used the
same installed Agent SDK directly so every SDK message could be recorded
without restarting the user's server or changing its logging configuration.

| Probe | Model estimate | Observed time remaining |
| --- | --- | --- |
| YA detached session, medium effort, 30-second wait and checksum | About 40 seconds | 36.593 seconds from persisted estimate to final assistant message |
| Direct SDK, medium effort, two 15-second waits | About 40 seconds, then about 20 seconds | About 39.56 seconds from first complete estimate to SDK result; about 19.81 seconds from the revised estimate |
| Direct SDK with custom estimate tool, low effort, 10-second wait | 20 seconds, then 2 seconds | 18.198 seconds and 2.758 seconds, respectively, from tool-handler receipt to SDK result |

The waits make these deliberately easy timing tasks. They do not establish
accuracy on coding, research, unknown tool runtimes, or multi-hour work.
Tool calls and final generation also consume time: even a two-second estimate
was exceeded in this tiny example.

### YA session and native transcript

Created with `POST /api/session-creations`, provider `claude`, model `fable`,
thinking `medium`, recaps and prompt suggestions off. The process and native
assistant messages confirmed the actual model as `claude-fable-5-2`.

- YA session: `1da96380-d391-44ec-bef6-470af72333d6`.
- [Open the probe on localhost:3400](http://localhost:3400/projects/L3ByaXZhdGUvdmFyL2ZvbGRlcnMvN2gveDBnODl0NG43NjUyNWY5NXRzZGRzNnJyMDAwMGduL1QveWVwLWFueXdoZXJlLW5vLXByb2plY3Q/sessions/1da96380-d391-44ec-bef6-470af72333d6).
- Native source was obtained from
  `GET /api/sessions/<sessionId>/native-source`, rather than guessing its path.
- First assistant text: `2026-11-10T10:38:06.196Z`.
- Final assistant text: `2026-11-10T10:38:42.789Z`.
- The command ran from 10:38:08Z to 10:38:38Z. Its SHA-256 was independently
  verified as `486b83e80000e93d198419edd48fd10df2511f30d8953315f58482071f228f7e`
  for the literal string `yep-fable-eta-probe`.
- The estimate was a normal assistant `text` block. There was no separate
  native ETA record in the 47 persisted rows. The process returned to idle.

### Raw SDK capture

The second probe's native session was
`881601b8-15be-4fa8-b68d-512029a940bb`. It produced 126 SDK messages,
including partial stream events, 18 `system/thinking_tokens` events, two
`system/task_started` events, two `system/task_notification` events, and a
successful result. The estimates appeared only in ordinary assistant text.

The SDK fields that might be mistaken for an ETA are different measurements:

- `thinking_tokens.estimated_tokens` and `estimated_tokens_delta` estimate
  thinking already generated in the current block. They do not predict total
  thinking or seconds remaining.
- `tool_progress.elapsed_time_seconds` and task usage `duration_ms` report
  elapsed work, not expected completion. `tool_progress` and `task_progress`
  were inspected in the declarations; neither appeared in this short capture.
- The result's `duration_ms` / `duration_api_ms` are retrospective durations.
- Progress-update `thinking` blocks contain user-facing status prose, not a
  typed completion estimate.

The model's own statement that it has no native ETA facility is not the
authority for this finding. The SDK declarations and captured fields are the
evidence. An untested API beta, other product harness, or later runtime could
still supply a feature these probes did not exercise.

### Explicit structured reporting proof

The third probe's native session was
`cf8d074f-220d-47fe-b440-8387dac0ef96`. An in-process SDK MCP server exposed
one tool, `report_completion_estimate`, with this input shape:

```ts
{
  remaining_seconds: number; // integer, 0..3600 in this bounded probe
  confidence: "low" | "medium" | "high";
  reason: string; // at most 240 characters
}
```

The handler validated inputs through the SDK's Zod tool schema and added its
own receipt timestamp. It only recorded the estimate and told the model to
continue; it did not schedule work or wait. The model was explicitly asked to
call it before work and again after the command finished. Actual raw assistant
tool-use inputs were:

```json
{"remaining_seconds":20,"confidence":"medium","reason":"One 10-second sleep command plus tool call overhead and a final estimate and confirmation."}
{"remaining_seconds":2,"confidence":"high","reason":"The sleep command finished; only the one-line confirmation remains."}
```

The receipts were `10:41:22.114Z` and `10:41:37.554Z`; the final result arrived
about 21.423 seconds after the harness started. These were real tool calls,
not parsed prose or fabricated native fields. The confidence values are also
model self-reports, not calibrated probabilities.

## Implications for a YA follow-up

There is no observed native ETA to wire straight into the current UI. A
possible implementation is an explicit, default-off estimate-reporting tool
and launch instruction. It would provide typed data without parsing arbitrary
assistant text or interpreting thinking-token counters as a countdown.

The server could attach each accepted report to the active user turn and add
`reportedAt` and `expectedFinishAt = reportedAt + remaining_seconds`. The
session's existing working-status area could show “Agent estimate: ~2 min,”
with the report age and reason available on demand. Label it as an estimate;
expiry should show “Estimate passed,” never imply successful completion.
Clear it on completion, cancellation, a new turn, or an incompatible resume.
An absent report should leave the current working indicator alone.

This needs actual integration and verification before shipping. The direct
SDK proof did not exercise YA tool permissions, sandboxed sessions, turn
attribution, reconnects, hosted-client compatibility, or UI rendering. In
particular, `ClaudeProvider.getSessionToolOptions` currently prohibits MCP
tools for confined sessions; the prototype does not justify loosening that
boundary. A follow-up must preserve it or choose another explicitly supported
reporting surface. Novel instructions and UI follow
[vanilla defaults](../../topics/vanilla-defaults.md).

Raw logs and the two standalone reproduction harnesses are retained locally
under `/tmp/yep-fable-eta-probe/` (`sdk-raw.jsonl`,
`structured-sdk-raw.jsonl`, `structured-estimates.jsonl`, and the
`*-sdk-probe.mjs` files). They contain native session context and are not
checked in. The native transcripts remain in Claude's normal session store.

## Upstream references checked

- [Fable 5.2 launch](https://www.anthropic.com/claude-fable-and-mythos-5-2).
- [What's new in Fable 5.2](https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2).
- [Keep users informed during long turns](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2#keep-users-informed-during-long-turns)
  describes progress updates in thinking blocks. No completion-time-estimate
  protocol was identified in these pages.
- Installed SDK `sdk.d.ts`: `SDKThinkingTokensMessage`,
  `SDKToolProgressMessage`, `SDKTaskProgressMessage`, and result declarations.

No production source or UI behavior changed. Verification was the three live
model probes, inspection of persisted and raw messages, and an independent
checksum. Repository test suites were not needed for this documentation-only
investigation.

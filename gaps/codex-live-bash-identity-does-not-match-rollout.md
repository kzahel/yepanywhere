# Codex live Bash and rollout tool identities can render duplicate rows

The native browser regression for repeated tool-result delivery now checks
completion before API replacement. With one actual Codex `tools.exec_command`
call running a gated Node command, expanded activity shows one pending Bash row
and one completed Bash row for the same command. The final zero-exit result is
delivered live. API replacement/reload can hide the duplication, so checking only
a completed row after reconnect missed it.

`packages/client/src/lib/codexToolReconciliation.ts` requires an exact fingerprint
of the entire normalized input. A live `command_execution` uses `{command, cwd}`
and includes the provider's outer `bash -lc` wrapper. The durable custom `exec`
call retains `{cmd, workdir, yield_time_ms, max_output_tokens, command}`. These
render the same command but cannot match that fingerprint. Read/image paths
already have narrower semantic normalization; their qualification does not
establish Bash convergence. Do not equate arbitrary command text, multi-command
orchestration or different working directories to remove a pending row.

Keep the common Process completion/cursor repair separate: it fixes dropped
same-UUID tool-result states and does not create this correlation mismatch.
The retained browser requires the live final result and one completed row
before replacement, after replacement and after reload, but does not claim
that no pending duplicate remains. Qualify a conservative canonical Bash
fingerprint and retain sanitized live/durable inputs plus a mounted regression
before closing this entry. The existing ten-second/same-turn/one-to-one matching
bounds must remain; this projection grants no execution or relationship authority.

Evidence: ignored `tasks/session-relationships/slice-27-browser-reviewed.log`
and `slice-27-browser-single.log` each fail the stronger total-row count before
replacement (expected one, observed pending plus complete). The latter uses one
native call, so this is not explained solely by multi-call JavaScript.
[Render convergence](../topics/codex-code-mode-render-convergence.md) owns the
live/durable identity contract.

Found 2026-11-05 while reviewing durable relationship evidence delivery.

# Claude interrupt can be ignored during a long foreground Bash call

YA's Stop reached `Process.interrupt()` → `sdkQuery.interrupt()`
(`packages/server/src/sdk/providers/claude.ts`, the `interrupt:` adapter) four
times, but Claude Code (agent SDK 0.3.330, CLI 2.1.330) wrote no
"Request interrupted" record, the running Bash `tool_use` got no result, and
the user's three queued messages stayed in Claude Code's own input queue. A
minute-scale foreground `agentctl wait --timeout 55m` therefore made the
session unreachable until the waiter process was killed by hand; the tool
then returned and the queue drained normally.

An interrupt of the same session two minutes earlier did work, but left that
cancelled Bash call's child process (an earlier `agentctl wait`) running —
a second symptom: interrupting a foreground Bash call does not reap its
process tree.

Likely an upstream Claude Code bug; not reproduced in isolation. A minimal
SDK repro (haiku, one `sleep 300` Bash call, `interrupt()` after 8 s)
ended the turn 17 ms after the acknowledgement, but the CLI had moved that
command to the background on its own, so the repro did not hold a
foreground call open; the steered-mid-turn variant was not run.

How YA fulfils Stop today: `Supervisor.interruptProcess()` races
`Process.interrupt()` against `DEFAULT_INTERRUPT_TIMEOUT_MS` (2 s) and
hard-aborts the process only when that call times out or returns false.
For Claude, `Process.interrupt()` returns true as soon as
`sdkQuery.interrupt()` resolves, which is the CLI's control-request
acknowledgement and not the end of the turn. No timeout or incomplete
event was logged for the four ignored interrupts, so every acknowledgement
arrived within 2 s and YA reported success while the turn kept running.
The contract YA needs is "the turn reached a terminal event", which it
never checks. Fixes:

- After an acknowledged interrupt, wait a bounded time for the turn's
  terminal `result`; if none arrives, treat the interrupt as incomplete
  and take the existing hard-abort path, or first kill the turn's
  foreground tool process tree (the SDK child's direct `bash -c`
  children), which unblocked this case without losing the session.
- Log the interrupt's outcome and elapsed time; `process_interrupt` is
  written before the SDK call and nothing after it.

The Claude refresh to 2.1.332 (SDK 0.3.332) has not been checked against
this.

Found 2026-11-26 while diagnosing an unresponsive session in
`~/trtllm-speculative/draft` (YA session 1d0a7d2e).

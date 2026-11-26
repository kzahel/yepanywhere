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

Likely an upstream Claude Code bug; not reproduced in isolation. YA-side
gaps that made diagnosis harder or could mitigate:

- `Process.interrupt()` logs `process_interrupt` before the SDK call but
  nothing after it, so a hung or no-op `interrupt()` is indistinguishable
  from success. Log the outcome and elapsed time.
- No fallback when the SDK acknowledges nothing: after a timeout with the
  turn still in a tool call, YA could offer to kill the turn's foreground
  tool process tree (the SDK child's direct `bash -c` children), which
  unblocked this case without losing the session.

Found 2026-11-26 while diagnosing an unresponsive session in
`~/trtllm-speculative/draft` (YA session 1d0a7d2e).

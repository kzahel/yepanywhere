# A second request for a loading agent's content polls a ref every 100 ms

`loadAgentContent` in `packages/client/src/contexts/AgentContentContext.tsx`
handles "this agent is already loading" by starting a 100 ms `setInterval`
that checks `loadedAgentsRef` until the other caller's load lands, with a
30-second `setTimeout` as the deadline.

- The waiter resolves with `agentContent[agentId]` from the closure of the
  render in which it was called, so it can return the pre-load value rather
  than what the load produced.
- `loadedAgentsRef` gains the agent only when the load succeeds. After a
  failed load the waiter polls for the full 30 seconds and then reports
  `pending`.
- The deadline timer is never cleared, and nothing stops either timer when
  the provider unmounts.

Cheap fix: keep one in-flight promise per agent ID and return it to later
callers, which removes both timers. Remove the file's `recurring` entry from
`scripts/timer-ownership.json` in the same commit.

Found 2026-11-15 while recording the timer ownership baseline.

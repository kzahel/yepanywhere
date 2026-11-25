# A copied routed session whose first launch is refused can expire for good

A clone, fork or aside of a routed session inherits its parent's account
through its own allocation (`AgentAuthRouter.inheritBinding` in
`packages/server/src/services/AgentAuthRouter.ts`). `launch` treats that
allocation as an existing pin: when the router refuses anything between
prepare and commit, the catch block leaves the reservation in place so the
copy stays retryable. AAR keeps a prepared reservation for five minutes
(`PREPARE_MS`, `src/control.ts` in agent-auth-router) and then answers every
prepare or commit for that id with "allocation expired". A copy whose first
launch was refused therefore cannot launch at all once the cause takes longer
than five minutes to clear. The session shows the router's refusal, and
nothing tells the user that the copy is dead.

Refusals that reach this window include a lapsed account login, a model the
account stopped serving, a pool commit recheck, and since plan 198 an unusable
binding transport. The failure predates plan 198; the transport check adds one
more way into it.

Not fixed in place because the remedy changes allocation identity for
inherited bindings. The likely fix: record whether an allocation was ever
committed; on a definitive pre-commit refusal of a never-committed inherited
allocation, cancel it and let the next launch allocate afresh for the same
pinned account, keeping the parent's account and pool. Cover a copy that is
refused, waits past the reservation window and then launches.

Found 2026-11-25 while reviewing plan 198 step 2.

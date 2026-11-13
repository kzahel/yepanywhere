# A paired server never gains operations added after it was paired

A Server Connections pairing stores the list of operations that existed when it
was made (`controlOperations` in `packages/server/src/peer-api/connections.ts`),
on both the target's incoming record and the source's outgoing record. When a
later build adds operations, an existing pairing keeps its old list, and renewal
preserves it too (`operations: current?.operations ?? controlOperations`).

Observed on a real pair: a macOS server and a Windows server paired before
[plan 192](../docs/tactical/192-v0-session-control-and-peer-contracts.md), both
updated to it. `GET .../access` on the Windows target lists no `targetHelp`,
`targetSchema`, `selection`, `prompt`, `requests`, `respond`, `cancel` or
`stop`. A session the Mac created there ran and answered, and the Mac then got
`403 Peer operation is not granted` for a follow-up prompt and for stop, so it
could start remote work it could not steer or end. `sendMessage` was renamed to
`prompt` with no alias, so the pairing lost follow-up input it had before.
Target help is refused as well, which leaves an agent unable to read the
target's own documentation.

This contradicts [peer access](../topics/peer-access.md#server-connections-settings),
which says a new trusted-control connection "includes all current and future
projects and resource operations". Plan 192 accepted recreating alpha
connections once; nothing prevents the same loss at the next added operation.
`uiPairingOperation` in `peer-api/state.ts` has the same shape of problem: it
recognizes a legacy UI pairing only while its stored list still contains every
current operation.

Not fixed here because it changes what a stored grant means. The likely repair
is for a trusted-control pairing to record that it covers all resource
operations and to evaluate the current list at request time on both ends, while
explicit narrower grants keep their fixed lists. Until then the owner must
remove and re-pair each affected connection.

Found 2026-11-13 while running real sessions between a macOS server and a
native Windows server.
Contributing-model: claude-fable-5-2

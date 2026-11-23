# An unreadable Antigravity log hides the records YA could read before it

Since plan 195 step 8, a stopped conversation whose brain log is unknown
shows one row saying its history cannot be shown
([contract](../topics/antigravity.md#history-ya-cannot-show)). The records
before the first one YA cannot read still parse, but the window reader
([`antigravity-log-window.ts`](../packages/server/src/sessions/antigravity-log-window.ts))
returns no partial result: a page that reads an unknown record is unknown
as a whole, and so is every page "Load older" would read through it.

Not fixed in step 8 because the only cause real `agy` produced is a second
`agy` writing the same conversation, which plan 195 does not design for, and
its duplicate step indexes start at the end of the log, so little readable
history is hidden; no other unknown shape was seen on `agy` 1.5.13 or
1.5.14 ([measured](../topics/antigravity-native-storage.md#the-replay-fallback--plan-195-step-8)).
A future `agy` that changes the record format would make this matter for
every conversation it writes.

A fix would let the projection stop at the first unknown record and return
the messages before it with the notice row at the break, and let the latest
page fall back to the page before the break: the window reader's page
selection, the resume point and the live join all assume a page is known
or unknown as a whole.

Found 2026-11-23 while removing the Antigravity ACP replay fallback (plan
195 step 8).

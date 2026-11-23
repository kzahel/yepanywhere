# An unreadable Antigravity log hides the readable records around it

Since plan 195 step 8, a stopped conversation's brain log is read a page
at a time and each page is validated on its own
([contract](../topics/antigravity.md#history-ya-cannot-show)). Pages that
do not read an unknown record are served normally. The page that reads it
is answered with one row saying the history cannot be shown, and no
older-page cursor, so paging back stops there. The window reader
([`antigravity-log-window.ts`](../packages/server/src/sessions/antigravity-log-window.ts))
returns no partial result, so the readable records on that page are
hidden: those before the bad record, those after it, and every older page
behind it. When the bad record is inside the latest page, the
conversation shows only the row, including turns a resumed owner took
after it once that owner stops.

Not fixed in step 8 because the only cause real `agy` produced is a second
`agy` writing the same conversation, which plan 195 does not design for;
its duplicate step indexes start near the end of the log. No other unknown
shape was seen on `agy` 1.5.13 or 1.5.14
([measured](../topics/antigravity-native-storage.md#the-replay-fallback--plan-195-step-8)).
A future `agy` that changes the record format would make this matter for
every conversation it writes.

A fix would let the projection stop at the unknown record and return the
messages on either side of it with the notice row at the break, so the
latest page and "Load older" both serve the records before and after it
and paging continues past it: the window reader's page selection, the
resume point and the live join all assume a page is known or unknown as a
whole.

Found 2026-11-23 while removing the Antigravity ACP replay fallback (plan
195 step 8).

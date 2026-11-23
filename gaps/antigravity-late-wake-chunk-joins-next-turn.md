# A late Antigravity wake chunk is attributed to the next turn

When a detached wake (a background command's or a subagent report's) is
still streaming as YA sends the next prompt, the wake's remaining ACP
chunks arrive after the prompt was sent, and the adapter routes every
update after a send to that prompt's foreground transcript
(`foregroundUpdate` in
[antigravity.ts](../packages/server/src/sdk/providers/antigravity.ts)). The
wake's tail is then shown as the start of the new turn's reply, not as the
wake's. `agy` 1.5.13 and 1.5.14 send no echo or other update tied to a
prompt that would mark where its own output begins: the review round 2
probe saw the interrupted wake's chunk `MW_TAIL` as the first update after
the prompt on both binaries
([measurements](../topics/antigravity-native-storage.md#live-memory--plan-195-step-6)).
The log is right: it records the wake's planner before the prompt's
`USER_INPUT`, so a cold view, or a live view after a move, attributes it
correctly.

This predates plan 195 step 6, which makes it more visible: when the
wake's record was already complete when the prompt was sent, a move past
it can show that chunk twice (from the log, and as a live row of the new
turn) until the owner stops ([live memory](../topics/antigravity.md#live-memory)).
It was not fixed in step 6 because nothing on the ACP stream separates
the two; a fix needs a positive marker. Candidates: compare chunk text with
the wake's logged planner once it is written, or hold attribution of
passive-looking chunks until the prompt's first tool call or its
`USER_INPUT` is logged, each qualified on real `agy`.

Found 2026-11-23 while reworking plan 195 step 6 (review round 2).

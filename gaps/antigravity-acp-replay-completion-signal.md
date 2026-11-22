# Antigravity replay needs a provider completion signal for ambiguous history

The Antigravity [cold loader](../packages/server/src/sdk/providers/antigravity-replay.ts)
waits for a saved text witness when `agy` responds to `session/load` early.
This recovers the distinct final report in the original long-session repro
and gates the first resumed prompt. The native transcript can contain
multiple identical replies or end in tool updates instead of text. The text
witness alone cannot identify the last occurrence or prove that subsequent
tool frames have arrived. An unmarked late tool frame after reactivation can
also enter the live update path.

Exercise these shapes with the controlled peer, then qualify any marker on
pinned and candidate binaries. Look for a native signal or replay identity
that preserves the full ordered history. The published ACP v1 timing rule
requires the whole history before the load response. The original long
session emitted intermediate usage updates, so those updates cannot locate
the replay boundary. See [Antigravity history](../topics/antigravity.md#identity-and-history).

The plan 195 step 3 census found the text witness itself refusing
complete replays. On a copy of one host's store, YA's loader rejected four
of twelve replays with "saved replay tail did not arrive", so those
conversations could not be opened cold. Since plan 195 step 4 they open
from the brain log, which needs no witness; the refusal still applies to
resume and to the replay fallback for a missing or unknown log. In three, the replay joins a reply that
exists only in the database to the log's last text, so the joined message
no longer ends with the witness. In one, the witness is a `USER_INPUT`
record, which the check compares in its wrapped `<USER_REQUEST>` form with
the unwrapped replayed text.
[Census](../topics/antigravity-native-storage.md#comparison-with-acp-replay)

Found in review of the long cold-replay fix on 2026-11-22.

# Session-header goal flag does not appear live after `/goal`; reload shows it

After a Claude `/goal <objective>` succeeds, the goal flag at the top of the
session view stays absent until the page is reloaded. Observed 2026-11-13 in
session `541db088-0657-4a1c-9f3b-afcf668ca8d1` (`~/sherpa-onnx-fusion`): the
goal was set at 10:14:07Z, Claude confirmed it ("Goal set" in its transcript),
YA stored its goal receipt at 10:14:08.5Z, and the flag showed only on reload.

The flag reads goal state from the slash-command inventory:
`readInventoryGoalDetails(slashCommands)` in
`packages/client/src/pages/SessionPage.tsx` (`currentGoal`). The server adds
that state to the inventory's `goal` entry through `withClaudeGoalDetails` in
`packages/server/src/sdk/providers/claude-goal.ts`, from the
`ClaudeGoalTracker` snapshot. Likely cause, not verified: nothing pushes or
refetches the inventory when the tracker's snapshot changes, so the client
keeps the inventory it loaded before the goal existed. The same staleness
would affect clear, pause and resume, and the inventory's goal argument
completions.

Probable fix: when a goal command or tracker refresh changes the snapshot,
notify subscribed clients (or invalidate their cached inventory) so the flag
updates without a reload. Verify with a live `/goal`, then `/goal clear`, and
watch the flag appear and disappear without reloading.

Bug class: UI state that only a reload brings up to date. Transcript content
of this kind is owned by
[stream/persisted render convergence](../topics/stream-persisted-render-parity.md);
this instance is the non-transcript variant, derived session state (the
command inventory) with no live update path.

Not fixed in place: found while fixing the duplicate `/goal` row on reload
(commit a6e4bc650); this needs its own trace of how clients receive inventory
updates.

Found 2026-11-13 while fixing the duplicate `/goal` echo on reload.

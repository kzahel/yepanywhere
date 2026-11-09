# session-header-responsive loses transcript follow on the phone pass

`packages/client/e2e/session-header-responsive.spec.ts` ("header preserves
identity, overflow actions and rename typing during live updates") fails
intermittently at line 384: after the phone-width Rename dialog opens, the
streamed "Checking workspace storage 9." row never appears. The failure
screenshot shows the transcript scrolled a little above its tail with the
Follow button visible, so following stopped and the render window never
reached the streamed row. It reproduced 3 of 8 runs at 703415fe6, before
the menu family landed, so it is not caused by the shared Menu; the menu
swap moved the rate around (focus moving into a pointer-opened menu made
it more frequent, and menus now leave focus alone on pointer opens).

Not fixed in place: the cause is in the transcript's follow heuristics
(`stopFollowingForUpwardScroll` in `components/MessageList.tsx`, an upward
movement from the last follow write read as reader intent) reacting to a
layout change around the phone header, viewport and dialog, which needs
its own diagnosis. Next step: record a trace of a failing repeat
(`--repeat-each 8 --trace retain-on-failure`) and find the scroll write
that moves the container upward before the dialog opens.

Found 2026-11-09 while verifying the menu and popover family (plan 182).

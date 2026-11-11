# Native allocation hides a known session from retained lists

`packages/server/test/sessions/session-native-allocation.test.ts:428`
fails because the retained global session list omits the known session
`11111111-1111-4111-8111-111111111111` while an allocation is pending.
The ordinary project list and direct known-session reads pass earlier in
the same scenario; the retained list contains only the pending YA session.

The failure reproduced in the full workspace run and in the isolated spec
while rebasing local work onto origin/main `8e0e5e279`. Repeating the isolated
spec with all server and shared sources temporarily restored to that upstream
revision produced the same failure (1 failed, 1 passed, about 3.7 seconds).
The rebased sources were restored afterward. Local diagnostic logs live in
`/tmp/yep-push-checks.kXZUc0/{test,native-allocation,upstream-native-allocation}.log`.

This upstream defect is outside the requested rebase/push and the CSS import
integration fix. Investigate retained catalog projection/invalidation while a
native namespace is pending; do not relax the known-session visibility check.

Found 2026-11-11 while rebasing and pushing main.

2026-11-11 CSS consolidation qualification: the full workspace again fails at
this unchanged assertion (final run: 7,340 server cases pass, 94 skip). An isolated repeat
after frozen-lockfile installation reproduces the same missing known id; both
new proxy response ownership cases pass after applying the already committed
Hono package patch. No server sources or assertions were changed by this pass.

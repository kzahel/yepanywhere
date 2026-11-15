# Eight components each run their own one-second interval

These each create a private `setInterval(…, 1000)` that sets component state:
`ExternalSessionWarning`, `PendingToolWarning`, `ForkSummaryDisplayObject`,
`ProjectQueueSection`, `HostedRouterControls`, `TemplateCreationProgress`,
`hooks/useBrowserDebugLease.ts` and `hooks/useFileActivity.ts`.
`useRelativeNow(1000)` in `MessageList.tsx` adds another, because only
`useMinuteNow` in `hooks/useRelativeNow.ts` shares one timer among its
subscribers.

Several of these mount on the session page, where
[memory growth](../topics/memory-growth.md) already names about nine
one-second timers as the trigger for per-second re-renders of the transcript.
Independent intervals also tick out of phase, so the page wakes more often
than once a second.

`useFileActivity` is a different defect in the same shape: it reads
`activityBus.connected` every second because the bus has no disconnect event.

Cheap fix: give `useRelativeNow.ts` a shared second clock beside the minute
clock, subscribed through `useSyncExternalStore` by the component that renders
the time, and give the activity bus a connection-change event. Remove each
converted file's `recurring` entry from `scripts/timer-ownership.json` in the
same commit.

Found 2026-11-15 while recording the timer ownership baseline.

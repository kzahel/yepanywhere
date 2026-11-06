# Inbox provider-wait proposal

Review-only fixture, requested 2026-11-06, for showing in the inbox whether an
active session is generating or only waiting. Rows are the real
`SessionListItem` card; the phase mark goes through `titleContent` and the
work pill through `customBadge`. No server or provider requests are made.

The shipped implementation is documented in
[provider waits](../../../../topics/provider-wait-and-background-work.md#contracts).
It departs from this fixture: there is no `quiet` phase, because keeping it
truthful would need a server timer; sleeps show their wake time rather than a
countdown; the phase has no `lastProgressAt`; and the Background tier
(the **grouped** layout) is what shipped. The fixture remains the original
proposal.

Row `activity` stays `"in-turn"` for every phase, so queued messages keep
waiting exactly as today. Only rendering changes. The proposed wire addition
on inbox (and session-list) items:

```ts
providerPhase?: {
  phase: "generating" | "waiting" | "quiet" | "background";
  lastProgressAt: string | null;
  work?: ProviderWorkItem[]; // first few; foreground waits, else background work
};
```

Derived server-side from the liveness snapshot:

| Phase | Mark | Source |
|---|---|---|
| generating | pulsing filled dot (today's) | in turn, recent verified progress |
| waiting | orange ring + orange pill | in turn, `providerRetention.foregroundWaits` non-empty |
| quiet | dashed amber ring + "no output Nm" | `long-silent-unverified` |
| background | gray ring + muted pill | `verified-waiting-provider`, `backgroundWork` |

Pills lead with the elapsed time or wake time so truncation removes the
label, not the timer. The fixture's inbox-scoped CSS lets the meta line wrap
so a long pill drops below project and age on phones.

The **grouped** layout splits background-held sessions into their own tier
below Active; **inline** keeps them in Active, after generating and waiting
rows.

## Build and capture

From the repository root:

```sh
pnpm --filter @yep-anywhere/client exec vite build --config mockups/inbox-provider-wait/vite.config.ts
pnpm exec tsx packages/client/mockups/inbox-provider-wait/capture.mts inline
pnpm exec tsx packages/client/mockups/inbox-provider-wait/capture.mts grouped lower
```

`lower` scrolls to the background rows before capturing. Open
`.artifacts/mockups/inbox-provider-wait/index.html` in YA's file viewer; the
top-row buttons switch layout and theme, and timers tick.
